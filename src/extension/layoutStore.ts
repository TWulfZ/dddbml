import * as vscode from 'vscode';
import type { EdgeLayout, Layout, GroupLayout, TableLayout } from '../shared/types';

export function sidecarUri(dbmlUri: vscode.Uri): vscode.Uri {
  return dbmlUri.with({ path: dbmlUri.path + '.layout.json' });
}

export function emptyLayout(): Layout {
  return { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, tables: {}, groups: {}, edges: {} };
}

export async function readLayout(dbmlUri: vscode.Uri): Promise<Layout> {
  const uri = sidecarUri(dbmlUri);
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder('utf-8').decode(bytes);
    return parseLayout(text);
  } catch {
    return emptyLayout();
  }
}

export async function writeLayout(dbmlUri: vscode.Uri, layout: Layout): Promise<string> {
  const layoutUri = sidecarUri(dbmlUri);
  const tmpUri = layoutUri.with({ path: layoutUri.path + '.tmp' });
  const serialized = serializeLayout(layout);
  const bytes = new TextEncoder().encode(serialized);
  await vscode.workspace.fs.writeFile(tmpUri, bytes);
  await vscode.workspace.fs.rename(tmpUri, layoutUri, { overwrite: true });
  return serialized;
}

export function parseLayout(text: string): Layout {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyLayout();
  }
  if (!raw || typeof raw !== 'object') return emptyLayout();
  const r = raw as Record<string, unknown>;
  const viewport = toViewport(r.viewport);
  const tables = toTables(r.tables);
  const groups = toGroups(r.groups);
  const edges = toEdges(r.edges);
  return { version: 1, viewport, tables, groups, edges };
}

function toEdges(raw: unknown): Record<string, EdgeLayout> {
  const out: Record<string, EdgeLayout> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const vv = v as Record<string, unknown>;
    const e: EdgeLayout = {};
    if (typeof vv.dx === 'number' && Number.isFinite(vv.dx)) e.dx = Math.round(vv.dx);
    if (typeof vv.dy === 'number' && Number.isFinite(vv.dy)) e.dy = Math.round(vv.dy);
    if (e.dx !== undefined || e.dy !== undefined) out[k] = e;
  }
  return out;
}

function toViewport(raw: unknown): Layout['viewport'] {
  if (!raw || typeof raw !== 'object') return { x: 0, y: 0, zoom: 1 };
  const r = raw as Record<string, unknown>;
  return {
    x: numeric(r.x, 0, true),
    y: numeric(r.y, 0, true),
    zoom: numeric(r.zoom, 1, false),
  };
}

function toTables(raw: unknown): Record<string, TableLayout> {
  const out: Record<string, TableLayout> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const vv = v as Record<string, unknown>;
    const entry: TableLayout = { x: numeric(vv.x, 0, true), y: numeric(vv.y, 0, true) };
    if (vv.hidden === true) entry.hidden = true;
    if (typeof vv.color === 'string' && vv.color.length > 0) entry.color = vv.color;
    out[k] = entry;
  }
  return out;
}

function toGroups(raw: unknown): Record<string, GroupLayout> {
  const out: Record<string, GroupLayout> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const vv = v as Record<string, unknown>;
    const g: GroupLayout = {};
    if (vv.collapsed === true) g.collapsed = true;
    if (vv.hidden === true) g.hidden = true;
    if (typeof vv.color === 'string') g.color = vv.color;
    out[k] = g;
  }
  return out;
}

function numeric(v: unknown, fallback: number, asInt: boolean): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return asInt ? Math.round(n) : Math.round(n * 1000) / 1000;
}

/**
 * Serializes layout to Git-friendly JSON:
 *   - keys sorted alphabetically (both levels)
 *   - 2-space indent
 *   - LF line endings
 *   - trailing newline
 *   - integer coords
 *   - default flags omitted (only write `collapsed: true` etc.)
 *   - compact object-on-one-line for leaves (tables/groups)
 */
export function serializeLayout(layout: Layout): string {
  const tableKeys = Object.keys(layout.tables).sort();
  const groupKeys = Object.keys(layout.groups).sort();

  const lines: string[] = [];
  lines.push('{');
  lines.push(`  "version": ${layout.version},`);
  const vp = layout.viewport;
  lines.push(`  "viewport": { "x": ${Math.round(vp.x)}, "y": ${Math.round(vp.y)}, "zoom": ${Math.round(vp.zoom * 1000) / 1000} },`);

  lines.push('  "tables": {');
  tableKeys.forEach((k, i) => {
    const v = layout.tables[k]!;
    const comma = i < tableKeys.length - 1 ? ',' : '';
    const parts = [`"x": ${Math.round(v.x)}`, `"y": ${Math.round(v.y)}`];
    if (v.hidden) parts.push('"hidden": true');
    if (v.color) parts.push(`"color": ${JSON.stringify(v.color)}`);
    lines.push(`    ${JSON.stringify(k)}: { ${parts.join(', ')} }${comma}`);
  });
  lines.push('  },');

  lines.push('  "groups": {');
  groupKeys.forEach((k, i) => {
    const v = layout.groups[k]!;
    const parts: string[] = [];
    if (v.collapsed) parts.push('"collapsed": true');
    if (v.hidden) parts.push('"hidden": true');
    if (v.color) parts.push(`"color": ${JSON.stringify(v.color)}`);
    const body = parts.length > 0 ? ` ${parts.join(', ')} ` : '';
    const comma = i < groupKeys.length - 1 ? ',' : '';
    lines.push(`    ${JSON.stringify(k)}: {${body}}${comma}`);
  });

  const edgeEntries = Object.entries(layout.edges ?? {}).filter(([, v]) => v.dx !== undefined || v.dy !== undefined);
  if (edgeEntries.length === 0) {
    lines.push('  },');
    lines.push('  "edges": {}');
  } else {
    lines.push('  },');
    lines.push('  "edges": {');
    edgeEntries.sort(([a], [b]) => a.localeCompare(b));
    edgeEntries.forEach(([k, v], i) => {
      const parts: string[] = [];
      if (v.dx !== undefined) parts.push(`"dx": ${Math.round(v.dx)}`);
      if (v.dy !== undefined) parts.push(`"dy": ${Math.round(v.dy)}`);
      const comma = i < edgeEntries.length - 1 ? ',' : '';
      lines.push(`    ${JSON.stringify(k)}: { ${parts.join(', ')} }${comma}`);
    });
    lines.push('  }');
  }

  lines.push('}');
  lines.push('');
  return lines.join('\n');
}
