import { describe, expect, it, vi } from 'vitest';
import type { Bbox } from '../../render/spatialIndex';
import { buildRouteGrid, type Side } from './grid';
import { LOOP_STEP } from '../../render/edgeRouter';
import {
  chooseSides4,
  orderEdges,
  routeOneEdge,
  type OrderEdgeInput,
  type PortPoint,
  type RoutedEdge,
} from './astar';

const bbox = (x: number, y: number, w: number, h: number): Bbox => ({ x, y, w, h });

/** Build a full corner list (stub → interior waypoints → stub) for geometric assertions. */
function corners(r: RoutedEdge, ep: OrderEdgeInput): PortPoint[] {
  return [ep.sourceStub, ...r.waypoints, ep.targetStub];
}

/** True if segment p→q (axis-aligned) crosses the interior of bbox b. */
function segIntersects(p: PortPoint, q: PortPoint, b: Bbox): boolean {
  const x0 = Math.min(p.x, q.x);
  const x1 = Math.max(p.x, q.x);
  const y0 = Math.min(p.y, q.y);
  const y1 = Math.max(p.y, q.y);
  // Overlap of the segment's aabb with the box interior (strict on the thin axis).
  return x0 < b.x + b.w && x1 > b.x && y0 < b.y + b.h && y1 > b.y;
}

function isOrthogonal(pts: PortPoint[]): boolean {
  for (let i = 1; i < pts.length; i++) {
    if (pts[i]!.x !== pts[i - 1]!.x && pts[i]!.y !== pts[i - 1]!.y) return false;
  }
  return true;
}

/** Route one edge through a freshly-built grid (the unit-test convenience the batch loop wraps). */
function routeWithObstacles(ep: OrderEdgeInput, obstacles: Bbox[], maxExplored = 6000): RoutedEdge {
  const win = bbox(-400, -400, 1600, 1600);
  const grid = buildRouteGrid(win, obstacles, 4_000_000)!;
  return routeOneEdge(ep, grid, maxExplored);
}

const mkEdge = (over: Partial<OrderEdgeInput> = {}): OrderEdgeInput => ({
  refId: 'a::c|b::c',
  sourceStub: { x: 224, y: 50 },
  targetStub: { x: 576, y: 50 },
  sourceTable: bbox(0, 0, 200, 100),
  targetTable: bbox(600, 0, 200, 100),
  sourceTableName: 'public.a',
  targetTableName: 'public.b',
  sourceSide: 'right',
  targetSide: 'left',
  ...over,
});

describe('routeOneEdge — obstacle avoidance', () => {
  const obstacle = bbox(300, 20, 100, 60); // straddles the straight y=50 corridor

  it('routes around an obstacle on the straight corridor (no segment intersects it)', () => {
    const ep = mkEdge();
    const r = routeWithObstacles(ep, [obstacle]);
    expect(r.ok).toBe(true);
    expect(r.waypoints.length).toBeGreaterThan(0); // it HAD to bend
    const cs = corners(r, ep);
    for (let i = 1; i < cs.length; i++) {
      expect(segIntersects(cs[i - 1]!, cs[i]!, obstacle)).toBe(false);
    }
  });

  it('produces a strictly orthogonal path with alternating axes (no diagonal, no doubled axis)', () => {
    const ep = mkEdge();
    const cs = corners(routeWithObstacles(ep, [obstacle]), ep);
    expect(isOrthogonal(cs)).toBe(true);
    // After collinear-merge no two consecutive segments share an axis.
    for (let i = 2; i < cs.length; i++) {
      const a1 = cs[i - 1]!.x === cs[i - 2]!.x ? 'v' : 'h';
      const a2 = cs[i]!.x === cs[i - 1]!.x ? 'v' : 'h';
      expect(a1).not.toBe(a2);
    }
  });

  it('emits integer waypoints', () => {
    const r = routeWithObstacles(mkEdge(), [obstacle]);
    for (const w of r.waypoints) {
      expect(Number.isInteger(w.x)).toBe(true);
      expect(Number.isInteger(w.y)).toBe(true);
    }
  });
});

describe('routeOneEdge — between stubs / columnY anchoring', () => {
  it('keeps the stubs as the path ends and never lists the ports as waypoints', () => {
    const ep = mkEdge();
    const r = routeWithObstacles(ep, [bbox(300, 20, 100, 60)]);
    // The interior waypoints are strictly between the stubs; ends equal the stubs exactly.
    const cs = corners(r, ep);
    expect(cs[0]).toEqual(ep.sourceStub);
    expect(cs[cs.length - 1]).toEqual(ep.targetStub);
    expect(r.waypoints).not.toContainEqual(ep.sourceStub);
    expect(r.waypoints).not.toContainEqual(ep.targetStub);
  });

  it('preserves the L/R column-row anchor: the first/last bend stays on the stub Y', () => {
    // A clear corridor → straight shot → no interior waypoints, ends on the same y (the column row).
    const ep = mkEdge();
    const r = routeWithObstacles(ep, []);
    expect(r.ok).toBe(true);
    expect(ep.sourceStub.y).toBe(ep.targetStub.y);
    // With an obstacle forcing a bend, the stubs connect to the waypoints with orthogonal legs
    // (no renderer safety elbow), so the port row anchor is intact.
    const bent = routeWithObstacles(ep, [bbox(300, 20, 100, 60)]);
    expect(bent.waypoints.length).toBeGreaterThan(0);
    const poly = [ep.sourceStub, ...bent.waypoints, ep.targetStub];
    for (let i = 1; i < poly.length; i++) {
      const p = poly[i - 1]!;
      const q = poly[i]!;
      expect(p.x === q.x || p.y === q.y).toBe(true);
    }
  });

  it('returns [] waypoints for a clear straight corridor', () => {
    expect(routeWithObstacles(mkEdge(), []).waypoints).toEqual([]);
  });
});

describe('chooseSides4 — the render zone rule, left/right only', () => {
  it('target right of the source ⇒ right/left', () => {
    expect(chooseSides4(bbox(0, 0, 200, 100), bbox(600, 0, 200, 100))).toEqual({
      sourceSide: 'right',
      targetSide: 'left',
    });
  });

  it('target left of the source ⇒ left/right', () => {
    expect(chooseSides4(bbox(600, 0, 200, 100), bbox(0, 300, 200, 100))).toEqual({
      sourceSide: 'left',
      targetSide: 'right',
    });
  });

  it('x-overlapping (stacked) tables ⇒ a C on the right, never bottom/top', () => {
    for (const tgt of [bbox(40, 400, 200, 100), bbox(-40, -400, 200, 100), bbox(200, 400, 200, 100)]) {
      expect(chooseSides4(bbox(0, 0, 200, 100), tgt)).toEqual({ sourceSide: 'right', targetSide: 'right' });
    }
  });

  it('intersecting tables where both Cs cross a table (centre rows) ⇒ the facing connector by centre order', () => {
    const src = bbox(0, 0, 200, 100);
    for (const [tgt, sourceSide] of [
      [bbox(60, 40, 200, 100), 'right'],
      [bbox(200, 40, 200, 100), 'right'],
      [bbox(-60, 40, 200, 100), 'left'],
      [bbox(-200, -40, 200, 100), 'left'],
    ] as const) {
      expect(chooseSides4(src, tgt)).toEqual({ sourceSide, targetSide: sourceSide === 'right' ? 'left' : 'right' });
    }
  });

  it('intersecting tables a C clears ⇒ that C, the right one first', () => {
    expect(chooseSides4(bbox(0, 0, 200, 100), bbox(0, 100, 200, 100))).toEqual({ sourceSide: 'right', targetSide: 'right' });
    // Centre rows 50 / 140: the right arm at y=50 runs through the target, the left C clears both.
    expect(chooseSides4(bbox(0, 0, 200, 100), bbox(60, 40, 200, 200))).toEqual({ sourceSide: 'left', targetSide: 'left' });
  });

  it('the engine still routes caller-given top/bottom sides around a side obstacle', () => {
    // Stacked, with the bottom→top route needing to dodge an obstacle between them.
    const ep = mkEdge({
      sourceStub: { x: 100, y: 124 },
      targetStub: { x: 140, y: 376 },
      sourceTable: bbox(0, 0, 200, 100),
      targetTable: bbox(40, 400, 200, 100),
      sourceSide: 'bottom',
      targetSide: 'top',
    });
    const obstacle = bbox(60, 200, 120, 60);
    const r = routeWithObstacles(ep, [obstacle]);
    expect(r.ok).toBe(true);
    const cs = corners(r, ep);
    for (let i = 1; i < cs.length; i++) {
      expect(segIntersects(cs[i - 1]!, cs[i]!, obstacle)).toBe(false);
    }
    // A bottom/top edge departs VERTICALLY: the first bend shares the source-stub X.
    expect(r.waypoints[0]!.x).toBe(ep.sourceStub.x);
  });
});

describe('routeOneEdge — fallback', () => {
  it('falls back to [] waypoints (no throw) when the node cap is exceeded', () => {
    const r = routeWithObstacles(mkEdge(), [bbox(300, 20, 100, 60)], 1);
    expect(r.ok).toBe(false);
    expect(r.waypoints).toEqual([]);
  });
});

describe('orderEdges — endpoint tables are obstacles', () => {
  // Stacked a / m / b, 16 apart: a's bottom stub end lies inside m, so the only cells that reach it
  // run through a itself — which used to end in a spur back over the stub.
  const a = bbox(0, 0, 240, 140);
  const m = bbox(0, 156, 240, 100);
  const b = bbox(0, 272, 240, 100);
  const up = mkEdge({
    sourceStub: { x: 120, y: 248 },
    targetStub: { x: 80, y: 164 },
    sourceTable: b,
    targetTable: a,
    sourceTableName: 'public.b',
    targetTableName: 'public.a',
    sourceSide: 'top',
    targetSide: 'bottom',
  });
  const down = mkEdge({
    sourceStub: up.targetStub,
    targetStub: up.sourceStub,
    sourceTable: a,
    targetTable: b,
    sourceTableName: 'public.a',
    targetTableName: 'public.b',
    sourceSide: 'bottom',
    targetSide: 'top',
  });

  for (const ep of [up, down]) {
    it(`never cuts through its own table (${ep.sourceSide} → ${ep.targetSide})`, async () => {
      const [r] = await orderEdges([ep], { obstaclesFor: () => [m] });
      const cs = corners(r!, ep);
      for (let i = 1; i < cs.length; i++) {
        expect(segIntersects(cs[i - 1]!, cs[i]!, a)).toBe(false);
        expect(segIntersects(cs[i - 1]!, cs[i]!, b)).toBe(false);
      }
    });
  }
});

describe('orderEdges — batch determinism, crossing, progress, abort', () => {
  const noObstacles = () => [];

  it('is deterministic: two runs produce byte-identical waypoints', async () => {
    const edges = [mkEdge({ refId: 'e1' }), mkEdge({ refId: 'e2', sourceStub: { x: 224, y: 70 }, targetStub: { x: 576, y: 70 } })];
    const obsFor = (w: Bbox) => [bbox(300, 0, 80, 200)];
    const a = await orderEdges(edges, { obstaclesFor: obsFor });
    const b = await orderEdges(edges, { obstaclesFor: obsFor });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('non-interacting edges (disjoint windows) are independent of input array order', async () => {
    // Far apart: no shared cells, so processing order cannot change either route.
    const e1 = mkEdge({ refId: 'e1' });
    const e2 = mkEdge({
      refId: 'e2',
      sourceStub: { x: 224, y: 5000 },
      targetStub: { x: 576, y: 5000 },
      sourceTable: bbox(0, 4950, 200, 100),
      targetTable: bbox(600, 4950, 200, 100),
    });
    const obsFor = () => [];
    const fwd = await orderEdges([e1, e2], { obstaclesFor: obsFor });
    const rev = await orderEdges([e2, e1], { obstaclesFor: obsFor });
    const byId = (rs: RoutedEdge[]) => Object.fromEntries(rs.map((r) => [r.refId, r.waypoints]));
    expect(byId(fwd)).toEqual(byId(rev));
  });

  it('accumulates crossing usage so a parallel edge is pushed off a shared corridor (world-keyed)', () => {
    // Two edges that want the SAME straight horizontal corridor (y=200). Routed alone each is
    // straight ([]); routed together the second pays CROSS_COST over many shared cells and detours.
    const mkCorridor = (refId: string): OrderEdgeInput =>
      mkEdge({
        refId,
        sourceStub: { x: 224, y: 200 },
        targetStub: { x: 576, y: 200 },
        sourceTable: bbox(0, 150, 200, 100),
        targetTable: bbox(600, 150, 200, 100),
      });
    const a = mkCorridor('a');
    const b = mkCorridor('b');
    return (async () => {
      const alone = await orderEdges([b], { obstaclesFor: () => [] });
      const together = await orderEdges([a, b], { obstaclesFor: () => [] });
      const bAlone = alone.find((r) => r.refId === 'b')!;
      const bAfterA = together.find((r) => r.refId === 'b')!;
      expect(bAlone.waypoints).toEqual([]); // unobstructed: straight
      expect(bAfterA.waypoints.length).toBeGreaterThan(0); // shared-corridor usage forced a detour
    })();
  });

  it('never runs along a lane (a loop or C trunk), but may cross it', async () => {
    // A Z whose free route has one vertical run; a lane laid on exactly that run must move it.
    const ep = mkEdge({ targetStub: { x: 576, y: 450 }, targetTable: bbox(600, 400, 200, 100) });
    const [free] = await orderEdges([ep], { obstaclesFor: () => [] });
    const runs = (r: RoutedEdge) => {
      const cs = corners(r, ep);
      return cs.slice(1).flatMap((q, i) => (cs[i]!.x === q.x && cs[i]!.y !== q.y ? [q.x] : []));
    };
    const laneX = runs(free!)[0]!;
    expect(laneX).toBeDefined();
    const [laned] = await orderEdges([ep], { obstaclesFor: () => [], lanes: [bbox(laneX, 0, 0, 500)] });
    expect(laned!.ok).toBe(true);
    for (const x of runs(laned!)) expect(Math.abs(x - laneX)).toBeGreaterThanOrEqual(LOOP_STEP);

    // A lane across the straight corridor is crossed, not detoured round.
    const [crossed] = await orderEdges([mkEdge()], { obstaclesFor: () => [], lanes: [bbox(400, 0, 0, 100)] });
    expect(crossed!.ok).toBe(true);
    expect(crossed!.waypoints).toEqual([]);
  });

  it('a routed C lays a lane for the edges after it', async () => {
    // Two Cs round a wide middle table, walled in so ONE column (x=300) is the only way past it:
    // crossing usage alone would let the second C share it; the lane makes it fall back instead.
    const c = (refId: string, y0: number, y1: number): OrderEdgeInput =>
      mkEdge({
        refId,
        sourceStub: { x: 224, y: y0 },
        targetStub: { x: 224, y: y1 },
        sourceTable: bbox(0, 0, 200, 100),
        targetTable: bbox(0, 300, 200, 100),
        sourceSide: 'right',
        targetSide: 'right',
      });
    const walls = [bbox(0, 140, 260, 120), bbox(330, -400, 40, 1200), bbox(-80, -400, 40, 1200)];
    const [first, second] = await orderEdges([c('a', 40, 340), c('b', 60, 360)], { obstaclesFor: () => walls });
    expect(first!.waypoints.map((w) => w.x)).toContain(300);
    expect(second!.ok).toBe(false);
  });

  it('reports monotonic progress ending at 100', async () => {
    const edges = Array.from({ length: 20 }, (_, i) => mkEdge({ refId: `e${i}` }));
    const seen: number[] = [];
    await orderEdges(edges, { obstaclesFor: () => [], yieldEvery: 4, onProgress: (p) => seen.push(p) });
    expect(seen.length).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(seen[0]!).toBeGreaterThanOrEqual(0);
    expect(seen[seen.length - 1]).toBe(100);
  });

  it('yields to the event loop (macrotask) between progress emits, so paint/cancel can run', async () => {
    const edges = Array.from({ length: 12 }, (_, i) => mkEdge({ refId: `e${i}` }));
    let timerFired = false;
    const firedBeforeProgress: boolean[] = [];
    setTimeout(() => { timerFired = true; }, 0);
    await orderEdges(edges, { obstaclesFor: () => [], yieldEvery: 4, onProgress: () => firedBeforeProgress.push(timerFired) });
    // With a microtask yield the timer could only run after the whole batch; a real yield lets it
    // fire before the second progress emit.
    expect(firedBeforeProgress.some(Boolean)).toBe(true);
  });

  it('aborts early and yields nothing (throws AbortError, no partial result)', async () => {
    const edges = Array.from({ length: 40 }, (_, i) => mkEdge({ refId: `e${i}` }));
    const ctrl = new AbortController();
    let progressCalls = 0;
    const p = orderEdges(edges, {
      obstaclesFor: () => [],
      yieldEvery: 4,
      signal: ctrl.signal,
      onProgress: () => {
        progressCalls++;
        ctrl.abort(); // abort after the first progress emit
      },
    });
    await expect(p).rejects.toThrow(/abort/i);
    expect(progressCalls).toBeLessThan(edges.length); // it did NOT finish all
  });
});
