/**
 * Image export — generate a standalone SVG document from the STORE MODEL (tables,
 * columns, groups, edges), not from the live DOM. The render path is culled (only
 * on-screen tables are mounted; see specs/04 + app.tsx `visibleNames`), so
 * rasterizing `.ddd-world` can never capture the whole diagram — building from the
 * model can. See specs/17-export-image.md.
 *
 * Pure: no Preact, no DOM reads. Colors are CSS tokens/vars resolved to literals via
 * an injected `resolve` fn (the browser probe in `buildImageSvg`), so the emitted SVG
 * is self-contained and theme-independent. Geometry comes from `densityMetrics()` /
 * `estimateSize()` / `columnCenterY()` — the same layout source of truth the canvas
 * uses — and edge paths are lifted verbatim from `routeRefs()`.
 */
import type { EdgeLayout, QualifiedName, Ref, Schema, Table, UiDensity } from '../../shared/types';
import { densityMetrics } from '../layout/density';
import { columnCenterY, estimateSize } from '../layout/autoLayout';
import { routeRefs } from '../render/edgeRouter';
import type { Bbox } from '../render/spatialIndex';

const GROUP_PREFIX = '__group__:';

export type ExportScope = 'all' | 'view' | 'selection';

export interface ExportOptions {
  scope: ExportScope;
  background: boolean;
  filename: string;
  /** Visible region in WORLD coords — required for scope 'view'. */
  viewRect?: { x: number; y: number; w: number; h: number };
}

/** The slice of `app.tsx`'s `derived` memo the export needs (passed in as a prop). */
export interface ExportDerived {
  hiddenTables: Set<QualifiedName>;
  collapsedTables: Set<QualifiedName>;
  collapsedNodes: Array<{ name: string; x: number; y: number; w: number; h: number; color: string; count: number }>;
  containers: Array<{ name: string; x: number; y: number; w: number; h: number; color: string }>;
  effectiveRefs: Ref[];
}

/** A consistent snapshot of store state taken at export time. */
export interface ExportSource {
  schema: Schema;
  positions: Map<QualifiedName, { x: number; y: number }>;
  tableColors: Map<QualifiedName, string>;
  edgeLayouts: Map<string, EdgeLayout>;
  selection: Set<QualifiedName>;
  density: UiDensity;
  derived: ExportDerived;
}

interface ExportTable {
  x: number; y: number; w: number; h: number;
  schemaName: string; tableName: string;
  /** Raw accent color (table/group color) or null → default accent token. */
  accent: string | null;
  columns: Array<{ name: string; type: string; pk: boolean; notNull: boolean; unique: boolean }>;
}
interface ExportContainer { x: number; y: number; w: number; h: number; name: string; color: string }
interface ExportCollapsed { x: number; y: number; w: number; h: number; name: string; count: number; color: string }
interface ExportEdge {
  d: string;
  color: string | null;
  startMarker: string;
  endMarker: string;
  source: { x: number; y: number };
  target: { x: number; y: number };
}

export interface ExportModel {
  bounds: { x: number; y: number; w: number; h: number };
  background: boolean;
  density: UiDensity;
  tables: ExportTable[];
  containers: ExportContainer[];
  collapsed: ExportCollapsed[];
  edges: ExportEdge[];
}

/** Resolved literal colors for the chosen theme. Every field is a concrete color string. */
export interface ThemeTokens {
  canvas: string;
  surface: string;
  border: string;
  fg: string;
  fgMuted: string;
  accent: string;
  headerBg: string;
  edge: string;
}

const PADDING = 28;
const RADIUS = 6;
const STRIPE = 3;

const PAD_X: Record<UiDensity, number> = { compact: 6, cozy: 10, comfortable: 12 };
const TEXT_PX: Record<UiDensity, number> = { compact: 11, cozy: 12, comfortable: 13 };

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
const MONO = "ui-monospace, Menlo, Consolas, monospace";

function rectsIntersect(a: Bbox, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Pick the tables/groups/edges for the scope and compute the export bounds. Pure.
 */
export function buildExportModel(source: ExportSource, opts: ExportOptions): ExportModel | null {
  const { schema, positions, tableColors, edgeLayouts, selection, density, derived } = source;
  const m = densityMetrics(density);

  const tablesByName = new Map<QualifiedName, Table>();
  for (const t of schema.tables) tablesByName.set(t.name, t);

  // World position of every routable node (tables + collapsed group nodes).
  const posEff = new Map<QualifiedName, { x: number; y: number }>();
  for (const [k, v] of positions) posEff.set(k, v);
  for (const g of derived.collapsedNodes) posEff.set(GROUP_PREFIX + g.name, { x: g.x, y: g.y });

  const groupByName = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const g of derived.collapsedNodes) groupByName.set(g.name, { x: g.x, y: g.y, w: g.w, h: g.h });

  const bboxOf = (name: QualifiedName): Bbox | undefined => {
    if (name.startsWith(GROUP_PREFIX)) {
      const g = groupByName.get(name.slice(GROUP_PREFIX.length));
      return g ? { x: g.x, y: g.y, w: g.w, h: g.h } : undefined;
    }
    const pos = posEff.get(name);
    if (!pos) return undefined;
    const t = tablesByName.get(name);
    const size = estimateSize(t?.columns.length ?? 0);
    return { x: pos.x, y: pos.y, w: size.width, h: size.height };
  };
  const columnY = (table: QualifiedName, column: string): number | undefined => {
    const t = tablesByName.get(table);
    if (!t) return undefined;
    const idx = t.columns.findIndex((c) => c.name === column);
    return idx < 0 ? undefined : columnCenterY(idx);
  };

  // Candidate rendered tables (mirror app.tsx: not hidden, not collapsed, has a position).
  const rendered = schema.tables.filter(
    (t) => !derived.hiddenTables.has(t.name) && !derived.collapsedTables.has(t.name) && positions.has(t.name),
  );

  const view = opts.scope === 'view' ? opts.viewRect : undefined;
  const inView = (b: Bbox | { x: number; y: number; w: number; h: number }) => !view || rectsIntersect(b as Bbox, view);

  // Which nodes are included for the chosen scope.
  const includedTables = new Set<QualifiedName>();
  for (const t of rendered) {
    if (opts.scope === 'selection' && !selection.has(t.name)) continue;
    if (opts.scope === 'view') {
      const b = bboxOf(t.name);
      if (!b || !inView(b)) continue;
    }
    includedTables.add(t.name);
  }
  const includedGroups = new Set<string>();
  if (opts.scope !== 'selection') {
    for (const g of derived.collapsedNodes) {
      if (opts.scope === 'view' && !inView(g)) continue;
      includedGroups.add(g.name);
    }
  }

  const tables: ExportTable[] = [];
  for (const t of rendered) {
    if (!includedTables.has(t.name)) continue;
    const pos = positions.get(t.name)!;
    const size = estimateSize(t.columns.length);
    const groupColor = t.groupName ? colorOfGroup(derived, t.groupName) : undefined;
    const accent = tableColors.get(t.name) ?? groupColor ?? null;
    tables.push({
      x: pos.x, y: pos.y, w: size.width, h: size.height,
      schemaName: t.schemaName, tableName: t.tableName,
      accent,
      columns: t.columns.map((c) => ({
        name: c.name, type: c.type, pk: c.pk === true, notNull: c.notNull === true, unique: c.unique === true,
      })),
    });
  }

  const collapsed: ExportCollapsed[] = derived.collapsedNodes
    .filter((g) => includedGroups.has(g.name))
    .map((g) => ({ x: g.x, y: g.y, w: g.w, h: g.h, name: g.name, count: g.count, color: g.color }));

  const containers: ExportContainer[] = opts.scope === 'selection'
    ? []
    : derived.containers
        .filter((c) => inView(c))
        .map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h, name: c.name, color: c.color }));

  // Route every effective ref once (matches the live edge layer), then keep those whose endpoints
  // are part of the included set. `view` keeps any edge touching the region (clipped by the viewBox).
  const refById = new Map<string, Ref>();
  for (const r of derived.effectiveRefs) refById.set(r.id, r);
  const routes = routeRefs(derived.effectiveRefs, bboxOf, columnY, (id) => edgeLayouts.get(id));
  const present = (endpoint: QualifiedName): boolean =>
    endpoint.startsWith(GROUP_PREFIX) ? includedGroups.has(endpoint.slice(GROUP_PREFIX.length)) : includedTables.has(endpoint);

  const edges: ExportEdge[] = [];
  for (const route of routes) {
    const ref = refById.get(route.id);
    if (!ref) continue;
    const srcIn = present(ref.source.table);
    const tgtIn = present(ref.target.table);
    const keep = opts.scope === 'view' ? srcIn || tgtIn : srcIn && tgtIn;
    if (!keep) continue;
    edges.push({
      d: route.d,
      color: edgeLayouts.get(route.id)?.color ?? null,
      startMarker: ref.source.relation === '*' ? 'url(#ddd-mk-many-s)' : 'url(#ddd-mk-one-s)',
      endMarker: ref.target.relation === '*' ? 'url(#ddd-mk-many)' : 'url(#ddd-mk-one)',
      source: route.source,
      target: route.target,
    });
  }

  // Bounds.
  let bounds: { x: number; y: number; w: number; h: number };
  if (opts.scope === 'view' && view) {
    bounds = { x: Math.round(view.x), y: Math.round(view.y), w: Math.round(view.w), h: Math.round(view.h) };
  } else {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const grow = (x: number, y: number, w = 0, h = 0) => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    };
    for (const t of tables) grow(t.x, t.y, t.w, t.h);
    for (const c of collapsed) grow(c.x, c.y, c.w, c.h);
    for (const c of containers) grow(c.x, c.y, c.w, c.h);
    for (const e of edges) { grow(e.source.x, e.source.y); grow(e.target.x, e.target.y); }
    if (!Number.isFinite(minX)) return null; // nothing to export
    bounds = {
      x: Math.round(minX - PADDING),
      y: Math.round(minY - PADDING),
      w: Math.round(maxX - minX + PADDING * 2),
      h: Math.round(maxY - minY + PADDING * 2),
    };
  }

  if (bounds.w <= 0 || bounds.h <= 0) return null;
  return { bounds, background: opts.background, density, tables, containers, collapsed, edges };
}

function colorOfGroup(derived: ExportDerived, groupName: string): string | undefined {
  const c = derived.containers.find((g) => g.name === groupName) ?? derived.collapsedNodes.find((g) => g.name === groupName);
  return c?.color;
}

/* ----- SVG emission (pure given a ThemeTokens + color resolver) ----- */

const MARKERS = `<defs>` +
  `<marker id="ddd-mk-many" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto"><path d="M2,2 L10,6 L2,10 M10,2 L10,10" fill="none" stroke="currentColor" stroke-width="1.2"/></marker>` +
  `<marker id="ddd-mk-one" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto"><path d="M10,2 L10,10" fill="none" stroke="currentColor" stroke-width="1.4"/></marker>` +
  `<marker id="ddd-mk-many-s" viewBox="0 0 12 12" refX="1" refY="6" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto"><path d="M10,2 L2,6 L10,10 M2,2 L2,10" fill="none" stroke="currentColor" stroke-width="1.2"/></marker>` +
  `<marker id="ddd-mk-one-s" viewBox="0 0 12 12" refX="1" refY="6" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto"><path d="M2,2 L2,10" fill="none" stroke="currentColor" stroke-width="1.4"/></marker>` +
  `</defs>`;

/** Render the model to a standalone SVG string. `resolve` turns a CSS color/var into a literal. */
export function renderSvg(model: ExportModel, theme: ThemeTokens, resolve: (color: string) => string): { svg: string; width: number; height: number } {
  const { bounds } = model;
  const m = densityMetrics(model.density);
  const padX = PAD_X[model.density];
  const textPx = TEXT_PX[model.density];
  const out: string[] = [];

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.w}" height="${bounds.h}" ` +
    `viewBox="${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}" font-family="${FONT}">`,
  );
  out.push(MARKERS);

  if (model.background) {
    out.push(`<rect x="${bounds.x}" y="${bounds.y}" width="${bounds.w}" height="${bounds.h}" fill="${theme.canvas}"/>`);
  }

  // Group containers (behind everything).
  for (const c of model.containers) {
    const col = resolve(c.color);
    out.push(`<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="10" fill="none" stroke="${col}" stroke-width="2" stroke-dasharray="6 4"/>`);
    out.push(groupLabel(c.x + 16, c.y - 10, c.name, col));
  }

  // Edges.
  for (const e of model.edges) {
    const col = e.color ? resolve(e.color) : theme.edge;
    out.push(`<g style="color:${col}">`);
    out.push(`<path d="${e.d}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" marker-start="${e.startMarker}" marker-end="${e.endMarker}"/>`);
    out.push(`<circle cx="${e.source.x}" cy="${e.source.y}" r="3" fill="${col}"/>`);
    out.push(`<circle cx="${e.target.x}" cy="${e.target.y}" r="3" fill="${theme.surface}" stroke="${col}" stroke-width="1.5"/>`);
    out.push(`</g>`);
  }

  // Tables.
  for (const t of model.tables) {
    const accent = t.accent ? resolve(t.accent) : theme.accent;
    const headerBg = t.accent ? rgba(resolve(t.accent), 0.22) : theme.headerBg;
    const avail = t.w - padX * 2;
    out.push(`<g>`);
    // a) surface fill
    out.push(`<rect x="${t.x}" y="${t.y}" width="${t.w}" height="${t.h}" rx="${RADIUS}" fill="${theme.surface}"/>`);
    // b) header band (rounded top) + c) accent stripe + d) header divider
    out.push(`<path d="${roundedTopPath(t.x, t.y, t.w, m.headerHeight, RADIUS)}" fill="${headerBg}"/>`);
    out.push(`<path d="${roundedTopPath(t.x, t.y, t.w, STRIPE, STRIPE)}" fill="${accent}"/>`);
    out.push(`<line x1="${t.x}" y1="${t.y + m.headerHeight}" x2="${t.x + t.w}" y2="${t.y + m.headerHeight}" stroke="${theme.border}" stroke-width="1"/>`);
    // e) header title
    const titleY = t.y + m.headerHeight / 2;
    out.push(headerTitle(t.x + padX, titleY, t.schemaName, t.tableName, avail, textPx, theme));
    // f) column rows
    for (let i = 0; i < t.columns.length; i++) {
      const c = t.columns[i]!;
      const cy = t.y + columnCenterY(i);
      const nameColor = c.pk ? accent : theme.fg;
      const nameW = avail * 0.58;
      const name = truncate(c.name, nameW, textPx);
      out.push(
        `<text x="${t.x + padX}" y="${cy}" font-size="${textPx}" dominant-baseline="central" ` +
        `fill="${nameColor}"${c.pk ? ' font-weight="600"' : ''}>${esc(name)}</text>`,
      );
      const flags = (c.notNull ? ' NN' : '') + (c.unique ? ' U' : '');
      const typeText = truncate(c.type + flags, avail * 0.42, textPx - 1);
      out.push(
        `<text x="${t.x + t.w - padX}" y="${cy}" font-size="${textPx - 1}" text-anchor="end" ` +
        `dominant-baseline="central" font-family="${MONO}" fill="${theme.fgMuted}">${esc(typeText)}</text>`,
      );
    }
    // g) border on top
    out.push(`<rect x="${t.x}" y="${t.y}" width="${t.w}" height="${t.h}" rx="${RADIUS}" fill="none" stroke="${theme.border}" stroke-width="1"/>`);
    out.push(`</g>`);
  }

  // Collapsed group nodes.
  for (const g of model.collapsed) {
    const col = resolve(g.color);
    out.push(`<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="10" fill="${rgba(col, 0.18)}" stroke="${col}" stroke-width="2"/>`);
    const cx = g.x + g.w / 2;
    out.push(`<text x="${cx}" y="${g.y + g.h / 2 - 6}" font-size="13" font-weight="600" text-anchor="middle" dominant-baseline="central" fill="${col}">${esc(truncate(g.name, g.w - 24, 13))}</text>`);
    out.push(`<text x="${cx}" y="${g.y + g.h / 2 + 12}" font-size="11" text-anchor="middle" dominant-baseline="central" fill="${theme.fgMuted}">${g.count} tables</text>`);
  }

  out.push(`</svg>`);
  return { svg: out.join(''), width: bounds.w, height: bounds.h };
}

function headerTitle(x: number, y: number, schemaName: string, tableName: string, avail: number, fontPx: number, theme: ThemeTokens): string {
  const prefix = schemaName !== 'public' ? `${schemaName}.` : '';
  const full = truncate(prefix + tableName, avail, fontPx);
  // Keep the muted schema prefix only if it fully survived truncation.
  if (prefix && full.startsWith(prefix)) {
    const name = full.slice(prefix.length);
    return (
      `<text x="${x}" y="${y}" font-size="${fontPx}" dominant-baseline="central" font-weight="600">` +
      `<tspan fill="${theme.fgMuted}" font-weight="400">${esc(prefix)}</tspan>` +
      `<tspan fill="${theme.fg}">${esc(name)}</tspan></text>`
    );
  }
  return `<text x="${x}" y="${y}" font-size="${fontPx}" dominant-baseline="central" font-weight="600" fill="${theme.fg}">${esc(full)}</text>`;
}

function groupLabel(x: number, y: number, name: string, color: string): string {
  const fontPx = 11;
  const text = truncate(name, 240, fontPx);
  const w = Math.ceil(text.length * fontPx * 0.6) + 12;
  const h = 18;
  return (
    `<g>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${color}"/>` +
    `<text x="${x + w / 2}" y="${y + h / 2}" font-size="${fontPx}" font-weight="600" text-anchor="middle" dominant-baseline="central" fill="${contrastText(color)}">${esc(text)}</text>` +
    `</g>`
  );
}

/** Rounded-TOP rect path (square bottom) so a header/stripe matches the table's rounded corners. */
function roundedTopPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h, w / 2);
  return (
    `M${x},${y + rr}` +
    `Q${x},${y} ${x + rr},${y}` +
    `L${x + w - rr},${y}` +
    `Q${x + w},${y} ${x + w},${y + rr}` +
    `L${x + w},${y + h}` +
    `L${x},${y + h}Z`
  );
}

/** Truncate text to fit `maxW` px at `fontPx`, appending an ellipsis. Width is approximate. */
function truncate(text: string, maxW: number, fontPx: number): string {
  if (maxW <= 0) return '';
  const charW = fontPx * 0.58;
  const max = Math.floor(maxW / charW);
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  return text.slice(0, max - 1) + '…';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Parse a CSS `rgb(...)`/`rgba(...)`/`#hex` color into [r,g,b]; returns null if unrecognized. */
function parseRgb(c: string): [number, number, number] | null {
  const mm = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(c);
  if (mm) return [Number(mm[1]), Number(mm[2]), Number(mm[3])];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (hex) {
    const h = hex[1]!;
    const n = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
    return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
  }
  return null;
}

/** Apply alpha to a resolved color, returning an `rgba(...)`. Falls back to the input if unparsable. */
function rgba(color: string, alpha: number): string {
  const p = parseRgb(color);
  return p ? `rgba(${p[0]}, ${p[1]}, ${p[2]}, ${alpha})` : color;
}

/** Black or white text for legibility on `bg` (resolved color), via relative luminance. */
function contrastText(bg: string): string {
  const p = parseRgb(bg);
  if (!p) return '#ffffff';
  const lum = (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) / 255;
  return lum > 0.6 ? '#1a1a1a' : '#ffffff';
}

/* ----- Browser entry: resolve theme via a probe element, then build ----- */

/**
 * Build a standalone SVG for the current diagram + theme. Browser-only (reads
 * `getComputedStyle`). Returns null when the chosen scope has nothing to export.
 */
export function buildImageSvg(source: ExportSource, opts: ExportOptions): { svg: string; width: number; height: number } | null {
  const model = buildExportModel(source, opts);
  if (!model) return null;
  const probe = document.createElement('span');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  document.body.appendChild(probe);
  const cache = new Map<string, string>();
  const resolve = (expr: string): string => {
    const hit = cache.get(expr);
    if (hit) return hit;
    probe.style.color = '';
    probe.style.color = expr;
    const c = getComputedStyle(probe).color || '#888888';
    cache.set(expr, c);
    return c;
  };
  try {
    const theme: ThemeTokens = {
      canvas: resolve('var(--ddd-surface-canvas)'),
      surface: resolve('var(--ddd-surface-raised)'),
      border: resolve('var(--ddd-border)'),
      fg: resolve('var(--ddd-fg)'),
      fgMuted: resolve('var(--ddd-fg-muted)'),
      accent: resolve('var(--ddd-accent)'),
      headerBg: resolve('var(--vscode-titleBar-activeBackground, var(--ddd-surface-raised))'),
      edge: resolve('var(--ddd-edge)'),
    };
    return renderSvg(model, theme, resolve);
  } finally {
    probe.remove();
  }
}
