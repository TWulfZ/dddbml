import type { EdgeLayout, QualifiedName, Ref, Waypoint } from '../../shared/types';
import { densityMetrics } from '../layout/density';
import { isSelfRef } from './edgeKey';
import type { Bbox } from './spatialIndex';

export type Side = 'left' | 'right' | 'top' | 'bottom';

/**
 * Length (world units) of the RIGID stub that always leaves each table. The pieces
 * `source → sourceStub` and `targetStub → target` are immutable: never draggable, never
 * subdivided, never collapsed. They keep the connection point coherent (the `1` / crow's-foot
 * marker never sits flush against the table). All user editing happens strictly between the
 * two stub ends. When opposed ports are closer than `2*MIN_STUB` along their axis the stub length
 * is clamped to half the port distance so the two stubs meet instead of crossing (no backtracking
 * spike); a very-close same-row edge then has no editable middle (just a straight rigid connector).
 */
const MIN_STUB = 24;

/** How far a self-loop's trunk sits from its table side (spec 05 §Self-loops: 2× stub). */
export const LOOP_OFFSET = 2 * MIN_STUB;
/** Extra distance per other loop on the same table side, so stacked loops nest instead of overlapping. */
export const LOOP_STEP = MIN_STUB / 2;
/** Row height used to split a same-column loop's ports when the caller passes none. */
const DEFAULT_ROW_HEIGHT = densityMetrics('cozy').rowHeight;

/** Farthest a table's loops reach out of its side when `stackSize` loops share that side. */
export function loopReach(stackSize: number): number {
  return LOOP_OFFSET + Math.max(0, stackSize - 1) * LOOP_STEP;
}

/** The single side a loop is drawn on: the persisted override (both ends flip together), else right. */
export function loopSide(layout: EdgeLayout | undefined): 'left' | 'right' {
  return (layout?.sourceSide ?? layout?.targetSide) === 'left' ? 'left' : 'right';
}

type Point = { x: number; y: number };

/** Outward unit vector of a stub leaving each table side. */
const STUB_DIR: Record<Side, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

export interface EdgeSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  axis: 'h' | 'v';
  /** Index of the waypoint that ends this segment, or `null` for the final leg into the target. */
  endWaypointIndex: number | null;
  /** Rigid stub (first/last segment): immutable, not draggable/subdividable. */
  rigid: boolean;
}

export interface EdgeRoute {
  id: string;
  d: string;
  /** Copy of the user's waypoints in world coords for rendering circles. */
  waypoints: Waypoint[];
  /** Orthogonal segments composing the path, in order. Used for hover hit-testing and "click to add waypoint". */
  segments: EdgeSegment[];
  /** Resolved port coordinates (world space), useful for hit-testing / highlighting. */
  source: { x: number; y: number };
  target: { x: number; y: number };
  /**
   * Fixed ends of the RIGID stubs. The editable polyline (and all waypoint editing) lives between
   * `sourceStub` and `targetStub`; `source → sourceStub` and `targetStub → target` are immutable.
   * Segment editing uses these as the fixed endpoints (not `source`/`target`).
   */
  sourceStub: { x: number; y: number };
  targetStub: { x: number; y: number };
  /** Self-loop: drawn by its own geometry, never carries editable waypoints (spec 05 §Self-loops). */
  loop?: true;
}

/** Optional per-endpoint port override — used to align edges with the PK/FK column row. */
export type ColumnYResolver = (table: QualifiedName, column: string) => number | undefined;

/** Resolves the EdgeLayout (waypoints + legacy dx/dy) for an edge, keyed by ref id. */
export type EdgeLayoutResolver = (refId: string) => EdgeLayout | undefined;

interface SideDecision {
  ref: Ref;
  srcBbox: Bbox;
  tgtBbox: Bbox;
  sourceSide: Side;
  targetSide: Side;
}

/** One edge end sitting on a (table, side) port group. */
interface PortEntry {
  edgeIdx: number;
  role: 'source' | 'target';
  /** Coordinate of the far end's centre the group is sorted by. */
  otherCenter: number;
  refId: string;
}

const portKey = (table: QualifiedName, side: Side): string => `${table}|${side}`;

function decideSides(r: Ref, bboxOf: (name: QualifiedName) => Bbox | undefined, layoutResolver?: EdgeLayoutResolver): SideDecision | null {
  const srcBbox = bboxOf(r.source.table);
  const tgtBbox = bboxOf(r.target.table);
  if (!srcBbox || !tgtBbox) return null;
  const layout = layoutResolver?.(r.id);
  if (isSelfRef(r)) {
    const side = loopSide(layout);
    return { ref: r, srcBbox, tgtBbox, sourceSide: side, targetSide: side };
  }
  const auto = chooseSides(srcBbox, tgtBbox);
  return {
    ref: r,
    srcBbox,
    tgtBbox,
    sourceSide: layout?.sourceSide ?? auto.sourceSide,
    targetSide: layout?.targetSide ?? auto.targetSide,
  };
}

/**
 * Barycentric crossing reduction: the edge whose far end sits higher/left gets the higher/left port.
 * Ties break by ref id, so the order depends only on geometry + stable ids, never on the refs[]
 * order (which @dbml/core can shuffle on re-parse) — the same schema yields the same routed ports.
 * The last two keys reproduce the insertion order (edge index, source before target), which keeps
 * an incremental re-sort identical to a full one even for entries of the same ref.
 */
function comparePorts(a: PortEntry, b: PortEntry): number {
  return (a.otherCenter - b.otherCenter)
    || (a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0)
    || (a.edgeIdx - b.edgeIdx)
    || (a.role === b.role ? 0 : a.role === 'source' ? -1 : 1);
}

function buildRoute(
  d: SideDecision,
  sourceRatio: number,
  targetRatio: number,
  columnYResolver: ColumnYResolver | undefined,
  layoutResolver: EdgeLayoutResolver | undefined,
  loopRank: number,
  rowHeight: number,
): EdgeRoute {
  if (isSelfRef(d.ref)) return buildLoopRoute(d, sourceRatio, targetRatio, columnYResolver, loopRank, rowHeight);
  let sourceY: number | undefined;
  let targetY: number | undefined;
  if (columnYResolver) {
    if (d.sourceSide === 'left' || d.sourceSide === 'right') {
      const offset = d.ref.source.columns[0] ? columnYResolver(d.ref.source.table, d.ref.source.columns[0]) : undefined;
      if (offset !== undefined) sourceY = d.srcBbox.y + offset;
    }
    if (d.targetSide === 'left' || d.targetSide === 'right') {
      const offset = d.ref.target.columns[0] ? columnYResolver(d.ref.target.table, d.ref.target.columns[0]) : undefined;
      if (offset !== undefined) targetY = d.tgtBbox.y + offset;
    }
  }

  const a = portPoint(d.srcBbox, d.sourceSide, sourceRatio, sourceY);
  const b = portPoint(d.tgtBbox, d.targetSide, targetRatio, targetY);

  const layout = layoutResolver?.(d.ref.id);
  const waypoints = layout?.waypoints && layout.waypoints.length > 0 ? layout.waypoints : [];
  const legacyDx = waypoints.length === 0 && layout?.dx !== undefined ? layout.dx : 0;

  const { corners, aStub, bStub } = buildPath(a, b, waypoints, legacyDx, d.sourceSide, d.targetSide);
  return {
    id: d.ref.id,
    d: roundedPathString(corners, CORNER_RADIUS),
    waypoints: waypoints.map((w) => ({ x: w.x, y: w.y })),
    segments: buildSegments(corners, waypoints),
    source: a,
    target: b,
    sourceStub: aStub,
    targetStub: bStub,
  };
}

/**
 * A self-loop leaves its source column's port, runs out `loopReach(rank + 1)` past the side, down
 * (or up) to the target column's row and back in on the same side. Ports coinciding (same column)
 * are split ±¼ row so the loop keeps a visible trunk.
 */
function buildLoopRoute(
  d: SideDecision,
  sourceRatio: number,
  targetRatio: number,
  columnYResolver: ColumnYResolver | undefined,
  rank: number,
  rowHeight: number,
): EdgeRoute {
  const side = d.sourceSide;
  const offsetOf = (cols: string[]) => (columnYResolver && cols[0] ? columnYResolver(d.ref.source.table, cols[0]) : undefined);
  const sOff = offsetOf(d.ref.source.columns);
  const tOff = offsetOf(d.ref.target.columns);
  const a = portPoint(d.srcBbox, side, sourceRatio, sOff === undefined ? undefined : d.srcBbox.y + sOff);
  const b = portPoint(d.srcBbox, side, targetRatio, tOff === undefined ? undefined : d.srcBbox.y + tOff);
  if (a.y === b.y) {
    const q = Math.round(rowHeight / 4);
    a.y -= q;
    b.y += q;
  }
  const dir = STUB_DIR[side].x;
  const aStub = { x: a.x + dir * MIN_STUB, y: a.y };
  const bStub = { x: b.x + dir * MIN_STUB, y: b.y };
  const farX = a.x + dir * loopReach(rank + 1);
  const corners = [a, aStub, { x: farX, y: a.y }, { x: farX, y: b.y }, bStub, b];
  return {
    id: d.ref.id,
    d: roundedPathString(corners, CORNER_RADIUS),
    waypoints: [],
    segments: buildSegments(corners, []),
    source: a,
    target: b,
    sourceStub: aStub,
    targetStub: bStub,
    loop: true,
  };
}

/** Vertical distance between a loop's two column rows; unresolved columns count as 0. */
function loopSpan(r: Ref, columnYResolver: ColumnYResolver | undefined): number {
  if (!columnYResolver) return 0;
  const off = (cols: string[]) => (cols[0] ? columnYResolver(r.source.table, cols[0]) : undefined) ?? 0;
  return Math.abs(off(r.target.columns) - off(r.source.columns));
}

/**
 * Routing state kept between calls so a table drag re-routes only what the move can change
 * (spec 04, "Commit del drag por frame"): the refs touching a moved table, plus every ref sharing a
 * port group (table + side) with one of them — the stubs on a side are spread by sorting the group,
 * so a moved far end can reorder (and re-space) its siblings. Every other route keeps its identity.
 */
export class EdgeRouteCache {
  private refs: readonly Ref[] = [];
  private decisions: Array<SideDecision | null> = [];
  private sourceRatio: number[] = [];
  private targetRatio: number[] = [];
  private routes: Array<EdgeRoute | null> = [];
  /** Stack position of each loop among the loops on its table side; 0 for every other ref. */
  private loopRank: number[] = [];
  private rowHeight = DEFAULT_ROW_HEIGHT;
  private readonly ports = new Map<string, PortEntry[]>();
  private readonly edgesByTable = new Map<QualifiedName, number[]>();
  private out: EdgeRoute[] = [];

  /**
   * Routes every ref orthogonally (Manhattan) and distributes ports along each
   * table side to minimize overlap when multiple edges share a side.
   *
   * Routing modes per edge:
   *   1. `EdgeLayout.waypoints` present → multi-waypoint Manhattan, alternating axes.
   *   2. Legacy `EdgeLayout.dx` (no waypoints) → original H-V-H with midX offset (back-compat).
   *   3. No layout → automatic H-V-H with midpoint between ports.
   *
   * Returns an ordered list matching refs[] order — callers can filter by visibility.
   * `rowHeight` (the density's) only splits the ports of a same-column self-loop.
   */
  public routeAll(
    refs: readonly Ref[],
    bboxOf: (name: QualifiedName) => Bbox | undefined,
    columnYResolver?: ColumnYResolver,
    layoutResolver?: EdgeLayoutResolver,
    rowHeight: number = DEFAULT_ROW_HEIGHT,
  ): EdgeRoute[] {
    this.refs = refs;
    this.rowHeight = rowHeight;
    this.rankLoops(columnYResolver, layoutResolver);
    this.decisions = refs.map((r) => decideSides(r, bboxOf, layoutResolver));
    this.sourceRatio = refs.map(() => 0.5);
    this.targetRatio = refs.map(() => 0.5);
    this.ports.clear();
    this.edgesByTable.clear();
    refs.forEach((r, i) => {
      this.indexTable(r.source.table, i);
      if (r.target.table !== r.source.table) this.indexTable(r.target.table, i);
      const d = this.decisions[i];
      if (d) this.addPorts(d, i, null);
    });
    for (const key of this.ports.keys()) this.spreadPorts(key, null);
    this.routes = this.decisions.map((d, i) =>
      d ? buildRoute(d, this.sourceRatio[i]!, this.targetRatio[i]!, columnYResolver, layoutResolver, this.loopRank[i]!, rowHeight) : null,
    );
    return this.collect();
  }

  /**
   * Re-routes after only the tables in `moved` changed position, with every other input (refs, sizes,
   * rows, layouts) identical to the last call. Returns the previous array when no ref is affected.
   */
  public routeMoved(
    moved: Iterable<QualifiedName>,
    bboxOf: (name: QualifiedName) => Bbox | undefined,
    columnYResolver?: ColumnYResolver,
    layoutResolver?: EdgeLayoutResolver,
  ): EdgeRoute[] {
    const affected = new Set<number>();
    for (const t of moved) for (const i of this.edgesByTable.get(t) ?? []) affected.add(i);
    if (affected.size === 0) return this.out;

    const touched = new Set<string>();
    for (const i of affected) {
      const old = this.decisions[i];
      if (old) {
        this.removePorts(portKey(old.ref.source.table, old.sourceSide), i, touched);
        this.removePorts(portKey(old.ref.target.table, old.targetSide), i, touched);
      }
      const d = decideSides(this.refs[i]!, bboxOf, layoutResolver);
      this.decisions[i] = d;
      if (d) this.addPorts(d, i, touched);
    }
    const dirty = new Set<number>(affected);
    for (const key of touched) this.spreadPorts(key, dirty);
    for (const i of dirty) {
      const d = this.decisions[i];
      this.routes[i] = d
        ? buildRoute(d, this.sourceRatio[i]!, this.targetRatio[i]!, columnYResolver, layoutResolver, this.loopRank[i]!, this.rowHeight)
        : null;
    }
    return this.collect();
  }

  /**
   * Nests the loops sharing a table side: the shorter span goes inside so nested loops never cross.
   * Reads only refs, rows and layouts — never positions — so a drag never re-ranks.
   */
  private rankLoops(columnYResolver: ColumnYResolver | undefined, layoutResolver: EdgeLayoutResolver | undefined): void {
    this.loopRank = this.refs.map(() => 0);
    const bySide = new Map<string, number[]>();
    this.refs.forEach((r, i) => {
      if (!isSelfRef(r)) return;
      const key = portKey(r.source.table, loopSide(layoutResolver?.(r.id)));
      const list = bySide.get(key);
      if (list) list.push(i);
      else bySide.set(key, [i]);
    });
    for (const list of bySide.values()) {
      if (list.length < 2) continue;
      const span = list.map((i) => loopSpan(this.refs[i]!, columnYResolver));
      const order = list.map((_, k) => k).sort((p, q) => {
        const a = this.refs[list[p]!]!.id;
        const b = this.refs[list[q]!]!.id;
        return (span[p]! - span[q]!) || (a < b ? -1 : a > b ? 1 : 0) || (list[p]! - list[q]!);
      });
      order.forEach((k, rank) => { this.loopRank[list[k]!] = rank; });
    }
  }

  private collect(): EdgeRoute[] {
    const out: EdgeRoute[] = [];
    for (const r of this.routes) if (r) out.push(r);
    this.out = out;
    return out;
  }

  private indexTable(table: QualifiedName, edgeIdx: number): void {
    const list = this.edgesByTable.get(table);
    if (list) list.push(edgeIdx);
    else this.edgesByTable.set(table, [edgeIdx]);
  }

  private addPorts(d: SideDecision, edgeIdx: number, touched: Set<string> | null): void {
    const tgtCenter = centerOf(d.tgtBbox);
    const srcCenter = centerOf(d.srcBbox);
    const srcKey = portKey(d.ref.source.table, d.sourceSide);
    const tgtKey = portKey(d.ref.target.table, d.targetSide);
    this.pushPort(srcKey, {
      edgeIdx,
      role: 'source',
      otherCenter: orientationOfSide(d.sourceSide) === 'v' ? tgtCenter.y : tgtCenter.x,
      refId: d.ref.id,
    });
    this.pushPort(tgtKey, {
      edgeIdx,
      role: 'target',
      otherCenter: orientationOfSide(d.targetSide) === 'v' ? srcCenter.y : srcCenter.x,
      refId: d.ref.id,
    });
    touched?.add(srcKey);
    touched?.add(tgtKey);
  }

  private pushPort(key: string, entry: PortEntry): void {
    const list = this.ports.get(key);
    if (list) list.push(entry);
    else this.ports.set(key, [entry]);
  }

  private removePorts(key: string, edgeIdx: number, touched: Set<string>): void {
    const list = this.ports.get(key);
    if (!list) return;
    const kept = list.filter((e) => e.edgeIdx !== edgeIdx);
    if (kept.length === 0) this.ports.delete(key);
    else this.ports.set(key, kept);
    touched.add(key);
  }

  /** Sorts a port group and spaces its ends evenly; records in `dirty` every edge whose ratio moved. */
  private spreadPorts(key: string, dirty: Set<number> | null): void {
    const entries = this.ports.get(key);
    if (!entries) return;
    entries.sort(comparePorts);
    const count = entries.length;
    for (let i = 0; i < count; i++) {
      const e = entries[i]!;
      const ratio = (i + 1) / (count + 1);
      const ratios = e.role === 'source' ? this.sourceRatio : this.targetRatio;
      if (ratios[e.edgeIdx] === ratio) continue;
      ratios[e.edgeIdx] = ratio;
      dirty?.add(e.edgeIdx);
    }
  }
}

/** One-shot routing of every ref; see `EdgeRouteCache.routeAll`. */
export function routeRefs(
  refs: Ref[],
  bboxOf: (name: QualifiedName) => Bbox | undefined,
  columnYResolver?: ColumnYResolver,
  layoutResolver?: EdgeLayoutResolver,
  rowHeight?: number,
): EdgeRoute[] {
  return new EdgeRouteCache().routeAll(refs, bboxOf, columnYResolver, layoutResolver, rowHeight);
}

/**
 * Build the corner points of the orthogonal polyline from `a` to `b`, through the user's LITERAL
 * corner waypoints. Wrapped in two RIGID stubs (`a → aStub`, `bStub → b`, fixed `MIN_STUB`, pointing
 * straight out of `sourceSide`/`targetSide` — vertical for top/bottom) — immutable, always present.
 *
 * No waypoints ⇒ the editable middle is the default route between the stub ends. Otherwise the
 * waypoints ARE the route's corners, connected directly (a single elbow inserted only for a stray
 * non-axis-aligned pair, as back-compat for v1 free waypoints). Nothing is collapsed/canonicalized,
 * so local notches (a dip whose pins are colinear with the run) survive.
 *
 * Returns the full corner list (`[a, ...editable..., b]`) plus the fixed stub ends.
 */
function buildPath(
  a: Point,
  b: Point,
  waypoints: Waypoint[],
  legacyDx: number,
  sourceSide: Side,
  targetSide: Side,
): { corners: Point[]; aStub: Point; bStub: Point } {
  const dirA = STUB_DIR[sourceSide];
  const dirB = STUB_DIR[targetSide];
  // Opposed stubs on one axis are clamped to half the port distance along it so they meet instead
  // of crossing (crossing would invert the editable span). Same-direction or perpendicular stubs
  // can never cross, and clamping them would collapse them onto the table border (F52).
  const opposed = dirA.x === -dirB.x && dirA.y === -dirB.y;
  const gap = dirA.x !== 0 ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
  const stubLen = opposed ? Math.min(MIN_STUB, Math.floor(gap / 2)) : MIN_STUB;
  const aStub = { x: a.x + dirA.x * stubLen, y: a.y + dirA.y * stubLen };
  const bStub = { x: b.x + dirB.x * stubLen, y: b.y + dirB.y * stubLen };

  const editable = waypoints.length === 0
    ? defaultEditableCorners(aStub, bStub, dirA, dirB, legacyDx)
    : cornersThrough(aStub, bStub, waypoints, dirA.y !== 0, dirB.y !== 0);
  const corners = [{ x: a.x, y: a.y }, ...editable, { x: b.x, y: b.y }];
  return { corners, aStub, bStub };
}

/**
 * Default editable corners between the stub ends. Both stubs horizontal ⇒ H-V-H around a vertical
 * trunk; both vertical ⇒ the V-H-V mirror; one of each ⇒ a single L elbow. Same-direction stubs get a
 * C-route whose trunk sits beyond the farther-reaching stub, so it never doubles back over a stub.
 * The legacy `dx` offset only ever applied to the horizontal-stub trunk.
 */
function defaultEditableCorners(
  aStub: Point,
  bStub: Point,
  dirA: Point,
  dirB: Point,
  legacyDx: number,
): Point[] {
  const aVertical = dirA.y !== 0;
  const bVertical = dirB.y !== 0;
  if (aVertical !== bVertical) {
    const elbow = aVertical ? { x: aStub.x, y: bStub.y } : { x: bStub.x, y: aStub.y };
    return [{ x: aStub.x, y: aStub.y }, elbow, { x: bStub.x, y: bStub.y }];
  }
  if (!aVertical) {
    if (bStub.y === aStub.y) return [{ x: aStub.x, y: aStub.y }, { x: bStub.x, y: bStub.y }];
    const trunk = dirA.x === dirB.x
      ? (dirA.x > 0 ? Math.max(aStub.x, bStub.x) : Math.min(aStub.x, bStub.x))
      : (aStub.x + bStub.x) / 2;
    const midX = Math.round(trunk + legacyDx);
    return [
      { x: aStub.x, y: aStub.y },
      { x: midX, y: aStub.y },
      { x: midX, y: bStub.y },
      { x: bStub.x, y: bStub.y },
    ];
  }
  if (bStub.x === aStub.x) return [{ x: aStub.x, y: aStub.y }, { x: bStub.x, y: bStub.y }];
  const midY = Math.round(dirA.y === dirB.y
    ? (dirA.y > 0 ? Math.max(aStub.y, bStub.y) : Math.min(aStub.y, bStub.y))
    : (aStub.y + bStub.y) / 2);
  return [
    { x: aStub.x, y: aStub.y },
    { x: aStub.x, y: midY },
    { x: bStub.x, y: midY },
    { x: bStub.x, y: bStub.y },
  ];
}

/**
 * Connect the stub ends through the user's literal corners with straight orthogonal segments.
 * Consecutive corners are expected axis-aligned (the editing ops guarantee it); a single elbow is
 * inserted only for a stray non-aligned pair (back-compat with v1 free waypoints). The elbow runs
 * along the adjacent stub's axis first, so a vertical (top/bottom) stub never gets a run lying flat
 * along the table border; interior pairs stay horizontal-first. Every user corner survives.
 */
function cornersThrough(
  aStub: Point,
  bStub: Point,
  waypoints: Waypoint[],
  aVertical: boolean,
  bVertical: boolean,
): Point[] {
  const out: Point[] = [{ x: aStub.x, y: aStub.y }];
  let cur = { x: aStub.x, y: aStub.y };
  const connect = (p: Point, verticalFirst: boolean) => {
    if (p.x !== cur.x && p.y !== cur.y) out.push(verticalFirst ? { x: cur.x, y: p.y } : { x: p.x, y: cur.y });
    out.push({ x: p.x, y: p.y });
    cur = { x: p.x, y: p.y };
  };
  waypoints.forEach((w, i) => connect({ x: w.x, y: w.y }, i === 0 && aVertical));
  connect({ x: bStub.x, y: bStub.y }, bVertical);
  return out;
}

/** Corner-rounding radius (world units) for the rendered path; clamped per-corner below. */
const CORNER_RADIUS = 8;

/**
 * Build the SVG path with ROUNDED corners. Each interior corner is replaced by a fillet: a line
 * to `radius` before the corner, then a quadratic Bézier whose control point IS the corner vertex,
 * ending `radius` after the corner. `radius` is clamped to half of each adjacent segment so fillets
 * never overlap or overshoot (e.g. the rigid `MIN_STUB` legs). Colinear/coincident points emit a
 * plain line (no fillet). Corner rounding is render-only smoothing — a turn is NEVER a node/circle;
 * editable handles live on segments, not corners. (React Flow getBend / JointJS rounded / mxGraph arcSize.)
 */
export function roundedPathString(points: Array<{ x: number; y: number }>, radius: number): string {
  // Drop coincident points (e.g. stubs that met) so segment lengths / unit vectors are well-defined.
  const pts: Array<{ x: number; y: number }> = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) pts.push(p);
  }
  if (pts.length === 0) return '';
  if (pts.length <= 2) {
    let s = `M${pts[0]!.x},${pts[0]!.y}`;
    for (let i = 1; i < pts.length; i++) s += ` L${pts[i]!.x},${pts[i]!.y}`;
    return s;
  }
  let s = `M${pts[0]!.x},${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    const next = pts[i + 1]!;
    const colinear =
      (prev.x === cur.x && cur.x === next.x) || (prev.y === cur.y && cur.y === next.y);
    if (colinear) {
      s += ` L${cur.x},${cur.y}`;
      continue;
    }
    const dPrev = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const dNext = Math.hypot(next.x - cur.x, next.y - cur.y);
    const rr = Math.min(radius, dPrev / 2, dNext / 2);
    const enter = {
      x: Math.round(cur.x + ((prev.x - cur.x) / dPrev) * rr),
      y: Math.round(cur.y + ((prev.y - cur.y) / dPrev) * rr),
    };
    const exit = {
      x: Math.round(cur.x + ((next.x - cur.x) / dNext) * rr),
      y: Math.round(cur.y + ((next.y - cur.y) / dNext) * rr),
    };
    s += ` L${enter.x},${enter.y} Q${cur.x},${cur.y} ${exit.x},${exit.y}`;
  }
  const last = pts[pts.length - 1]!;
  s += ` L${last.x},${last.y}`;
  return s;
}

/**
 * Build segment descriptors from the corner list. The `endWaypointIndex` lets callers
 * compute the insert position when the user clicks a segment to add a waypoint:
 *
 *   - If `endWaypointIndex === k`, segment ends exactly at waypoint k. Clicking it inserts
 *     before waypoint k (the new waypoint takes index k, existing waypoint moves to k+1).
 *   - If `endWaypointIndex === null`, segment is after all waypoints. Clicking it appends
 *     (insert index = waypoints.length).
 */
function buildSegments(corners: Array<{ x: number; y: number }>, waypoints: Waypoint[]): EdgeSegment[] {
  const segs: EdgeSegment[] = [];
  let wpIdx = 0;
  for (let i = 0; i < corners.length - 1; i++) {
    const p1 = corners[i]!;
    const p2 = corners[i + 1]!;
    if (p1.x === p2.x && p1.y === p2.y) continue;
    const axis: 'h' | 'v' = p1.y === p2.y ? 'h' : 'v';
    const nextWp = waypoints[wpIdx];
    const endsAtWaypoint = nextWp !== undefined && p2.x === nextWp.x && p2.y === nextWp.y;
    segs.push({
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
      axis,
      endWaypointIndex: endsAtWaypoint ? wpIdx : null,
      rigid: false,
    });
    if (endsAtWaypoint) wpIdx++;
  }
  // First and last segments are the rigid stubs (corners are always [a, aStub, …, bStub, b],
  // and a→aStub / bStub→b are non-zero), so they bound the editable middle. Mark them immutable.
  if (segs.length > 0) {
    segs[0]!.rigid = true;
    segs[segs.length - 1]!.rigid = true;
  }
  return segs;
}

/**
 * Materialize the editable corners of a route (`aStub … bStub`) from its rendered segments. After
 * any edit the route becomes fully explicit (every corner is a stored waypoint), so editing one run
 * never disturbs the rest. `corners[0]` is `aStub`, `corners[last]` is `bStub`.
 */
function editableCornersOf(route: EdgeRoute): Array<{ x: number; y: number }> {
  const edit = route.segments.filter((s) => !s.rigid);
  if (edit.length === 0) return [];
  return [{ x: edit[0]!.x1, y: edit[0]!.y1 }, ...edit.map((s) => ({ x: s.x2, y: s.y2 }))];
}

/**
 * A run `corners[j] → corners[j+1]` is the BOTTOM of an existing symmetric notch when the two
 * corners just outside it (its pins) sit at one shared perpendicular level different from the run's
 * — i.e. the line dips into the run and rises back out to the same level on both sides.
 */
function isDip(corners: Array<{ x: number; y: number }>, j: number, axis: 'h' | 'v'): boolean {
  const a = corners[j - 1];
  const b = corners[j + 2];
  if (!a || !b) return false;
  return axis === 'h' ? a.y === b.y && a.y !== corners[j]!.y : a.x === b.x && a.x !== corners[j]!.x;
}

/** Axis of an axis-aligned run `p → q`. */
function runAxis(p: { x: number; y: number }, q: { x: number; y: number }): 'h' | 'v' {
  return p.y === q.y ? 'h' : 'v';
}

/**
 * Drop coincident and strictly-colinear interior corners; the endpoints are preserved. This is a
 * SAFE canonicalization — removing a point colinear with its two neighbours never changes the
 * rendered line (three colinear points draw identically). No corner of a symmetric notch is
 * colinear with both neighbours, so a real notch is never destroyed; but a notch slid back to its
 * pin level (its dip corners become colinear with the pins) collapses away, and a slid arm's
 * redundant points drop. Used after a SLIDE, never during a CREATE.
 */
function cleanCorners(pts: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const dedup: Array<{ x: number; y: number }> = [];
  for (const p of pts) {
    const last = dedup[dedup.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) dedup.push({ x: p.x, y: p.y });
  }
  if (dedup.length <= 2) return dedup;
  const out: Array<{ x: number; y: number }> = [dedup[0]!];
  for (let i = 1; i < dedup.length - 1; i++) {
    const prev = out[out.length - 1]!;
    const cur = dedup[i]!;
    const next = dedup[i + 1]!;
    const colinear =
      (prev.x === cur.x && cur.x === next.x) || (prev.y === cur.y && cur.y === next.y);
    if (!colinear) out.push(cur);
  }
  out.push(dedup[dedup.length - 1]!);
  return out;
}

/** Half-width (fraction of the run) of a local notch's dipped bottom, centred on the grabbed quarter. */
const NOTCH_HALF_FRACTION = 1 / 8;

/**
 * Notch re-merge tolerance (world units). When a notch's dip-run is dragged back toward its pins,
 * it snaps flat once within this distance of the pin level, so the notch dissolves without needing
 * pixel-perfect aim. Raise for a friendlier (larger) merge zone, lower for finer control.
 */
const NOTCH_MERGE_SNAP = 10;

/**
 * The 4 corners of a LOCAL symmetric notch carved around `quarter` (0.25 / 0.75) of run `p1 → p2`,
 * dipped by `d` perpendicular. The two pins sit at `quarter ∓ 1/8` (still at the run's level); the
 * dipped bottom spans between them, the rest of the run stays flat (short lead-in, long tail). This
 * is the geometry behind the two GHOST handles — each quarter carves its own local notch.
 */
function localNotchCorners(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  axis: 'h' | 'v',
  d: number,
  quarter: number,
): Array<{ x: number; y: number }> {
  const f1 = quarter - NOTCH_HALF_FRACTION;
  const f2 = quarter + NOTCH_HALF_FRACTION;
  if (axis === 'h') {
    const y0 = p1.y;
    const t1 = Math.round(p1.x + (p2.x - p1.x) * f1);
    const t2 = Math.round(p1.x + (p2.x - p1.x) * f2);
    return [{ x: t1, y: y0 }, { x: t1, y: y0 + d }, { x: t2, y: y0 + d }, { x: t2, y: y0 }];
  }
  const x0 = p1.x;
  const t1 = Math.round(p1.y + (p2.y - p1.y) * f1);
  const t2 = Math.round(p1.y + (p2.y - p1.y) * f2);
  return [{ x: x0, y: t1 }, { x: x0 + d, y: t1 }, { x: x0 + d, y: t2 }, { x: x0, y: t2 }];
}

/** True if the run at `segIndex` is an existing notch's dip bottom (drag = deepen, not create). */
export function isDipRun(route: EdgeRoute, segIndex: number): boolean {
  const seg = route.segments[segIndex];
  // A loop's trunk is U-shaped like a notch, but a loop never carries waypoints.
  if (!seg || seg.rigid || route.loop) return false;
  const corners = editableCornersOf(route);
  const j = segIndex - 1;
  const p1 = corners[j];
  const p2 = corners[j + 1];
  if (!p1 || !p2) return false;
  return isDip(corners, j, p1.y === p2.y ? 'h' : 'v');
}

/**
 * Slide an editable run perpendicular to itself — the gesture behind each run's REAL centre handle
 * (and behind grabbing the run anywhere). Moves the whole run to a new parallel level: a shared
 * corner with a PERPENDICULAR neighbour just moves (the neighbour lengthens); where the neighbour is
 * PARALLEL (a rigid stub end, or a colinear arm) a jog corner is inserted so the stub/port anchor
 * never moves. Sliding an existing notch's dip-run deepens it; sliding it back to the pin level
 * flattens the notch away (`cleanCorners`).
 *
 * 1-DOF perpendicular: a horizontal run reacts to `dyWorld` only, a vertical run to `dxWorld` only.
 * Materializes the route's corners first so the rest of the route is untouched. Call with the
 * ORIGINAL route + cumulative delta (idempotent; the run index never drifts mid-drag).
 */
export function slideSegment(
  route: EdgeRoute,
  segIndex: number,
  dxWorld: number,
  dyWorld: number,
  snap: (n: number) => number = Math.round,
): Waypoint[] {
  const seg = route.segments[segIndex];
  const fallback = (): Waypoint[] => route.waypoints.map((w) => ({ x: w.x, y: w.y }));
  if (!seg || seg.rigid) return fallback();

  const C = editableCornersOf(route); // [aStub, …, bStub]
  const j = segIndex - 1; // the run connects C[j] → C[j+1]
  const p1 = C[j];
  const p2 = C[j + 1];
  if (!p1 || !p2) return fallback();
  const axis: 'h' | 'v' = runAxis(p1, p2);
  const lvl = axis === 'h' ? p1.y : p1.x;
  let newLvl = axis === 'h' ? snap(p1.y + dyWorld) : snap(p1.x + dxWorld);
  // Notch re-merge: when this run IS a notch's dip-run, snap to the pin level once within
  // NOTCH_MERGE_SNAP so dragging it most of the way back dissolves the notch (cleanCorners) without
  // pixel-perfect aim. The pins (corners[j-1]/corners[j+2]) share one level by construction.
  if (isDip(C, j, axis)) {
    const pinLvl = axis === 'h' ? C[j - 1]!.y : C[j - 1]!.x;
    if (Math.abs(newLvl - pinLvl) <= NOTCH_MERGE_SNAP) newLvl = pinLvl;
  }
  if (newLvl === lvl) return fallback();

  const atLevel = (pt: { x: number; y: number }): { x: number; y: number } =>
    axis === 'h' ? { x: pt.x, y: newLvl } : { x: newLvl, y: pt.y };

  // A stub end (j at the boundary) or a parallel (colinear) neighbour must stay; insert a jog there.
  const leftFixed = j === 0 || runAxis(C[j - 1]!, p1) === axis;
  const rightFixed = j + 1 === C.length - 1 || runAxis(p2, C[j + 2]!) === axis;
  const left = leftFixed ? [{ x: p1.x, y: p1.y }, atLevel(p1)] : [atLevel(p1)];
  const right = rightFixed ? [atLevel(p2), { x: p2.x, y: p2.y }] : [atLevel(p2)];

  const result = [...C.slice(0, j), ...left, ...right, ...C.slice(j + 2)];
  return cleanCorners(result).slice(1, -1);
}

/**
 * Carve a LOCAL symmetric notch on the run at `segIndex`, centred on `quarter` (0.25 / 0.75) — the
 * gesture behind the two GHOST handles. Returns the route's new literal-corner waypoints: 2 pins at
 * the run's level + 2 dropped corners at the dragged level, around the grabbed quarter; the run's
 * ends and the rest of the route stay put.
 *
 * 1-DOF perpendicular (horizontal run → `dyWorld`, vertical run → `dxWorld`). Materializes the
 * route's corners first. Call with the ORIGINAL route + cumulative delta (idempotent).
 */
export function notchAtQuarter(
  route: EdgeRoute,
  segIndex: number,
  quarter: number,
  dxWorld: number,
  dyWorld: number,
  snap: (n: number) => number = Math.round,
): Waypoint[] {
  const seg = route.segments[segIndex];
  const fallback = (): Waypoint[] => route.waypoints.map((w) => ({ x: w.x, y: w.y }));
  if (!seg || seg.rigid) return fallback();

  const corners = editableCornersOf(route);
  const j = segIndex - 1; // the run connects corners[j] → corners[j+1]
  const p1 = corners[j];
  const p2 = corners[j + 1];
  if (!p1 || !p2) return fallback();
  const axis: 'h' | 'v' = runAxis(p1, p2);
  const d = axis === 'h' ? snap(p1.y + dyWorld) - p1.y : snap(p1.x + dxWorld) - p1.x;
  if (d === 0) return fallback();

  corners.splice(j + 1, 0, ...localNotchCorners(p1, p2, axis, d, quarter));
  return corners.slice(1, -1);
}

/** Remove the notch whose dip bottom is the run at `segIndex` (double-click to delete). No-op otherwise. */
export function deleteNotch(route: EdgeRoute, segIndex: number): Waypoint[] {
  const seg = route.segments[segIndex];
  if (!seg || seg.rigid) return route.waypoints.map((w) => ({ x: w.x, y: w.y }));
  const corners = editableCornersOf(route);
  const j = segIndex - 1;
  const p1 = corners[j];
  const p2 = corners[j + 1];
  if (!p1 || !p2) return route.waypoints.map((w) => ({ x: w.x, y: w.y }));
  if (!isDip(corners, j, p1.y === p2.y ? 'h' : 'v')) return corners.slice(1, -1);
  corners.splice(j - 1, 4);
  return corners.slice(1, -1);
}

function orientationOfSide(side: Side): 'h' | 'v' {
  return side === 'left' || side === 'right' ? 'h' : 'v';
}

export function chooseSides(src: Bbox, tgt: Bbox): { sourceSide: Side; targetSide: Side } {
  // Always exit/enter horizontally. Column-aligned ports only make sense horizontally,
  // so forcing left/right for every edge keeps routing predictable and aligned with column rows.
  const srcC = centerOf(src);
  const tgtC = centerOf(tgt);
  const dx = tgtC.x - srcC.x;
  return dx >= 0
    ? { sourceSide: 'right', targetSide: 'left' }
    : { sourceSide: 'left', targetSide: 'right' };
}

function centerOf(b: Bbox): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function portPoint(b: Bbox, side: Side, ratio: number, overrideY?: number, overrideX?: number): { x: number; y: number } {
  const r = Math.max(0.05, Math.min(0.95, ratio));
  switch (side) {
    case 'left':   return { x: b.x,           y: overrideY ?? b.y + b.h * r };
    case 'right':  return { x: b.x + b.w,     y: overrideY ?? b.y + b.h * r };
    case 'top':    return { x: overrideX ?? b.x + b.w * r, y: b.y };
    case 'bottom': return { x: overrideX ?? b.x + b.w * r, y: b.y + b.h };
  }
}
