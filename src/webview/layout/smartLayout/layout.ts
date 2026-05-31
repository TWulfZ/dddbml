import * as dagre from '@dagrejs/dagre';
import type { QualifiedName, Ref, Table, TableGroup } from '../../../shared/types';
import { columnCenterY, type NodeSize } from '../autoLayout';
import { classify, type TableMeta } from './classify';
import { buildClusters, type Cluster } from './cluster';

export type Orientation = 'TB' | 'LR';
export type SmartLayoutMode = 'all' | 'new' | 'selection';

export interface SmartLayoutInput {
  tables: Table[];
  refs: Ref[];
  groups: TableGroup[];
  sizeOf: (name: QualifiedName) => NodeSize;
  mode?: SmartLayoutMode;
  /** Tables that must NOT move. For mode='new', defaults to everything in `existing`. For 'selection', defaults to everything except the selected set. */
  fixed?: Set<QualifiedName>;
  /** Current positions, used for anchoring/obstacle avoidance in incremental modes. */
  existing?: Map<QualifiedName, { x: number; y: number }>;
  /** For mode='selection' — the tables allowed to move. */
  selection?: Set<QualifiedName>;
  orientation?: Orientation | 'auto';
  /**
   * Density multiplier for all separations/margins (user-configurable "spacing").
   * 1 = default. <1 packs tighter (closer to ELK compound density), >1 spreads out.
   * Clamped to [SPACING_MIN, SPACING_MAX].
   */
  spacing?: number;
}

// Base separations at spacing = 1. Scaled by the spacing factor in `computeSeps`.
const BASE_INTRA_NODESEP = 32;
const BASE_INTRA_RANKSEP = 64;
const BASE_INTER_NODESEP = 96;
const BASE_INTER_RANKSEP = 128;
const BASE_CLUSTER_MARGIN = 48;
const BASE_MIN_GAP = 16;

export const SPACING_MIN = 0.4;
export const SPACING_MAX = 2.5;
export const SPACING_DEFAULT = 1;

const COLUMN_ALIGN_PASSES = 3;
const COLUMN_ALIGN_FACTOR = 0.3;
const INCREMENTAL_STEP = 64;

// Min gap between cluster boxes after compaction (scaled by spacing). Smaller than dagre's
// inter-cluster separation on purpose — compaction's job is to close that excess.
const BASE_CLUSTER_GAP = 56;

// Compaction rounds (each = one X pass + one Y pass). Two converges for the few-cluster case;
// it's a constant, deterministic.
const COMPACT_ROUNDS = 2;

/** Scaled, integer separations for one layout run (git-friendly integer coords downstream). */
interface Seps {
  intraNode: number;
  intraRank: number;
  interNode: number;
  interRank: number;
  clusterMargin: number;
  clusterGap: number;
  minGap: number;
}

function computeSeps(spacing: number | undefined): Seps {
  const s = Math.min(SPACING_MAX, Math.max(SPACING_MIN, spacing ?? SPACING_DEFAULT));
  return {
    intraNode: Math.round(BASE_INTRA_NODESEP * s),
    intraRank: Math.round(BASE_INTRA_RANKSEP * s),
    interNode: Math.round(BASE_INTER_NODESEP * s),
    interRank: Math.round(BASE_INTER_RANKSEP * s),
    clusterMargin: Math.round(BASE_CLUSTER_MARGIN * s),
    clusterGap: Math.round(BASE_CLUSTER_GAP * s),
    minGap: Math.round(BASE_MIN_GAP * s),
  };
}

/** dagre's laid-out node shape (center x/y + size). `@dagrejs/dagre@3` doesn't export a `Node` type. */
interface DagreNode {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ClusterLayout {
  positions: Map<QualifiedName, { x: number; y: number }>;
  bbox: { w: number; h: number };
}

interface Analysis {
  meta: Map<QualifiedName, TableMeta>;
  clusters: Cluster[];
}

/**
 * DB-aware table layout. The geometry engine is **dagre** (already in the bundle), used in two
 * levels: an inner dagre per cluster (`layoutClusterLocal`) and an outer dagre over the clusters as
 * meta-nodes (`layoutMeta`). Aggregate clusters (hub + satellites) use a dedicated radial placement.
 * The DB brain (classify/cluster) is engine-agnostic.
 *
 * Replaced an earlier ELK compound engine: elkjs was ~468kb gz (~71% of the webview bundle) for only
 * ~10% extra compactness over this two-level dagre on grouped schemas — not worth the weight. dagre
 * is already bundled (flat-fallback `autoLayout`), so this adds zero bundle. Density vs ELK is a
 * constant factor in the separations, exposed to the user as `spacing`. (See specs/13, specs/07.)
 *
 * Synchronous — dagre is sync.
 */
export function smartLayout(
  input: SmartLayoutInput,
): Map<QualifiedName, { x: number; y: number }> {
  const mode: SmartLayoutMode = input.mode ?? 'all';
  const existing = input.existing ?? new Map<QualifiedName, { x: number; y: number }>();
  const selection = input.selection ?? new Set<QualifiedName>();
  const fixed = input.fixed ?? computeFixed(input.tables, mode, existing, selection);
  const orientation = resolveOrientation(input);
  const seps = computeSeps(input.spacing);

  const meta = classify(input.tables, input.refs);
  const clusters = buildClusters(input.tables, input.refs, input.groups, meta);
  const analysis: Analysis = { meta, clusters };

  const movable = new Set<QualifiedName>();
  for (const t of input.tables) if (!fixed.has(t.name)) movable.add(t.name);

  if (mode === 'all' || movable.size === input.tables.length) {
    return layoutAll(analysis, input, orientation, seps);
  }
  return layoutIncremental(analysis, input, orientation, movable, existing, seps);
}

function computeFixed(
  tables: Table[],
  mode: SmartLayoutMode,
  existing: Map<QualifiedName, { x: number; y: number }>,
  selection: Set<QualifiedName>,
): Set<QualifiedName> {
  const out = new Set<QualifiedName>();
  if (mode === 'new') {
    for (const t of tables) if (existing.has(t.name)) out.add(t.name);
  } else if (mode === 'selection') {
    for (const t of tables) if (!selection.has(t.name) && existing.has(t.name)) out.add(t.name);
  }
  return out;
}

/* ----- Orientation ----- */

function resolveOrientation(input: SmartLayoutInput): Orientation {
  if (input.orientation && input.orientation !== 'auto') return input.orientation;
  return detectOrientation(input.tables, input.refs);
}

function detectOrientation(tables: Table[], refs: Ref[]): Orientation {
  const parents = buildParentsMap(tables, refs);
  const longest = longestPath(tables.map((t) => t.name), parents);
  const threshold = Math.max(2, Math.ceil(Math.sqrt(tables.length)));
  return longest >= threshold ? 'TB' : 'LR';
}

function buildParentsMap(
  tables: Table[],
  refs: Ref[],
): Map<QualifiedName, Set<QualifiedName>> {
  const parents = new Map<QualifiedName, Set<QualifiedName>>();
  for (const t of tables) parents.set(t.name, new Set());
  for (const r of refs) {
    const { child, parent } = normalizeDirection(r);
    parents.get(child)?.add(parent);
  }
  return parents;
}

function normalizeDirection(r: Ref): { child: QualifiedName; parent: QualifiedName } {
  const sourceIsChild = r.source.relation === '*' || r.target.relation === '1';
  return sourceIsChild
    ? { child: r.source.table, parent: r.target.table }
    : { child: r.target.table, parent: r.source.table };
}

function longestPath(
  nodes: QualifiedName[],
  parents: Map<QualifiedName, Set<QualifiedName>>,
): number {
  const memo = new Map<QualifiedName, number>();
  const visiting = new Set<QualifiedName>();
  const dfs = (n: QualifiedName): number => {
    const cached = memo.get(n);
    if (cached !== undefined) return cached;
    if (visiting.has(n)) return 0;
    visiting.add(n);
    let best = 0;
    for (const p of parents.get(n) ?? []) best = Math.max(best, 1 + dfs(p));
    visiting.delete(n);
    memo.set(n, best);
    return best;
  };
  let longest = 0;
  for (const n of nodes) longest = Math.max(longest, dfs(n));
  return longest;
}

/* ----- All mode: two-level dagre (per-cluster + meta) ----- */

function layoutAll(
  analysis: Analysis,
  input: SmartLayoutInput,
  orientation: Orientation,
  seps: Seps,
): Map<QualifiedName, { x: number; y: number }> {
  // 1. Lay out each cluster locally (radial for aggregates, dagre otherwise).
  const clusterLayouts = new Map<string, ClusterLayout>();
  for (const c of analysis.clusters) {
    if (c.members.length === 0) continue;
    if (c.kind === 'aggregate' && c.anchor) {
      clusterLayouts.set(c.id, radialPlace(c, input, analysis.meta, seps));
    } else {
      clusterLayouts.set(c.id, layoutClusterLocal(c, input, orientation, seps));
    }
  }

  // 2. Place the clusters relative to each other (outer dagre over meta-nodes).
  const origins = layoutMeta(analysis.clusters, input.refs, clusterLayouts, orientation, seps);

  // 2b. Compact the cluster boxes (remove dead inter-cluster whitespace dagre leaves) WITHOUT
  //     changing their relative order or introducing overlaps. This is what recovers the density
  //     ELK's compound packer had; the `spacing` factor rides on top via `seps.clusterGap`.
  compactClusters(origins, clusterLayouts, seps.clusterGap);

  // 3. Flatten cluster-local coords to world coords.
  const positions = new Map<QualifiedName, { x: number; y: number }>();
  for (const c of analysis.clusters) {
    const cl = clusterLayouts.get(c.id);
    if (!cl) continue;
    const origin = origins.get(c.id) ?? { x: 0, y: 0 };
    for (const [name, pos] of cl.positions) {
      positions.set(name, { x: origin.x + pos.x, y: origin.y + pos.y });
    }
  }
  // Defensive: any table not placed (shouldn't happen) is parked at origin; collisionGuard separates it.
  for (const t of input.tables) if (!positions.has(t.name)) positions.set(t.name, { x: 0, y: 0 });

  columnAlignPass(positions, input, null, analysis.meta);
  resolveCollisions(positions, input.sizeOf, null, seps);
  return roundPositions(positions);
}

/** Inner dagre layout of one cluster, normalized to a 0-origin bbox. */
function layoutClusterLocal(
  cluster: Cluster,
  input: SmartLayoutInput,
  globalOrientation: Orientation,
  seps: Seps,
): ClusterLayout {
  if (cluster.members.length === 0) {
    return { positions: new Map(), bbox: { w: 0, h: 0 } };
  }
  if (cluster.members.length === 1) {
    const only = cluster.members[0]!;
    const size = input.sizeOf(only);
    return {
      positions: new Map([[only, { x: 0, y: 0 }]]),
      bbox: { w: size.width, h: size.height },
    };
  }

  const memberSet = new Set(cluster.members);
  const internalRefs = input.refs.filter(
    (r) => memberSet.has(r.source.table) && memberSet.has(r.target.table),
  );

  const orient = pickClusterOrientation(cluster, internalRefs, globalOrientation);

  const g = new dagre.graphlib.Graph({ multigraph: true, compound: false });
  g.setGraph({
    rankdir: orient,
    nodesep: seps.intraNode,
    ranksep: seps.intraRank,
    marginx: 0,
    marginy: 0,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const m of cluster.members) {
    const size = input.sizeOf(m);
    g.setNode(m, { width: size.width, height: size.height });
  }

  for (const r of internalRefs) {
    const { child, parent } = normalizeDirection(r);
    if (!g.hasNode(child) || !g.hasNode(parent)) continue;
    g.setEdge(child, parent, { weight: 1 }, r.id);
  }

  dagre.layout(g);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const raw = new Map<QualifiedName, { x: number; y: number }>();
  for (const m of cluster.members) {
    const n = g.node(m) as DagreNode | undefined;
    if (!n || typeof n.x !== 'number' || typeof n.y !== 'number') continue;
    const x = n.x - n.width / 2;
    const y = n.y - n.height / 2;
    raw.set(m, { x, y });
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + n.width > maxX) maxX = x + n.width;
    if (y + n.height > maxY) maxY = y + n.height;
  }
  if (!Number.isFinite(minX)) {
    return { positions: raw, bbox: { w: 0, h: 0 } };
  }

  const positions = new Map<QualifiedName, { x: number; y: number }>();
  for (const [k, v] of raw) positions.set(k, { x: v.x - minX, y: v.y - minY });

  return {
    positions,
    bbox: { w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) },
  };
}

/** Per-cluster orientation: small clusters go LR; deep FK chains go TB; else inherit global. */
function pickClusterOrientation(
  cluster: Cluster,
  internalRefs: Ref[],
  global: Orientation,
): Orientation {
  if (cluster.members.length <= 3) return 'LR';
  const parents = new Map<QualifiedName, Set<QualifiedName>>();
  for (const m of cluster.members) parents.set(m, new Set());
  for (const r of internalRefs) {
    const { child, parent } = normalizeDirection(r);
    parents.get(child)?.add(parent);
  }
  const longest = longestPath(cluster.members, parents);
  const threshold = Math.ceil(Math.sqrt(cluster.members.length));
  if (longest >= threshold) return 'TB';
  return global;
}

/** Outer dagre over the clusters as meta-nodes (cluster bbox + margin), cross-cluster refs weighted. */
function layoutMeta(
  clusters: Cluster[],
  refs: Ref[],
  clusterLayouts: Map<string, ClusterLayout>,
  orientation: Orientation,
  seps: Seps,
): Map<string, { x: number; y: number }> {
  const memberToCluster = new Map<QualifiedName, string>();
  for (const c of clusters) for (const m of c.members) memberToCluster.set(m, c.id);

  const g = new dagre.graphlib.Graph({ multigraph: true, compound: false });
  g.setGraph({
    rankdir: orientation,
    nodesep: seps.interNode,
    ranksep: seps.interRank,
    marginx: 32,
    marginy: 32,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const c of clusters) {
    const cl = clusterLayouts.get(c.id);
    if (!cl) continue;
    g.setNode(c.id, {
      width: cl.bbox.w + seps.clusterMargin * 2,
      height: cl.bbox.h + seps.clusterMargin * 2,
    });
  }

  const pairWeight = new Map<string, number>();
  for (const r of refs) {
    const sc = memberToCluster.get(r.source.table);
    const tc = memberToCluster.get(r.target.table);
    if (!sc || !tc || sc === tc) continue;
    const { child, parent } = normalizeDirection(r);
    const from = memberToCluster.get(child);
    const to = memberToCluster.get(parent);
    if (!from || !to || from === to) continue;
    const key = `${from} ${to}`;
    pairWeight.set(key, (pairWeight.get(key) ?? 0) + 1);
  }
  for (const [key, weight] of pairWeight) {
    const [from, to] = key.split(' ');
    if (!from || !to) continue;
    g.setEdge(from, to, { weight });
  }

  dagre.layout(g);

  const origins = new Map<string, { x: number; y: number }>();
  for (const c of clusters) {
    const n = g.node(c.id) as DagreNode | undefined;
    if (!n || typeof n.x !== 'number' || typeof n.y !== 'number') continue;
    origins.set(c.id, {
      x: n.x - n.width / 2 + seps.clusterMargin,
      y: n.y - n.height / 2 + seps.clusterMargin,
    });
  }
  return origins;
}

/* ----- Cluster compaction (order-preserving, per-axis; topology-preserving) ----- */

interface CBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Close dead whitespace **between** clusters that dagre's meta-layout leaves, without reordering
 * clusters or introducing overlaps. Each laid-out cluster is treated as a rigid box; we push the
 * boxes toward the top-left, one axis at a time, gap-separated only against boxes they actually
 * shadow on the perpendicular axis. This is the standard order-preserving (visibility-graph)
 * compaction (cf. Dwyer & Marriott, "Topology-Preserving Constrained Graph Layout"; Graphviz `pack`
 * at cluster granularity) — it preserves the rank reading (a cluster left/above another stays so)
 * and the rigid intra-cluster layout, so the no-overlap + determinism invariants hold.
 *
 * Trade-off: a cluster with no shadow on an axis slides flush to that wall, which can lengthen a
 * cross-cluster edge. Accepted: structure + user-tunable `spacing`/`clusterGap` over max density.
 */
function compactClusters(
  origins: Map<string, { x: number; y: number }>,
  clusterLayouts: Map<string, ClusterLayout>,
  gap: number,
): void {
  const boxes: CBox[] = [];
  for (const [id, cl] of clusterLayouts) {
    const o = origins.get(id);
    if (!o || cl.bbox.w <= 0 || cl.bbox.h <= 0) continue;
    boxes.push({ id, x: o.x, y: o.y, w: cl.bbox.w, h: cl.bbox.h });
  }
  if (boxes.length <= 1) return;

  for (let round = 0; round < COMPACT_ROUNDS; round++) {
    compactAxis(boxes, gap, true); // horizontal: push left
    compactAxis(boxes, gap, false); // vertical: push up
  }

  for (const b of boxes) origins.set(b.id, { x: b.x, y: b.y });
}

/**
 * One greedy push toward the min wall along one axis. Boxes are processed in axis order (tie by id
 * for determinism); each box stops at the far edge (+gap) of the nearest already-placed box that
 * overlaps it on the *perpendicular* axis, or the wall. Preserves axis order; the perpendicular
 * coords are fixed during the pass, so the result is overlap-free for every shadowing pair.
 */
function compactAxis(boxes: CBox[], gap: number, horizontal: boolean): void {
  let wall = Infinity;
  for (const b of boxes) wall = Math.min(wall, horizontal ? b.x : b.y);
  if (!Number.isFinite(wall)) return;

  const order = [...boxes].sort((a, b) => {
    const d = horizontal ? a.x - b.x : a.y - b.y;
    if (d !== 0) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const placed: CBox[] = [];
  for (const b of order) {
    const bCrossStart = horizontal ? b.y : b.x;
    const bCrossEnd = bCrossStart + (horizontal ? b.h : b.w);
    let pos = wall;
    for (const p of placed) {
      const pCrossStart = horizontal ? p.y : p.x;
      const pCrossEnd = pCrossStart + (horizontal ? p.h : p.w);
      const crossOverlap = bCrossStart < pCrossEnd && pCrossStart < bCrossEnd;
      if (!crossOverlap) continue;
      const edge = (horizontal ? p.x + p.w : p.y + p.h) + gap;
      if (edge > pos) pos = edge;
    }
    if (horizontal) b.x = pos;
    else b.y = pos;
    placed.push(b);
  }
}

/* ----- Radial (star) placement for hub aggregate clusters ----- */

function radialPlace(
  cluster: Cluster,
  input: SmartLayoutInput,
  meta: Map<QualifiedName, TableMeta>,
  seps: Seps,
): ClusterLayout {
  const anchor = cluster.anchor!;
  const hub = input.sizeOf(anchor);
  const sats = cluster.members.filter((m) => m !== anchor);
  if (sats.length === 0) {
    return { positions: new Map([[anchor, { x: 0, y: 0 }]]), bbox: { w: hub.width, h: hub.height } };
  }

  // Deterministic ring order: by inDeg ascending, tie by name.
  sats.sort((a, b) => {
    const da = meta.get(a)?.inDeg ?? 0;
    const db = meta.get(b)?.inDeg ?? 0;
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });

  let maxSat = 0;
  for (const s of sats) {
    const sz = input.sizeOf(s);
    maxSat = Math.max(maxSat, sz.width, sz.height);
  }
  const sepRadius = (sats.length * (maxSat + seps.minGap)) / (2 * Math.PI);
  const minRadius = Math.max(hub.width, hub.height) / 2 + maxSat / 2 + seps.minGap * 2;
  const radius = Math.max(sepRadius, minRadius);

  // Hub center placed at the origin; we normalize to a 0-based bbox afterwards.
  const raw = new Map<QualifiedName, { cx: number; cy: number; w: number; h: number }>();
  raw.set(anchor, { cx: 0, cy: 0, w: hub.width, h: hub.height });
  const step = (2 * Math.PI) / sats.length;
  sats.forEach((s, i) => {
    const sz = input.sizeOf(s);
    const angle = -Math.PI / 2 + i * step;
    raw.set(s, { cx: radius * Math.cos(angle), cy: radius * Math.sin(angle), w: sz.width, h: sz.height });
  });

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of raw.values()) {
    const x = v.cx - v.w / 2;
    const y = v.cy - v.h / 2;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + v.w);
    maxY = Math.max(maxY, y + v.h);
  }

  const positions = new Map<QualifiedName, { x: number; y: number }>();
  for (const [k, v] of raw) {
    positions.set(k, { x: v.cx - v.w / 2 - minX, y: v.cy - v.h / 2 - minY });
  }
  return { positions, bbox: { w: maxX - minX, h: maxY - minY } };
}

/* ----- Column-aligned relaxation (deterministic) ----- */

function columnAlignPass(
  positions: Map<QualifiedName, { x: number; y: number }>,
  input: SmartLayoutInput,
  movableOrNull: Set<QualifiedName> | null,
  meta: Map<QualifiedName, TableMeta>,
): void {
  const tableByName = new Map<QualifiedName, Table>();
  for (const t of input.tables) tableByName.set(t.name, t);

  const isMovable = (name: QualifiedName): boolean =>
    movableOrNull === null ? true : movableOrNull.has(name);
  const degOf = (name: QualifiedName): number => meta.get(name)?.totalDeg ?? 0;

  // Density-correct row height (no fixed TABLE_ROW_H constant exists).
  const ROW_H = columnCenterY(1) - columnCenterY(0);
  const maxShift = ROW_H * 2;

  for (let pass = 0; pass < COLUMN_ALIGN_PASSES; pass++) {
    let any = false;
    for (const r of input.refs) {
      const src = tableByName.get(r.source.table);
      const tgt = tableByName.get(r.target.table);
      if (!src || !tgt) continue;
      const srcCol = r.source.columns[0];
      const tgtCol = r.target.columns[0];
      if (!srcCol || !tgtCol) continue;
      const srcIdx = src.columns.findIndex((c) => c.name === srcCol);
      const tgtIdx = tgt.columns.findIndex((c) => c.name === tgtCol);
      if (srcIdx < 0 || tgtIdx < 0) continue;

      const srcPos = positions.get(src.name);
      const tgtPos = positions.get(tgt.name);
      if (!srcPos || !tgtPos) continue;

      const srcY = srcPos.y + columnCenterY(srcIdx);
      const tgtY = tgtPos.y + columnCenterY(tgtIdx);
      const delta = srcY - tgtY;
      if (Math.abs(delta) < 1) continue;

      const srcMovable = isMovable(src.name);
      const tgtMovable = isMovable(tgt.name);
      if (!srcMovable && !tgtMovable) continue;

      // Deterministic tie-break (git-friendly): move the lower-degree endpoint;
      // tie → the lexicographically smaller name.
      const moveSrc =
        srcMovable && (!tgtMovable || shouldMoveSrc(degOf(src.name), degOf(tgt.name), src.name, tgt.name));
      const target = moveSrc ? src.name : tgt.name;
      const pos = moveSrc ? srcPos : tgtPos;
      const sign = moveSrc ? -1 : 1;
      const shift = Math.max(-maxShift, Math.min(maxShift, sign * delta * COLUMN_ALIGN_FACTOR));
      positions.set(target, { x: pos.x, y: pos.y + shift });
      any = true;
    }
    if (!any) break;
  }
}

function shouldMoveSrc(srcDeg: number, tgtDeg: number, srcName: string, tgtName: string): boolean {
  if (srcDeg !== tgtDeg) return srcDeg < tgtDeg;
  return srcName < tgtName;
}

/* ----- Collision resolution (final safety net after nudges) ----- */

function resolveCollisions(
  positions: Map<QualifiedName, { x: number; y: number }>,
  sizeOf: (name: QualifiedName) => NodeSize,
  movableOrNull: Set<QualifiedName> | null,
  seps: Seps,
): void {
  const boxes = new Map<QualifiedName, Box>();
  for (const [name, pos] of positions) {
    const s = sizeOf(name);
    boxes.set(name, { x: pos.x, y: pos.y, w: s.width, h: s.height });
  }

  const names = [...positions.keys()];
  const MAX_ITER = 8;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    let moved = false;
    names.sort((a, b) => (boxes.get(a)?.x ?? 0) - (boxes.get(b)?.x ?? 0));
    for (let i = 0; i < names.length; i++) {
      const a = names[i]!;
      const A = boxes.get(a);
      if (!A) continue;
      for (let j = i + 1; j < names.length; j++) {
        const b = names[j]!;
        const B = boxes.get(b);
        if (!B) continue;
        if (B.x >= A.x + A.w + seps.minGap) break;
        if (!overlap(A, B)) continue;

        const aMovable = movableOrNull === null ? true : movableOrNull.has(a);
        const bMovable = movableOrNull === null ? true : movableOrNull.has(b);
        let moveName: QualifiedName | null = null;
        if (bMovable) moveName = b;
        else if (aMovable) moveName = a;
        else continue;

        const M = moveName === a ? A : B;
        const S = moveName === a ? B : A;
        const overlapX = Math.min(S.x + S.w, M.x + M.w) - Math.max(S.x, M.x);
        const overlapY = Math.min(S.y + S.h, M.y + M.h) - Math.max(S.y, M.y);
        if (overlapX < overlapY) {
          M.x = S.x + S.w + seps.minGap;
        } else {
          M.y = S.y + S.h + seps.minGap;
        }
        positions.set(moveName, { x: M.x, y: M.y });
        moved = true;
      }
    }
    if (!moved) break;
  }
}

function overlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/* ----- Incremental: lay out the movable subset, anchor to fixed FK-neighbors ----- */

function layoutIncremental(
  analysis: Analysis,
  input: SmartLayoutInput,
  orientation: Orientation,
  movable: Set<QualifiedName>,
  existing: Map<QualifiedName, { x: number; y: number }>,
  seps: Seps,
): Map<QualifiedName, { x: number; y: number }> {
  const positions = new Map<QualifiedName, { x: number; y: number }>();
  for (const [k, v] of existing) positions.set(k, { ...v });

  const obstacles: Box[] = [];
  for (const [name, pos] of existing) {
    if (!movable.has(name)) {
      const s = input.sizeOf(name);
      obstacles.push({ x: pos.x, y: pos.y, w: s.width, h: s.height });
    }
  }

  const movableByCluster = new Map<string, QualifiedName[]>();
  for (const c of analysis.clusters) {
    const ms = c.members.filter((m) => movable.has(m));
    if (ms.length > 0) movableByCluster.set(c.id, ms);
  }

  for (const [cid, members] of movableByCluster) {
    const cluster = analysis.clusters.find((c) => c.id === cid);
    if (!cluster) continue;

    const subCluster: Cluster = { ...cluster, members };
    const cl = layoutClusterLocal(subCluster, input, orientation, seps);

    const anchor = computeAnchor(members, input.refs, positions, obstacles);
    const placement = findFreeSpot(anchor, cl.bbox, obstacles);

    for (const [name, pos] of cl.positions) {
      positions.set(name, {
        x: placement.x + pos.x,
        y: placement.y + pos.y,
      });
    }
    obstacles.push({ x: placement.x, y: placement.y, w: cl.bbox.w, h: cl.bbox.h });
  }

  columnAlignPass(positions, input, movable, analysis.meta);
  resolveCollisions(positions, input.sizeOf, movable, seps);

  return roundPositions(positions);
}

function computeAnchor(
  members: QualifiedName[],
  refs: Ref[],
  positions: Map<QualifiedName, { x: number; y: number }>,
  obstacles: Box[],
): { x: number; y: number } {
  const memberSet = new Set(members);
  let sumX = 0;
  let sumY = 0;
  let n = 0;
  for (const r of refs) {
    const s = r.source.table;
    const t = r.target.table;
    if (memberSet.has(s) && !memberSet.has(t)) {
      const p = positions.get(t);
      if (p) { sumX += p.x; sumY += p.y; n++; }
    } else if (memberSet.has(t) && !memberSet.has(s)) {
      const p = positions.get(s);
      if (p) { sumX += p.x; sumY += p.y; n++; }
    }
  }
  if (n > 0) return { x: sumX / n, y: sumY / n };

  let maxX = 0;
  let minY = 0;
  let seen = false;
  for (const o of obstacles) {
    if (!seen) { maxX = o.x + o.w; minY = o.y; seen = true; continue; }
    if (o.x + o.w > maxX) maxX = o.x + o.w;
    if (o.y < minY) minY = o.y;
  }
  return { x: maxX + INCREMENTAL_STEP, y: minY };
}

function findFreeSpot(
  anchor: { x: number; y: number },
  size: { w: number; h: number },
  obstacles: Box[],
): { x: number; y: number } {
  let x = anchor.x;
  let y = anchor.y;
  for (let tries = 0; tries < 64; tries++) {
    const candidate: Box = { x, y, w: size.w, h: size.h };
    let hit = false;
    for (const o of obstacles) {
      if (overlap(candidate, o)) { hit = true; break; }
    }
    if (!hit) return { x, y };
    x += INCREMENTAL_STEP;
    if (tries % 10 === 9) { x = anchor.x; y += INCREMENTAL_STEP; }
  }
  return { x, y };
}

function roundPositions(
  positions: Map<QualifiedName, { x: number; y: number }>,
): Map<QualifiedName, { x: number; y: number }> {
  const out = new Map<QualifiedName, { x: number; y: number }>();
  for (const [k, v] of positions) out.set(k, { x: Math.round(v.x), y: Math.round(v.y) });
  return out;
}
