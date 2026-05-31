import type { EdgeLayout, QualifiedName, Ref, Waypoint } from '../../shared/types';
import type { Bbox } from './spatialIndex';

export type Side = 'left' | 'right' | 'top' | 'bottom';

/**
 * Length (world units) of the RIGID stub that always leaves each table. The pieces
 * `source → sourceStub` and `targetStub → target` are immutable: never draggable, never
 * subdivided, never collapsed. They keep the connection point coherent (the `1` / crow's-foot
 * marker never sits flush against the table). All user editing happens strictly between the
 * two stub ends. When tables are closer than `2*MIN_STUB` horizontally the stub length is clamped
 * to half the port distance so the two stubs meet instead of crossing (no backtracking spike);
 * a very-close same-row edge then has no editable middle (just a straight rigid connector).
 */
const MIN_STUB = 24;

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
}

/** Optional per-endpoint port override — used to align edges with the PK/FK column row. */
export type ColumnYResolver = (table: QualifiedName, column: string) => number | undefined;

/** Resolves the EdgeLayout (waypoints + legacy dx/dy) for an edge, keyed by ref id. */
export type EdgeLayoutResolver = (refId: string) => EdgeLayout | undefined;

interface PortAssignment {
  sourceSide: Side;
  targetSide: Side;
  sourceRatio: number; // 0..1 along the side
  targetRatio: number;
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
 */
export function routeRefs(
  refs: Ref[],
  bboxOf: (name: QualifiedName) => Bbox | undefined,
  columnYResolver?: ColumnYResolver,
  layoutResolver?: EdgeLayoutResolver,
): EdgeRoute[] {
  // 1. decide sides for each edge
  const decisions: Array<{ ref: Ref; srcBbox: Bbox; tgtBbox: Bbox; sourceSide: Side; targetSide: Side } | null> = [];
  for (const r of refs) {
    const srcBbox = bboxOf(r.source.table);
    const tgtBbox = bboxOf(r.target.table);
    if (!srcBbox || !tgtBbox) {
      decisions.push(null);
      continue;
    }
    const auto = chooseSides(srcBbox, tgtBbox);
    const layout = layoutResolver?.(r.id);
    const sourceSide: Side = layout?.sourceSide ?? auto.sourceSide;
    const targetSide: Side = layout?.targetSide ?? auto.targetSide;
    decisions.push({ ref: r, srcBbox, tgtBbox, sourceSide, targetSide });
  }

  // 2. group by (table, side) to compute port offsets
  type Group = Array<{ edgeIdx: number; role: 'source' | 'target'; otherCenter: number; refId: string; orientation: 'h' | 'v' }>;
  const groups = new Map<string, Group>();

  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    if (!d) continue;

    const srcKey = `${d.ref.source.table}|${d.sourceSide}`;
    const tgtKey = `${d.ref.target.table}|${d.targetSide}`;
    const srcOrientation = orientationOfSide(d.sourceSide);
    const tgtOrientation = orientationOfSide(d.targetSide);

    const tgtCenter = centerOf(d.tgtBbox);
    const srcCenter = centerOf(d.srcBbox);

    const srcOther = srcOrientation === 'v' ? tgtCenter.y : tgtCenter.x;
    const tgtOther = tgtOrientation === 'v' ? srcCenter.y : srcCenter.x;

    pushGroup(groups, srcKey, { edgeIdx: i, role: 'source', otherCenter: srcOther, refId: d.ref.id, orientation: srcOrientation });
    pushGroup(groups, tgtKey, { edgeIdx: i, role: 'target', otherCenter: tgtOther, refId: d.ref.id, orientation: tgtOrientation });
  }

  // 3. assign port ratios: sort group by the other endpoint's center (barycentric crossing
  // reduction — the edge whose far end sits higher/left gets the higher/left port), then
  // distribute evenly. Tie-break by ref id so the assignment depends only on geometry + stable
  // ids, never on the refs[] array order (which @dbml/core can shuffle on re-parse) — preserving
  // the git-friendly invariant that the same schema yields the same routed ports.
  const portAssign: PortAssignment[] = decisions.map(() => ({
    sourceSide: 'right',
    targetSide: 'left',
    sourceRatio: 0.5,
    targetRatio: 0.5,
  }));

  for (const [, entries] of groups) {
    entries.sort((a, b) => (a.otherCenter - b.otherCenter) || (a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0));
    const count = entries.length;
    for (let i = 0; i < count; i++) {
      const entry = entries[i]!;
      const ratio = (i + 1) / (count + 1);
      const d = decisions[entry.edgeIdx]!;
      const assign = portAssign[entry.edgeIdx]!;
      assign.sourceSide = d.sourceSide;
      assign.targetSide = d.targetSide;
      if (entry.role === 'source') assign.sourceRatio = ratio;
      else assign.targetRatio = ratio;
    }
  }

  // 4. build paths
  const out: EdgeRoute[] = [];
  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    if (!d) continue;
    const assign = portAssign[i]!;

    let sourceY: number | undefined;
    let targetY: number | undefined;
    if (columnYResolver) {
      if (assign.sourceSide === 'left' || assign.sourceSide === 'right') {
        const offset = d.ref.source.columns[0] ? columnYResolver(d.ref.source.table, d.ref.source.columns[0]) : undefined;
        if (offset !== undefined) sourceY = d.srcBbox.y + offset;
      }
      if (assign.targetSide === 'left' || assign.targetSide === 'right') {
        const offset = d.ref.target.columns[0] ? columnYResolver(d.ref.target.table, d.ref.target.columns[0]) : undefined;
        if (offset !== undefined) targetY = d.tgtBbox.y + offset;
      }
    }

    const a = portPoint(d.srcBbox, assign.sourceSide, assign.sourceRatio, sourceY);
    const b = portPoint(d.tgtBbox, assign.targetSide, assign.targetRatio, targetY);

    const layout = layoutResolver?.(d.ref.id);
    const waypoints = layout?.waypoints && layout.waypoints.length > 0 ? layout.waypoints : [];
    const legacyDx = waypoints.length === 0 && layout?.dx !== undefined ? layout.dx : 0;

    const { corners, aStub, bStub } = buildPath(a, b, waypoints, legacyDx, d.sourceSide, d.targetSide);
    const d_str = roundedPathString(corners, CORNER_RADIUS);
    const segments = buildSegments(corners, waypoints);

    out.push({
      id: d.ref.id,
      d: d_str,
      waypoints: waypoints.map((w) => ({ x: w.x, y: w.y })),
      segments,
      source: a,
      target: b,
      sourceStub: aStub,
      targetStub: bStub,
    });
  }
  return out;
}

/**
 * Build the corner points of the orthogonal polyline from `a` to `b`, through the user's LITERAL
 * corner waypoints. Wrapped in two RIGID stubs (`a → aStub`, `bStub → b`, fixed `MIN_STUB`,
 * direction from `sourceSide`/`targetSide`) — immutable, always present, never collapsed.
 *
 * No waypoints ⇒ the editable middle is the default centered H-V-H. Otherwise the waypoints ARE the
 * route's corners, connected directly (a single elbow inserted only for a stray non-axis-aligned
 * pair, as back-compat for v1 free waypoints). Nothing is collapsed/canonicalized, so local notches
 * (a dip whose pins are colinear with the run) survive — the whole point of the editing model.
 *
 * Returns the full corner list (`[a, ...editable..., b]`) plus the fixed stub ends.
 */
function buildPath(
  a: { x: number; y: number },
  b: { x: number; y: number },
  waypoints: Waypoint[],
  legacyDx: number,
  sourceSide: Side,
  targetSide: Side,
): { corners: Array<{ x: number; y: number }>; aStub: { x: number; y: number }; bStub: { x: number; y: number } } {
  const dirA = sourceSide === 'left' ? -1 : 1;
  const dirB = targetSide === 'left' ? -1 : 1;
  // Clamp stub length to half the horizontal port distance so the two stubs can never cross when
  // tables are closer than 2*MIN_STUB (crossing would invert the editable span).
  const stubLen = Math.min(MIN_STUB, Math.floor(Math.abs(b.x - a.x) / 2));
  const aStub = { x: a.x + dirA * stubLen, y: a.y };
  const bStub = { x: b.x + dirB * stubLen, y: b.y };

  const editable = waypoints.length === 0
    ? defaultEditableCorners(aStub, bStub, legacyDx)
    : cornersThrough(aStub, bStub, waypoints);
  const corners = [{ x: a.x, y: a.y }, ...editable, { x: b.x, y: b.y }];
  return { corners, aStub, bStub };
}

/** Default editable corners between the stub ends: straight when same-row, else centered H-V-H. */
function defaultEditableCorners(
  aStub: { x: number; y: number },
  bStub: { x: number; y: number },
  legacyDx: number,
): Array<{ x: number; y: number }> {
  // Same row ⇒ a straight connector (no redundant midpoint corner).
  if (bStub.y === aStub.y) return [{ x: aStub.x, y: aStub.y }, { x: bStub.x, y: bStub.y }];
  // Offset ⇒ H-V-H with a centered trunk (+ optional legacy dx).
  const midX = Math.round((aStub.x + bStub.x) / 2 + legacyDx);
  return [
    { x: aStub.x, y: aStub.y },
    { x: midX, y: aStub.y },
    { x: midX, y: bStub.y },
    { x: bStub.x, y: bStub.y },
  ];
}

/**
 * Connect the stub ends through the user's literal corners with straight orthogonal segments.
 * Consecutive corners are expected axis-aligned (the editing ops guarantee it); a single
 * horizontal-first elbow is inserted only for a stray non-aligned pair (back-compat with v1 free
 * waypoints). No collapsing — every user corner (incl. a notch's pins) survives.
 */
function cornersThrough(
  aStub: { x: number; y: number },
  bStub: { x: number; y: number },
  waypoints: Waypoint[],
): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [{ x: aStub.x, y: aStub.y }];
  let cur = { x: aStub.x, y: aStub.y };
  const connect = (p: { x: number; y: number }) => {
    if (p.x !== cur.x && p.y !== cur.y) out.push({ x: p.x, y: cur.y }); // safety elbow
    out.push({ x: p.x, y: p.y });
    cur = { x: p.x, y: p.y };
  };
  for (const w of waypoints) connect({ x: w.x, y: w.y });
  connect({ x: bStub.x, y: bStub.y });
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
  if (!seg || seg.rigid) return false;
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
  if (newLvl === lvl) return C.slice(1, -1);

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
  if (d === 0) return corners.slice(1, -1);

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

function pushGroup(
  groups: Map<string, Array<{ edgeIdx: number; role: 'source' | 'target'; otherCenter: number; refId: string; orientation: 'h' | 'v' }>>,
  key: string,
  entry: { edgeIdx: number; role: 'source' | 'target'; otherCenter: number; refId: string; orientation: 'h' | 'v' },
): void {
  let arr = groups.get(key);
  if (!arr) {
    arr = [];
    groups.set(key, arr);
  }
  arr.push(entry);
}

function orientationOfSide(side: Side): 'h' | 'v' {
  return side === 'left' || side === 'right' ? 'h' : 'v';
}

function chooseSides(src: Bbox, tgt: Bbox): { sourceSide: Side; targetSide: Side } {
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
