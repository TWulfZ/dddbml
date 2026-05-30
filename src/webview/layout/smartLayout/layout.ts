import type { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk.bundled.js';
import type { QualifiedName, Ref, Table, TableGroup } from '../../../shared/types';
import { columnCenterY, type NodeSize } from '../autoLayout';
import { classify, type TableMeta } from './classify';
import { buildClusters, type Cluster } from './cluster';
import { runElk } from './layoutEngine';

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
}

const INTRA_NODESEP = 32;
const INTRA_RANKSEP = 64;
const INTER_NODESEP = 96;
const INTER_RANKSEP = 128;
const CLUSTER_MARGIN = 48;
const MIN_GAP = 16;
const COLUMN_ALIGN_PASSES = 3;
const COLUMN_ALIGN_FACTOR = 0.3;
const INCREMENTAL_STEP = 64;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LocalLayout {
  positions: Map<QualifiedName, { x: number; y: number }>;
  bbox: { w: number; h: number };
}

interface Analysis {
  meta: Map<QualifiedName, TableMeta>;
  clusters: Cluster[];
}

export async function smartLayout(
  input: SmartLayoutInput,
): Promise<Map<QualifiedName, { x: number; y: number }>> {
  const mode: SmartLayoutMode = input.mode ?? 'all';
  const existing = input.existing ?? new Map<QualifiedName, { x: number; y: number }>();
  const selection = input.selection ?? new Set<QualifiedName>();
  const fixed = input.fixed ?? computeFixed(input.tables, mode, existing, selection);
  const orientation = resolveOrientation(input);

  const meta = classify(input.tables, input.refs);
  const clusters = buildClusters(input.tables, input.refs, input.groups, meta);
  const analysis: Analysis = { meta, clusters };

  const movable = new Set<QualifiedName>();
  for (const t of input.tables) if (!fixed.has(t.name)) movable.add(t.name);

  if (mode === 'all' || movable.size === input.tables.length) {
    return layoutAll(analysis, input, orientation);
  }
  return layoutIncremental(analysis, input, orientation, movable, existing);
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

const elkDir = (o: Orientation): string => (o === 'TB' ? 'DOWN' : 'RIGHT');

/* ----- All mode: one ELK compound layout ----- */

async function layoutAll(
  analysis: Analysis,
  input: SmartLayoutInput,
  orientation: Orientation,
): Promise<Map<QualifiedName, { x: number; y: number }>> {
  const graph = buildCompoundGraph(analysis, input, orientation);
  const boxes = await runElk(graph);

  const positions = new Map<QualifiedName, { x: number; y: number }>();
  for (const t of input.tables) {
    const b = boxes.get(t.name);
    if (b) positions.set(t.name, { x: b.x, y: b.y });
  }
  // Any table ELK didn't place (defensive) gets parked at origin; collisionGuard separates it.
  for (const t of input.tables) if (!positions.has(t.name)) positions.set(t.name, { x: 0, y: 0 });

  columnAlignPass(positions, input, null, analysis.meta);
  resolveCollisions(positions, input.sizeOf, null);
  return roundPositions(positions);
}

function buildCompoundGraph(
  analysis: Analysis,
  input: SmartLayoutInput,
  orientation: Orientation,
): ElkNode {
  const dir = elkDir(orientation);
  const memberToCluster = new Map<QualifiedName, string>();
  for (const c of analysis.clusters) for (const m of c.members) memberToCluster.set(m, c.id);

  const containers: ElkNode[] = [];
  for (const c of analysis.clusters) {
    if (c.members.length === 0) continue;
    if (c.kind === 'aggregate' && c.anchor) {
      containers.push(radialContainer(c, input, analysis.meta));
    } else {
      containers.push(layeredContainer(c, input, dir));
    }
  }

  const crossEdges: ElkExtendedEdge[] = [];
  for (const r of input.refs) {
    const sc = memberToCluster.get(r.source.table);
    const tc = memberToCluster.get(r.target.table);
    if (!sc || !tc || sc === tc) continue;
    const { child, parent } = normalizeDirection(r);
    crossEdges.push({ id: r.id, sources: [child], targets: [parent] });
  }

  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': dir,
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.spacing.nodeNode': String(INTER_NODESEP),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(INTER_RANKSEP),
      'elk.spacing.componentComponent': String(INTER_NODESEP),
      'elk.separateConnectedComponents': 'true',
    },
    children: containers,
    edges: crossEdges,
  };
}

function layeredContainer(cluster: Cluster, input: SmartLayoutInput, dir: string): ElkNode {
  const memberSet = new Set(cluster.members);
  const children: ElkNode[] = cluster.members.map((m) => {
    const s = input.sizeOf(m);
    return { id: m, width: s.width, height: s.height };
  });
  const edges: ElkExtendedEdge[] = [];
  for (const r of input.refs) {
    if (!memberSet.has(r.source.table) || !memberSet.has(r.target.table)) continue;
    const { child, parent } = normalizeDirection(r);
    edges.push({ id: r.id, sources: [child], targets: [parent] });
  }
  return {
    id: cluster.id,
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': dir,
      'elk.spacing.nodeNode': String(INTRA_NODESEP),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(INTRA_RANKSEP),
      'elk.padding': `[top=${CLUSTER_MARGIN},left=${CLUSTER_MARGIN},bottom=${CLUSTER_MARGIN},right=${CLUSTER_MARGIN}]`,
    },
    children,
    edges,
  };
}

/* ----- Radial (star) placement for hub aggregate clusters ----- */

function radialContainer(
  cluster: Cluster,
  input: SmartLayoutInput,
  meta: Map<QualifiedName, TableMeta>,
): ElkNode {
  const local = radialPlace(cluster, input, meta);
  const children: ElkNode[] = cluster.members.map((m) => {
    const s = input.sizeOf(m);
    const p = local.positions.get(m) ?? { x: 0, y: 0 };
    return { id: m, x: p.x, y: p.y, width: s.width, height: s.height };
  });
  return {
    id: cluster.id,
    layoutOptions: { 'elk.algorithm': 'fixed' },
    width: local.bbox.w,
    height: local.bbox.h,
    children,
  };
}

function radialPlace(
  cluster: Cluster,
  input: SmartLayoutInput,
  meta: Map<QualifiedName, TableMeta>,
): LocalLayout {
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
  const sepRadius = (sats.length * (maxSat + MIN_GAP)) / (2 * Math.PI);
  const minRadius = Math.max(hub.width, hub.height) / 2 + maxSat / 2 + MIN_GAP * 2;
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

/* ----- Incremental: lay out the movable subset, anchor to fixed FK-neighbors ----- */

async function layoutIncremental(
  analysis: Analysis,
  input: SmartLayoutInput,
  orientation: Orientation,
  movable: Set<QualifiedName>,
  existing: Map<QualifiedName, { x: number; y: number }>,
): Promise<Map<QualifiedName, { x: number; y: number }>> {
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

  for (const [, members] of movableByCluster) {
    const cl = await elkSubsetLocal(members, input, orientation);
    const anchor = computeAnchor(members, input.refs, positions, obstacles);
    const placement = findFreeSpot(anchor, cl.bbox, obstacles);
    for (const [name, pos] of cl.positions) {
      positions.set(name, { x: placement.x + pos.x, y: placement.y + pos.y });
    }
    obstacles.push({ x: placement.x, y: placement.y, w: cl.bbox.w, h: cl.bbox.h });
  }

  columnAlignPass(positions, input, movable, analysis.meta);
  resolveCollisions(positions, input.sizeOf, movable);
  return roundPositions(positions);
}

/** Flat ELK layout of a subset of tables (+ their internal refs), normalized to a 0-origin bbox. */
async function elkSubsetLocal(
  members: QualifiedName[],
  input: SmartLayoutInput,
  orientation: Orientation,
): Promise<LocalLayout> {
  if (members.length === 0) return { positions: new Map(), bbox: { w: 0, h: 0 } };
  if (members.length === 1) {
    const only = members[0]!;
    const s = input.sizeOf(only);
    return { positions: new Map([[only, { x: 0, y: 0 }]]), bbox: { w: s.width, h: s.height } };
  }

  const memberSet = new Set(members);
  const children: ElkNode[] = members.map((m) => {
    const s = input.sizeOf(m);
    return { id: m, width: s.width, height: s.height };
  });
  const edges: ElkExtendedEdge[] = [];
  for (const r of input.refs) {
    if (!memberSet.has(r.source.table) || !memberSet.has(r.target.table)) continue;
    const { child, parent } = normalizeDirection(r);
    edges.push({ id: r.id, sources: [child], targets: [parent] });
  }

  const dir = elkDir(orientation);
  const boxes = await runElk({
    id: 'sub',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': dir,
      'elk.spacing.nodeNode': String(INTRA_NODESEP),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(INTRA_RANKSEP),
    },
    children,
    edges,
  });

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes.values()) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  if (!Number.isFinite(minX)) return { positions: new Map(), bbox: { w: 0, h: 0 } };

  const positions = new Map<QualifiedName, { x: number; y: number }>();
  for (const [name, b] of boxes) positions.set(name, { x: b.x - minX, y: b.y - minY });
  return { positions, bbox: { w: maxX - minX, h: maxY - minY } };
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
        if (B.x >= A.x + A.w + MIN_GAP) break;
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
          M.x = S.x + S.w + MIN_GAP;
        } else {
          M.y = S.y + S.h + MIN_GAP;
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

function roundPositions(
  positions: Map<QualifiedName, { x: number; y: number }>,
): Map<QualifiedName, { x: number; y: number }> {
  const out = new Map<QualifiedName, { x: number; y: number }>();
  for (const [k, v] of positions) out.set(k, { x: Math.round(v.x), y: Math.round(v.y) });
  return out;
}
