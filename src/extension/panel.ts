import * as vscode from 'vscode';
import type { ExportCommandPayload } from '../shared/exporters/types';
import type { AutoArrangeMode, FlatSettingsPatch, HostToWebview, Layout, Ref, ViewportCommand, WebviewToHost, Schema, QualifiedName } from '../shared/types';
import { parseDbml } from './parser';
import { emptyLayout, LayoutConflictError, mergeLayout, readLayout, serializeSharedLayout, sidecarUri, writeSharedLayout } from './layoutStore';
import { applyViewState, extractViewState, readViewState, writeViewState } from './viewStateStore';
import { applyDecisions, countKeys, detectSidecarConflict, toSerializableConflicts } from './mergeResolver';
import type { MergeConflict } from './mergeThreeWay';
import { gitAdd } from './gitStages';
import { getExporter, listExporters } from './exporters';
import { applySettingsPatch, loadSettings, onSettingsChange } from './settings';

const PERSIST_DEBOUNCE_MS = 200;

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
  private pendingPersist: Layout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
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
    this.post({ type: 'export:prompt' });
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
      case 'settings:update':
        void applySettingsPatch(msg.payload as Partial<FlatSettingsPatch>);
        return;
      case 'merge:resolve':
        void this.resolveMerge(msg.payload.decisions);
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
  }

  private async sendSchema(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.dbmlUri);
      const source = new TextDecoder('utf-8').decode(bytes);
      const result = parseDbml(source);
      if (result.error) {
        this.post({
          type: 'schema:update',
          payload: { schema: this.lastValidSchema, parseError: result.error },
        });
      } else {
        this.lastValidSchema = result.schema;
        this.post({
          type: 'schema:update',
          payload: { schema: result.schema, parseError: null },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({
        type: 'schema:update',
        payload: { schema: this.lastValidSchema, parseError: { message } },
      });
    }
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
    try {
      const sharedSerialized = serializeSharedLayout(layout);
      if (sharedSerialized !== this.lastWrittenSerialized) {
        await writeSharedLayout(this.dbmlUri, layout);
        this.lastWrittenSerialized = sharedSerialized;
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
      if (uri.toString() === this.dbmlUri.toString()) void this.sendSchema();
    });

    const layoutWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(parentUri, layoutName),
    );
    const onLayoutFs = async (uri: vscode.Uri) => {
      if (uri.toString() !== layoutSidecar.toString()) return;
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
