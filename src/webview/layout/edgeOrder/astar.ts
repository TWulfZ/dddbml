import type { QualifiedName, Waypoint } from '../../../shared/types';
import type { Bbox } from '../../render/spatialIndex';
import { buildRouteGrid, RouteGrid, WorldUsage, type Cell, type Side } from './grid';
import {
  CROSS_COST,
  GRID_MARGIN,
  MAX_EXPLORED,
  MAX_GRID_CELLS,
  STEP_COST,
  TURN_COST,
  YIELD_EVERY,
} from './constants';

export type { Side } from './grid';

/**
 * On-demand A* obstacle-avoiding edge router (spec 05 §9, E1). PURE and framework-free: geometry
 * in, geometry out. Knows nothing of the store, `EdgeLayout`, the spatial-index instance, history,
 * or persistence — the runner adapter maps results onto `EdgeLayout`. Deterministic by construction
 * (see §8 of the design): no RNG, no clock in any cost/ordering decision, edges processed in caller
 * order (the runner sorts by `ref.id`), origin-snapped grids, fully-ordered priority-queue tie-break.
 */

export interface PortPoint {
  x: number;
  y: number;
}

export interface OrderEdgeInput {
  refId: string;
  /** Fixed stub ends from one routeRefs pass; A* routes strictly between these (ports untouched). */
  sourceStub: PortPoint;
  targetStub: PortPoint;
  sourceTable: Bbox;
  targetTable: Bbox;
  sourceTableName: QualifiedName;
  targetTableName: QualifiedName;
  /** Phase-1 chosen sides (the side the stubs exit). The engine routes between the given stubs. */
  sourceSide: Side;
  targetSide: Side;
}

export interface RoutedEdge {
  refId: string;
  sourceSide: Side;
  targetSide: Side;
  /** Integer literal corners strictly between the stubs, after collinear-merge. `[]` ⇒ straight/H-V-H. */
  waypoints: Waypoint[];
  /** Cell-centre world points of the routed path, for crossing-usage accumulation. */
  pathWorld: PortPoint[];
  /** false ⇒ caller writes empty waypoints (default H-V-H fallback). */
  ok: boolean;
}

export interface OrderEdgesOptions {
  /** Obstacle bboxes overlapping `window`, excluding the edge's own two endpoint tables. */
  obstaclesFor: (window: Bbox, excludeA: QualifiedName, excludeB: QualifiedName) => Bbox[];
  signal?: AbortSignal;
  onProgress?: (pct: number) => void;
  /** Edges between cooperative yields. Overridable for tests; defaults to `YIELD_EVERY`. */
  yieldEvery?: number;
  /** Explored-node cap per edge. Overridable for tests; defaults to `MAX_EXPLORED`. */
  maxExplored?: number;
  /** Grid cell ceiling. Overridable for tests; defaults to `MAX_GRID_CELLS`. */
  maxGridCells?: number;
}

/**
 * 4-side port selection for the on-demand pass (resolved decision 1). When the tables are stacked
 * more vertically than horizontally (`|dy| > |dx|`) the edge exits top/bottom; otherwise left/right
 * (matching the render path's L/R `chooseSides`). The adapter assigns these provisional sides to ALL
 * edges BEFORE its routeRefs pass, so the resulting spread stubs are the ones A* routes between and
 * the ones that persist — no first-render kink (critic G5). Pure + deterministic (centre geometry).
 */
export function chooseSides4(src: Bbox, tgt: Bbox): { sourceSide: Side; targetSide: Side } {
  const sx = src.x + src.w / 2;
  const sy = src.y + src.h / 2;
  const tx = tgt.x + tgt.w / 2;
  const ty = tgt.y + tgt.h / 2;
  const dx = tx - sx;
  const dy = ty - sy;
  if (Math.abs(dy) > Math.abs(dx)) {
    return dy >= 0 ? { sourceSide: 'bottom', targetSide: 'top' } : { sourceSide: 'top', targetSide: 'bottom' };
  }
  return dx >= 0 ? { sourceSide: 'right', targetSide: 'left' } : { sourceSide: 'left', targetSide: 'right' };
}

const DIRS = [
  { dx: 0, dy: -1, code: 1 }, // N
  { dx: 1, dy: 0, code: 2 }, // E
  { dx: 0, dy: 1, code: 3 }, // S
  { dx: -1, dy: 0, code: 4 }, // W
] as const;
const NONE = 0;

/** Inflate a bbox by `m` on every side. */
function inflate(b: Bbox, m: number): Bbox {
  return { x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m };
}

/** Axis-aligned bounding union of two bboxes. */
function union(a: Bbox, b: Bbox): Bbox {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Drop corners colinear with both neighbours (exact integer equality). Endpoints preserved. */
function collinearMerge(pts: PortPoint[]): PortPoint[] {
  if (pts.length <= 2) return pts.slice();
  const out: PortPoint[] = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = out[out.length - 1]!;
    const cur = pts[i]!;
    const next = pts[i + 1]!;
    const colinear = (prev.x === cur.x && cur.x === next.x) || (prev.y === cur.y && cur.y === next.y);
    if (!colinear) out.push(cur);
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

/**
 * Pull a cell-path ENDPOINT onto the stub's fixed axis so the leg connecting to the rigid stub is
 * orthogonal: a horizontal exit (left/right) puts the endpoint at the stub's Y (preserving the L/R
 * column-row anchor), a vertical exit (top/bottom) puts it at the stub's X. The endpoint keeps its
 * free-axis cell coordinate (where the detour actually turns), so the bend itself is NOT flattened.
 */
function anchorEndpoint(corners: PortPoint[], idx: number, side: Side, stub: PortPoint): void {
  const c = corners[idx];
  if (!c) return;
  if (side === 'left' || side === 'right') corners[idx] = { x: c.x, y: Math.round(stub.y) };
  else corners[idx] = { x: Math.round(stub.x), y: c.y };
}

interface SearchResult {
  cells: Cell[];
  cost: number;
}

/**
 * Single-source A* between two cells on `grid`. Node = (cell, incomingDir) so turns are penalized.
 * Returns the cell path + total cost, or null on no-path / cap-exceeded. Pure; no yields.
 */
function searchGrid(
  grid: RouteGrid,
  start: Cell,
  goal: Cell,
  maxExplored: number,
): SearchResult | null {
  const W = grid.cols;
  const H = grid.rows;
  const N = W * H;
  // Node id = cellOrdinal*5 + dirCode. Flat typed stores (no Map in the hot loop).
  const g = new Float64Array(N * 5).fill(Infinity);
  const cameFrom = new Int32Array(N * 5).fill(-1);
  const closed = new Uint8Array(N * 5);

  const h = (cx: number, cy: number): number =>
    STEP_COST * (Math.abs(cx - goal.cx) + Math.abs(cy - goal.cy));

  // Binary min-heap of node ids; ordered by (f asc, g desc, nodeKey asc) via `better`.
  const heap: number[] = [];
  const fOf = new Float64Array(N * 5);
  const better = (a: number, b: number): boolean => {
    if (fOf[a] !== fOf[b]) return fOf[a]! < fOf[b]!;
    if (g[a] !== g[b]) return g[a]! > g[b]!; // deeper g first (closer to goal)
    return a < b; // nodeKey = node id, a pure function of (cell,dir)
  };
  const push = (id: number): void => {
    heap.push(id);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (better(heap[i]!, heap[p]!)) {
        [heap[i], heap[p]] = [heap[p]!, heap[i]!];
        i = p;
      } else break;
    }
  };
  const pop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let m = i;
        if (l < heap.length && better(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && better(heap[r]!, heap[m]!)) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m]!, heap[i]!];
        i = m;
      }
    }
    return top;
  };

  const startId = grid.ordinal(start.cx, start.cy) * 5 + NONE;
  g[startId] = 0;
  fOf[startId] = h(start.cx, start.cy);
  push(startId);

  let explored = 0;
  let goalId = -1;
  while (heap.length > 0) {
    const cur = pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    const ord = Math.floor(cur / 5);
    const dir = cur % 5;
    const cx = ord % W;
    const cy = Math.floor(ord / W);

    if (cx === goal.cx && cy === goal.cy) {
      goalId = cur;
      break;
    }
    if (++explored > maxExplored) return null;

    for (const d of DIRS) {
      const nx = cx + d.dx;
      const ny = cy + d.dy;
      if (grid.isBlocked(nx, ny)) continue;
      const turned = dir !== NONE && dir !== d.code;
      const step = STEP_COST + (turned ? TURN_COST : 0) + CROSS_COST * grid.usageAt(nx, ny);
      const nid = grid.ordinal(nx, ny) * 5 + d.code;
      const ng = g[cur]! + step;
      if (ng < g[nid]!) {
        g[nid] = ng;
        cameFrom[nid] = cur;
        fOf[nid] = ng + h(nx, ny);
        push(nid);
      }
    }
  }

  if (goalId < 0) return null;
  const cells: Cell[] = [];
  let id = goalId;
  while (id !== -1) {
    const ord = Math.floor(id / 5);
    cells.push({ cx: ord % W, cy: Math.floor(ord / W) });
    id = cameFrom[id]!;
  }
  cells.reverse();
  return { cells, cost: g[goalId]! };
}

/**
 * Route ONE edge between its stubs, choosing the lower-cost of two candidate side-pairs (the given
 * Phase-1 sides, plus a 4-side `chooseSides` that may pick top/bottom). Pure: takes a prepared grid,
 * returns a `RoutedEdge`. Falls back to `{ok:false, waypoints:[]}` on no-path / cap / degenerate grid.
 */
export function routeOneEdge(ep: OrderEdgeInput, grid: RouteGrid, maxExplored = MAX_EXPLORED): RoutedEdge {
  const fallback: RoutedEdge = {
    refId: ep.refId,
    sourceSide: ep.sourceSide,
    targetSide: ep.targetSide,
    waypoints: [],
    pathWorld: [],
    ok: false,
  };

  // Carve start/goal corridors so a neighbour's inflation can't wall in the ports, then search.
  const undoA = grid.carveEndpoint(ep.sourceStub.x, ep.sourceStub.y, ep.sourceSide);
  const undoB = grid.carveEndpoint(ep.targetStub.x, ep.targetStub.y, ep.targetSide);
  const start = grid.toCell(ep.sourceStub.x, ep.sourceStub.y);
  const goal = grid.toCell(ep.targetStub.x, ep.targetStub.y);
  if (grid.isBlocked(start.cx, start.cy) || grid.isBlocked(goal.cx, goal.cy)) {
    grid.restore(undoB);
    grid.restore(undoA);
    return fallback;
  }
  const search = searchGrid(grid, start, goal, maxExplored);
  grid.restore(undoB);
  grid.restore(undoA);
  if (!search) return fallback;

  // Cell-centre world points drive crossing usage (what physically routed where).
  const pathWorld: PortPoint[] = search.cells.map((c) => grid.toWorld(c.cx, c.cy));

  // Turn corners on the cell grid. ≤2 ⇒ A* found an essentially straight shot; emit no waypoints
  // and let the render path's default H-V-H connect the stubs (handles a small column-row offset
  // cleanly). Only a genuine detour (≥3 corners) becomes explicit waypoints.
  const cellCorners = collinearMerge(pathWorld).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  if (cellCorners.length <= 2) {
    return { refId: ep.refId, sourceSide: ep.sourceSide, targetSide: ep.targetSide, waypoints: [], pathWorld, ok: true };
  }

  // Pull the cell-path endpoints onto the stubs' fixed axes (orthogonal connection to each rigid
  // stub + L/R column-row anchor survives) WITHOUT moving the interior detour corners.
  const last = cellCorners.length - 1;
  anchorEndpoint(cellCorners, 0, ep.sourceSide, ep.sourceStub);
  anchorEndpoint(cellCorners, last, ep.targetSide, ep.targetStub);

  // These anchored corners ARE the literal waypoints between the stubs. Drop any that coincide with
  // a stub (the stub is re-added by buildPath), then collinear-merge once more.
  const merged = collinearMerge(cellCorners);
  const waypoints = merged
    .filter((p) => !(p.x === Math.round(ep.sourceStub.x) && p.y === Math.round(ep.sourceStub.y)))
    .filter((p) => !(p.x === Math.round(ep.targetStub.x) && p.y === Math.round(ep.targetStub.y)))
    .map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  return {
    refId: ep.refId,
    sourceSide: ep.sourceSide,
    targetSide: ep.targetSide,
    waypoints,
    pathWorld,
    ok: true,
  };
}

/**
 * Macrotask yield. `await Promise.resolve()` only drains the microtask queue, so the browser never
 * got to paint the progress overlay or dispatch its Cancel click — the batch looked frozen.
 * MessageChannel beats setTimeout(0) (no 4 ms clamping after nesting).
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(resolve, 0);
      return;
    }
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(null);
  });
}

/**
 * Batch-route every edge (caller supplies them in deterministic order, e.g. sorted by ref.id).
 * Marks each routed path on a shared world-keyed `WorldUsage` so later edges avoid earlier ones
 * (greedy crossing-min). Yields every `yieldEvery` edges and reports monotonic 0→100 progress;
 * abortable via `signal` (throws `AbortError`, no partial result returned).
 */
export async function orderEdges(
  edges: ReadonlyArray<OrderEdgeInput>,
  opts: OrderEdgesOptions,
): Promise<RoutedEdge[]> {
  const yieldEvery = opts.yieldEvery ?? YIELD_EVERY;
  const maxExplored = opts.maxExplored ?? MAX_EXPLORED;
  const maxGridCells = opts.maxGridCells ?? MAX_GRID_CELLS;
  const usage = new WorldUsage();
  const out: RoutedEdge[] = [];
  const total = edges.length;

  for (let i = 0; i < total; i++) {
    if (opts.signal?.aborted) throw new DOMException('Edge ordering aborted', 'AbortError');
    const ep = edges[i]!;
    const win = inflate(union(ep.sourceTable, ep.targetTable), GRID_MARGIN);
    const obstacles = opts.obstaclesFor(win, ep.sourceTableName, ep.targetTableName);
    const grid = buildRouteGrid(win, obstacles, maxGridCells);

    let routed: RoutedEdge;
    if (!grid) {
      routed = { refId: ep.refId, sourceSide: ep.sourceSide, targetSide: ep.targetSide, waypoints: [], pathWorld: [], ok: false };
    } else {
      grid.bindUsage(usage);
      routed = routeOneEdge(ep, grid, maxExplored);
    }
    out.push(routed);
    if (routed.ok && routed.pathWorld.length > 0) usage.add(routed.pathWorld);

    if ((i + 1) % yieldEvery === 0) {
      opts.onProgress?.(Math.floor(((i + 1) / total) * 100));
      await yieldToEventLoop();
    }
  }
  opts.onProgress?.(100);
  return out;
}
