import * as vscode from 'vscode';
import type { ExportCommandPayload } from '../shared/exporters/types';
import type { AutoArrangeMode, FlatSettingsPatch, HostToWebview, Layout, ParseError, QualifiedName, Ref, Schema, ViewportCommand, WebviewToHost } from '../shared/types';
import { parseDbml } from './parser';
import { emptyLayout, LayoutConflictError, mergeLayout, parseLayout, readLayout, serializeSharedLayout, sidecarUri, writeSharedLayout } from './layoutStore';
import { applyViewState, extractViewState, readViewState, writeViewState } from './viewStateStore';
import { applyDecisions, countKeys, detectSidecarConflict, toSerializableConflicts } from './mergeResolver';
import { diffSchemas } from './schemaDiff';
import type { MergeConflict } from './mergeThreeWay';
import { getCurrentBranch, getRepoRoot, gitAdd, gitCommit, gitLog, gitRestore, gitStashApply, gitStashList, gitStashPop, gitStashPush, gitStatusPorcelain, showBlob, toRepoRelative } from './gitStages';
import type { GitOp } from '../shared/types';
import { getExporter, listExporters } from './exporters';
import { applySettingsPatch, loadSettings, onSettingsChange } from './settings';

const PERSIST_DEBOUNCE_MS = 200;
/** Editor autosave fires the .dbml watcher on a timer while typing; coalesce bursts. */
const SCHEMA_DEBOUNCE_MS = 150;
/** Each git status spawns 2-3 processes; a drag+save burst used to spawn ~6 of them. */
const GIT_STATUS_DEBOUNCE_MS = 200;

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

  private readonly webviewPanel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private lastValidSchema: Schema = { tables: [], refs: [], groups: [] };
  private currentLayout: Layout = emptyLayout();
  private lastWrittenSerialized: string | null = null;
  /** True once the webview has sent `ready` and received schema/layout; prompts wait for this. */
  private hydrated = false;
  private afterHydrate: Array<() => void> = [];
  private pendingPersist: Layout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private schemaTimer: NodeJS.Timeout | null = null;
  private gitStatusTimer: NodeJS.Timeout | null = null;
  /** Serialized form of the last `schema:update` posted — lets the watcher skip no-op reparses. */
  private lastPostedSchema: string | null = null;
  /** Set while a conflicted sidecar awaits in-webview resolution; null otherwise. Holds the
   *  retained host-side conflicts so the webview only has to return per-conflict decisions. */
  private pendingMerge: { conflicts: MergeConflict[]; merged: Layout; repoRoot: string; relpath: string } | null = null;
  /** Guards against concurrent Apply round-trips writing/staging twice. */
  private mergeResolving = false;
  /** Signature (joined conflict ids) of the last `merge:begin` posted — so re-detecting the SAME
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

  public async resetLayout(): Promise<void> {
    this.currentLayout = { ...this.currentLayout, tables: {} };
    await this.flushPersist(this.currentLayout);
    this.post({ type: 'layout:loaded', payload: this.currentLayout });
    void vscode.window.showInformationMessage('dddbml: layout reset — auto-layout will re-run.');
  }

  public async pruneOrphans(): Promise<void> {
    const liveTables = new Set(this.lastValidSchema.tables.map((t) => t.name));
    const liveGroups = new Set(this.lastValidSchema.groups.map((g) => g.name));
    const nextTables: Record<string, { x: number; y: number }> = {};
    for (const [k, v] of Object.entries(this.currentLayout.tables)) {
      if (liveTables.has(k)) nextTables[k] = v;
    }
    const nextGroups: typeof this.currentLayout.groups = {};
    for (const [k, v] of Object.entries(this.currentLayout.groups)) {
      if (liveGroups.has(k)) nextGroups[k] = v;
    }
    const removedTables = Object.keys(this.currentLayout.tables).length - Object.keys(nextTables).length;
    const removedGroups = Object.keys(this.currentLayout.groups).length - Object.keys(nextGroups).length;
    this.currentLayout = { ...this.currentLayout, tables: nextTables, groups: nextGroups };
    await this.flushPersist(this.currentLayout);
    this.post({ type: 'layout:loaded', payload: this.currentLayout });
    void vscode.window.showInformationMessage(`dddbml: pruned ${removedTables} orphan table(s), ${removedGroups} orphan group(s).`);
  }

  public dispose(): void {
    DiagramPanel.panels.delete(this.dbmlUri.toString());
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.schemaTimer) clearTimeout(this.schemaTimer);
    if (this.gitStatusTimer) clearTimeout(this.gitStatusTimer);
    while (this.disposables.length) {
      const d = this.disposables.pop();
      try { d?.dispose(); } catch { /* noop */ }
    }
    try { this.webviewPanel.dispose(); } catch { /* noop */ }
  }

  private post(msg: HostToWebview): void {
    void this.webviewPanel.webview.postMessage(msg);
  }

  private handleWebviewMessage(msg: WebviewToHost): void {
    switch (msg.type) {
      case 'ready':
        void this.hydrate();
        return;
      case 'layout:persist':
        this.onLayoutPersist(msg.payload);
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
      case 'git:timeTravel:enter':
        void this.enterTimeTravel(msg.payload.sha, msg.payload.label);
        return;
      case 'git:timeTravel:exit':
        void this.exitTimeTravel();
        return;
      case 'git:diff:enter':
        void this.enterDiff();
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

    const filtered = payload.scope === 'selected'
      ? filterSchemaBySelection(this.lastValidSchema, new Set(payload.selection))
      : this.lastValidSchema;

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
  private async saveImage(payload: { dataBase64: string; mime: 'image/png' | 'image/svg+xml'; suggestedName: string }): Promise<void> {
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
      void vscode.window.showInformationMessage(`dddbml: image saved — ${this.shortName(target)}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`dddbml: image export failed — ${message}`);
      this.post({ type: 'image:result', payload: { ok: false, message } });
    }
  }

  private async revealTable(qualifiedName: string): Promise<void> {
    // qualifiedName is "schema.tableName". DBML allows either `Table name` (public) or `Table schema.name`.
    try {
      const bytes = await vscode.workspace.fs.readFile(this.dbmlUri);
      const source = new TextDecoder('utf-8').decode(bytes);
      const [schema, tableName] = splitQualified(qualifiedName);
      const lines = source.split(/\r?\n/);
      const re = /^\s*Table\s+([\w.]+)(?:\s+as\s+[\w]+)?\s*(?:\[[^\]]*\])?\s*\{/i;
      let lineIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        const m = re.exec(lines[i] ?? '');
        if (!m) continue;
        const ident = m[1] ?? '';
        const parts = ident.split('.');
        const s = parts.length > 1 ? parts[0]! : 'public';
        const t = parts.length > 1 ? parts.slice(1).join('.') : ident;
        if (s === schema && t === tableName) { lineIdx = i; break; }
      }
      if (lineIdx < 0) {
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

  private async hydrate(): Promise<void> {
    // Send layout first so that when the schema arrives, positions are already in the
    // store and the auto-layout effect skips tables that already have a saved position.
    await this.sendLayout();
    await this.sendSchema();
    this.maybePostMerge(); // after schema, so the ghost tables can render
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
  private async sendSchema(opts: { skipIfUnchanged?: boolean } = {}): Promise<void> {
    let payload: { schema: Schema; parseError: ParseError | null };
    try {
      const bytes = await vscode.workspace.fs.readFile(this.dbmlUri);
      const source = new TextDecoder('utf-8').decode(bytes);
      const result = parseDbml(source);
      if (result.error) {
        payload = { schema: this.lastValidSchema, parseError: result.error };
      } else {
        this.lastValidSchema = result.schema;
        payload = { schema: result.schema, parseError: null };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      payload = { schema: this.lastValidSchema, parseError: { message } };
    }
    const serialized = JSON.stringify(payload);
    if (opts.skipIfUnchanged && serialized === this.lastPostedSchema) return;
    this.lastPostedSchema = serialized;
    this.post({ type: 'schema:update', payload });
  }

  private scheduleSchemaRefresh(): void {
    if (this.schemaTimer) clearTimeout(this.schemaTimer);
    this.schemaTimer = setTimeout(() => {
      this.schemaTimer = null;
      void this.sendSchema({ skipIfUnchanged: true });
    }, SCHEMA_DEBOUNCE_MS);
  }

  private scheduleGitStatus(): void {
    if (this.gitStatusTimer) clearTimeout(this.gitStatusTimer);
    this.gitStatusTimer = setTimeout(() => {
      this.gitStatusTimer = null;
      void this.sendGitStatus();
    }, GIT_STATUS_DEBOUNCE_MS);
  }

  private async sendLayout(isExternal = false): Promise<void> {
    this.currentLayout = await this.loadFullLayout();
    this.post({
      type: isExternal ? 'layout:external-change' : 'layout:loaded',
      payload: this.currentLayout,
    });
  }

  /**
   * Reconstructs the full layout the webview expects from BOTH persistence
   * destinations: the git sidecar (shared design) + the local view-state file
   * (viewport / per-user hidden+collapsed). The webview never sees the split.
   */
  private async loadFullLayout(): Promise<Layout> {
    const shared = await this.loadSharedLayout();
    const vs = await readViewState(this.context, this.dbmlUri);
    return applyViewState(shared, vs);
  }

  /**
   * Reads the shared sidecar. On unresolved git conflict markers, runs the
   * in-extension 3-way merge (reads git stages 1/2/3, QuickPick for true conflicts)
   * instead of silently wiping. If even that fails (e.g. not a git repo), keeps the
   * last good in-memory layout rather than losing positions.
   */
  private async loadSharedLayout(): Promise<Layout> {
    try {
      const layout = await readLayout(this.dbmlUri);
      this.pendingMerge = null; // a clean read clears any stale conflict state
      return layout;
    } catch (err) {
      if (err instanceof LayoutConflictError) {
        return this.handleConflict();
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
      void vscode.window.showWarningMessage(
        'dddbml: could not read the layout conflict from git — resolve the markers manually, then reopen the diagram.',
      );
      return this.currentLayout;
    }
    const { merged, conflicts, repoRoot, relpath } = detected;
    if (conflicts.length === 0) {
      const serialized = await writeSharedLayout(this.dbmlUri, merged);
      this.lastWrittenSerialized = serialized;
      try { await gitAdd(repoRoot, relpath); } catch { /* staging is best-effort */ }
      this.pendingMerge = null;
      void vscode.window.showInformationMessage(
        `dddbml: layout auto-merged cleanly — ${countKeys(merged)} item(s), no conflicts.`,
      );
      return merged;
    }
    this.pendingMerge = { conflicts, merged, repoRoot, relpath };
    return merged;
  }

  /** Post the conflict set to the webview (schema must already be up so ghosts can render). Skips a
   *  re-post when the conflict set is unchanged, so a double-firing watcher doesn't wipe decisions. */
  private maybePostMerge(): void {
    if (!this.pendingMerge) { this.lastPostedMergeSig = null; return; }
    const conflicts = toSerializableConflicts(this.pendingMerge.conflicts);
    const sig = conflicts.map((c) => c.id).join('|');
    if (sig === this.lastPostedMergeSig) return; // identical set already on screen — keep the user's picks
    if (this.lastPostedMergeSig !== null) {
      void vscode.window.showWarningMessage('dddbml: the layout changed on disk — the conflict list was refreshed.');
    }
    this.lastPostedMergeSig = sig;
    this.post({ type: 'merge:begin', payload: { conflicts } });
  }

  /** The webview resolved the conflicts: apply decisions, write the clean sidecar, stage, refresh, exit. */
  private async resolveMerge(decisions: Record<string, 'ours' | 'theirs'>): Promise<void> {
    const pending = this.pendingMerge;
    if (!pending || this.mergeResolving) return; // ignore concurrent Apply clicks
    this.mergeResolving = true;
    try {
      const resolved = applyDecisions(pending.merged, pending.conflicts, decisions);
      try {
        const serialized = await writeSharedLayout(this.dbmlUri, resolved);
        this.lastWrittenSerialized = serialized;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`dddbml: failed to write resolved layout — ${message}`);
        // Re-post the conflicts so the webview leaves its "Applying…" state and can retry; the file
        // still has its markers and pendingMerge is intact.
        this.post({ type: 'merge:begin', payload: { conflicts: toSerializableConflicts(pending.conflicts) } });
        return;
      }
      try { await gitAdd(pending.repoRoot, pending.relpath); } catch { /* staging is best-effort */ }
      this.pendingMerge = null;
      this.lastPostedMergeSig = null;
      const chosen = pending.conflicts.length;
      const auto = countKeys(resolved) - chosen;
      const vs = await readViewState(this.context, this.dbmlUri);
      this.currentLayout = applyViewState(resolved, vs);
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
   * Re-read the diagram from disk after a git op rewrote the working tree (restore / stash / pop).
   * Resets the write-dedup guard so the change isn't suppressed, then refreshes schema + layout +
   * git status; routes any conflict markers (e.g. from a stash pop) into the merge resolver.
   */
  private async reloadFromDisk(): Promise<void> {
    this.lastWrittenSerialized = null;
    await this.sendSchema();
    await this.sendLayout(true);
    this.maybePostMerge();
    await this.sendGitStatus();
  }

  private postOpResult(op: GitOp, ok: boolean, message?: string): void {
    this.post({ type: 'git:opResult', payload: { op, ok, message } });
  }

  /** Discard uncommitted changes to the diagram files (restore to HEAD). DESTRUCTIVE — the webview
   *  already confirmed. Untracked files have no HEAD version, so they're left as-is. */
  private async handleGitRestore(): Promise<void> {
    const scope = await this.diagramScope();
    if (!scope) { this.postOpResult('restore', false, 'Not a git repository'); return; }
    const restorable = (await gitStatusPorcelain(scope.repoRoot, scope.relpaths))
      .filter((f) => f.status !== 'untracked')
      .map((f) => f.relpath);
    if (restorable.length === 0) { this.postOpResult('restore', false, 'No tracked changes to revert'); return; }
    try {
      await gitRestore(scope.repoRoot, restorable);
      await this.reloadFromDisk();
      this.postOpResult('restore', true);
      void vscode.window.showInformationMessage(`dddbml: reverted ${restorable.length} diagram file(s) to HEAD.`);
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
    try {
      if (op === 'stashApply') await gitStashApply(scope.repoRoot, ref);
      else await gitStashPop(scope.repoRoot, ref);
      await this.reloadFromDisk();
      await this.sendStashes();
      this.postOpResult(op, true);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.postOpResult(op, false, m);
      void vscode.window.showErrorMessage(`dddbml: stash ${op === 'stashPop' ? 'pop' : 'apply'} failed — ${m}`);
    }
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
   * read-only overlay; `exitTimeTravel` restores the working view.
   */
  private async enterTimeTravel(sha: string, label: string): Promise<void> {
    const scope = await this.diagramScope();
    if (!scope) return; // not a repo — the UI gates this, so just ignore
    const dbmlSrc = await showBlob(scope.repoRoot, sha, scope.dbmlRel);
    if (dbmlSrc == null) {
      void vscode.window.showWarningMessage('dddbml: could not read that revision of the diagram.');
      return;
    }
    const parsed = parseDbml(dbmlSrc);
    const schema = parsed.error ? this.lastValidSchema : parsed.schema;
    const sidecarSrc = await showBlob(scope.repoRoot, sha, scope.sidecarRel);
    const shared = sidecarSrc != null ? parseLayout(sidecarSrc) : emptyLayout();
    const vs = await readViewState(this.context, this.dbmlUri);
    const layout = applyViewState(shared, vs);
    this.post({ type: 'git:timeTravel:enter', payload: { rev: sha, label, schema, layout } });
  }

  /** Leave time-travel: flip the webview out of read-only mode, then re-send the working state. */
  private async exitTimeTravel(): Promise<void> {
    this.post({ type: 'git:timeTravel:exit' });
    await this.sendSchema();
    await this.sendLayout();
  }

  /**
   * Diff the working tree against HEAD (spec 16, Phase 4) and post the structural delta. The webview
   * keeps showing its current (working) schema and overlays the diff — added/modified tables get a
   * border + per-column tints; removed tables/refs render as ghosts placed from HEAD's sidecar. The
   * diff is computed in the host (parse HEAD via `git show`) off the render path.
   */
  private async enterDiff(): Promise<void> {
    const scope = await this.diagramScope();
    if (!scope) { void vscode.window.showWarningMessage('dddbml: not a git repository.'); return; }
    const baseDbml = await showBlob(scope.repoRoot, 'HEAD', scope.dbmlRel);
    if (baseDbml == null) { void vscode.window.showWarningMessage('dddbml: the diagram has no committed version at HEAD yet.'); return; }
    const parsedBase = parseDbml(baseDbml);
    const baseSchema = parsedBase.error ? { tables: [], refs: [], groups: [] } : parsedBase.schema;
    const diff = diffSchemas(baseSchema, this.lastValidSchema);
    if (diff.tables.length === 0 && diff.refs.length === 0) {
      void vscode.window.showInformationMessage('dddbml: no schema changes vs HEAD.');
      return;
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
    this.post({ type: 'git:diff:enter', payload: { baseLabel: 'HEAD', headLabel: 'working', diff } });
  }

  private onLayoutPersist(payload: Partial<Layout>): void {
    const merged = mergeLayout(this.currentLayout, payload);
    this.currentLayout = merged;
    this.pendingPersist = merged;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const next = this.pendingPersist;
      this.pendingPersist = null;
      if (next) void this.flushPersist(next);
    }, PERSIST_DEBOUNCE_MS);
  }

  private async flushPersist(layout: Layout): Promise<void> {
    // Git sidecar: shared design only. Skip the write when the shared form is unchanged
    // so pure pan/zoom (view-state only) never churns the tracked file.
    let sharedChanged = false;
    try {
      const sharedSerialized = serializeSharedLayout(layout);
      if (sharedSerialized !== this.lastWrittenSerialized) {
        await writeSharedLayout(this.dbmlUri, layout);
        this.lastWrittenSerialized = sharedSerialized;
        sharedChanged = true;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`dddbml: failed to write layout file — ${message}`);
    }
    // Local view-state: never tracked by git, so failures here are non-fatal.
    try {
      await writeViewState(this.context, this.dbmlUri, extractViewState(layout));
    } catch (err) {
      console.error('[dddbml] failed to write view-state', err);
    }
    // Only a real shared-layout write flips the sidecar dirty/clean — refresh the Git panel's status
    // then (NOT on pure pan/zoom, which would spawn `git status` on every frame's debounced flush).
    if (sharedChanged) this.scheduleGitStatus();
  }

  private setupWatchers(): void {
    const parentUri = vscode.Uri.joinPath(this.dbmlUri, '..');
    const dbmlName = this.shortName(this.dbmlUri);
    const layoutSidecar = sidecarUri(this.dbmlUri);
    const layoutName = this.shortName(layoutSidecar);

    const dbmlWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(parentUri, dbmlName),
    );
    dbmlWatcher.onDidChange((uri) => {
      if (uri.toString() !== this.dbmlUri.toString()) return;
      this.scheduleSchemaRefresh();
      this.scheduleGitStatus();
    });

    const layoutWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(parentUri, layoutName),
    );
    const onLayoutFs = async (uri: vscode.Uri) => {
      if (uri.toString() !== layoutSidecar.toString()) return;
      this.scheduleGitStatus(); // sidecar touched on disk → dirty/clean may have flipped
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = new TextDecoder('utf-8').decode(bytes);
        if (this.lastWrittenSerialized !== null && text === this.lastWrittenSerialized) return;
      } catch {
        return;
      }
      await this.sendLayout(true);
      this.maybePostMerge(); // external pull/merge may have introduced conflicts
    };
    layoutWatcher.onDidChange(onLayoutFs);
    layoutWatcher.onDidCreate(onLayoutFs);

    this.disposables.push(dbmlWatcher, layoutWatcher);
  }

  private currentThemeKind(): 'light' | 'dark' {
    return vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast
      ? 'dark'
      : 'light';
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

function splitQualified(qn: string): [string, string] {
  const idx = qn.indexOf('.');
  if (idx < 0) return ['public', qn];
  return [qn.slice(0, idx), qn.slice(idx + 1)];
}

function filterSchemaBySelection(schema: Schema, selection: Set<QualifiedName>): Schema {
  const tables = schema.tables.filter((t) => selection.has(t.name));
  const refs: Ref[] = schema.refs.filter(
    (r) => selection.has(r.source.table) && selection.has(r.target.table),
  );
  const groups = schema.groups
    .map((g) => ({ ...g, tables: g.tables.filter((t) => selection.has(t)) }))
    .filter((g) => g.tables.length > 0);
  return { tables, refs, groups };
}
