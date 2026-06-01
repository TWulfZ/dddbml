import * as vscode from 'vscode';
import type { EdgeLayout, Layout, GroupLayout, TableLayout, Waypoint } from '../shared/types';
import { isEdgeSide } from '../shared/types';

export function sidecarUri(dbmlUri: vscode.Uri): vscode.Uri {
  return dbmlUri.with({ path: dbmlUri.path + '.layout.json' });
}

export function emptyLayout(): Layout {
  return { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, tables: {}, groups: {}, edges: {} };
}

/** Raised by `readLayout` when the sidecar still holds unresolved git conflict markers.
 *  Callers route this to the 3-way merge resolver instead of silently wiping the layout. */
export class LayoutConflictError extends Error {
  constructor(public readonly conflictedText: string) {
    super('dddbml: layout sidecar contains unresolved git conflict markers');
    this.name = 'LayoutConflictError';
  }
}

// `<<<<<<<`, `|||||||` (diff3 base), `=======`, `>>>>>>>` — never valid at the start of a JSON line.
const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7}|\|{7})/m;

export function hasConflictMarkers(text: string): boolean {
  return CONFLICT_MARKER_RE.test(text);
}

/**
 * Merges a `layout:persist` partial onto the current layout. The webview sends a partial; a key
 * it omits must keep its current value — never drop a sub-object. `edges` is included here on
 * purpose: leaving it out is what silently wiped persisted waypoints/colors/sides to `{}`.
 */
export function mergeLayout(current: Layout, payload: Partial<Layout>): Layout {
  return {
    version: 1,
    viewport: payload.viewport ?? current.viewport,
    tables: payload.tables ?? current.tables,
    groups: payload.groups ?? current.groups,
    edges: payload.edges ?? current.edges ?? {},
  };
}

export async function readLayout(dbmlUri: vscode.Uri): Promise<Layout> {
  const uri = sidecarUri(dbmlUri);
  let text: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    text = new TextDecoder('utf-8').decode(bytes);
  } catch {
    return emptyLayout(); // missing/unreadable sidecar → treat as empty
  }
  // Do NOT feed conflict-marker soup to JSON.parse: it throws and the old catch wiped the
  // layout to empty. Signal the conflict so the caller can run the 3-way merge instead.
  if (hasConflictMarkers(text)) throw new LayoutConflictError(text);
  return parseLayout(text);
}

/** Writes the Git-tracked sidecar. Always the SHARED form — per-user view-state
 *  (viewport, hidden/collapsed) lives in the local view-state file, never here. */
export async function writeSharedLayout(dbmlUri: vscode.Uri, layout: Layout): Promise<string> {
  const layoutUri = sidecarUri(dbmlUri);
  const tmpUri = layoutUri.with({ path: layoutUri.path + '.tmp' });
  const serialized = serializeSharedLayout(layout);
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
    if (Array.isArray(vv.waypoints)) {
      const wps: Waypoint[] = [];
      for (const item of vv.waypoints) {
        if (!item || typeof item !== 'object') continue;
        const w = item as Record<string, unknown>;
        if (typeof w.x !== 'number' || !Number.isFinite(w.x)) continue;
        if (typeof w.y !== 'number' || !Number.isFinite(w.y)) continue;
        wps.push({ x: Math.round(w.x), y: Math.round(w.y) });
      }
      if (wps.length > 0) e.waypoints = wps;
    }
    // Legacy fields: read for back-compat. Webview migrates to waypoints on next persist.
    if (typeof vv.dx === 'number' && Number.isFinite(vv.dx)) e.dx = Math.round(vv.dx);
    if (typeof vv.dy === 'number' && Number.isFinite(vv.dy)) e.dy = Math.round(vv.dy);
    if (typeof vv.color === 'string' && vv.color.length > 0) e.color = vv.color;
    if (isEdgeSide(vv.sourceSide)) e.sourceSide = vv.sourceSide;
    if (isEdgeSide(vv.targetSide)) e.targetSide = vv.targetSide;
    if (e.waypoints || e.color || e.sourceSide || e.targetSide || e.dx !== undefined || e.dy !== undefined) out[k] = e;
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
  return serializeLayoutImpl(layout, false);
}

/**
 * Git-tracked serialization: shared design ONLY. Omits all per-user view-state
 * (`viewport`, table `hidden`, group `collapsed`/`hidden`) and any group entry with
 * no `color`. The sidecar therefore never diffs on pan/zoom or personal show/hide —
 * it carries only what the team collaborates on (positions, colors, edge routing).
 */
export function serializeSharedLayout(layout: Layout): string {
  return serializeLayoutImpl(layout, true);
}

function serializeLayoutImpl(layout: Layout, shared: boolean): string {
  const tableKeys = Object.keys(layout.tables).sort();
  const groupKeys = (shared
    ? Object.keys(layout.groups).filter((k) => !!layout.groups[k]!.color)
    : Object.keys(layout.groups)
  ).sort();

  const lines: string[] = [];
  lines.push('{');
  lines.push(`  "version": ${layout.version},`);
  if (!shared) {
    const vp = layout.viewport;
    lines.push(`  "viewport": { "x": ${Math.round(vp.x)}, "y": ${Math.round(vp.y)}, "zoom": ${Math.round(vp.zoom * 1000) / 1000} },`);
  }

  lines.push('  "tables": {');
  tableKeys.forEach((k, i) => {
    const v = layout.tables[k]!;
    const comma = i < tableKeys.length - 1 ? ',' : '';
    const parts = [`"x": ${Math.round(v.x)}`, `"y": ${Math.round(v.y)}`];
    if (!shared && v.hidden) parts.push('"hidden": true');
    if (v.color) parts.push(`"color": ${JSON.stringify(v.color)}`);
    lines.push(`    ${JSON.stringify(k)}: { ${parts.join(', ')} }${comma}`);
  });
  lines.push('  },');

  lines.push('  "groups": {');
  groupKeys.forEach((k, i) => {
    const v = layout.groups[k]!;
    const parts: string[] = [];
    if (!shared && v.collapsed) parts.push('"collapsed": true');
    if (!shared && v.hidden) parts.push('"hidden": true');
    if (v.color) parts.push(`"color": ${JSON.stringify(v.color)}`);
    const body = parts.length > 0 ? ` ${parts.join(', ')} ` : '';
    const comma = i < groupKeys.length - 1 ? ',' : '';
    lines.push(`    ${JSON.stringify(k)}: {${body}}${comma}`);
  });

  const edgeEntries = Object.entries(layout.edges ?? {}).filter(([, v]) =>
    (v.waypoints && v.waypoints.length > 0) ||
    v.color !== undefined || v.sourceSide !== undefined || v.targetSide !== undefined ||
    v.dx !== undefined || v.dy !== undefined,
  );
  if (edgeEntries.length === 0) {
    lines.push('  },');
    lines.push('  "edges": {}');
  } else {
    lines.push('  },');
    lines.push('  "edges": {');
    edgeEntries.sort(([a], [b]) => a.localeCompare(b));
    edgeEntries.forEach(([k, v], i) => {
      const comma = i < edgeEntries.length - 1 ? ',' : '';
      const hasWaypoints = !!(v.waypoints && v.waypoints.length > 0);
      // Scalar fields in deterministic key order. Waypoints prevail over legacy dx/dy.
      const scalars: string[] = [];
      if (v.color) scalars.push(`"color": ${JSON.stringify(v.color)}`);
      if (v.sourceSide) scalars.push(`"sourceSide": ${JSON.stringify(v.sourceSide)}`);
      if (v.targetSide) scalars.push(`"targetSide": ${JSON.stringify(v.targetSide)}`);
      if (!hasWaypoints) {
        if (v.dx !== undefined) scalars.push(`"dx": ${Math.round(v.dx)}`);
        if (v.dy !== undefined) scalars.push(`"dy": ${Math.round(v.dy)}`);
      }
      if (hasWaypoints) {
        lines.push(`    ${JSON.stringify(k)}: {`);
        for (const part of scalars) lines.push(`      ${part},`);
        lines.push('      "waypoints": [');
        v.waypoints!.forEach((w, j) => {
          const wc = j < v.waypoints!.length - 1 ? ',' : '';
          lines.push(`        { "x": ${Math.round(w.x)}, "y": ${Math.round(w.y)} }${wc}`);
        });
        lines.push('      ]');
        lines.push(`    }${comma}`);
      } else {
        lines.push(`    ${JSON.stringify(k)}: { ${scalars.join(', ')} }${comma}`);
      }
    });
    lines.push('  }');
  }

  lines.push('}');
  lines.push('');
  return lines.join('\n');
}
