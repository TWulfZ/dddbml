import type { EdgeLayout, QualifiedName, Ref, Waypoint } from '../../shared/types';
import type { Bbox } from './spatialIndex';

export type Side = 'left' | 'right' | 'top' | 'bottom';

export interface EdgeSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  axis: 'h' | 'v';
  /** Index of the waypoint that ends this segment, or `null` for the final leg into the target. */
  endWaypointIndex: number | null;
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
  type Group = Array<{ edgeIdx: number; role: 'source' | 'target'; otherCenter: number; orientation: 'h' | 'v' }>;
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

    pushGroup(groups, srcKey, { edgeIdx: i, role: 'source', otherCenter: srcOther, orientation: srcOrientation });
    pushGroup(groups, tgtKey, { edgeIdx: i, role: 'target', otherCenter: tgtOther, orientation: tgtOrientation });
  }

  // 3. assign port ratios: sort group by otherCenter, evenly distribute
  const portAssign: PortAssignment[] = decisions.map(() => ({
    sourceSide: 'right',
    targetSide: 'left',
    sourceRatio: 0.5,
    targetRatio: 0.5,
  }));

  for (const [, entries] of groups) {
    entries.sort((a, b) => a.otherCenter - b.otherCenter);
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

    const { corners } = buildPath(a, b, waypoints, legacyDx);
    const d_str = pathString(corners);
    const segments = buildSegments(corners, waypoints);

    out.push({
      id: d.ref.id,
      d: d_str,
      waypoints: waypoints.map((w) => ({ x: w.x, y: w.y })),
      segments,
      source: a,
      target: b,
    });
  }
  return out;
}

/**
 * Build the corner points of an orthogonal polyline from `a` to `b`, passing through user waypoints.
 *
 * Both `a` and `b` are horizontal ports (chooseSides forces left/right). The polyline starts
 * with a horizontal segment exiting `a` and ends with a horizontal segment entering `b`.
 * Axes alternate at each waypoint.
 *
 * When `waypoints` is empty, falls back to the original H-V-H with optional `legacyDx` offset.
 *
 * Returns the corner list plus a parallel `isWaypoint` mask indicating which corners are
 * user-placed (must be preserved by `collapseColinear`).
 */
function buildPath(
  a: { x: number; y: number },
  b: { x: number; y: number },
  waypoints: Waypoint[],
  legacyDx: number,
): { corners: Array<{ x: number; y: number }>; isWaypoint: boolean[] } {
  const P: Array<{ x: number; y: number }> = [{ x: a.x, y: a.y }];
  const wp: boolean[] = [false];
  let cur = { x: a.x, y: a.y };
  let lastAxis: 'h' | 'v' = 'h';

  const pushCorner = (p: { x: number; y: number }, isUserWaypoint: boolean) => {
    P.push(p);
    wp.push(isUserWaypoint);
  };

  for (const w of waypoints) {
    if (lastAxis === 'h') {
      if (w.x !== cur.x) {
        pushCorner({ x: w.x, y: cur.y }, false);
        lastAxis = 'h';
      }
      // Always push the waypoint itself so it survives colinearity collapsing.
      pushCorner({ x: w.x, y: w.y }, true);
      if (w.y !== cur.y) lastAxis = 'v';
    } else {
      if (w.y !== cur.y) {
        pushCorner({ x: cur.x, y: w.y }, false);
        lastAxis = 'v';
      }
      pushCorner({ x: w.x, y: w.y }, true);
      if (w.x !== cur.x) lastAxis = 'h';
    }
    cur = { x: w.x, y: w.y };
  }

  if (waypoints.length === 0) {
    // Default H-V-H: centered trunk (+ legacy dx). `cur` is still the source port here.
    const midX = Math.round((cur.x + b.x) / 2 + legacyDx);
    if (midX !== cur.x) pushCorner({ x: midX, y: cur.y }, false);
    if (b.y !== cur.y) pushCorner({ x: midX, y: b.y }, false);
    pushCorner({ x: b.x, y: b.y }, false);
  } else {
    // Edited path: route the last vertex STRAIGHT into the port — vertical to b's row at
    // cur.x, then horizontal into the port. No midX bridge, so the path can never double
    // back into a spike; every leg flows one direction toward the target.
    if (b.y !== cur.y) pushCorner({ x: cur.x, y: b.y }, false);
    pushCorner({ x: b.x, y: b.y }, false);
  }

  return collapseColinear(P, wp);
}

/**
 * Remove redundant corners while preserving every user waypoint.
 *
 * Two conditions collapse a corner:
 *   1. Exact duplicate of the previous point (`prev.x === cur.x && prev.y === cur.y`).
 *   2. Three colinear points (prev → cur → next share x OR share y) AND `cur` is not a user waypoint.
 *
 * User waypoints (`isWaypoint[i] === true`) always survive — they may be visually mid-segment
 * but the user placed them, and dragging them later must work even if currently colinear.
 */
function collapseColinear(
  points: Array<{ x: number; y: number }>,
  isWaypoint: boolean[],
): { corners: Array<{ x: number; y: number }>; isWaypoint: boolean[] } {
  if (points.length <= 2) return { corners: points, isWaypoint };
  const outPoints: Array<{ x: number; y: number }> = [points[0]!];
  const outWp: boolean[] = [isWaypoint[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = outPoints[outPoints.length - 1]!;
    const cur = points[i]!;
    const next = points[i + 1]!;
    const samePoint = prev.x === cur.x && prev.y === cur.y;
    const colinear =
      (prev.x === cur.x && cur.x === next.x) || (prev.y === cur.y && cur.y === next.y);
    const isUserWp = isWaypoint[i]!;
    if (samePoint && !isUserWp) continue;
    if (colinear && !isUserWp) continue;
    outPoints.push(cur);
    outWp.push(isUserWp);
  }
  const last = points[points.length - 1]!;
  const tail = outPoints[outPoints.length - 1]!;
  if (last.x !== tail.x || last.y !== tail.y) {
    outPoints.push(last);
    outWp.push(isWaypoint[points.length - 1]!);
  }
  return { corners: outPoints, isWaypoint: outWp };
}

function pathString(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return '';
  let s = `M${points[0]!.x},${points[0]!.y}`;
  for (let i = 1; i < points.length; i++) s += ` L${points[i]!.x},${points[i]!.y}`;
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
    });
    if (endsAtWaypoint) wpIdx++;
  }
  return segs;
}

/**
 * Translate a dragged segment along its normal and return the new waypoint list.
 *
 * Orthogonal segment dragging: a segment only moves perpendicular to itself, so the
 * path can never gain a diagonal or a staircase "pico". Editing maps to whole-segment moves —
 * a segment bounded by stored waypoint(s) shifts those waypoints' relevant coordinate; a bare
 * bridge/stub segment inserts the minimal waypoint(s) to anchor the new bend. The router
 * re-bridges the other axis to the (table-following) ports, so the result is port-independent.
 *
 * Always call with the ORIGINAL route snapshot + cumulative delta (not the live route) so
 * repeated pointermove calls are idempotent and segment indices never drift mid-drag.
 */
export function computeSegmentDrag(
  route: EdgeRoute,
  segIndex: number,
  dxWorld: number,
  dyWorld: number,
  snap: (n: number) => number = Math.round,
): Waypoint[] {
  const seg = route.segments[segIndex];
  const W: Waypoint[] = route.waypoints.map((w) => ({ x: w.x, y: w.y }));
  if (!seg) return W;

  const startWp = segIndex > 0 ? route.segments[segIndex - 1]!.endWaypointIndex : null;
  const endWp = seg.endWaypointIndex;

  // Insertion index = number of stored waypoints that appear before this segment.
  let insertIdx = 0;
  for (let k = 0; k < segIndex; k++) if (route.segments[k]!.endWaypointIndex !== null) insertIdx++;

  if (seg.axis === 'v') {
    const newX = snap(seg.x1 + dxWorld);
    let moved = false;
    if (startWp !== null && W[startWp]) { W[startWp]!.x = newX; moved = true; }
    if (endWp !== null && W[endWp]) { W[endWp]!.x = newX; moved = true; }
    // Bare vertical trunk → one vertex pins x; the router re-bridges the y to the ports.
    if (!moved) W.splice(insertIdx, 0, { x: newX, y: snap((seg.y1 + seg.y2) / 2) });
  } else {
    const newY = snap(seg.y1 + dyWorld);
    let moved = false;
    if (startWp !== null && W[startWp]) { W[startWp]!.y = newY; moved = true; }
    if (endWp !== null && W[endWp]) { W[endWp]!.y = newY; moved = true; }
    // Bare horizontal segment → clean parallel offset: two vertices at the segment's own
    // endpoints (never thirds/midpoints), so dragging the middle can't make a tiny segment.
    if (!moved) {
      W.splice(insertIdx, 0, { x: snap(seg.x1), y: newY }, { x: snap(seg.x2), y: newY });
    }
  }
  return simplifyWaypoints(W, route.source, route.target);
}

/**
 * Drop waypoints that don't bend the polyline `[a, ...W, b]` (three colinear points or a
 * duplicate), so dragging a segment back into line removes the bend instead of leaving a
 * dead vertex. Conservative: only removes exact colinear/duplicate vertices.
 */
export function simplifyWaypoints(
  W: Waypoint[],
  a: { x: number; y: number },
  b: { x: number; y: number },
): Waypoint[] {
  if (W.length === 0) return W;
  const pts = [a, ...W, b];
  const out: Waypoint[] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    const next = pts[i + 1]!;
    const colinear = (prev.x === cur.x && cur.x === next.x) || (prev.y === cur.y && cur.y === next.y);
    const dup = prev.x === cur.x && prev.y === cur.y;
    if (!colinear && !dup) out.push({ x: cur.x, y: cur.y });
  }
  return out;
}

function pushGroup(
  groups: Map<string, Array<{ edgeIdx: number; role: 'source' | 'target'; otherCenter: number; orientation: 'h' | 'v' }>>,
  key: string,
  entry: { edgeIdx: number; role: 'source' | 'target'; otherCenter: number; orientation: 'h' | 'v' },
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
