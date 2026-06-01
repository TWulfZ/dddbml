import { describe, expect, it, vi } from 'vitest';
import type { Bbox } from '../../render/spatialIndex';
import { buildRouteGrid, type Side } from './grid';
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
    // With an obstacle forcing a bend, the segment leaving the source still departs horizontally
    // (the first waypoint shares the source-stub Y), so the port row anchor is intact.
    const bent = routeWithObstacles(ep, [bbox(300, 20, 100, 60)]);
    expect(bent.waypoints[0]!.y).toBe(ep.sourceStub.y);
    expect(bent.waypoints[bent.waypoints.length - 1]!.y).toBe(ep.targetStub.y);
  });

  it('returns [] waypoints for a clear straight corridor', () => {
    expect(routeWithObstacles(mkEdge(), []).waypoints).toEqual([]);
  });
});

describe('chooseSides4 — picks top/bottom only when stacked vertically', () => {
  it('side-by-side tables ⇒ left/right', () => {
    expect(chooseSides4(bbox(0, 0, 200, 100), bbox(600, 0, 200, 100))).toEqual({
      sourceSide: 'right',
      targetSide: 'left',
    });
  });

  it('vertically stacked tables ⇒ bottom/top', () => {
    expect(chooseSides4(bbox(0, 0, 200, 100), bbox(40, 400, 200, 100))).toEqual({
      sourceSide: 'bottom',
      targetSide: 'top',
    });
  });

  it('routes a top/bottom edge around a side obstacle when sides are chosen that way', () => {
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

  it('reports monotonic progress ending at 100', async () => {
    const edges = Array.from({ length: 20 }, (_, i) => mkEdge({ refId: `e${i}` }));
    const seen: number[] = [];
    await orderEdges(edges, { obstaclesFor: () => [], yieldEvery: 4, onProgress: (p) => seen.push(p) });
    expect(seen.length).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(seen[0]!).toBeGreaterThanOrEqual(0);
    expect(seen[seen.length - 1]).toBe(100);
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
