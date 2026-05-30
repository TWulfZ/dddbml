import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import type { GroupLayout, Layout, QualifiedName, TableLayout, ViewportLayout } from '../shared/types';

/**
 * Per-user, per-file VIEW STATE — never committed to git. Lives in the extension's
 * `globalStorageUri` (OS app-data), keyed by the `.dbml` file URI. Holds exactly the
 * fields that are personal and ephemeral: viewport (pan/zoom) and per-group /
 * per-table visibility. This is the half of the old layout sidecar that caused
 * guaranteed git conflicts on every commit; pulling it out of the repo is Tier 0.
 */
export interface ViewState {
  viewport: ViewportLayout;
  tables: Record<QualifiedName, { hidden?: boolean }>;
  groups: Record<string, { hidden?: boolean; collapsed?: boolean }>;
}

export function emptyViewState(): ViewState {
  return { viewport: { x: 0, y: 0, zoom: 1 }, tables: {}, groups: {} };
}

/** Pulls the view-state slice out of a full in-memory layout (for local persistence). */
export function extractViewState(layout: Layout): ViewState {
  const tables: ViewState['tables'] = {};
  for (const [k, v] of Object.entries(layout.tables)) {
    if (v.hidden) tables[k] = { hidden: true };
  }
  const groups: ViewState['groups'] = {};
  for (const [k, v] of Object.entries(layout.groups)) {
    const g: { hidden?: boolean; collapsed?: boolean } = {};
    if (v.hidden) g.hidden = true;
    if (v.collapsed) g.collapsed = true;
    if (g.hidden || g.collapsed) groups[k] = g;
  }
  return { viewport: layout.viewport, tables, groups };
}

/** Re-injects local view-state onto a shared (git) layout to reconstruct the full
 *  layout the webview expects. Group keys are unioned: a group may exist only for its
 *  shared color, only for a local hidden flag, or both. */
export function applyViewState(shared: Layout, vs: ViewState): Layout {
  const tables: Record<QualifiedName, TableLayout> = {};
  for (const [k, v] of Object.entries(shared.tables)) {
    tables[k] = vs.tables[k]?.hidden ? { ...v, hidden: true } : { ...v };
  }

  const groups: Record<string, GroupLayout> = {};
  const groupKeys = new Set([...Object.keys(shared.groups), ...Object.keys(vs.groups)]);
  for (const k of groupKeys) {
    const g: GroupLayout = { ...(shared.groups[k] ?? {}) };
    const view = vs.groups[k];
    if (view?.hidden) g.hidden = true;
    if (view?.collapsed) g.collapsed = true;
    groups[k] = g;
  }

  return { ...shared, viewport: vs.viewport, tables, groups };
}

function viewStateDir(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, 'view-state');
}

function viewStateFileUri(context: vscode.ExtensionContext, dbmlUri: vscode.Uri): vscode.Uri {
  const key = createHash('sha256').update(dbmlUri.toString()).digest('hex');
  return vscode.Uri.joinPath(viewStateDir(context), `${key}.json`);
}

export async function readViewState(
  context: vscode.ExtensionContext,
  dbmlUri: vscode.Uri,
): Promise<ViewState> {
  try {
    const bytes = await vscode.workspace.fs.readFile(viewStateFileUri(context, dbmlUri));
    return parseViewState(new TextDecoder('utf-8').decode(bytes));
  } catch {
    return emptyViewState();
  }
}

export async function writeViewState(
  context: vscode.ExtensionContext,
  dbmlUri: vscode.Uri,
  vs: ViewState,
): Promise<void> {
  const dir = viewStateDir(context);
  try { await vscode.workspace.fs.createDirectory(dir); } catch { /* already exists */ }
  const fileUri = viewStateFileUri(context, dbmlUri);
  const tmpUri = fileUri.with({ path: fileUri.path + '.tmp' });
  // Not git-tracked, so formatting is irrelevant — keep `source` for human debugging.
  const payload = JSON.stringify({ source: dbmlUri.toString(), ...vs }, null, 2);
  const bytes = new TextEncoder().encode(payload);
  await vscode.workspace.fs.writeFile(tmpUri, bytes);
  await vscode.workspace.fs.rename(tmpUri, fileUri, { overwrite: true });
}

function parseViewState(text: string): ViewState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyViewState();
  }
  if (!raw || typeof raw !== 'object') return emptyViewState();
  const r = raw as Record<string, unknown>;
  const vp = (r.viewport && typeof r.viewport === 'object') ? r.viewport as Record<string, unknown> : {};
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

  const tables: ViewState['tables'] = {};
  if (r.tables && typeof r.tables === 'object') {
    for (const [k, v] of Object.entries(r.tables as Record<string, unknown>)) {
      if (v && typeof v === 'object' && (v as Record<string, unknown>).hidden === true) tables[k] = { hidden: true };
    }
  }
  const groups: ViewState['groups'] = {};
  if (r.groups && typeof r.groups === 'object') {
    for (const [k, v] of Object.entries(r.groups as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const vv = v as Record<string, unknown>;
      const g: { hidden?: boolean; collapsed?: boolean } = {};
      if (vv.hidden === true) g.hidden = true;
      if (vv.collapsed === true) g.collapsed = true;
      if (g.hidden || g.collapsed) groups[k] = g;
    }
  }
  return {
    viewport: { x: num(vp.x, 0), y: num(vp.y, 0), zoom: num(vp.zoom, 1) },
    tables,
    groups,
  };
}
