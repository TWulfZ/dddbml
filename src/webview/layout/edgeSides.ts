import type { EdgeLayout } from '../../shared/types';
import type { Bbox } from '../render/spatialIndex';

/**
 * Automatic FK port sides, shared by the render router and the on-demand A* pass (spec 05 §1, §9).
 * Lives outside `render/edgeRouter.ts` because the `edgeOrder/` engine must not import the renderer.
 */

export type HorizontalSide = 'left' | 'right';

/** The render path's rigid stub length; `render/edgeRouter.ts` defines its `MIN_STUB` from it. */
export const EDGE_STUB = 24;

export interface HorizontalSidePair {
  sourceSide: HorizontalSide;
  targetSide: HorizontalSide;
}

/** Neither table lies entirely right or left of the other (touching included). */
export function xOverlaps(a: Bbox, b: Bbox): boolean {
  return b.x - (a.x + a.w) <= 0 && a.x - (b.x + b.w) <= 0;
}

/** The boxes share area or a border: overlapping on both axes, touching included. */
export function boxesIntersect(a: Bbox, b: Bbox): boolean {
  return xOverlaps(a, b) && b.y - (a.y + a.h) <= 0 && a.y - (b.y + b.h) <= 0;
}

/** Port rows (world y) of an edge's two ends, as anchored on a left/right side. */
export interface PortRows {
  source: number;
  target: number;
}

/** Open-interior overlap of an axis-aligned segment with a box: running along its border is fine. */
function segmentCrosses(x0: number, y0: number, x1: number, y1: number, b: Bbox): boolean {
  return Math.min(x0, x1) < b.x + b.w && Math.max(x0, x1) > b.x && Math.min(y0, y1) < b.y + b.h && Math.max(y0, y1) > b.y;
}

/**
 * Whether a C on `side` keeps out of both endpoint tables: its two arms (port to trunk, stub included)
 * and its trunk at `MIN_STUB` past the farther border. Each arm starts on its own table's border, so
 * only the other table can be crossed. Nesting only pushes the trunk farther out, past both tables,
 * so the unnested trunk decides for every nested one.
 */
export function cClearsEndpoints(src: Bbox, tgt: Bbox, side: HorizontalSide, rows: PortRows): boolean {
  const border = (b: Bbox) => (side === 'right' ? b.x + b.w : b.x);
  const sx = border(src);
  const tx = border(tgt);
  const trunk = side === 'right' ? Math.max(sx, tx) + EDGE_STUB : Math.min(sx, tx) - EDGE_STUB;
  const segs: Array<[number, number, number, number]> = [
    [sx, rows.source, trunk, rows.source],
    [trunk, rows.source, trunk, rows.target],
    [tx, rows.target, trunk, rows.target],
  ];
  return segs.every(([x0, y0, x1, y1]) => !segmentCrosses(x0, y0, x1, y1, src) && !segmentCrosses(x0, y0, x1, y1, tgt));
}

/**
 * dbdiagram-style zones with the right side favoured: a target entirely right of the source gets a Z
 * out of the source's right side, one entirely left gets the mirrored Z, and an x-overlap (touching
 * included) with a clear vertical gap wraps a C around the right of both tables. Intersecting boxes
 * (touching included) take the right C if it keeps out of both tables, else the left C, else the
 * facing connector by centre order (tables side by side). That last regime needs the port rows; without
 * `rows` the bbox centres stand in. Only left/right anchor a port to its column row.
 */
export function chooseHorizontalSides(src: Bbox, tgt: Bbox, rows?: PortRows): HorizontalSidePair {
  if (tgt.x - (src.x + src.w) > 0) return { sourceSide: 'right', targetSide: 'left' };
  if (src.x - (tgt.x + tgt.w) > 0) return { sourceSide: 'left', targetSide: 'right' };
  if (!boxesIntersect(src, tgt)) return { sourceSide: 'right', targetSide: 'right' };
  const r = rows ?? { source: src.y + src.h / 2, target: tgt.y + tgt.h / 2 };
  if (cClearsEndpoints(src, tgt, 'right', r)) return { sourceSide: 'right', targetSide: 'right' };
  if (cClearsEndpoints(src, tgt, 'left', r)) return { sourceSide: 'left', targetSide: 'left' };
  return src.x + src.w / 2 <= tgt.x + tgt.w / 2
    ? { sourceSide: 'right', targetSide: 'left' }
    : { sourceSide: 'left', targetSide: 'right' };
}

/** The render path's corner fillet radius; `render/edgeRouter.ts` defines its `CORNER_RADIUS` from it. */
export const EDGE_CORNER_RADIUS = 8;

/**
 * Port gap from which the clamped Z takes over from the S: at exactly `2·EDGE_STUB` both full stubs
 * end on the gap's midpoint, where the Z puts its trunk, so the shape is continuous across it.
 */
const S_MAX_GAP = 2 * EDGE_STUB;

/** How far the S keeps its runs off a table's outline: a run on the border draws under the table. */
const S_CLEARANCE = 4;

const inflate = (b: Bbox, d: number): Bbox => ({ x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d });

/**
 * The jog row of the dbdiagram S, or `undefined` when the pair keeps the clamped stubs (spec 05 §1).
 * Applies to facing left/right ports with `0 < gap < S_MAX_GAP` and rows at least one stub apart:
 * both stubs keep the full `EDGE_STUB`, so the jog is `S_MAX_GAP - gap` wide (a 1 px stair at gap 47
 * is the intended look), and the middle jogs across at the rows' midpoint, else (tables
 * one above the other) at the middle of the vertical gap between them. Below one stub of gap the full
 * stubs reach past the other table's border, so a jog row is taken only if every run keeps
 * `S_CLEARANCE` off both tables (each stub only off the other table); a packed pair that no row clears
 * keeps the clamp, whose trunk stays in the visible gap. Geometry-only (ports, sides, boxes).
 */
export function narrowGapSJog(
  a: { x: number; y: number },
  b: { x: number; y: number },
  sourceSide: string,
  targetSide: string,
  src: Bbox,
  tgt: Bbox,
): number | undefined {
  const facing = (sourceSide === 'right' && targetSide === 'left') || (sourceSide === 'left' && targetSide === 'right');
  if (!facing) return undefined;
  const gap = sourceSide === 'right' ? b.x - a.x : a.x - b.x;
  if (!(gap > 0 && gap < S_MAX_GAP && Math.abs(b.y - a.y) >= EDGE_STUB)) return undefined;
  const dir = sourceSide === 'right' ? 1 : -1;
  const ax = a.x + dir * EDGE_STUB;
  const bx = b.x - dir * EDGE_STUB;
  const srcZone = inflate(src, S_CLEARANCE);
  const tgtZone = inflate(tgt, S_CLEARANCE);
  const clears = (midY: number): boolean => {
    const runs: Array<[number, number, number, number]> = [
      [ax, a.y, ax, midY],
      [ax, midY, bx, midY],
      [bx, midY, bx, b.y],
    ];
    const ok = (z: Bbox) => runs.every(([x0, y0, x1, y1]) => !segmentCrosses(x0, y0, x1, y1, z));
    return ok(srcZone) && ok(tgtZone) && !segmentCrosses(a.x, a.y, ax, a.y, tgtZone) && !segmentCrosses(bx, b.y, b.x, b.y, srcZone);
  };
  const candidates = [Math.round((a.y + b.y) / 2)];
  const [upper, lower] = src.y <= tgt.y ? [src, tgt] : [tgt, src];
  if (upper.y + upper.h < lower.y) candidates.push(Math.round((upper.y + upper.h + lower.y) / 2));
  return candidates.find(clears);
}

const isVerticalSide = (side: string | undefined): boolean => side === 'top' || side === 'bottom';

/**
 * An A*-written shape the current zone rule cannot draw, so render and edits ignore it whole (sides +
 * waypoints, which were routed for other ports); a manual override (no `auto`) is always honoured.
 * - Any `auto` top/bottom port: before 2026-10-03 the pass could persist them.
 * - Side-less `auto` waypoints between x-overlapping tables (needs both bboxes): older passes left the
 *   sides implicit, routing for bottom/top (v0.3.0) or centre-ordered left/right, never for today's
 *   zones. The pass now always writes both sides with its waypoints, so no current shape matches.
 */
export function isLegacyAutoShape(layout: EdgeLayout | undefined, src?: Bbox, tgt?: Bbox): boolean {
  if (layout?.auto !== true) return false;
  if (isVerticalSide(layout.sourceSide) || isVerticalSide(layout.targetSide)) return true;
  if (!src || !tgt || !layout.waypoints?.length || layout.sourceSide || layout.targetSide) return false;
  return xOverlaps(src, tgt);
}

/** What render and edits treat as the stored layout: an ignored legacy auto shape keeps only its color. */
export function effectiveEdgeLayout(layout: EdgeLayout | undefined, src?: Bbox, tgt?: Bbox): EdgeLayout | undefined {
  if (!isLegacyAutoShape(layout, src, tgt)) return layout;
  return layout?.color ? { color: layout.color } : undefined;
}
