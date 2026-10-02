import * as vscode from 'vscode';
import type { ExportCommandPayload } from '../shared/exporters/types';
import type { AutoArrangeMode, FlatSettingsPatch, HostToWebview, Layout, ParseError, QualifiedName, Ref, Schema, ViewportCommand, ViewportLayout, WebviewToHost } from '../shared/types';
import { locateTableAsync, parseAsync } from './parseService';
import { emptyLayout, LayoutConflictError, LayoutParseError, mergeLayout, parseLayout, readLayout, readSidecarText, serializeSharedLayout, sidecarUri, writeSharedLayout } from './layoutStore';
import { applyViewState, emptyViewState, extractViewState, mergeViewStateChange, readViewState, sameViewState, writeViewState, type ViewState } from './viewStateStore';
import { applyDecisions, countKeys, detectSidecarConflict, toSerializableConflicts } from './mergeResolver';
import { diffSchemas } from './schemaDiff';
import type { MergeConflict } from './mergeThreeWay';
import { getCurrentBranch, getRepoRoot, getUnmergedStages, gitAdd, gitCommit, gitLog, gitRestore, gitStashApply, gitStashList, gitUnstageNew, gitStashPop, gitStashPush, gitStatusPorcelain, showBlob, toRepoRelative } from './gitStages';
import type { GitOp } from '../shared/types';
import { getExporter, listExporters } from './exporters';
import { applySettingsPatch, loadSettings, onSettingsChange } from './settings';

const PERSIST_DEBOUNCE_MS = 200;
/** Editor autosave fires the .dbml watcher on a timer while typing; coalesce bursts. */
const SCHEMA_DEBOUNCE_MS = 150;
/** Each git status spawns 2-3 processes; a drag+save burst used to spawn ~6 of them. */
const GIT_STATUS_DEBOUNCE_MS = 200;
const DESIGN_VS_DATA_DOC_URL = 'https://github.com/TWulfZ/dddbml#design-vs-data';

const MERGE_UNREADABLE = 'The layout file has git conflict markers, but the conflict could not be read from git. Resolve the markers in the layout file manually; layout changes are not saved until then.';

/** Why the panel refuses shared writes (spec 16, "Gate en dos capas"). */
type ReadOnlyReason = 'merge' | 'timeTravel' | 'diff';

type TimeTravelPayload = Extract<HostToWebview, { type: 'git:timeTravel:enter' }>['payload'];
type DiffPayload = Extract<HostToWebview, { type: 'git:diff:enter' }>['payload'];

/** The git overlay on screen; time travel keeps its payload so a reloaded webview gets it back. */
type GitOverlay = { kind: 'timeTravel'; enter: TimeTravelPayload } | { kind: 'diff' };
/** `abortIf` is checked after the async parse, right before posting (F21 overlay-entry race). */
type SchemaSendOptions = { skipIfUnchanged?: boolean; abortIf?: () => boolean };

export class DiagramPanel {
  private static panels = new Map<string, DiagramPanel>();

  public static createOrShow(context: vscode.ExtensionContext, dbmlUri: vscode.Uri): void {
    const key = dbmlUri.toString();
    const existing = DiagramPanel.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }
    const panel = new DiagramPanel(context, dbmlUri);
    DiagramPanel.panels.set(key, panel);
  }

  public static get(dbmlUri: vscode.Uri): DiagramPanel | undefined {
    return DiagramPanel.panels.get(dbmlUri.toString());
  }

  public static getActive(): DiagramPanel | undefined {
    for (const panel of DiagramPanel.panels.values()) {
      if (panel.webviewPanel.active) return panel;
    }
    return undefined;
  }

  public static disposeAll(): void {
    for (const panel of DiagramPanel.panels.values()) panel.dispose();
    DiagramPanel.panels.clear();
  }

  /** Persists started by a close/hide flush. deactivate() awaits them: on window reload the panels
   *  may already be disposed (and their flushes in flight) before deactivate runs. */
  private static readonly inFlightFlushes = new Set<Promise<void>>();

  public static async settle(): Promise<void> {
    while (DiagramPanel.inFlightFlushes.size > 0) await Promise.all([...DiagramPanel.inFlightFlushes]);
  }

  private readonly webviewPanel: vscode.WebviewPanel;
  /** Tables already told that the layout color overrides their DBML headercolor (once per session). */
  private readonly headerColorNotified = new Set<QualifiedName>();
  private readonly disposables: vscode.Disposable[] = [];
  private lastValidSchema: Schema = { tables: [], refs: [], groups: [] };
  /** Whether the latest read of the .dbml parsed; lastValidSchema may be stale (or the empty
   *  sentinel) when it did not. */
  private lastParseOk = false;
  private layoutLoaded = false;
  private gitOverlay: GitOverlay | null = null;
  /** A watcher or git-op reload that arrived during a git overlay; replayed when it ends (F21). */
  private reloadDeferred = false;
  /** Bumped each time a git overlay goes on screen. An external reload that passed its overlay check
   *  under an older value must not post: it would replace the revision under the banner (F21). */
  private overlayGeneration = 0;
  /** A layout:persist was dropped by the gate: the webview shows an edit the host never took, so
   *  the next overlay exit must re-send the layout even when nothing else changed. */
  private webviewDiverged = false;
  /** Overlay enter/exit and hydrate run one at a time. Interleaved, a second Exit click posted its
   *  exit before the first had sent the working state, unlocking the past revision for editing. */
  private overlayQueue: Promise<void> = Promise.resolve();
  private currentLayout: Layout = emptyLayout();
  /** Exact sidecar text last seen on disk — adopted by a read or produced by our own write (null =
   *  no file). A watcher event whose file still matches it is an echo or a no-op; anything else is
   *  external and reloads. Must track reads too: tracking only our writes ignores a `git checkout`
   *  that returns the file to that content after another branch's layout was loaded (F01). */
  private diskSidecarText: string | null = null;
  /** Canonical shared serialization of what is on disk; a persist whose shared form equals it is a
   *  view-state-only change and must not rewrite the tracked sidecar. */
  private diskSharedSerialized: string | null = null;
  /** View-state as last loaded into / persisted from this panel; flushes write only the delta
   *  against it (see mergeViewStateChange). null = no view-state file existed at load. */
  private viewStateBaseline: ViewState | null = null;
  private viewStateWrites: Promise<void> = Promise.resolve();
  /** Set while the sidecar on disk is unparseable; shared writes are refused until a clean read. */
  private sidecarCorrupt = false;
  /** True once the webview has sent `ready` and received schema/layout; prompts wait for this. */
  private hydrated = false;
  private afterHydrate: Array<() => void> = [];
  private pendingPersist: Layout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private schemaTimer: NodeJS.Timeout | null = null;
  private sidecarEventPending = false;
  private disposed = false;
  private gitStatusTimer: NodeJS.Timeout | null = null;
  /** Serialized form of the last `schema:update` posted — lets the watcher skip no-op reparses. */
  private lastPostedSchema: string | null = null;
  /** The most recent sendSchema; a superseded parse waits on it so callers still see schema posted. */
  private latestSchemaSend: Promise<void> = Promise.resolve();
  private schemaPosts = 0;
  /** Set while a conflicted sidecar awaits in-webview resolution; null otherwise. Holds the
   *  retained host-side conflicts so the webview only has to return per-conflict decisions. */
  private pendingMerge: { conflicts: MergeConflict[]; merged: Layout; repoRoot: string; relpath: string } | null = null;
  /** The sidecar has conflict markers but git's stages could not be read (F04): still a merge, so
   *  still read-only, with no conflicts to pick until a clean read. */
  private mergeUnreadable = false;
  /** Guards against concurrent Apply round-trips writing/staging twice. */
  private mergeResolving = false;
  /** Signature (conflicts with both sides) of the last `merge:begin` posted — so re-detecting the SAME
   *  conflict set (e.g. a double-firing watcher) doesn't re-post and wipe the user's decisions. */
  private lastPostedMergeSig: string | null = null;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly dbmlUri: vscode.Uri,
  ) {
    const distRoot = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
    this.webviewPanel = vscode.window.createWebviewPanel(
      'dddbml.diagram',
      `dddbml — ${this.shortName(dbmlUri)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [distRoot],
      },
    );

    this.webviewPanel.webview.html = this.renderHtml();
    this.webviewPanel.webview.onDidReceiveMessage(
      (msg: WebviewToHost) => this.handleWebviewMessage(msg),
      null,
      this.disposables,
    );
    this.webviewPanel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) return;
      // Hiding destroys the webview (retainContextWhenHidden: false): prompts must wait for the
      // next `ready`, and a debounced persist must land before the re-shown webview reads disk.
      this.hydrated = false;
      return this.flushPendingPersistNow();
    }, null, this.disposables);

    this.disposables.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.post({ type: 'theme:change', payload: { kind: this.currentThemeKind() } });
      }),
      onSettingsChange(() => {
        this.post({ type: 'settings:loaded', payload: loadSettings() });
      }),
    );

    this.setupWatchers();
  }

  public openExportModal(): void {
    this.whenHydrated(() => this.post({ type: 'export:prompt' }));
  }

  public openExportImageModal(): void {
    this.whenHydrated(() => this.post({ type: 'exportImage:prompt' }));
  }

  /** Run now if the webview is hydrated, else right after hydration. Replaces the old fixed
   *  250 ms timer, which lost the prompt on large schemas that took longer to hydrate. */
  private whenHydrated(fn: () => void): void {
    if (this.hydrated) fn();
    else this.afterHydrate.push(fn);
  }

  public reveal(): void {
    // The hide event may not have reached the extension host yet; a hidden panel will reload.
    if (!this.webviewPanel.visible) this.hydrated = false;
    this.webviewPanel.reveal(vscode.ViewColumn.Beside, true);
  }

  public sendViewportCommand(action: ViewportCommand): void {
    this.post({ type: 'viewport:command', payload: { action } });
  }

  public sendAutoArrange(mode: AutoArrangeMode): void {
    this.post({ type: 'command:autoArrange', payload: { mode } });
  }

  public sendEdgeOrderOnly(): void {
    this.post({ type: 'command:orderEdges', payload: {} });
  }

  /** Only the webview can lay tables out, so it runs the reset and persists the result (spec 03,
   *  F24); the write then passes the same read-only gate as any edit. */
  public resetLayout(): void {
    if (this.refuseWhileReadOnly('Reset Layout')) return;
    this.whenHydrated(() => this.post({ type: 'command:resetLayout' }));
  }

  public async pruneOrphans(): Promise<void> {
    if (this.refuseWhileReadOnly('Prune orphans')) return;
    // "Orphan" is judged against the schema: with no current parse (or no layout loaded yet) every
    // entry looks orphaned and the whole sidecar — positions and colours — would be wiped.
    if (!this.layoutLoaded || !this.lastParseOk) {
      void vscode.window.showWarningMessage('dddbml: fix the .dbml so it parses before pruning orphan layout entries.');
      return;
    }
    const preview = this.computePrune();
    if (preview.removedTables === 0 && preview.removedGroups === 0) {
      void vscode.window.showInformationMessage('dddbml: no orphan layout entries to prune.');
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `dddbml: remove ${preview.removedTables} orphan table(s) and ${preview.removedGroups} orphan group(s) from the layout file? This cannot be undone.`,
      { modal: true },
      'Prune',
    );
    if (answer !== 'Prune' || this.refuseWhileReadOnly('Prune orphans')) return;
    // Recomputed: the layout may have changed while the modal was open.
    const { tables: nextTables, groups: nextGroups, removedTables, removedGroups } = this.computePrune();
    this.currentLayout = { ...this.currentLayout, tables: nextTables, groups: nextGroups };
    await this.flushPersist(this.currentLayout);
    this.post({ type: 'layout:loaded', payload: this.currentLayout });
    void vscode.window.showInformationMessage(`dddbml: pruned ${removedTables} orphan table(s), ${removedGroups} orphan group(s).`);
  }

  /** Host half of the read-only gate: the webview's own gate does not survive a reload, a timer set
   *  before entering, or a host command, so the host is the authority (spec 16). */
  private get readOnly(): ReadOnlyReason | null {
    if (this.pendingMerge || this.mergeUnreadable) return 'merge';
    return this.gitOverlay?.kind ?? null;
  }

  private refuseWhileReadOnly(action: string): boolean {
    const reason = this.readOnly;
    if (!reason) return false;
    const fix = reason === 'merge' ? 'resolve the layout merge first' : 'exit the read-only git view first';
    void vscode.window.showWarningMessage(`dddbml: ${action} is unavailable — ${fix}.`);
    return true;
  }

  private computePrune(): { tables: Layout['tables']; groups: Layout['groups']; removedTables: number; removedGroups: number } {
    const liveTables = new Set(this.lastValidSchema.tables.map((t) => t.name));
    const liveGroups = new Set(this.lastValidSchema.groups.map((g) => g.name));
    const tables: Layout['tables'] = {};
    for (const [k, v] of Object.entries(this.currentLayout.tables)) {
      if (liveTables.has(k)) tables[k] = v;
    }
    const groups: Layout['groups'] = {};
    for (const [k, v] of Object.entries(this.currentLayout.groups)) {
      if (liveGroups.has(k)) groups[k] = v;
    }
    return {
      tables,
      groups,
      removedTables: Object.keys(this.currentLayout.tables).length - Object.keys(tables).length,
      removedGroups: Object.keys(this.currentLayout.groups).length - Object.keys(groups).length,
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    DiagramPanel.panels.delete(this.dbmlUri.toString());
    void this.flushPendingPersistNow();
    if (this.schemaTimer) clearTimeout(this.schemaTimer);
    if (this.gitStatusTimer) clearTimeout(this.gitStatusTimer);
    while (this.disposables.length) {
      const d = this.disposables.pop();
      try { d?.dispose(); } catch { /* noop */ }
    }
    try { this.webviewPanel.dispose(); } catch { /* noop */ }
  }

  private post(msg: HostToWebview): void {
    if (this.disposed) return; // the webview getter throws once disposed (e.g. a late flush)
    void this.webviewPanel.webview.postMessage(msg);
  }

  private flushPendingPersistNow(): Promise<void> | undefined {
    const pending = this.pendingPersist;
    this.cancelPendingPersist();
    if (!pending) return undefined;
    return this.trackFlush(this.flushPersist(pending));
  }

  private trackFlush(work: Promise<void>): Promise<void> {
    const flush: Promise<void> = work.finally(() => DiagramPanel.inFlightFlushes.delete(flush));
    DiagramPanel.inFlightFlushes.add(flush);
    return flush;
  }

  private handleWebviewMessage(msg: WebviewToHost): void {
    switch (msg.type) {
      case 'ready':
        void this.serializeOverlay(() => this.hydrate());
        return;
      case 'layout:persist':
        this.onLayoutPersist(msg.payload);
        return;
      case 'viewport:persist':
        this.onViewportPersist(msg.payload);
        return;
      case 'command:pruneOrphans':
        void this.pruneOrphans();
        return;
      case 'command:reveal':
        void this.revealTable(msg.payload.tableName);
        return;
      case 'command:export':
        void this.runExport(msg.payload);
        return;
      case 'command:saveImage':
        void this.saveImage(msg.payload);
        return;
      case 'settings:update':
        void applySettingsPatch(msg.payload as Partial<FlatSettingsPatch>);
        return;
      case 'notify:headerColorOverride':
        void this.notifyHeaderColorOverride(msg.payload.table);
        return;
      case 'merge:resolve':
        void this.resolveMerge(msg.payload.decisions);
        return;
      case 'git:requestStatus':
        void this.sendGitStatus();
        return;
      case 'git:commit':
        void this.handleGitCommit(msg.payload.message);
        return;
      case 'git:requestStashes':
        void this.sendStashes();
        return;
      case 'git:restore':
        void this.handleGitRestore();
        return;
      case 'git:stashPush':
        void this.handleGitStashPush(msg.payload.message);
        return;
      case 'git:stashApply':
        void this.handleGitStashOp('stashApply', msg.payload.ref);
        return;
      case 'git:stashPop':
        void this.handleGitStashOp('stashPop', msg.payload.ref);
        return;
      case 'git:requestCommits':
        void this.sendCommits();
        return;
      case 'git:timeTravel:enter': {
        const { sha, label } = msg.payload;
        void this.serializeOverlay(() => this.enterTimeTravel(sha, label));
        return;
      }
      case 'git:timeTravel:exit':
        void this.serializeOverlay(() => this.leaveOverlay('git:timeTravel:exit'));
        return;
      case 'git:diff:enter':
        void this.serializeOverlay(() => this.enterDiff());
        return;
      case 'git:diff:exit':
        void this.serializeOverlay(() => this.leaveOverlay('git:diff:exit'));
        return;
      case 'error:log':
        console.error('[dddbml webview]', msg.payload.message, msg.payload.stack);
        return;
      default:
        return;
    }
  }

  private async runExport(payload: ExportCommandPayload): Promise<void> {
    const exporter = getExporter(payload.formatId);
    if (!exporter) {
      void vscode.window.showErrorMessage(`dddbml: unknown export format "${payload.formatId}".`);
      this.post({ type: 'export:result', payload: { ok: false, message: 'unknown format' } });
      return;
    }

    // Export what is on screen: during time travel that is the past revision, not the working tree.
    const source = this.gitOverlay?.kind === 'timeTravel' ? this.gitOverlay.enter.schema : this.lastValidSchema;
    const filtered = payload.scope === 'selected'
      ? filterSchemaBySelection(source, new Set(payload.selection))
      : source;

    if (filtered.tables.length === 0) {
      const message = payload.scope === 'selected'
        ? 'dddbml: nothing to export — selection is empty.'
        : 'dddbml: nothing to export — schema has no tables.';
      void vscode.window.showWarningMessage(message);
      this.post({ type: 'export:result', payload: { ok: false, message } });
      return;
    }

    try {
      const result = exporter.export({
        schema: filtered,
        scope: payload.scope,
        selection: payload.selection,
        options: payload.options,
      });

      const doc = await vscode.workspace.openTextDocument({
        content: result.content,
        language: result.language,
      });
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false });

      if (result.warnings && result.warnings.length > 0) {
        const head = result.warnings.slice(0, 3).join('\n');
        const more = result.warnings.length > 3 ? `\n…and ${result.warnings.length - 3} more.` : '';
        void vscode.window.showInformationMessage(`dddbml export warnings:\n${head}${more}`);
      }

      this.post({ type: 'export:result', payload: { ok: true, warnings: result.warnings } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`dddbml: export failed — ${message}`);
      this.post({ type: 'export:result', payload: { ok: false, message } });
    }
  }

  /**
   * Save an image the webview rendered (PNG/SVG bytes, base64). Prompts for a location with a
   * save dialog (defaulting beside the .dbml), writes the bytes, and reports back so the webview
   * can close the dialog. Cancelling the dialog is a no-op (ok:false, no error).
   */
  private async saveImage(payload: { dataBase64: string; mime: 'image/png' | 'image/svg+xml'; suggestedName: string; reducedScale?: number }): Promise<void> {
    const ext = payload.mime === 'image/svg+xml' ? 'svg' : 'png';
    const defaultUri = vscode.Uri.joinPath(this.dbmlUri, '..', payload.suggestedName);
    try {
      const target = await vscode.window.showSaveDialog({
        defaultUri,
        filters: ext === 'svg' ? { 'SVG image': ['svg'] } : { 'PNG image': ['png'] },
      });
      if (!target) {
        this.post({ type: 'image:result', payload: { ok: false } });
        return;
      }
      const bytes = Buffer.from(payload.dataBase64, 'base64');
      await vscode.workspace.fs.writeFile(target, bytes);
      this.post({ type: 'image:result', payload: { ok: true, path: target.fsPath } });
      const reduced = payload.reducedScale !== undefined
        ? ` at ${payload.reducedScale}× (reduced: too large for the requested scale; use SVG for full resolution)`
        : '';
      void vscode.window.showInformationMessage(`dddbml: image saved${reduced} — ${this.shortName(target)}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`dddbml: image export failed — ${message}`);
      this.post({ type: 'image:result', payload: { ok: false, message } });
    }
  }

  private async revealTable(qualifiedName: string): Promise<void> {
    try {
      // The editor buffer, not the disk: line numbers must match what showTextDocument displays
      // even with unsaved edits.
      const source = (await vscode.workspace.openTextDocument(this.dbmlUri)).getText();
      const lineIdx = await locateTableAsync(source, qualifiedName, `locate:${this.dbmlUri.toString()}`);
      if (lineIdx === undefined) return; // a newer double-click superseded this one
      if (lineIdx === null) {
        void vscode.window.showWarningMessage(`dddbml: could not find "${qualifiedName}" in source.`);
        return;
      }
      const pos = new vscode.Position(lineIdx, 0);
      await vscode.window.showTextDocument(this.dbmlUri, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
        selection: new vscode.Range(pos, pos),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`dddbml: reveal failed — ${message}`);
    }
  }

  private serializeOverlay(work: () => Promise<void>): Promise<void> {
    const run = this.overlayQueue.then(work);
    this.overlayQueue = run.catch((err: unknown) => console.error('[dddbml] git overlay transition failed', err));
    return run;
  }

  private async hydrate(): Promise<void> {
    this.lastPostedMergeSig = null; // a fresh webview has no merge on screen: re-post it (F02)
    this.reloadDeferred = false; // it gets the current working state below
    await this.flushPendingPersistNow(); // sendLayout drops a pending persist; a working edit must land first
    // Computed before the working state goes out: awaiting the diff after it left the fresh webview
    // editable while the host still dropped its persists (spec 16).
    const overlay = await this.overlayToRepost();
    // Send layout first so that when the schema arrives, positions are already in the
    // store and the auto-layout effect skips tables that already have a saved position.
    await this.sendLayout();
    await this.sendSchema();
    this.maybePostMerge(); // after schema, so the ghost tables can render
    if (overlay && this.gitOverlay) this.post(overlay); // a merge found meanwhile takes over instead
    this.post({ type: 'theme:change', payload: { kind: this.currentThemeKind() } });
    this.post({ type: 'settings:loaded', payload: loadSettings() });
    this.post({ type: 'exporters:list', payload: { exporters: listExporters() } });
    void this.sendGitStatus();
    this.hydrated = true;
    const queued = this.afterHydrate;
    this.afterHydrate = [];
    for (const fn of queued) fn();
  }

  /**
   * Re-parse the .dbml and post `schema:update`. With `skipIfUnchanged` (watcher path) an
   * identical payload is not re-posted: a save that changes nothing (or only comments) used to
   * hand the webview a fresh schema object and force every derived memo to recompute. Direct
   * callers (hydrate, time-travel exit) must always post, since the webview state differs.
   */
  private sendSchema(opts: SchemaSendOptions = {}): Promise<void> {
    const send = this.parseAndPostSchema(opts);
    this.latestSchemaSend = send;
    return send;
  }

  private async parseAndPostSchema(opts: SchemaSendOptions): Promise<void> {
    const postsBefore = this.schemaPosts;
    let payload: { schema: Schema; parseError: ParseError | null };
    try {
      const bytes = await vscode.workspace.fs.readFile(this.dbmlUri);
      const source = new TextDecoder('utf-8').decode(bytes);
      const result = await parseAsync(source, `live:${this.dbmlUri.toString()}`);
      // A newer save superseded this parse; it posts the fresher schema, and callers that order
      // messages after "schema posted" (hydrate, overlay exits) must still wait for it.
      if (result === null) {
        // Only sendSchema parses on the live channel, so latestSchemaSend is that newer call.
        await this.latestSchemaSend;
        // That newer send may have skipped (unchanged payload) or aborted (an overlay went up); a
        // caller that must post (hydrate, overlay exit) re-parses instead of leaving the webview on
        // a revision schema under an unlocked editor.
        if (opts.skipIfUnchanged || opts.abortIf?.() || this.disposed || this.schemaPosts !== postsBefore) return;
        return this.sendSchema(opts);
      }
      if (this.disposed) return;
      if (result.error) {
        this.lastParseOk = false;
        payload = { schema: this.lastValidSchema, parseError: result.error };
      } else {
        this.lastValidSchema = result.schema;
        this.lastParseOk = true;
        payload = { schema: result.schema, parseError: null };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastParseOk = false;
      payload = { schema: this.lastValidSchema, parseError: { message } };
    }
    if (opts.abortIf?.()) return;
    const serialized = JSON.stringify(payload);
    if (opts.skipIfUnchanged && serialized === this.lastPostedSchema) return;
    this.lastPostedSchema = serialized;
    this.schemaPosts++;
    this.post({ type: 'schema:update', payload });
  }

  private scheduleGitStatus(): void {
    if (this.disposed) return;
    if (this.gitStatusTimer) clearTimeout(this.gitStatusTimer);
    this.gitStatusTimer = setTimeout(() => {
      this.gitStatusTimer = null;
      void this.sendGitStatus();
    }, GIT_STATUS_DEBOUNCE_MS);
  }

  /** `'ifChanged'` (overlay exit / diff entry): external only when the sidecar text moved since it
   *  was last seen. The webview drops its stashed undo history on an external change (F76), and a
   *  peek that changed nothing on disk must not cost it. */
  private async sendLayout(isExternal: boolean | 'ifChanged' = false, abortIf?: () => boolean): Promise<void> {
    const seen = this.diskSidecarText;
    const seenShared = this.diskSharedSerialized;
    const layout = await this.loadFullLayout();
    if (abortIf?.()) {
      // Never shown: un-see the text so the replay (or the next reload) still posts it as external.
      this.diskSidecarText = seen;
      this.diskSharedSerialized = seenShared;
      return;
    }
    this.currentLayout = layout;
    // The webview is about to show this layout; a persist accepted against what it showed before
    // (another revision, or a reload that raced it) must not be written over it.
    this.cancelPendingPersist();
    this.webviewDiverged = false;
    this.layoutLoaded = true;
    const external = isExternal === 'ifChanged' ? this.diskSidecarText !== seen : isExternal;
    this.post({
      type: external ? 'layout:external-change' : 'layout:loaded',
      payload: this.currentLayout,
    });
  }

  /**
   * Reconstructs the full layout the webview expects from BOTH persistence
   * destinations: the git sidecar (shared design) + the local view-state file
   * (viewport / per-user hidden+collapsed). The webview never sees the split.
   */
  private async loadFullLayout(): Promise<Layout> {
    return this.withViewState(await this.loadSharedLayout());
  }

  /** Clothes a working shared layout with this user's view-state. With no view-state file yet, it is
   *  seeded once from flags a legacy (≤ v0.2.2) sidecar still carries; the next persist saves it. */
  private async withViewState(shared: Layout): Promise<Layout> {
    const vs = await readViewState(this.context, this.dbmlUri);
    const layout = applyViewState(shared, vs ?? extractViewState(shared));
    // What the webview now knows; null forces the first persist to create the file (seeding).
    this.viewStateBaseline = vs === null ? null : extractViewState(layout);
    return layout;
  }

  /**
   * Reads the shared sidecar. On unresolved git conflict markers, runs the
   * in-extension 3-way merge (reads git stages 1/2/3, QuickPick for true conflicts)
   * instead of silently wiping. If even that fails (e.g. not a git repo), keeps the
   * last good in-memory layout rather than losing positions.
   */
  private async loadSharedLayout(): Promise<Layout> {
    try {
      const { layout, text } = await readLayout(this.dbmlUri);
      this.pendingMerge = null; // a clean read clears any stale conflict state
      this.mergeUnreadable = false;
      this.sidecarCorrupt = false;
      this.diskSidecarText = text;
      this.diskSharedSerialized = text === null ? null : serializeSharedLayout(layout);
      return layout;
    } catch (err) {
      if (err instanceof LayoutConflictError) {
        this.diskSidecarText = err.conflictedText;
        this.diskSharedSerialized = null;
        return this.handleConflict();
      }
      if (err instanceof LayoutParseError) {
        this.diskSidecarText = err.text;
        this.diskSharedSerialized = null;
        this.sidecarCorrupt = true;
        void vscode.window.showWarningMessage(
          'dddbml: the layout file is not valid JSON — fix it (or restore it from git) to save layout changes. The diagram is read from the last good layout meanwhile.',
        );
        return this.currentLayout;
      }
      return emptyLayout();
    }
  }

  /**
   * A conflicted sidecar: read git's three stages and run the pure 3-way merge. Unambiguous keys
   * auto-merge; genuine "both moved the same key" conflicts are handed to the webview ghost UI
   * (merge:begin, posted by maybePostMerge once the schema is up). Crucially the file KEEPS its
   * conflict markers until the user applies — so closing the panel mid-merge re-triggers this on
   * reopen (the old QuickPick wrote a marker-free file on cancel and destroyed its own trigger).
   * Returns the provisional (ours-biased) merge for spatial context; with zero conflicts it
   * writes + stages immediately, like the old auto path.
   */
  private async handleConflict(): Promise<Layout> {
    let detected;
    try {
      detected = await detectSidecarConflict(this.dbmlUri);
    } catch {
      // Never fall back to an editable layout: the first edit would overwrite both sides (F04).
      this.pendingMerge = null;
      this.mergeUnreadable = true;
      this.cancelPendingPersist();
      return this.currentLayout;
    }
    this.mergeUnreadable = false;
    const { merged, conflicts, repoRoot, relpath } = detected;
    if (conflicts.length === 0) {
      await this.writeShared(merged);
      try { await gitAdd(repoRoot, relpath); } catch { /* staging is best-effort */ }
      this.pendingMerge = null;
      void vscode.window.showInformationMessage(
        `dddbml: layout auto-merged cleanly — ${countKeys(merged)} item(s), no conflicts.`,
      );
      return merged;
    }
    // A persist debounced before the markers landed holds the pre-merge layout (F27).
    this.cancelPendingPersist();
    this.pendingMerge = { conflicts, merged, repoRoot, relpath };
    return merged;
  }

  /** Post the conflict set to the webview (schema must already be up so ghosts can render). Skips a
   *  re-post when the conflict set is unchanged, so a double-firing watcher doesn't wipe decisions.
   *  A merge that ended outside the diagram (resolved, aborted) posts merge:done (F03). */
  private maybePostMerge(): void {
    if (!this.pendingMerge && !this.mergeUnreadable) {
      if (this.lastPostedMergeSig !== null) this.post({ type: 'merge:done' });
      this.lastPostedMergeSig = null;
      return;
    }
    const conflicts = this.pendingMerge ? toSerializableConflicts(this.pendingMerge.conflicts) : [];
    const error = this.mergeUnreadable ? MERGE_UNREADABLE : null;
    // Sides are part of the signature: the next rebase step can conflict on the same keys with new
    // values, and keeping the old ghosts would make Apply write a value the user never saw.
    const sig = JSON.stringify({ conflicts, error });
    if (sig === this.lastPostedMergeSig) return; // identical set already on screen — keep the user's picks
    if (this.lastPostedMergeSig !== null) {
      void vscode.window.showWarningMessage('dddbml: the layout changed on disk — the conflict list was refreshed.');
    }
    this.lastPostedMergeSig = sig;
    this.gitOverlay = null; // beginMerge drops the webview out of any git view
    this.post({ type: 'merge:begin', payload: { conflicts, error } });
  }

  /** The webview resolved the conflicts: apply decisions, write the clean sidecar, stage, refresh, exit. */
  private async resolveMerge(decisions: Record<string, 'ours' | 'theirs'>): Promise<void> {
    if (this.mergeResolving) return; // ignore concurrent Apply clicks
    const pending = this.pendingMerge;
    if (!pending) {
      if (this.mergeUnreadable) { this.post({ type: 'merge:applyFailed' }); return; }
      // Resolved or aborted outside the diagram: the webview must still leave merge mode (F03).
      this.lastPostedMergeSig = null;
      this.post({ type: 'merge:done' });
      return;
    }
    this.mergeResolving = true;
    try {
      let resolved: Layout;
      try {
        resolved = applyDecisions(pending.merged, pending.conflicts, decisions);
        await this.writeShared(resolved);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`dddbml: failed to write resolved layout — ${message}`);
        // The file keeps its markers and pendingMerge is intact; the user's picks must survive the retry (F73).
        this.post({ type: 'merge:applyFailed' });
        return;
      }
      try { await gitAdd(pending.repoRoot, pending.relpath); } catch { /* staging is best-effort */ }
      this.pendingMerge = null;
      this.lastPostedMergeSig = null;
      const chosen = pending.conflicts.length;
      const auto = countKeys(resolved) - chosen;
      this.currentLayout = await this.withViewState(resolved);
      // Apply the final layout WHILE still in conflict mode (conflicting tables are hidden behind
      // their ghosts), THEN exit — so each conflicting table goes ghost → final position with no
      // intermediate frame at the provisional (ours) spot.
      this.post({ type: 'layout:loaded', payload: this.currentLayout });
      this.post({ type: 'merge:done' });
      void vscode.window.showInformationMessage(
        `dddbml: layout merged — ${auto} auto-resolved, ${chosen} chosen by you.`,
      );
    } finally {
      this.mergeResolving = false;
    }
  }

  /** The git-tracked files that make up this diagram: the `.dbml` + its layout sidecar. All git
   *  write/read ops are scoped to exactly these (spec 16 — diagram-files-only). Returns null when
   *  the file is not inside a git work tree. (!include discovery is a later, best-effort phase.) */
  private async diagramScope(): Promise<{ repoRoot: string; dbmlRel: string; sidecarRel: string; relpaths: string[] } | null> {
    const repoRoot = await getRepoRoot(this.dbmlUri.fsPath);
    if (!repoRoot) return null;
    const sidecar = sidecarUri(this.dbmlUri);
    const dbmlRel = toRepoRelative(repoRoot, this.dbmlUri.fsPath);
    const sidecarRel = toRepoRelative(repoRoot, sidecar.fsPath);
    return { repoRoot, dbmlRel, sidecarRel, relpaths: [dbmlRel, sidecarRel] };
  }

  /** Compute the live git status of the diagram files and push it to the webview. Best-effort:
   *  any git failure degrades to `inRepo: false` rather than throwing. */
  private async sendGitStatus(): Promise<void> {
    const scope = await this.diagramScope();
    if (!scope) {
      this.post({ type: 'git:status', payload: { inRepo: false, branch: null, files: [], dirty: false } });
      return;
    }
    const [branch, files] = await Promise.all([
      getCurrentBranch(scope.repoRoot),
      gitStatusPorcelain(scope.repoRoot, scope.relpaths),
    ]);
    this.post({ type: 'git:status', payload: { inRepo: true, branch, files, dirty: files.length > 0 } });
  }

  /** Stage + commit ONLY the dirty diagram files with the given message, then refresh status. */
  private async handleGitCommit(message: string): Promise<void> {
    const trimmed = message.trim();
    if (!trimmed) {
      this.post({ type: 'git:commitResult', payload: { ok: false, message: 'Commit message is empty' } });
      return;
    }
    const scope = await this.diagramScope();
    if (!scope) {
      this.post({ type: 'git:commitResult', payload: { ok: false, message: 'Not a git repository' } });
      return;
    }
    const blocked = await this.mergeBlocksGitWrite(scope);
    if (blocked) {
      this.post({ type: 'git:commitResult', payload: { ok: false, message: blocked } });
      return;
    }
    const dirty = (await gitStatusPorcelain(scope.repoRoot, scope.relpaths)).map((f) => f.relpath);
    if (dirty.length === 0) {
      this.post({ type: 'git:commitResult', payload: { ok: false, message: 'No diagram changes to commit' } });
      return;
    }
    try {
      await gitCommit(scope.repoRoot, dirty, trimmed);
      this.post({ type: 'git:commitResult', payload: { ok: true } });
      void vscode.window.showInformationMessage(`dddbml: committed ${dirty.length} diagram file(s).`);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.post({ type: 'git:commitResult', payload: { ok: false, message: m } });
      void vscode.window.showErrorMessage(`dddbml: commit failed — ${m}`);
    }
    await this.sendGitStatus();
  }

  /** List repo stashes and push them to the webview. Best-effort: empty list when not in a repo. */
  private async sendStashes(): Promise<void> {
    const scope = await this.diagramScope();
    const stashes = scope ? await gitStashList(scope.repoRoot) : [];
    this.post({ type: 'git:stashes', payload: { stashes } });
  }

  /**
   * Re-read the diagram from disk after a git op rewrote the working tree (restore / stash / pop):
   * refreshes schema + layout + git status; routes any conflict markers (e.g. from a stash pop)
   * into the merge resolver.
   */
  private async reloadFromDisk(): Promise<void> {
    if (this.gitOverlay) {
      this.reloadDeferred = true;
      await this.sendGitStatus();
      return;
    }
    await this.sendSchema();
    await this.sendLayout(true);
    this.maybePostMerge();
    await this.sendGitStatus();
  }

  private postOpResult(op: GitOp, ok: boolean, message?: string): void {
    this.post({ type: 'git:opResult', payload: { op, ok, message } });
  }

  /** Discard uncommitted changes to the diagram files (restore to HEAD). DESTRUCTIVE — the webview
   *  already confirmed. Untracked files have no HEAD version, so they're left as-is; staged-new
   *  files have none either, so they're only unstaged (left untracked, same rule). */
  private async handleGitRestore(): Promise<void> {
    const scope = await this.diagramScope();
    if (!scope) { this.postOpResult('restore', false, 'Not a git repository'); return; }
    const blocked = await this.mergeBlocksGitWrite(scope);
    if (blocked) { this.postOpResult('restore', false, blocked); return; }
    const status = await gitStatusPorcelain(scope.repoRoot, scope.relpaths);
    const restorable = status.filter((f) => f.status !== 'untracked' && f.status !== 'added').map((f) => f.relpath);
    const stagedNew = status.filter((f) => f.status === 'added').map((f) => f.relpath);
    const count = restorable.length + stagedNew.length;
    if (count === 0) { this.postOpResult('restore', false, 'No tracked changes to revert'); return; }
    try {
      if (restorable.length > 0) await gitRestore(scope.repoRoot, restorable);
      await gitUnstageNew(scope.repoRoot, stagedNew);
      await this.reloadFromDisk();
      this.postOpResult('restore', true);
      void vscode.window.showInformationMessage(`dddbml: reverted ${count} diagram file(s) to HEAD.`);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.postOpResult('restore', false, m);
      void vscode.window.showErrorMessage(`dddbml: revert failed — ${m}`);
    }
  }

  /** Stash the diagram's tracked changes (scoped). Untracked files are excluded (plain stash push
   *  does not include them). After stashing, the working tree reverts to HEAD → reload. */
  private async handleGitStashPush(message?: string): Promise<void> {
    const scope = await this.diagramScope();
    if (!scope) { this.postOpResult('stashPush', false, 'Not a git repository'); return; }
    const blocked = await this.mergeBlocksGitWrite(scope);
    if (blocked) { this.postOpResult('stashPush', false, blocked); return; }
    const tracked = (await gitStatusPorcelain(scope.repoRoot, scope.relpaths))
      .filter((f) => f.status !== 'untracked')
      .map((f) => f.relpath);
    if (tracked.length === 0) { this.postOpResult('stashPush', false, 'No tracked changes to stash'); return; }
    try {
      await gitStashPush(scope.repoRoot, tracked, message);
      await this.reloadFromDisk();
      await this.sendStashes();
      this.postOpResult('stashPush', true);
      void vscode.window.showInformationMessage('dddbml: diagram changes stashed.');
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.postOpResult('stashPush', false, m);
      void vscode.window.showErrorMessage(`dddbml: stash failed — ${m}`);
    }
  }

  /** Apply or pop a stash, then reload (a pop may surface conflict markers → merge resolver). */
  private async handleGitStashOp(op: 'stashApply' | 'stashPop', ref: string): Promise<void> {
    const scope = await this.diagramScope();
    if (!scope) { this.postOpResult(op, false, 'Not a git repository'); return; }
    const blocked = await this.mergeBlocksGitWrite(scope);
    if (blocked) { this.postOpResult(op, false, blocked); return; }
    try {
      if (op === 'stashApply') await gitStashApply(scope.repoRoot, ref);
      else await gitStashPop(scope.repoRoot, ref);
      await this.reloadFromDisk();
      await this.sendStashes();
      this.postOpResult(op, true);
    } catch (err) {
      // git exits non-zero when the stash applied but conflicted: the working tree DID change, so
      // reporting "failed" invites a retry or a Revert that discards the half-applied stash.
      if (await this.hasUnmergedDiagramFiles(scope)) {
        await this.reloadFromDisk();
        await this.sendStashes();
        this.postOpResult(op, true, 'Applied with conflicts');
        void vscode.window.showInformationMessage('dddbml: the stash was applied with conflicts — resolve them; the stash is kept until then.');
        return;
      }
      const m = err instanceof Error ? err.message : String(err);
      this.postOpResult(op, false, m);
      void vscode.window.showErrorMessage(`dddbml: stash ${op === 'stashPop' ? 'pop' : 'apply'} failed — ${m}`);
    }
  }

  /**
   * Staging the marker-laden sidecar erases git's unmerged stages (F31). Git state is checked, not
   * only pendingMerge: a stash-pop conflict has no MERGE_HEAD, so git itself refuses nothing.
   */
  private async mergeBlocksGitWrite(scope: { repoRoot: string; relpaths: string[] }): Promise<string | null> {
    if (this.readOnly !== 'merge' && !(await this.hasUnmergedDiagramFiles(scope))) return null;
    const message = 'Resolve the layout merge first';
    void vscode.window.showWarningMessage(`dddbml: ${message.toLowerCase()} — git operations on the diagram files are blocked while it is pending.`);
    return message;
  }

  private async hasUnmergedDiagramFiles(scope: { repoRoot: string; relpaths: string[] }): Promise<boolean> {
    for (const relpath of scope.relpaths) {
      try {
        if ((await getUnmergedStages(scope.repoRoot, relpath)).size > 0) return true;
      } catch { /* treat as not unmerged */ }
    }
    return false;
  }

  /** List commits touching the diagram files and push them to the webview (History pane). */
  private async sendCommits(): Promise<void> {
    const scope = await this.diagramScope();
    const commits = scope ? await gitLog(scope.repoRoot, scope.relpaths) : [];
    this.post({ type: 'git:commits', payload: { commits } });
  }

  /**
   * Virtual time-travel (spec 16): read a past commit's `.dbml` + sidecar via `git show` and parse
   * them IN MEMORY — the working tree and the open editor are never touched. The shared layout is
   * re-clothed with the user's current view-state so pan/zoom/hidden stay put. The webview enters a
   * read-only overlay; `leaveOverlay` restores the working view.
   */
  private async enterTimeTravel(sha: string, label: string): Promise<void> {
    if (this.refuseWhileMerging('Exploring versions')) return;
    const scope = await this.diagramScope();
    if (!scope) return; // not a repo — the UI gates this, so just ignore
    const dbmlSrc = await showBlob(scope.repoRoot, sha, scope.dbmlRel);
    if (dbmlSrc == null) {
      void vscode.window.showWarningMessage('dddbml: could not read that revision of the diagram.');
      return;
    }
    const parsed = await parseAsync(dbmlSrc, `revision:${this.dbmlUri.toString()}`);
    if (!parsed || this.disposed) return; // a newer peek superseded this one
    if (parsed.error) {
      // Substituting today's schema under the old label would silently show the wrong tables.
      void vscode.window.showWarningMessage(`dddbml: the diagram at ${label} does not parse — ${parsed.error.message}`);
      return;
    }
    const schema = parsed.schema;
    const sidecarSrc = await showBlob(scope.repoRoot, sha, scope.sidecarRel);
    const shared = sidecarSrc != null ? parseLayout(sidecarSrc) : emptyLayout();
    // Never seed from the past sidecar's legacy flags: a peek always wears the current view-state.
    const vs = (await readViewState(this.context, this.dbmlUri)) ?? emptyViewState();
    const layout = applyViewState(shared, vs);
    await this.flushPendingPersistNow(); // the last working edit lands before the gate closes
    const enter: TimeTravelPayload = { rev: sha, label, schema, layout };
    this.overlayGeneration++;
    this.gitOverlay = { kind: 'timeTravel', enter };
    this.post({ type: 'git:timeTravel:enter', payload: enter });
  }

  /**
   * End a git overlay and bring the webview back to the working state: time travel always (the past
   * revision is on screen), a diff only when a reload was deferred or a persist dropped meanwhile.
   * The exit is posted LAST — the webview stays read-only until the working state is in its store
   * (F27), and a merge found by the reload opens before it (merge wins over the overlay).
   */
  private async leaveOverlay(exit: 'git:timeTravel:exit' | 'git:diff:exit'): Promise<void> {
    const overlay = this.gitOverlay;
    // A repeated Exit, or a merge that already took over: nothing was restored, so nothing to unlock.
    if (!overlay) return;
    this.gitOverlay = null;
    if (overlay.kind === 'timeTravel' || this.reloadDeferred || this.webviewDiverged) {
      this.reloadDeferred = false;
      await this.sendSchema();
      await this.sendLayout('ifChanged');
      this.maybePostMerge();
    }
    this.post({ type: exit });
  }

  /** A reloaded webview starts on the working state; the overlay it was showing goes back on top. */
  private async overlayToRepost(): Promise<HostToWebview | null> {
    const overlay = this.gitOverlay;
    if (!overlay) return null;
    if (overlay.kind === 'timeTravel') return { type: 'git:timeTravel:enter', payload: overlay.enter };
    // The working tree may have changed while the diff was up; a stale diff would mis-tint it.
    const diff = await this.computeDiff();
    if (!diff) {
      this.gitOverlay = null;
      return null;
    }
    return { type: 'git:diff:enter', payload: diff };
  }

  /**
   * Diff the working tree against HEAD (spec 16, Phase 4) and post the structural delta. The webview
   * keeps showing its current (working) schema and overlays the diff — added/modified tables get a
   * border + per-column tints; removed tables/refs render as ghosts placed from HEAD's sidecar. The
   * diff is computed in the host (parse HEAD via `git show`) off the render path.
   */
  private async enterDiff(): Promise<void> {
    if (this.refuseWhileMerging('Diff against HEAD')) return;
    const diff = await this.computeDiff();
    if (!diff) return;
    await this.flushPendingPersistNow();
    const fromTimeTravel = this.gitOverlay?.kind === 'timeTravel';
    this.overlayGeneration++;
    this.gitOverlay = { kind: 'diff' };
    if (fromTimeTravel || this.reloadDeferred) {
      // The diff overlays the WORKING tree; a past revision left on screen would be what its Exit
      // unlocks for editing (F05).
      this.reloadDeferred = false;
      await this.sendSchema();
      await this.sendLayout('ifChanged');
      if (this.readOnly === 'merge') { this.maybePostMerge(); return; }
    }
    this.post({ type: 'git:diff:enter', payload: diff });
  }

  private refuseWhileMerging(action: string): boolean {
    return this.readOnly === 'merge' && this.refuseWhileReadOnly(action);
  }

  private async computeDiff(): Promise<DiffPayload | null> {
    const scope = await this.diagramScope();
    if (!scope) { void vscode.window.showWarningMessage('dddbml: not a git repository.'); return null; }
    const baseDbml = await showBlob(scope.repoRoot, 'HEAD', scope.dbmlRel);
    if (baseDbml == null) { void vscode.window.showWarningMessage('dddbml: the diagram has no committed version at HEAD yet.'); return null; }
    const parsedBase = await parseAsync(baseDbml, `diffBase:${this.dbmlUri.toString()}`);
    if (!parsedBase) return null;
    if (parsedBase.error) {
      // An empty base would report every table as "added" — a false diff, not a degraded one.
      void vscode.window.showWarningMessage(`dddbml: the diagram at HEAD does not parse — ${parsedBase.error.message}`);
      return null;
    }
    // Re-read rather than trust lastValidSchema: it is stale (or the empty sentinel) while the file
    // is broken, and diffing against it shows every table as removed.
    let headSource: string;
    try {
      headSource = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(this.dbmlUri));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showWarningMessage(`dddbml: could not read the working diagram — ${message}`);
      return null;
    }
    const parsedHead = await parseAsync(headSource, `diffHead:${this.dbmlUri.toString()}`);
    if (!parsedHead) return null;
    if (parsedHead.error) {
      void vscode.window.showWarningMessage(`dddbml: the working diagram does not parse — ${parsedHead.error.message}`);
      return null;
    }
    const diff = diffSchemas(parsedBase.schema, parsedHead.schema);
    if (diff.tables.length === 0 && diff.refs.length === 0) {
      void vscode.window.showInformationMessage('dddbml: no schema changes vs HEAD.');
      return null;
    }
    // Enrich removed tables with their base position (from HEAD's sidecar) so the ghost can be placed.
    const baseSidecar = await showBlob(scope.repoRoot, 'HEAD', scope.sidecarRel);
    const baseLayout = baseSidecar != null ? parseLayout(baseSidecar) : emptyLayout();
    for (const t of diff.tables) {
      if (t.status === 'removed') {
        const p = baseLayout.tables[t.table];
        t.pos = p ? { x: p.x, y: p.y } : null;
      }
    }
    return { baseLabel: 'HEAD', headLabel: 'working', diff };
  }

  private onLayoutPersist(payload: Partial<Layout>): void {
    const reason = this.readOnly;
    if (reason) {
      console.warn(`[dddbml] layout:persist dropped: the canvas is read-only (${reason}).`);
      this.webviewDiverged = true;
      return;
    }
    const merged = mergeLayout(this.currentLayout, payload);
    this.currentLayout = merged;
    this.pendingPersist = merged;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flushPendingPersistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** The camera is personal view-state (spec 03, F26): it never reaches the sidecar, so the
   *  read-only gate does not apply — panning a past revision or a merge still saves it. */
  private onViewportPersist(viewport: ViewportLayout): void {
    this.currentLayout = { ...this.currentLayout, viewport };
    if (this.pendingPersist) this.pendingPersist = { ...this.pendingPersist, viewport };
    void this.trackFlush(this.writeViewStateDelta());
  }

  /** Every shared write goes through here: what we just wrote is valid, so a stale corrupt flag
   *  must not keep blocking later saves (F30). */
  private async writeShared(layout: Layout): Promise<void> {
    const serialized = await writeSharedLayout(this.dbmlUri, layout);
    this.diskSidecarText = serialized;
    this.diskSharedSerialized = serialized;
    this.sidecarCorrupt = false;
  }

  private async flushPersist(layout: Layout): Promise<void> {
    // Git sidecar: shared design only. Skip the write when the shared form is unchanged
    // so pure pan/zoom (view-state only) never churns the tracked file.
    let sharedChanged = false;
    try {
      const sharedSerialized = serializeSharedLayout(layout);
      if (this.sidecarCorrupt || this.readOnly === 'merge') {
        // Never clobber a corrupt or conflict-marked sidecar; the watcher re-reads on fix.
      } else if (sharedSerialized !== this.diskSharedSerialized) {
        // The watcher can lag a `git merge`/`pull` past our debounce: writing now would rename over
        // its result (conflict markers included), and the reload would then take it for our echo.
        if ((await readSidecarText(this.dbmlUri)) !== this.diskSidecarText) {
          this.scheduleExternalReload(true);
        } else {
          await this.writeShared(layout);
          sharedChanged = true;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`dddbml: failed to write layout file — ${message}`);
    }
    await this.writeViewStateDelta();
    // Only a real shared-layout write flips the sidecar dirty/clean — refresh the Git panel's status
    // then (NOT on pure pan/zoom, which would spawn `git status` on every frame's debounced flush).
    if (sharedChanged) this.scheduleGitStatus();
  }

  /** Local view-state: never tracked by git, so failures here are non-fatal. Writes are chained
   *  (a camera write and a layout flush could land out of order) and read the layout when they run:
   *  a flush's snapshot predates a camera saved while its shared write was in flight. */
  private writeViewStateDelta(): Promise<void> {
    const write = this.viewStateWrites.then(async () => {
      try {
        const next = extractViewState(this.currentLayout);
        const base = this.viewStateBaseline;
        if (base === null || !sameViewState(base, next)) {
          const disk = (await readViewState(this.context, this.dbmlUri)) ?? emptyViewState();
          await writeViewState(this.context, this.dbmlUri, mergeViewStateChange(disk, base ?? emptyViewState(), next));
          this.viewStateBaseline = next;
        }
      } catch (err) {
        console.error('[dddbml] failed to write view-state', err);
      }
    });
    this.viewStateWrites = write;
    return write;
  }

  private setupWatchers(): void {
    const parentUri = vscode.Uri.joinPath(this.dbmlUri, '..');
    const dbmlName = this.shortName(this.dbmlUri);
    const layoutSidecar = sidecarUri(this.dbmlUri);
    const layoutName = this.shortName(layoutSidecar);

    const dbmlWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(parentUri, globLiteral(dbmlName)),
    );
    const onDbmlFs = (uri: vscode.Uri) => {
      if (uri.toString() !== this.dbmlUri.toString()) return;
      this.scheduleExternalReload(false);
    };
    // Create too: tools that save via temp file + rename only emit a create.
    dbmlWatcher.onDidChange(onDbmlFs);
    dbmlWatcher.onDidCreate(onDbmlFs);

    const layoutWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(parentUri, globLiteral(layoutName)),
    );
    const onLayoutFs = (uri: vscode.Uri) => {
      if (uri.toString() !== layoutSidecar.toString()) return;
      this.scheduleExternalReload(true);
    };
    layoutWatcher.onDidChange(onLayoutFs);
    layoutWatcher.onDidCreate(onLayoutFs);
    layoutWatcher.onDidDelete(onLayoutFs);

    this.disposables.push(dbmlWatcher, layoutWatcher);
  }

  /**
   * Both watchers funnel into ONE debounced reload so a branch switch / pull that rewrites the
   * .dbml and the sidecar together is applied schema-first. Posting the new layout against the old
   * schema let the webview auto-place tables that only exist in the previous revision, and the next
   * edit wrote those phantom entries into the new branch's sidecar.
   */
  private scheduleExternalReload(sidecarTouched: boolean): void {
    if (this.disposed) return;
    if (sidecarTouched) this.sidecarEventPending = true;
    this.scheduleGitStatus();
    if (this.schemaTimer) clearTimeout(this.schemaTimer);
    this.schemaTimer = setTimeout(() => {
      this.schemaTimer = null;
      void this.runExternalReload();
    }, SCHEMA_DEBOUNCE_MS);
  }

  private async runExternalReload(): Promise<void> {
    const sidecarTouched = this.sidecarEventPending;
    this.sidecarEventPending = false;
    if (this.gitOverlay) {
      // Pushing it now would replace the revision being viewed while the banner still names it (F21).
      this.reloadDeferred = true;
      return;
    }
    const generation = this.overlayGeneration;
    const superseded = (): boolean => generation !== this.overlayGeneration;
    await this.sendSchema({ skipIfUnchanged: true, abortIf: superseded });
    if (superseded()) return this.supersedeReload(sidecarTouched);
    if (!sidecarTouched) return;
    const text = await readSidecarText(this.dbmlUri);
    if (superseded()) return this.supersedeReload(sidecarTouched);
    if (text === this.diskSidecarText) return; // our own write's echo, or no net change
    // The webview is about to show the external layout; a queued write of the old one would
    // overwrite what just arrived on disk.
    this.cancelPendingPersist();
    await this.sendLayout(true, superseded);
    if (superseded()) return this.supersedeReload(sidecarTouched);
    this.maybePostMerge(); // external pull/merge may have introduced conflicts
  }

  /** An overlay went on screen while a reload awaited: defer it to the overlay's exit like one that
   *  arrived during it, or, if the overlay is already gone again, start over from fresh reads. */
  private supersedeReload(sidecarTouched: boolean): void {
    if (this.gitOverlay) {
      this.reloadDeferred = true;
      return;
    }
    this.scheduleExternalReload(sidecarTouched);
  }

  private cancelPendingPersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.pendingPersist = null;
  }

  private currentThemeKind(): 'light' | 'dark' {
    return vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast
      ? 'dark'
      : 'light';
  }

  private async notifyHeaderColorOverride(table: QualifiedName): Promise<void> {
    if (this.headerColorNotified.has(table)) return;
    this.headerColorNotified.add(table);
    const choice = await vscode.window.showWarningMessage(
      `dddbml: "${table}" now uses the layout color instead of the headercolor in ${this.shortName(this.dbmlUri)}. ` +
        'Colors and positions live in the layout file so the .dbml stays data-only.',
      'Learn more',
    );
    if (choice === 'Learn more') void vscode.env.openExternal(vscode.Uri.parse(DESIGN_VS_DATA_DOC_URL));
  }

  private shortName(uri: vscode.Uri): string {
    const parts = uri.path.split('/');
    return parts[parts.length - 1] ?? 'diagram';
  }

  private renderHtml(): string {
    const webview = this.webviewPanel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'webview.js'),
    );
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'codicon.css'),
    );
    const nonce = generateNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `connect-src ${webview.cspSource}`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>dddbml</title>
<link href="${codiconUri}" rel="stylesheet" />
<style>
  html, body, #root { height: 100%; margin: 0; padding: 0; overflow: hidden; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function generateNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

/** VS Code globs have no escape character; a one-character class matches a metacharacter literally. */
function globLiteral(name: string): string {
  return name.replace(/[[\]{}*?]/g, (c) => `[${c}]`);
}

function filterSchemaBySelection(schema: Schema, selection: Set<QualifiedName>): Schema {
  const tables = schema.tables.filter((t) => selection.has(t.name));
  // A ref with one selected end is kept so the exporter sees the cut and warns (spec 09); refs with
  // both ends outside the selection are dropped, or every unrelated relation would warn.
  const refs: Ref[] = schema.refs.filter(
    (r) => selection.has(r.source.table) || selection.has(r.target.table),
  );
  const groups = schema.groups
    .map((g) => ({ ...g, tables: g.tables.filter((t) => selection.has(t)) }))
    .filter((g) => g.tables.length > 0);
  return { tables, refs, groups };
}
