import type { EdgeLayout, QualifiedName, Ref, Waypoint } from '../../shared/types';
import { densityMetrics } from '../layout/density';
import { boxesIntersect, cClearsEndpoints, chooseHorizontalSides, EDGE_CORNER_RADIUS, EDGE_STUB, effectiveEdgeLayout, narrowGapSJog, type PortRows } from '../layout/edgeSides';
import { isSelfRef } from './edgeKey';
import type { Bbox } from './spatialIndex';

export type Side = 'left' | 'right' | 'top' | 'bottom';

/**
 * Length (world units) of the RIGID stub that always leaves each table. The pieces
 * `source → sourceStub` and `targetStub → target` are immutable: never draggable, never
 * subdivided, never collapsed. They keep the connection point coherent (the `1` / crow's-foot
 * marker never sits flush against the table). All user editing happens strictly between the
 * two stub ends. Opposed stubs are clamped to a quarter of the port distance (`buildPath`), so
 * tables closer than `4*MIN_STUB` still keep the central half of the gap editable, except a gap under
 * `2*MIN_STUB` with rows a stub apart, which keeps both stubs full and draws the S (`narrowGapSJog`).
 */
const MIN_STUB = EDGE_STUB;

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

/** Room a loop stack keeps from a neighbouring node, and a facing Z trunk from a loop (`loopBlock`). */
const LOOP_CLEARANCE = EDGE_CORNER_RADIUS;
/** Innermost a clamped loop's trunk may sit: one fillet past its stub end. */
const LOOP_MIN_REACH = MIN_STUB + EDGE_CORNER_RADIUS;
/** Tightest spacing a clamped stack compresses to before it gives up keeping off the neighbour. */
const LOOP_MIN_STEP = LOOP_STEP / 2;

/** Outermost reach of a fully compressed stack of `stackSize` loops: the least room `clampedLoopReach` honours. */
const minStackReach = (stackSize: number): number => LOOP_MIN_REACH + Math.max(0, stackSize - 1) * LOOP_MIN_STEP;

/**
 * Reach of the loop of stack position `rank` among `stackSize`, when the side has `room` before the
 * nearest neighbouring node (`LOOP_CLEARANCE` already taken off). A stack that fits keeps the
 * `loopReach` layout; otherwise its outermost loop moves in to `room` and the rest follow at
 * `LOOP_STEP`, compressing to `LOOP_MIN_STEP` above `LOOP_MIN_REACH`. A stack that does not fit even
 * then stays at that most compressed layout, into the neighbour (spec 05 §Self-loops).
 */
export function clampedLoopReach(rank: number, stackSize: number, room: number): number {
  if (loopReach(stackSize) <= room) return loopReach(rank + 1);
  const steps = stackSize - 1;
  const step = steps > 0 ? Math.max(LOOP_MIN_STEP, Math.min(LOOP_STEP, (room - LOOP_MIN_REACH) / steps)) : 0;
  const outer = Math.max(room, LOOP_MIN_REACH + steps * step);
  return Math.round(outer - (steps - rank) * step);
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
  /** The stored shape is a legacy A* one the router ignored (`isLegacyAutoShape`); edits drop it first. */
  shapeIgnored?: true;
  /** Facing Z that made loops yield it a lane (spec 05 §1): A* leaves its shape to render. */
  laneClaim?: true;
  /** Loop pulled in for a passing Z: where its trunk returns once no Z claims, which A* must also keep off. */
  unyieldedTrunkX?: number;
}

/** Optional per-endpoint port override — used to align edges with the PK/FK column row. */
export type ColumnYResolver = (table: QualifiedName, column: string) => number | undefined;

/**
 * Names of the rendered nodes (tables, collapsed groups) that may overlap `box`; a superset is fine,
 * since exact bboxes come from `bboxOf`, and names it cannot resolve (group containers) are ignored.
 */
export type ObstacleQuery = (box: Bbox) => Iterable<QualifiedName>;

/** Resolves the EdgeLayout (waypoints + legacy dx/dy) for an edge, keyed by ref id. */
export type EdgeLayoutResolver = (refId: string) => EdgeLayout | undefined;

interface SideDecision {
  ref: Ref;
  srcBbox: Bbox;
  tgtBbox: Bbox;
  sourceSide: Side;
  targetSide: Side;
  /** The layout both the sides and the waypoints come from, legacy auto shapes already dropped. */
  layout: EdgeLayout | undefined;
  shapeIgnored: boolean;
}

/** An automatic C's decision with both ends mirrored when nesting flipped it (`nestTrunks`). */
function effectiveDecision(d: SideDecision | null, flipped: boolean): SideDecision | null {
  if (!d || !flipped) return d;
  const side = d.sourceSide === 'right' ? 'left' : 'right';
  return { ...d, sourceSide: side, targetSide: side };
}

/** One edge end sitting on a (table, side) port group. */
interface PortEntry {
  edgeIdx: number;
  role: 'source' | 'target';
  /** Far end's centre along the side's run (x on top/bottom, y on left/right): the group's sort key. */
  otherCenter: number;
  refId: string;
}

const portKey = (table: QualifiedName, side: Side): string => `${table}|${side}`;

/**
 * Port rows read at ratio ½ (column row when resolved, else the side's middle): what the zone rule
 * and trunk specs see, independent of port spreading.
 */
function halfRatioRows(r: Ref, srcBbox: Bbox, tgtBbox: Bbox, columnYResolver: ColumnYResolver | undefined): PortRows {
  const rowOf = (table: QualifiedName, column: string | undefined, b: Bbox): number => {
    const off = columnYResolver && column ? columnYResolver(table, column) : undefined;
    return off === undefined ? b.y + b.h * 0.5 : b.y + off;
  };
  return { source: rowOf(r.source.table, r.source.columns[0], srcBbox), target: rowOf(r.target.table, r.target.columns[0], tgtBbox) };
}

function decideSides(
  r: Ref,
  bboxOf: (name: QualifiedName) => Bbox | undefined,
  layoutResolver?: EdgeLayoutResolver,
  columnYResolver?: ColumnYResolver,
): SideDecision | null {
  const srcBbox = bboxOf(r.source.table);
  const tgtBbox = bboxOf(r.target.table);
  if (!srcBbox || !tgtBbox) return null;
  const stored = layoutResolver?.(r.id);
  if (isSelfRef(r)) {
    const side = loopSide(stored);
    return { ref: r, srcBbox, tgtBbox, sourceSide: side, targetSide: side, layout: stored, shapeIgnored: false };
  }
  // Filtered here, where both bboxes are known, and carried on the decision so `buildRoute` reads its
  // waypoints from the same layout the sides came from.
  const layout = effectiveEdgeLayout(stored, srcBbox, tgtBbox);
  // Only intersecting boxes need the rows (which C clears both tables); skip the lookups otherwise.
  const rows = boxesIntersect(srcBbox, tgtBbox) ? halfRatioRows(r, srcBbox, tgtBbox, columnYResolver) : undefined;
  const auto = chooseSides(srcBbox, tgtBbox, rows);
  return {
    ref: r,
    srcBbox,
    tgtBbox,
    layout,
    shapeIgnored: layout !== stored,
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

/** Port points of an edge: column-row anchored on left/right, else spread by `ratio` along the side. */
function resolvePorts(
  d: SideDecision,
  sourceRatio: number,
  targetRatio: number,
  columnYResolver: ColumnYResolver | undefined,
  rowHeight: number,
): { a: Point; b: Point } {
  if (isSelfRef(d.ref)) return loopPorts(d, sourceRatio, targetRatio, columnYResolver, rowHeight);
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
  return {
    a: portPoint(d.srcBbox, d.sourceSide, sourceRatio, sourceY),
    b: portPoint(d.tgtBbox, d.targetSide, targetRatio, targetY),
  };
}

const waypointsOf = (layout: EdgeLayout | undefined): Waypoint[] =>
  layout?.waypoints && layout.waypoints.length > 0 ? layout.waypoints : [];

const legacyDxOf = (layout: EdgeLayout | undefined): number =>
  waypointsOf(layout).length === 0 && layout?.dx !== undefined ? layout.dx : 0;

/** What `buildRoute` reads from the cache beyond the decision and its ports. */
interface RouteContext {
  /** Loop only: its trunk's reach, and the reach it would have if no Z claimed a lane. */
  loopReach: number;
  unyieldedReach: number;
  /** Automatic C only: its nested trunk (`nestTrunks`). */
  trunkX: number | undefined;
  /** Facing Z only: its trunk off loops (`loopBlock`), `undefined` keeping the midpoint. */
  placeZ: (lane: ZLane) => number | undefined;
  laneClaim: boolean;
}

function buildRoute(
  d: SideDecision,
  sourceRatio: number,
  targetRatio: number,
  columnYResolver: ColumnYResolver | undefined,
  rowHeight: number,
  ctx: RouteContext,
): EdgeRoute {
  const { a, b } = resolvePorts(d, sourceRatio, targetRatio, columnYResolver, rowHeight);
  if (isSelfRef(d.ref)) return buildLoopRoute(d, a, b, ctx.loopReach, ctx.unyieldedReach);

  const layout = d.layout;
  const waypoints = waypointsOf(layout);
  const legacyDx = legacyDxOf(layout);

  const sJog = narrowGapSJog(a, b, d.sourceSide, d.targetSide, d.srcBbox, d.tgtBbox);
  const lane = facingZLane(a, b, d.sourceSide, d.targetSide, waypoints, legacyDx, sJog, d.ref.source.table, d.ref.target.table);
  const zTrunkX = lane ? ctx.placeZ(lane) : undefined;
  const { corners, aStub, bStub } = buildPath(a, b, waypoints, legacyDx, d.sourceSide, d.targetSide, ctx.trunkX, sJog, zTrunkX);
  return {
    id: d.ref.id,
    d: roundedPathString(corners, CORNER_RADIUS),
    waypoints: waypoints.map((w) => ({ x: w.x, y: w.y })),
    segments: buildSegments(corners, waypoints),
    source: a,
    target: b,
    sourceStub: aStub,
    targetStub: bStub,
    ...(d.shapeIgnored ? { shapeIgnored: true as const } : {}),
    ...(ctx.laneClaim ? { laneClaim: true as const } : {}),
  };
}

/** A loop's two ports on its side; coinciding ports (same column) split ±¼ row to keep a visible trunk. */
function loopPorts(
  d: SideDecision,
  sourceRatio: number,
  targetRatio: number,
  columnYResolver: ColumnYResolver | undefined,
  rowHeight: number,
): { a: Point; b: Point } {
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
  return { a, b };
}

const loopTrunkX = (side: Side, port: Point, reach: number): number => port.x + STUB_DIR[side].x * reach;

/**
 * A self-loop leaves its source column's port, runs out `reach` past the side (`clampedLoopReach`),
 * down (or up) to the target column's row and back in on the same side.
 */
function buildLoopRoute(d: SideDecision, a: Point, b: Point, reach: number, unyieldedReach: number): EdgeRoute {
  const side = d.sourceSide;
  const dir = STUB_DIR[side].x;
  const aStub = { x: a.x + dir * MIN_STUB, y: a.y };
  const bStub = { x: b.x + dir * MIN_STUB, y: b.y };
  const farX = loopTrunkX(side, a, reach);
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
    ...(unyieldedReach > reach ? { unyieldedTrunkX: loopTrunkX(side, a, unyieldedReach) } : {}),
  };
}

/** Vertical distance between a loop's two column rows; unresolved columns count as 0. */
function loopSpan(r: Ref, columnYResolver: ColumnYResolver | undefined): number {
  if (!columnYResolver) return 0;
  const off = (cols: string[]) => (cols[0] ? columnYResolver(r.source.table, cols[0]) : undefined) ?? 0;
  return Math.abs(off(r.target.columns) - off(r.source.columns));
}

/**
 * The vertical run a loop or an automatic C occupies beside its tables, in side-local coordinates:
 * `x` grows outward from the side (world x on the right, −x on the left), so one nesting pass serves
 * both sides.
 */
interface TrunkSpec {
  side: 'left' | 'right';
  /** Nearest table border the route leaves from (local x): its arms run from here to the trunk. */
  inner: number;
  lo: number;
  hi: number;
  /** Loop: its fixed trunk (local x). C: undefined, placed by `nestTrunks`. */
  fixed?: number;
  /** C only: the closest its trunk may sit (local x), past its own tables' stubs and loops. */
  floor: number;
  span: number;
  refId: string;
  tables: readonly [QualifiedName, QualifiedName];
  /** Automatic C only: the mirrored C it falls back to when a third node blocks this side. */
  alt?: { side: 'left' | 'right'; inner: number; floor: number };
}

const localX = (side: 'left' | 'right', x: number): number => (side === 'right' ? x : -x);

/** The world box a self-loop's arms and trunk enclose beside its table: `x0..x1` × its rows `lo..hi`. */
export interface LoopEnvelope {
  x0: number;
  x1: number;
  lo: number;
  hi: number;
  table: QualifiedName;
  side: 'left' | 'right';
}

function envelopeOf(t: TrunkSpec): LoopEnvelope | null {
  if (t.fixed === undefined) return null;
  const inner = localX(t.side, t.inner);
  const trunk = localX(t.side, t.fixed);
  return { x0: Math.min(inner, trunk), x1: Math.max(inner, trunk), lo: t.lo, hi: t.hi, table: t.tables[0], side: t.side };
}

const sameEnvelope = (p: LoopEnvelope | null | undefined, q: LoopEnvelope | null | undefined): boolean =>
  p === q || (!!p && !!q && p.x0 === q.x0 && p.x1 === q.x1 && p.lo === q.lo && p.hi === q.hi && p.table === q.table && p.side === q.side);

/** The beside-the-side run of a loop, independent of its reach: border x and its two port rows. */
interface LoopRun {
  border: number;
  lo: number;
  hi: number;
}

/**
 * Where a facing Z may put its vertical trunk: strictly between its stub ends (`lo`..`hi`), over its
 * two port rows. `mid` is the default trunk; `source`/`target` are its own tables.
 */
export interface ZLane {
  lo: number;
  hi: number;
  yLo: number;
  yHi: number;
  mid: number;
  source: QualifiedName;
  target: QualifiedName;
}

/**
 * Stub length of a route: opposed stubs on one axis take at most a quarter of the port distance each,
 * so close tables keep the central half of the gap as an editable middle instead of two stubs meeting
 * in a rigid line. Sub-pixel quarters stay fractional so neither stub collapses onto the table border.
 * Same-direction or perpendicular stubs can never cross, and clamping them would collapse them too
 * (F52). A narrow gap with room for a jog keeps both stubs full instead (the S, `narrowS`).
 */
function stubLength(a: Point, b: Point, dirA: Point, dirB: Point, narrowS: boolean): number {
  const opposed = dirA.x === -dirB.x && dirA.y === -dirB.y;
  const gap = dirA.x !== 0 ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
  const quarter = gap / 4;
  return opposed && !narrowS ? Math.min(MIN_STUB, quarter >= 1 ? Math.floor(quarter) : quarter) : MIN_STUB;
}

/**
 * The lane of a facing Z drawn by default (no waypoints, no legacy `dx`, not the narrow-gap S) whose
 * rows differ, else `undefined`: the only routes whose trunk keeps off loops
 * (`defaultEditableCorners`). The one definition shared by the drawn trunk and the lane claim.
 */
function facingZLane(
  a: Point,
  b: Point,
  sourceSide: Side,
  targetSide: Side,
  waypoints: readonly Waypoint[],
  legacyDx: number,
  sJog: number | undefined,
  source: QualifiedName,
  target: QualifiedName,
): ZLane | undefined {
  if (waypoints.length > 0 || legacyDx !== 0 || sJog !== undefined || a.y === b.y) return undefined;
  const dirA = STUB_DIR[sourceSide];
  const dirB = STUB_DIR[targetSide];
  if (dirA.y !== 0 || dirB.y !== 0 || dirA.x === dirB.x) return undefined;
  const len = stubLength(a, b, dirA, dirB, false);
  const ax = a.x + dirA.x * len;
  const bx = b.x + dirB.x * len;
  if ((bx - ax) * dirA.x <= 0) return undefined;
  return { lo: Math.min(ax, bx), hi: Math.max(ax, bx), yLo: Math.min(a.y, b.y), yHi: Math.max(a.y, b.y), mid: midpointBetween(ax, bx), source, target };
}

/**
 * The open x range a loop keeps a facing Z's trunk out of, when it reaches into `lane` over its rows:
 * a third table's whole envelope, but only the trunk of a loop on one of the Z's own tables, whose
 * port arm has to cross that envelope anyway. Both widened by `LOOP_CLEARANCE`.
 */
function loopBlock(e: LoopEnvelope, lane: ZLane): [number, number] | null {
  if (e.hi < lane.yLo || e.lo > lane.yHi) return null;
  const own = e.table === lane.source || e.table === lane.target;
  const trunk = e.side === 'right' ? e.x1 : e.x0;
  const x0 = (own ? trunk : e.x0) - LOOP_CLEARANCE;
  const x1 = (own ? trunk : e.x1) + LOOP_CLEARANCE;
  return x1 > lane.lo && x0 < lane.hi ? [x0, x1] : null;
}

/**
 * Where a facing Z's trunk goes among loop `envelopes` (spec 05 §1 "Z frente a lazos"): `'clear'` keeps
 * `mid`; else the free x nearest `mid`, strictly inside the lane and outside every `loopBlock`;
 * `'stuck'` when the lane has none.
 */
export function placeZTrunk(lane: ZLane, envelopes: Iterable<LoopEnvelope>): 'clear' | 'stuck' | { x: number } {
  const blocks: Array<[number, number]> = [];
  for (const e of envelopes) {
    const b = loopBlock(e, lane);
    if (b) blocks.push(b);
  }
  const blocked = (x: number) => blocks.some(([x0, x1]) => x > x0 && x < x1);
  if (!blocked(lane.mid)) return 'clear';
  let best: number | undefined;
  for (const [x0, x1] of blocks) {
    for (const c of [Math.floor(x0), Math.ceil(x1)]) {
      if (c <= lane.lo || c >= lane.hi || blocked(c)) continue;
      const d = Math.abs(c - lane.mid);
      if (best === undefined || d < Math.abs(best - lane.mid) || (d === Math.abs(best - lane.mid) && c < best)) best = c;
    }
  }
  return best === undefined ? 'stuck' : { x: best };
}

/** The loops on one (table, side), in stack order, with what decides their reach. */
interface LoopStack {
  table: QualifiedName;
  side: 'left' | 'right';
  /** Edge indices by rank (innermost first). */
  loops: number[];
  /** Room before the nearest node beside the side, `LOOP_CLEARANCE` taken off (`loopRoom`). */
  neighbourRoom: number;
  /** Outer reach each claiming facing Z leaves room for, by Z edge index. */
  claims: Map<number, number>;
  /** Superset of every envelope the stack can draw at any reach, inflated by `LOOP_CLEARANCE`; null when hidden. */
  band: Band | null;
}

/** World box open in x, closed in y (matching `loopBlock`). */
interface Band {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const laneBand = (l: ZLane): Band => ({ x0: l.lo, x1: l.hi, y0: l.yLo, y1: l.yHi });
const bandsMeet = (p: Band, q: Band): boolean => p.x1 > q.x0 && p.x0 < q.x1 && p.y1 >= q.y0 && p.y0 <= q.y1;

const LANE_CELL = 512;

/**
 * Facing-Z lanes by edge index, bucketed by x: which Zs a changed loop envelope or stack band can
 * reach, without scanning every route on each drag frame. Wide lanes span several buckets.
 */
class LaneGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly lanes = new Map<number, ZLane>();

  public clear(): void {
    this.cells.clear();
    this.lanes.clear();
  }

  public set(i: number, lane: ZLane | null): void {
    const old = this.lanes.get(i);
    if (old === lane || (old && lane && old.lo === lane.lo && old.hi === lane.hi && old.yLo === lane.yLo && old.yHi === lane.yHi)) {
      if (lane) this.lanes.set(i, lane);
      return;
    }
    if (old) {
      for (let c = Math.floor(old.lo / LANE_CELL); c <= Math.floor(old.hi / LANE_CELL); c++) {
        const list = this.cells.get(c)!;
        list.splice(list.indexOf(i), 1);
        if (list.length === 0) this.cells.delete(c);
      }
      this.lanes.delete(i);
    }
    if (!lane) return;
    this.lanes.set(i, lane);
    for (let c = Math.floor(lane.lo / LANE_CELL); c <= Math.floor(lane.hi / LANE_CELL); c++) {
      const list = this.cells.get(c);
      if (list) list.push(i);
      else this.cells.set(c, [i]);
    }
  }

  /** Adds to `out` every edge whose lane meets `box`. */
  public collect(box: Band, out: Set<number>): void {
    for (let c = Math.floor(box.x0 / LANE_CELL); c <= Math.floor(box.x1 / LANE_CELL); c++) {
      for (const i of this.cells.get(c) ?? []) if (!out.has(i) && bandsMeet(laneBand(this.lanes.get(i)!), box)) out.add(i);
    }
  }
}

function finalRoomOf(s: LoopStack): number {
  let room = s.neighbourRoom;
  for (const r of s.claims.values()) if (r < room) room = r;
  return room;
}

/** Whether a C on `side` with its trunk at local `x` keeps clear of every third node (`EdgeRouteCache.trunkFits`). */
type TrunkFits = (t: TrunkSpec, side: 'left' | 'right', inner: number, x: number) => boolean;

interface PlacedTrunk {
  x: number;
  inner: number;
  lo: number;
  hi: number;
}

/** `floor` pushed `LOOP_STEP` past every placed run on the side it would otherwise touch. */
function nestedSlot(placed: readonly PlacedTrunk[], floor: number, t: TrunkSpec): number {
  let x = floor;
  const near = placed.filter((p) => p.lo <= t.hi && t.lo <= p.hi).sort((p, q) => p.x - q.x);
  for (const p of near) if (p.inner <= x && p.x + LOOP_STEP > x) x = p.x + LOOP_STEP;
  return x;
}

/**
 * Places every automatic C trunk (spec 05 §1 "Anidado de C"). Loops are fixed and go in first; Cs
 * follow shortest vertical span first (ties by ref id, then index: never the refs[] order), each at
 * its floor pushed `LOOP_STEP` past any already-placed trunk it would otherwise touch. "Touch" means
 * the vertical extents overlap and the other run's arms start inside this trunk's reach; candidates
 * are visited by ascending trunk so a single pass settles each C. An automatic C whose slot would
 * reach a third node takes its mirrored slot instead when that one is clear (`flip`); with both
 * blocked it keeps its own side. Returns world x per edge index.
 */
function nestTrunks(
  specs: ReadonlyArray<TrunkSpec | null>,
  fits: TrunkFits | undefined,
): { x: Array<number | undefined>; flip: boolean[] } {
  const x: Array<number | undefined> = specs.map(() => undefined);
  const flip = specs.map(() => false);
  const placed: Record<'left' | 'right', PlacedTrunk[]> = { left: [], right: [] };
  const cs: number[] = [];
  specs.forEach((t, i) => {
    if (!t) return;
    if (t.fixed !== undefined) placed[t.side].push({ x: t.fixed, inner: t.inner, lo: t.lo, hi: t.hi });
    else cs.push(i);
  });
  cs.sort((p, q) => {
    const a = specs[p]!;
    const b = specs[q]!;
    return (a.span - b.span) || (a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0) || (p - q);
  });
  for (const i of cs) {
    const t = specs[i]!;
    let side = t.side;
    let inner = t.inner;
    let at = nestedSlot(placed[side], t.floor, t);
    if (fits && t.alt && !fits(t, side, inner, at)) {
      const altAt = nestedSlot(placed[t.alt.side], t.alt.floor, t);
      if (fits(t, t.alt.side, t.alt.inner, altAt)) {
        side = t.alt.side;
        inner = t.alt.inner;
        at = altAt;
        flip[i] = true;
      }
    }
    placed[side].push({ x: at, inner, lo: t.lo, hi: t.hi });
    x[i] = localX(side, at);
  }
  return { x, flip };
}

/**
 * Routing state kept between calls so a table drag re-routes only what the move can change
 * (spec 04, "Commit del drag por frame"): the refs touching a moved table, plus every ref sharing a
 * port group (table + side) with one of them — the stubs on a side are spread by sorting the group,
 * so a moved far end can reorder (and re-space) its siblings. Every other route keeps its identity.
 */
export class EdgeRouteCache {
  private refs: readonly Ref[] = [];
  /** Sides before any C flip: what nesting reads, so a flip never feeds back into its own cause. */
  private baseDecisions: Array<SideDecision | null> = [];
  /** What is drawn: `baseDecisions` with each flipped C mirrored. */
  private decisions: Array<SideDecision | null> = [];
  private flipped: boolean[] = [];
  private sourceRatio: number[] = [];
  private targetRatio: number[] = [];
  private routes: Array<EdgeRoute | null> = [];
  /** Stack position of each loop among the loops on its table side; 0 for every other ref. */
  private loopRank: number[] = [];
  /** Each loop's drawn reach: `clampedLoopReach` under its stack's final room; 0 for every other ref. */
  private loopReachAt: number[] = [];
  /** Each loop's reach off its neighbours alone, before any Z claim: what claims are decided against. */
  private preReachAt: number[] = [];
  private loopIdx: number[] = [];
  private loopRunAt: Array<LoopRun | null> = [];
  private preEnvelopeAt: Array<LoopEnvelope | null> = [];
  /** Loop envelopes by edge index (null for non-loops): what a facing Z trunk keeps off. */
  private envelopeAt: Array<LoopEnvelope | null> = [];
  /** Loops per (table, side), by `portKey`: a C on that side keeps its trunk outside all of them. */
  private readonly stacks = new Map<string, LoopStack>();
  private stackOf: Array<LoopStack | undefined> = [];
  private readonly stackedTables = new Set<QualifiedName>();
  /** Stacks with a band, sorted by `band.x0`: the lane lookup (`stacksNear`). */
  private stackIndex: LoopStack[] = [];
  private maxBandW = 0;
  /** Lane each facing Z could claim (`claimLaneOf`); only kept with an obstacle query and loops. */
  private zLaneAt: Array<ZLane | null> = [];
  /** Lane of every drawn facing Z, claiming or not (`build`): what a changed envelope or band can reach. */
  private readonly laneGrid = new LaneGrid();
  /** Stacks each claiming Z made yield, by Z edge index. */
  private readonly claimedBy = new Map<number, LoopStack[]>();
  private trunkSpecs: Array<TrunkSpec | null> = [];
  private trunkX: Array<number | undefined> = [];
  private rowHeight = DEFAULT_ROW_HEIGHT;
  private bboxOf: (name: QualifiedName) => Bbox | undefined = () => undefined;
  private obstacles: ObstacleQuery | undefined;
  private readonly ports = new Map<string, PortEntry[]>();
  private readonly edgesByTable = new Map<QualifiedName, number[]>();
  private out: EdgeRoute[] = [];

  /** Facing Zs currently holding a lane claim (perf tests prove the scenario exercises claims). */
  public get claimCount(): number {
    return this.claimedBy.size;
  }

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
   * `rowHeight` (the density's) only splits the ports of a same-column self-loop. Without
   * `obstacles` no automatic C ever flips sides (spec 05 §1 "Anidado de C") and no loop stack
   * yields a lane to a facing Z (§Self-loops).
   *
   * One pass, no feedback: loop reach off neighbours (pre-reach) → Z lane claims, read only from
   * pre-reach envelopes and base decisions → final loop reach → trunk specs, nesting, ports, routes.
   * A claim only ever lowers a reach, so it can never block another Z's lane.
   */
  public routeAll(
    refs: readonly Ref[],
    bboxOf: (name: QualifiedName) => Bbox | undefined,
    columnYResolver?: ColumnYResolver,
    layoutResolver?: EdgeLayoutResolver,
    rowHeight: number = DEFAULT_ROW_HEIGHT,
    obstacles?: ObstacleQuery,
  ): EdgeRoute[] {
    this.refs = refs;
    this.rowHeight = rowHeight;
    this.bboxOf = bboxOf;
    this.obstacles = obstacles;
    this.rankLoops(columnYResolver, layoutResolver);
    this.baseDecisions = refs.map((r) => decideSides(r, bboxOf, layoutResolver, columnYResolver));
    this.loopRunAt = refs.map(() => null);
    for (const i of this.loopIdx) this.loopRunAt[i] = this.loopRunOf(i, columnYResolver);
    this.preReachAt = refs.map(() => 0);
    this.preEnvelopeAt = refs.map(() => null);
    for (const s of this.stacks.values()) {
      this.refreshStack(s, null, true);
      s.band = this.bandOf(s);
    }
    this.rebuildStackIndex();
    this.zLaneAt = [];
    this.claimedBy.clear();
    if (obstacles && this.stacks.size > 0) {
      this.zLaneAt = refs.map((_, i) => this.claimLaneOf(i, columnYResolver));
      this.zLaneAt.forEach((lane, i) => { if (lane) this.updateClaim(i); });
    }
    this.loopReachAt = refs.map(() => 0);
    this.finalReach(null);
    this.trunkSpecs = this.baseDecisions.map((_, i) => this.trunkSpecOf(i, columnYResolver));
    this.envelopeAt = this.trunkSpecs.map((t) => (t ? envelopeOf(t) : null));
    const nest = nestTrunks(this.trunkSpecs, obstacles ? this.trunkFits : undefined);
    this.trunkX = nest.x;
    this.flipped = nest.flip;
    this.decisions = this.baseDecisions.map((d, i) => effectiveDecision(d, this.flipped[i]!));
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
    this.laneGrid.clear();
    this.routes = this.decisions.map((_, i) => this.build(i, columnYResolver));
    return this.collect();
  }

  /**
   * Re-routes after only the tables in `moved` changed position, with every other input (refs, sizes,
   * rows, layouts, the obstacle query) identical to the last call. Returns the previous array when no
   * ref is affected.
   */
  public routeMoved(
    moved: Iterable<QualifiedName>,
    bboxOf: (name: QualifiedName) => Bbox | undefined,
    columnYResolver?: ColumnYResolver,
    layoutResolver?: EdgeLayoutResolver,
  ): EdgeRoute[] {
    this.bboxOf = bboxOf;
    const movedNames = new Set(moved);
    const affected = new Set<number>();
    let stackMoved = false;
    for (const t of movedNames) {
      for (const i of this.edgesByTable.get(t) ?? []) affected.add(i);
      if (this.stackedTables.has(t)) stackMoved = true;
    }
    const decided = new Set<number>();
    const dirty = new Set<number>();
    // Any moved node, even one no ref touches, can crowd or free a loop stack's side.
    if (this.stacks.size > 0 && (this.obstacles || stackMoved)) {
      this.updateLoops(movedNames, stackMoved, affected, decided, dirty, columnYResolver, layoutResolver);
    }
    // Any moved node, even one no ref touches, can block or clear an automatic C's side.
    const flippable = this.obstacles !== undefined && this.trunkSpecs.some((t) => t?.alt !== undefined);
    if (affected.size === 0 && dirty.size === 0 && !flippable) return this.out;

    // A trunk's nest depends on every loop/C it may touch, anywhere, and on the third nodes beside it:
    // when any of them changed, re-nest all. Specs read base sides, column rows and bboxes only (never
    // port ratios or flips), so unaffected specs are unchanged and this equals a full rebuild.
    let nestInputChanged = flippable;
    const changedEnvelopes: LoopEnvelope[] = [];
    for (const i of affected) {
      if (!decided.has(i)) this.baseDecisions[i] = decideSides(this.refs[i]!, bboxOf, layoutResolver, columnYResolver);
      const next = this.trunkSpecOf(i, columnYResolver);
      if (next || this.trunkSpecs[i]) nestInputChanged = true;
      this.trunkSpecs[i] = next;
      const env = next ? envelopeOf(next) : null;
      const old = this.envelopeAt[i];
      if (!sameEnvelope(env, old)) {
        if (old) changedEnvelopes.push(old);
        if (env) changedEnvelopes.push(env);
        this.envelopeAt[i] = env;
      }
    }
    const resided = new Set<number>(affected);
    for (const i of affected) dirty.add(i);
    // A facing Z elsewhere may have slid off (or may now return from) a loop that moved. Every other
    // route ignores envelopes, and a Z's lane only moves with its own tables (then it is in `affected`).
    for (const e of changedEnvelopes) {
      this.laneGrid.collect({ x0: e.x0 - LOOP_CLEARANCE, x1: e.x1 + LOOP_CLEARANCE, y0: e.lo, y1: e.hi }, dirty);
    }
    if (nestInputChanged) {
      const next = nestTrunks(this.trunkSpecs, this.obstacles ? this.trunkFits : undefined);
      next.x.forEach((x, i) => { if (x !== this.trunkX[i]) dirty.add(i); });
      next.flip.forEach((f, i) => { if (f !== this.flipped[i]) resided.add(i); });
      this.trunkX = next.x;
      this.flipped = next.flip;
    }

    const touched = new Set<string>();
    for (const i of resided) {
      const old = this.decisions[i];
      if (old) {
        this.removePorts(portKey(old.ref.source.table, old.sourceSide), i, touched);
        this.removePorts(portKey(old.ref.target.table, old.targetSide), i, touched);
      }
      const d = effectiveDecision(this.baseDecisions[i] ?? null, this.flipped[i]!);
      this.decisions[i] = d;
      if (d) this.addPorts(d, i, touched);
      dirty.add(i);
    }
    for (const key of touched) this.spreadPorts(key, dirty);
    for (const i of dirty) this.routes[i] = this.build(i, columnYResolver);
    return this.collect();
  }

  /**
   * The loop half of `routeMoved`, in `routeAll`'s order: base decisions of the moved tables' refs,
   * every stack's neighbour room and pre-reach (one obstacle query per stack, as collapsed-group
   * boxes can change without their name in `moved`), then the claims of the Zs whose lane moved or
   * meets a stack band that changed, then every loop's final reach. Loops whose reach changed join
   * `affected`; Zs whose claim changed join `dirty`.
   */
  private updateLoops(
    moved: ReadonlySet<QualifiedName>,
    stackMoved: boolean,
    affected: Set<number>,
    decided: Set<number>,
    dirty: Set<number>,
    columnYResolver: ColumnYResolver | undefined,
    layoutResolver: EdgeLayoutResolver | undefined,
  ): void {
    for (const i of affected) {
      this.baseDecisions[i] = decideSides(this.refs[i]!, this.bboxOf, layoutResolver, columnYResolver);
      decided.add(i);
      if (this.stackOf[i]) this.loopRunAt[i] = this.loopRunOf(i, columnYResolver);
    }
    const changedBands: Band[] = [];
    const preChanged = new Set<number>();
    for (const s of this.stacks.values()) {
      const tableMoved = moved.has(s.table);
      if (!this.obstacles && !tableMoved) continue;
      const old = s.band;
      const envChanged = this.refreshStack(s, preChanged, tableMoved);
      if (tableMoved) s.band = this.bandOf(s);
      if (tableMoved || envChanged) {
        if (old) changedBands.push(old);
        if (s.band && s.band !== old) changedBands.push(s.band);
      }
    }
    if (stackMoved) this.rebuildStackIndex();
    for (const i of preChanged) affected.add(i);
    if (!this.obstacles) return;
    if (this.zLaneAt.length > 0) {
      const zDirty = new Set<number>();
      for (const i of decided) {
        const had = this.zLaneAt[i] ?? null;
        const lane = this.claimLaneOf(i, columnYResolver);
        this.zLaneAt[i] = lane;
        if (had || lane) zDirty.add(i);
      }
      // A claim lane is its Z's drawn lane (same ports), so the grid finds the claims a band can change.
      const near = new Set<number>();
      for (const b of changedBands) this.laneGrid.collect(b, near);
      for (const z of near) if (this.zLaneAt[z]) zDirty.add(z);
      for (const z of zDirty) if (this.updateClaim(z)) dirty.add(z);
    }
    this.finalReach(affected);
  }

  private build(i: number, columnYResolver: ColumnYResolver | undefined): EdgeRoute | null {
    const d = this.decisions[i];
    let lane: ZLane | null = null;
    const route = d
      ? buildRoute(d, this.sourceRatio[i]!, this.targetRatio[i]!, columnYResolver, this.rowHeight, {
        loopReach: this.loopReachAt[i]!,
        unyieldedReach: this.preReachAt[i]!,
        trunkX: this.trunkX[i],
        placeZ: (l) => {
          lane = l;
          return this.placeZ(l);
        },
        laneClaim: this.claimedBy.has(i),
      })
      : null;
    this.laneGrid.set(i, lane);
    return route;
  }

  private readonly placeZ = (lane: ZLane): number | undefined => {
    if (this.stackIndex.length === 0) return undefined;
    const placed = placeZTrunk(lane, this.envelopesNear(lane, this.envelopeAt));
    return typeof placed === 'object' ? placed.x : undefined;
  };

  /** Envelopes from `source` (pre-claim or final) of the loops whose stack band meets `lane`. */
  private envelopesNear(lane: ZLane, source: ReadonlyArray<LoopEnvelope | null>): LoopEnvelope[] {
    const out: LoopEnvelope[] = [];
    for (const s of this.stacksNear(laneBand(lane))) {
      for (const i of s.loops) {
        const e = source[i];
        if (e) out.push(e);
      }
    }
    return out;
  }

  /** Stacks whose band meets `box`: a binary search on `band.x0`, then the exact test. */
  private stacksNear(box: Band): LoopStack[] {
    const idx = this.stackIndex;
    const from = box.x0 - this.maxBandW;
    let lo = 0;
    let hi = idx.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (idx[mid]!.band!.x0 <= from) lo = mid + 1;
      else hi = mid;
    }
    const out: LoopStack[] = [];
    for (let k = lo; k < idx.length && idx[k]!.band!.x0 < box.x1; k++) {
      if (bandsMeet(idx[k]!.band!, box)) out.push(idx[k]!);
    }
    return out;
  }

  private rebuildStackIndex(): void {
    const idx: LoopStack[] = [];
    let w = 0;
    for (const s of this.stacks.values()) {
      if (!s.band) continue;
      idx.push(s);
      w = Math.max(w, s.band.x1 - s.band.x0);
    }
    this.stackIndex = idx.sort((p, q) => p.band!.x0 - q.band!.x0);
    this.maxBandW = w;
  }

  private bandOf(s: LoopStack): Band | null {
    let border: number | undefined;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const i of s.loops) {
      const run = this.loopRunAt[i];
      if (!run) continue;
      border = run.border;
      y0 = Math.min(y0, run.lo);
      y1 = Math.max(y1, run.hi);
    }
    if (border === undefined) return null;
    // `clampedLoopReach` never exceeds `loopReach(n)`, so the band covers every reach a claim leaves.
    const far = loopReach(s.loops.length) + LOOP_CLEARANCE;
    return s.side === 'right'
      ? { x0: border - LOOP_CLEARANCE, x1: border + far, y0, y1 }
      : { x0: border - far, x1: border + LOOP_CLEARANCE, y0, y1 };
  }

  private loopRunOf(i: number, columnYResolver: ColumnYResolver | undefined): LoopRun | null {
    const d = this.baseDecisions[i];
    if (!d) return null;
    const { a, b } = resolvePorts(d, 0.5, 0.5, columnYResolver, this.rowHeight);
    return { border: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) };
  }

  /**
   * Re-reads a stack's neighbour room and, when it or the table (`moved`) changed, sets its loops'
   * pre-reach and pre-envelope. Records in `preChanged` every loop whose pre-reach moved; returns
   * whether any pre-envelope changed.
   */
  private refreshStack(s: LoopStack, preChanged: Set<number> | null, moved: boolean): boolean {
    const n = s.loops.length;
    const room = this.loopRoom(s.table, s.side, n);
    if (room === s.neighbourRoom && !moved) return false;
    s.neighbourRoom = room;
    let changed = false;
    for (let rank = 0; rank < n; rank++) {
      const i = s.loops[rank]!;
      const reach = clampedLoopReach(rank, n, room);
      if (reach !== this.preReachAt[i]) {
        this.preReachAt[i] = reach;
        preChanged?.add(i);
      }
      const run = this.loopRunAt[i];
      const old = this.preEnvelopeAt[i];
      if (!run) {
        if (old) changed = true;
        this.preEnvelopeAt[i] = null;
        continue;
      }
      const x0 = s.side === 'right' ? run.border : run.border - reach;
      const x1 = s.side === 'right' ? run.border + reach : run.border;
      if (old && old.x0 === x0 && old.x1 === x1 && old.lo === run.lo && old.hi === run.hi) continue;
      this.preEnvelopeAt[i] = { x0, x1, lo: run.lo, hi: run.hi, table: s.table, side: s.side };
      changed = true;
    }
    return changed;
  }

  /**
   * Lane of edge `i` when it is a facing Z drawn by default with both column rows resolved, else
   * null. Read from its base decision at the column rows, exactly the ports `buildRoute` resolves, so
   * the lane claimed is the lane later slid in. An unresolved column's port follows port spreading,
   * which the claims must not read, so such a Z never claims (it still slides).
   */
  private claimLaneOf(i: number, columnYResolver: ColumnYResolver | undefined): ZLane | null {
    const d = this.baseDecisions[i];
    if (!d || !columnYResolver || this.stackOf[i]) return null;
    const horizontal = (s: Side) => s === 'left' || s === 'right';
    if (!horizontal(d.sourceSide) || !horizontal(d.targetSide) || d.sourceSide === d.targetSide) return null;
    const sCol = d.ref.source.columns[0];
    const tCol = d.ref.target.columns[0];
    const sOff = sCol ? columnYResolver(d.ref.source.table, sCol) : undefined;
    const tOff = tCol ? columnYResolver(d.ref.target.table, tCol) : undefined;
    if (sOff === undefined || tOff === undefined) return null;
    const a = portPoint(d.srcBbox, d.sourceSide, 0.5, d.srcBbox.y + sOff);
    const b = portPoint(d.tgtBbox, d.targetSide, 0.5, d.tgtBbox.y + tOff);
    const sJog = narrowGapSJog(a, b, d.sourceSide, d.targetSide, d.srcBbox, d.tgtBbox);
    const layout = d.layout;
    return facingZLane(a, b, d.sourceSide, d.targetSide, waypointsOf(layout), legacyDxOf(layout), sJog, d.ref.source.table, d.ref.target.table) ?? null;
  }

  /**
   * The stacks a facing Z makes yield, with the outer reach each may keep (spec 05 §Self-loops "Carril
   * para Z ajenas"); null when it claims nothing. It claims only when its lane has no free x among the
   * pre-reach envelopes, and then aims its trunk at `free`, 1 px inside the lane's far end (`placeZTrunk`
   * candidates are `ceil`/`floor` with strict bounds, so fractional positions also work). Yielding
   * stacks: every blocking one, and every stack of the Z's own tables whose trunk could come within
   * `LOOP_CLEARANCE` of `free` at any reach. The latter is load-bearing: a claim only lowers reaches,
   * which shrinks a third table's envelope but slides an own trunk inward, so another Z's claim could
   * otherwise park it on `free`; claimed here, its trunk stays at most `room` out. Each yielding stack
   * must face the lane from the claim's side with its table at the lane's near end and compress to its
   * `room` (`free` less `LOOP_CLEARANCE`); otherwise nothing yields and the trunk keeps its midpoint.
   */
  private claimFor(lane: ZLane): Array<[LoopStack, number]> | null {
    if (placeZTrunk(lane, this.envelopesNear(lane, this.preEnvelopeAt)) !== 'stuck') return null;
    const near = this.stacksNear(laneBand(lane));
    const blocks = (s: LoopStack) => s.loops.some((i) => {
      const e = this.preEnvelopeAt[i];
      return !!e && loopBlock(e, lane) !== null;
    });
    const side = near.find(blocks)?.side;
    if (!side) return null;
    const free = side === 'right' ? Math.ceil(lane.hi) - 1 : Math.floor(lane.lo) + 1;
    const out: Array<[LoopStack, number]> = [];
    for (const s of near) {
      const own = s.table === lane.source || s.table === lane.target;
      if (!blocks(s) && !(own && this.trunkMayReach(s, lane, free))) continue;
      const border = this.loopRunAt[s.loops[0]!]?.border;
      if (s.side !== side || border === undefined) return null;
      if (side === 'right' ? border > lane.lo : border < lane.hi) return null;
      const room = Math.floor(side === 'right' ? free - border - LOOP_CLEARANCE : border - LOOP_CLEARANCE - free);
      if (room < minStackReach(s.loops.length)) return null;
      out.push([s, room]);
    }
    return out;
  }

  /** Whether a loop of `s` over the lane's rows, at any reach from `LOOP_MIN_REACH` to its pre-reach, has its trunk within `LOOP_CLEARANCE` of `x`. */
  private trunkMayReach(s: LoopStack, lane: ZLane, x: number): boolean {
    const dir = s.side === 'right' ? 1 : -1;
    return s.loops.some((i) => {
      const run = this.loopRunAt[i];
      if (!run || run.hi < lane.yLo || run.lo > lane.yHi) return false;
      const d = (x - run.border) * dir;
      return d > LOOP_MIN_REACH - LOOP_CLEARANCE && d < this.preReachAt[i]! + LOOP_CLEARANCE;
    });
  }

  /** Re-decides Z `z`'s claim and moves it between stacks; returns whether it changed. */
  private updateClaim(z: number): boolean {
    const lane = this.zLaneAt[z];
    const next = lane ? this.claimFor(lane) : null;
    const old = this.claimedBy.get(z);
    let same = (old?.length ?? 0) === (next?.length ?? 0);
    for (const s of old ?? []) {
      if (same && !next?.some(([t, room]) => t === s && room === s.claims.get(z))) same = false;
      s.claims.delete(z);
    }
    if (next) {
      for (const [s, room] of next) s.claims.set(z, room);
      this.claimedBy.set(z, next.map(([s]) => s));
    } else {
      this.claimedBy.delete(z);
    }
    return !same;
  }

  /** Every loop's drawn reach under its stack's final room (neighbours and claims); changed loops join `affected`. */
  private finalReach(affected: Set<number> | null): void {
    for (const s of this.stacks.values()) {
      const n = s.loops.length;
      const room = s.claims.size > 0 ? finalRoomOf(s) : undefined;
      s.loops.forEach((i, rank) => {
        const reach = room === undefined ? this.preReachAt[i]! : clampedLoopReach(rank, n, room);
        if (reach === this.loopReachAt[i]) return;
        this.loopReachAt[i] = reach;
        affected?.add(i);
      });
    }
  }

  /**
   * A C trunk at local `x` on `side` is clear when no third node (never its own two tables) overlaps
   * the band from its nearest border to `x + MIN_STUB` across its vertical run: that band holds its
   * arms and trunk, and the `MIN_STUB` margin keeps the trunk out of the neighbour's own stub band.
   */
  private readonly trunkFits: TrunkFits = (t, side, inner, x) => {
    const query = this.obstacles;
    if (!query) return true;
    const reach = x + MIN_STUB;
    const box: Bbox = { x: side === 'right' ? inner : -reach, y: t.lo, w: reach - inner, h: t.hi - t.lo };
    for (const name of query(box)) {
      if (name === t.tables[0] || name === t.tables[1]) continue;
      const o = this.bboxOf(name);
      if (!o) continue;
      const near = side === 'right' ? o.x : -(o.x + o.w);
      const far = side === 'right' ? o.x + o.w : -o.x;
      if (near < reach && far > inner && o.y <= t.hi && o.y + o.h >= t.lo) return false;
    }
    return true;
  };

  /**
   * Builds the loop stacks: the loops sharing a table side nest with the shorter span inside so nested
   * loops never cross. Reads only refs, rows and layouts — never positions — so a drag never re-ranks.
   */
  private rankLoops(columnYResolver: ColumnYResolver | undefined, layoutResolver: EdgeLayoutResolver | undefined): void {
    this.loopRank = this.refs.map(() => 0);
    this.stacks.clear();
    this.stackedTables.clear();
    this.stackOf = this.refs.map(() => undefined);
    this.loopIdx = [];
    const bySide = new Map<string, number[]>();
    this.refs.forEach((r, i) => {
      if (!isSelfRef(r)) return;
      this.loopIdx.push(i);
      const key = portKey(r.source.table, loopSide(layoutResolver?.(r.id)));
      const list = bySide.get(key);
      if (list) list.push(i);
      else bySide.set(key, [i]);
    });
    for (const [key, list] of bySide) {
      const span = list.map((i) => loopSpan(this.refs[i]!, columnYResolver));
      const order = list.map((_, k) => k).sort((p, q) => {
        const a = this.refs[list[p]!]!.id;
        const b = this.refs[list[q]!]!.id;
        return (span[p]! - span[q]!) || (a < b ? -1 : a > b ? 1 : 0) || (list[p]! - list[q]!);
      });
      const loops = order.map((k) => list[k]!);
      loops.forEach((i, rank) => { this.loopRank[i] = rank; });
      const first = this.refs[loops[0]!]!;
      const s: LoopStack = { table: first.source.table, side: loopSide(layoutResolver?.(first.id)), loops, neighbourRoom: Infinity, claims: new Map(), band: null };
      this.stacks.set(key, s);
      this.stackedTables.add(s.table);
      for (const i of loops) this.stackOf[i] = s;
    }
  }

  /** Distance from `table`'s `side` to the nearest node level with it, less `LOOP_CLEARANCE`; Infinity when none is in reach. */
  private loopRoom(table: QualifiedName, side: 'left' | 'right', stackSize: number): number {
    const query = this.obstacles;
    const b = this.bboxOf(table);
    if (!query || !b) return Infinity;
    const band = loopReach(stackSize) + LOOP_CLEARANCE;
    const border = side === 'right' ? b.x + b.w : b.x;
    const box: Bbox = { x: side === 'right' ? border : border - band, y: b.y, w: band, h: b.h };
    let room = Infinity;
    for (const name of query(box)) {
      if (name === table) continue;
      const o = this.bboxOf(name);
      if (!o || o.y >= b.y + b.h || o.y + o.h <= b.y) continue;
      const dist = side === 'right' ? o.x - border : border - (o.x + o.w);
      // A node overlapping the table itself leaves no side to keep off.
      if (dist > 0 && dist < band) room = Math.min(room, dist - LOOP_CLEARANCE);
    }
    return room;
  }

  /**
   * What edge `i` occupies for trunk nesting, from its BASE decision: a loop's fixed run, or a C (same
   * left/right side on both ends, no waypoints, no legacy `dx`), whose floor clears its own tables'
   * stubs and sits `LOOP_STEP` past their farthest loop on that side (`loopReach(n + 1)`). A C whose
   * sides are automatic also carries its mirrored variant (`alt`). Anything else: null. Ports are
   * read at ratio ½ so the spec ignores port spreading, which flips change: column rows anchor every
   * left/right port, so only an unresolved column's run is approximate.
   */
  private trunkSpecOf(i: number, columnYResolver: ColumnYResolver | undefined): TrunkSpec | null {
    const d = this.baseDecisions[i];
    if (!d) return null;
    const side = d.sourceSide;
    if ((side !== 'left' && side !== 'right') || d.targetSide !== side) return null;
    const loop = isSelfRef(d.ref);
    if (!loop && (waypointsOf(d.layout).length > 0 || legacyDxOf(d.layout) !== 0)) return null;
    const { a, b } = resolvePorts(d, 0.5, 0.5, columnYResolver, this.rowHeight);
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    const tables = [d.ref.source.table, d.ref.target.table] as const;
    const base = { side, lo, hi, span: hi - lo, refId: d.ref.id, tables };
    if (loop) {
      const inner = localX(side, a.x);
      return { ...base, inner, fixed: localX(side, loopTrunkX(side, a, this.loopReachAt[i]!)), floor: 0 };
    }
    const reach = (table: QualifiedName, s: 'left' | 'right'): number => {
      const n = this.stacks.get(portKey(table, s))?.loops.length ?? 0;
      return n > 0 ? loopReach(n + 1) : MIN_STUB;
    };
    // Rounded in world space exactly as the unnested trunk was, so a C with no neighbours is unchanged.
    const variant = (s: 'left' | 'right') => {
      const border = (bb: Bbox) => (s === 'right' ? bb.x + bb.w : bb.x);
      const dir = STUB_DIR[s].x;
      const ends = [border(d.srcBbox) + dir * reach(d.ref.source.table, s), border(d.tgtBbox) + dir * reach(d.ref.target.table, s)];
      const floor = Math.round(s === 'right' ? Math.max(...ends) : Math.min(...ends));
      return { side: s, inner: Math.min(localX(s, border(d.srcBbox)), localX(s, border(d.tgtBbox))), floor: localX(s, floor) };
    };
    const own = variant(side);
    const other = side === 'right' ? 'left' : 'right';
    // Intersecting tables only mirror into a C that keeps out of both of them, like the zone rule.
    const mirrorable = d.layout?.sourceSide === undefined && d.layout?.targetSide === undefined
      && (!boxesIntersect(d.srcBbox, d.tgtBbox) || cClearsEndpoints(d.srcBbox, d.tgtBbox, other, { source: a.y, target: b.y }));
    return { ...base, ...own, ...(mirrorable ? { alt: variant(other) } : {}) };
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
      otherCenter: orientationOfSide(d.sourceSide) === 'v' ? tgtCenter.x : tgtCenter.y,
      refId: d.ref.id,
    });
    this.pushPort(tgtKey, {
      edgeIdx,
      role: 'target',
      otherCenter: orientationOfSide(d.targetSide) === 'v' ? srcCenter.x : srcCenter.y,
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
  obstacles?: ObstacleQuery,
): EdgeRoute[] {
  return new EdgeRouteCache().routeAll(refs, bboxOf, columnYResolver, layoutResolver, rowHeight, obstacles);
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
  trunkX?: number,
  sJog?: number,
  zTrunkX?: number,
): { corners: Point[]; aStub: Point; bStub: Point } {
  const dirA = STUB_DIR[sourceSide];
  const dirB = STUB_DIR[targetSide];
  // Geometry-only, so stored waypoints materialized from an S still meet the same stub ends.
  const stubLen = stubLength(a, b, dirA, dirB, sJog !== undefined);
  const aStub = { x: a.x + dirA.x * stubLen, y: a.y + dirA.y * stubLen };
  const bStub = { x: b.x + dirB.x * stubLen, y: b.y + dirB.y * stubLen };

  let editable: Point[];
  if (waypoints.length > 0) editable = cornersThrough(aStub, bStub, waypoints, dirA.y !== 0, dirB.y !== 0);
  else if (sJog !== undefined) editable = narrowGapSCorners(aStub, bStub, sJog);
  else editable = defaultEditableCorners(aStub, bStub, dirA, dirB, legacyDx, trunkX, zTrunkX);
  const corners = [{ x: a.x, y: a.y }, ...editable, { x: b.x, y: b.y }];
  return { corners, aStub, bStub };
}

/**
 * The dbdiagram S between crossed full stubs: down from `aStub`, across at `jogY`, down into `bStub`.
 * Three separate editable runs; the legacy `dx` has no single trunk to shift here.
 */
function narrowGapSCorners(aStub: Point, bStub: Point, jogY: number): Point[] {
  return [{ x: aStub.x, y: aStub.y }, { x: aStub.x, y: jogY }, { x: bStub.x, y: jogY }, { x: bStub.x, y: bStub.y }];
}

/**
 * Default editable corners between the stub ends. Both stubs horizontal ⇒ H-V-H around a vertical
 * trunk; both vertical ⇒ the V-H-V mirror; one of each ⇒ a single L elbow. Same-direction stubs get a
 * C-route whose trunk sits beyond the farther-reaching stub, so it never doubles back over a stub, or
 * at `nestedTrunkX` when the cache nested it outside loops and other Cs (`nestTrunks`). A facing Z
 * puts its trunk at `zTrunkX` when it slid off loops (`placeZTrunk`). Aligned opposed stubs still get the trunk's two (coincident) corners: the middle is split at its
 * midpoint into two runs, so either half can be slid or notched. The legacy `dx` offset only ever
 * applied to the horizontal-stub trunk.
 */
function defaultEditableCorners(
  aStub: Point,
  bStub: Point,
  dirA: Point,
  dirB: Point,
  legacyDx: number,
  nestedTrunkX?: number,
  zTrunkX?: number,
): Point[] {
  const aVertical = dirA.y !== 0;
  const bVertical = dirB.y !== 0;
  if (aVertical !== bVertical) {
    const elbow = aVertical ? { x: aStub.x, y: bStub.y } : { x: bStub.x, y: aStub.y };
    return [{ x: aStub.x, y: aStub.y }, elbow, { x: bStub.x, y: bStub.y }];
  }
  if (!aVertical) {
    const facing = dirA.x !== dirB.x && (bStub.x - aStub.x) * dirA.x > 0;
    const mid = midpointBetween(aStub.x, bStub.x);
    const trunk = dirA.x === dirB.x
      ? nestedTrunkX ?? Math.round(dirA.x > 0 ? Math.max(aStub.x, bStub.x) : Math.min(aStub.x, bStub.x))
      : (facing && legacyDx === 0 && aStub.y !== bStub.y ? zTrunkX : undefined) ?? mid;
    const midX = legacyDx === 0 ? trunk : Math.round(trunk + legacyDx);
    return [
      { x: aStub.x, y: aStub.y },
      { x: midX, y: aStub.y },
      { x: midX, y: bStub.y },
      { x: bStub.x, y: bStub.y },
    ];
  }
  const midY = dirA.y === dirB.y
    ? Math.round(dirA.y > 0 ? Math.max(aStub.y, bStub.y) : Math.min(aStub.y, bStub.y))
    : midpointBetween(aStub.y, bStub.y);
  return [
    { x: aStub.x, y: aStub.y },
    { x: aStub.x, y: midY },
    { x: bStub.x, y: midY },
    { x: bStub.x, y: bStub.y },
  ];
}

/**
 * Integer midpoint of two stub ends, unless rounding would land it on one of them (a 1-3 px gap): the
 * exact midpoint then keeps the trunk off both ends so it stays a separate, editable run.
 */
function midpointBetween(p: number, q: number): number {
  const exact = (p + q) / 2;
  const rounded = Math.round(exact);
  return rounded > Math.min(p, q) && rounded < Math.max(p, q) ? rounded : exact;
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
const CORNER_RADIUS = EDGE_CORNER_RADIUS;

/** Fillet coordinates keep 2 decimals: rounding a sub-pixel fillet to whole units collapses it into a hard step. */
const fmt = (v: number): number => Math.round(v * 100) / 100;

/**
 * Build the SVG path with ROUNDED corners. Each interior corner is replaced by a fillet: a line
 * to `radius` before the corner, then a quadratic Bézier whose control point IS the corner vertex,
 * ending `radius` after the corner. `radius` is clamped to half of the straight RUN on each side (up
 * to the next turn, through any colinear split such as a clamped stub end), so a corner looks the
 * same however its run is split (the S at gap 47 and the Z at gap 48 share their fillets) and
 * fillets never overlap. A colinear point is emitted as a plain line only where it lies outside both
 * neighbouring fillets: inside one it would make the path double back (a spike). Corner rounding is
 * render-only smoothing — a turn is NEVER a node/circle; editable handles live on segments, not
 * corners. (React Flow getBend / JointJS rounded / mxGraph arcSize.)
 */
export function roundedPathString(points: Array<{ x: number; y: number }>, radius: number): string {
  // Drop coincident points (e.g. stubs that met) so segment lengths / unit vectors are well-defined.
  const pts: Array<{ x: number; y: number }> = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) pts.push(p);
  }
  if (pts.length === 0) return '';
  let s = `M${pts[0]!.x},${pts[0]!.y}`;
  if (pts.length <= 2) {
    for (let i = 1; i < pts.length; i++) s += ` L${pts[i]!.x},${pts[i]!.y}`;
    return s;
  }
  const n = pts.length;
  const colinear = (i: number): boolean => {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    const next = pts[i + 1]!;
    return (prev.x === cur.x && cur.x === next.x) || (prev.y === cur.y && cur.y === next.y);
  };
  // A colinear point that keeps the direction is part of a straight run; one that doubles back is
  // drawn as is, like an endpoint.
  const straight = pts.map((cur, i) => {
    if (i === 0 || i === n - 1 || !colinear(i)) return false;
    const prev = pts[i - 1]!;
    const next = pts[i + 1]!;
    return (cur.x - prev.x) * (next.x - cur.x) + (cur.y - prev.y) * (next.y - cur.y) > 0;
  });
  const prevStop: number[] = [];
  for (let i = 0, last = 0; i < n; i++) {
    prevStop.push(last);
    if (!straight[i]) last = i;
  }
  const nextStop: number[] = new Array<number>(n);
  for (let i = n - 1, last = n - 1; i >= 0; i--) {
    nextStop[i] = last;
    if (!straight[i]) last = i;
  }
  const enter: Array<{ x: number; y: number }> = pts.map((p) => p);
  const exit: Array<{ x: number; y: number }> = pts.map((p) => p);
  for (let i = 1; i < n - 1; i++) {
    if (straight[i] || colinear(i)) continue;
    const cur = pts[i]!;
    const before = pts[prevStop[i]!]!;
    const after = pts[nextStop[i]!]!;
    const dPrev = Math.hypot(cur.x - before.x, cur.y - before.y);
    const dNext = Math.hypot(after.x - cur.x, after.y - cur.y);
    const rr = Math.min(radius, dPrev / 2, dNext / 2);
    enter[i] = { x: fmt(cur.x + ((before.x - cur.x) / dPrev) * rr), y: fmt(cur.y + ((before.y - cur.y) / dPrev) * rr) };
    exit[i] = { x: fmt(cur.x + ((after.x - cur.x) / dNext) * rr), y: fmt(cur.y + ((after.y - cur.y) / dNext) * rr) };
  }
  for (let i = 1; i < n - 1; i++) {
    const cur = pts[i]!;
    if (straight[i]) {
      const from = exit[prevStop[i]!]!;
      const to = enter[nextStop[i]!]!;
      const t = (p: { x: number; y: number }) => (p.x - from.x) * (to.x - from.x) + (p.y - from.y) * (to.y - from.y);
      const tc = t(cur);
      if (tc >= 0 && tc <= t(to)) s += ` L${cur.x},${cur.y}`;
      continue;
    }
    if (colinear(i)) {
      s += ` L${cur.x},${cur.y}`;
      continue;
    }
    s += ` L${enter[i]!.x},${enter[i]!.y} Q${cur.x},${cur.y} ${exit[i]!.x},${exit[i]!.y}`;
  }
  const last = pts[n - 1]!;
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

/**
 * Render-path side choice for non-loop edges: the shared left/right zone rule (spec 05 §1). The router
 * passes the port rows; bbox-only callers get the centre-row approximation for intersecting tables.
 */
export function chooseSides(src: Bbox, tgt: Bbox, rows?: PortRows): { sourceSide: Side; targetSide: Side } {
  return chooseHorizontalSides(src, tgt, rows);
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
