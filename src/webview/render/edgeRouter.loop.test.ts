import { describe, expect, it } from 'vitest';
import type { EdgeLayout, Ref } from '../../shared/types';
import { EdgeRouteCache, LOOP_OFFSET, LOOP_STEP, routeRefs, type EdgeRoute } from './edgeRouter';
import type { Bbox } from './spatialIndex';

const W = 200;
const H = 100;

function ref(id: string, source: string, sCol: string, target: string, tCol: string): Ref {
  return {
    id,
    source: { table: source, columns: [sCol], relation: '*' },
    target: { table: target, columns: [tCol], relation: '1' },
  };
}

function boxes(pos: Record<string, { x: number; y: number }>) {
  return (name: string): Bbox | undefined => {
    const p = pos[name];
    return p ? { x: p.x, y: p.y, w: W, h: H } : undefined;
  };
}

const ROW_Y: Record<string, number> = { a: 30, b: 70, c: 40, d: 60 };
const columnY = (_table: string, column: string) => ROW_Y[column];
const pos = { t: { x: 100, y: 50 }, u: { x: 1000, y: 50 } };

const byId = (routes: EdgeRoute[], id: string): EdgeRoute => {
  const r = routes.find((x) => x.id === id);
  if (!r) throw new Error(`route ${id} missing`);
  return r;
};

const corners = (r: EdgeRoute) => r.segments.flatMap((s) => [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }]);
const trunk = (r: EdgeRoute) => r.segments.filter((s) => s.axis === 'v');

describe('self-loops (spec 05 §Self-loops)', () => {
  it('leaves and re-enters the right side by default, through the column rows', () => {
    const [r] = routeRefs([ref('l', 't', 'a', 't', 'b')], boxes(pos), columnY);
    expect(r!.loop).toBe(true);
    expect(r!.source).toEqual({ x: 300, y: 80 });
    expect(r!.target).toEqual({ x: 300, y: 120 });
    expect(r!.sourceStub).toEqual({ x: 324, y: 80 });
    expect(r!.targetStub).toEqual({ x: 324, y: 120 });
    expect(trunk(r!)).toEqual([expect.objectContaining({ x1: 300 + LOOP_OFFSET, y1: 80, x2: 300 + LOOP_OFFSET, y2: 120 })]);
    for (const c of corners(r!)) expect(c.x).toBeGreaterThanOrEqual(300);
    expect(r!.d.startsWith('M300,80')).toBe(true);
    expect(r!.d.endsWith('L300,120')).toBe(true);
    expect(r!.segments[0]!.rigid).toBe(true);
    expect(r!.segments[r!.segments.length - 1]!.rigid).toBe(true);
  });

  it('stacks several loops on one side, the shorter span inside', () => {
    const outer = ref('a-outer', 't', 'a', 't', 'b'); // span 40
    const inner = ref('z-inner', 't', 'c', 't', 'd'); // span 20
    const routes = routeRefs([outer, inner], boxes(pos), columnY);
    expect(trunk(byId(routes, 'z-inner'))[0]!.x1).toBe(300 + LOOP_OFFSET);
    expect(trunk(byId(routes, 'a-outer'))[0]!.x1).toBe(300 + LOOP_OFFSET + LOOP_STEP);
  });

  it('a loop on the other side does not push a loop outward', () => {
    const layouts = new Map<string, EdgeLayout>([['l2', { sourceSide: 'left', targetSide: 'left' }]]);
    const routes = routeRefs([ref('l1', 't', 'a', 't', 'b'), ref('l2', 't', 'c', 't', 'd')], boxes(pos), columnY, (id) => layouts.get(id));
    expect(trunk(byId(routes, 'l1'))[0]!.x1).toBe(300 + LOOP_OFFSET);
    expect(trunk(byId(routes, 'l2'))[0]!.x1).toBe(100 - LOOP_OFFSET);
  });

  it('splits the ports of a same-column loop by a quarter row', () => {
    const [r] = routeRefs([ref('l', 't', 'c', 't', 'c')], boxes(pos), columnY, undefined, 20);
    expect(r!.source).toEqual({ x: 300, y: 85 });
    expect(r!.target).toEqual({ x: 300, y: 95 });
    expect(trunk(r!)[0]!.x1).toBe(300 + LOOP_OFFSET);
  });

  it('a flip moves both ends to the left side', () => {
    const layouts = new Map<string, EdgeLayout>([['l', { sourceSide: 'left', targetSide: 'left' }]]);
    const [r] = routeRefs([ref('l', 't', 'a', 't', 'b')], boxes(pos), columnY, (id) => layouts.get(id));
    expect(r!.source).toEqual({ x: 100, y: 80 });
    expect(r!.target).toEqual({ x: 100, y: 120 });
    expect(trunk(r!)[0]!.x1).toBe(100 - LOOP_OFFSET);
    for (const c of corners(r!)) expect(c.x).toBeLessThanOrEqual(100);
  });

  it('ignores waypoints and top/bottom sides persisted for a loop', () => {
    const layouts = new Map<string, EdgeLayout>([['l', { waypoints: [{ x: 900, y: 900 }], sourceSide: 'top', targetSide: 'bottom' }]]);
    const [r] = routeRefs([ref('l', 't', 'a', 't', 'b')], boxes(pos), columnY, (id) => layouts.get(id));
    expect(r!.waypoints).toEqual([]);
    expect(r!.source).toEqual({ x: 300, y: 80 });
    expect(trunk(r!)[0]!.x1).toBe(300 + LOOP_OFFSET);
  });

  it('joins the side port group like any other edge', () => {
    const routes = routeRefs([ref('l', 't', 'a', 't', 'b'), ref('e', 't', 'a', 'u', 'a')], boxes(pos));
    const ys = [byId(routes, 'l').source.y, byId(routes, 'l').target.y, byId(routes, 'e').source.y].sort((p, q) => p - q);
    expect(ys).toEqual([75, 100, 125]);
  });

  it('a dragged table re-routes its loops, matching a full rebuild', () => {
    const refs = [ref('l1', 't', 'a', 't', 'b'), ref('l2', 't', 'c', 't', 'd'), ref('e', 't', 'a', 'u', 'a')];
    const cache = new EdgeRouteCache();
    const before = cache.routeAll(refs, boxes(pos), columnY);
    const next = { ...pos, t: { x: 160, y: 90 } };
    const after = cache.routeMoved(['t'], boxes(next), columnY);
    expect(after).toEqual(routeRefs(refs, boxes(next), columnY));
    expect(byId(after, 'l1')).not.toBe(byId(before, 'l1'));
    expect(byId(after, 'l1').source).toEqual({ x: 360, y: 120 });
  });
});
