import { describe, expect, it } from 'vitest';
import { EdgeRouteCache, routeRefs, type EdgeRoute } from './edgeRouter';
import type { EdgeLayout, Ref } from '../../shared/types';
import type { Bbox } from './spatialIndex';

const W = 200;
const H = 100;

const ref = (id: string, source: string, target: string): Ref => ({
  id,
  source: { table: source, columns: ['fk'], relation: '*' },
  target: { table: target, columns: ['id'], relation: '1' },
});

const boxes = (pos: Record<string, { x: number; y: number }>) => (name: string): Bbox | undefined => {
  const p = pos[name];
  return p ? { x: p.x, y: p.y, w: W, h: H } : undefined;
};

const rowY = () => 40;

/** True when the segment runs through the bbox interior (sitting on its border is fine). */
function crossesInterior(s: EdgeRoute['segments'][number], b: Bbox): boolean {
  const x0 = Math.min(s.x1, s.x2);
  const x1 = Math.max(s.x1, s.x2);
  const y0 = Math.min(s.y1, s.y2);
  const y1 = Math.max(s.y1, s.y2);
  return x0 < b.x + b.w && x1 > b.x && y0 < b.y + b.h && y1 > b.y;
}

const insideAny = (r: EdgeRoute, ...bs: Bbox[]) => r.segments.some((s) => bs.some((b) => crossesInterior(s, b)));

describe('routeRefs — x-overlapping tables use top/bottom ports (spec 05 Limitaciones 5)', () => {
  // `b` sits below `a`, shifted right but still inside a's x-extent.
  const stacked = { a: { x: 0, y: 0 }, b: { x: 50, y: 300 } };

  it('routes source bottom → target top through the vertical gap, never behind either table', () => {
    const bboxOf = boxes(stacked);
    const r = routeRefs([ref('a-b', 'a', 'b')], bboxOf, rowY)[0]!;
    expect(r.source.y).toBe(H); // a's bottom border
    expect(r.target.y).toBe(300); // b's top border
    expect(r.segments[0]!.axis).toBe('v');
    expect(r.segments[r.segments.length - 1]!.axis).toBe('v');
    expect(insideAny(r, bboxOf('a')!, bboxOf('b')!)).toBe(false);
  });

  it('flips to source top → target bottom when the target is above', () => {
    const bboxOf = boxes(stacked);
    const r = routeRefs([ref('b-a', 'b', 'a')], bboxOf, rowY)[0]!;
    expect(r.source.y).toBe(300);
    expect(r.target.y).toBe(H);
    expect(insideAny(r, bboxOf('a')!, bboxOf('b')!)).toBe(false);
  });

  it('keeps left/right once the x-extents no longer overlap', () => {
    const r = routeRefs([ref('a-b', 'a', 'b')], boxes({ a: { x: 0, y: 0 }, b: { x: W + 10, y: 300 } }), rowY)[0]!;
    expect(r.source.x).toBe(W);
    expect(r.target.x).toBe(W + 10);
  });

  it('spreads several edges along a shared top side, sorted by the far end', () => {
    const pos = { u: { x: 0, y: 400 }, p: { x: -120, y: 0 }, q: { x: 120, y: 0 } };
    const routes = routeRefs([ref('q-u', 'q', 'u'), ref('p-u', 'p', 'u')], boxes(pos), rowY);
    const p = routes.find((r) => r.id === 'p-u')!;
    const q = routes.find((r) => r.id === 'q-u')!;
    expect(p.target.y).toBe(400);
    expect(q.target.y).toBe(400);
    expect(p.target.x).toBeLessThan(q.target.x);
    expect(p.target.x).toBeCloseTo(W / 3);
    expect(q.target.x).toBeCloseTo((2 * W) / 3);
  });

  it('respects a persisted left/right override on both ends', () => {
    const layout: EdgeLayout = { sourceSide: 'right', targetSide: 'left' };
    const r = routeRefs([ref('a-b', 'a', 'b')], boxes(stacked), rowY, () => layout)[0]!;
    expect(r.source).toEqual({ x: W, y: 40 });
    expect(r.target).toEqual({ x: 50, y: 340 });
  });

  it('a single left/right override keeps the auto end horizontal (no L elbow through the table)', () => {
    const bboxOf = boxes(stacked);
    const r = routeRefs([ref('a-b', 'a', 'b')], bboxOf, rowY, () => ({ sourceSide: 'left' }))[0]!;
    expect(r.source.x).toBe(0);
    expect([50, 50 + W]).toContain(r.target.x);
    expect(r.segments[r.segments.length - 1]!.axis).toBe('h');
    expect(insideAny(r, bboxOf('a')!, bboxOf('b')!)).toBe(false);
  });

  it('draws persisted top/bottom sides as before', () => {
    const r = routeRefs(
      [ref('a-b', 'a', 'b')],
      boxes({ a: { x: 0, y: 0 }, b: { x: 600, y: 300 } }),
      rowY,
      () => ({ sourceSide: 'bottom', targetSide: 'top' }),
    )[0]!;
    expect(r.source.y).toBe(H);
    expect(r.target.y).toBe(300);
  });

  it('leaves self-loops on their side', () => {
    const r = routeRefs([{ ...ref('a-a', 'a', 'a'), target: { table: 'a', columns: ['id'], relation: '1' } }], boxes(stacked), rowY)[0]!;
    expect(r.loop).toBe(true);
    expect(r.source.x).toBe(W);
  });
});

describe('EdgeRouteCache — drags across the x-overlap boundary', () => {
  it('routeMoved matches a full rebuild when a table enters and leaves x-overlap', () => {
    const refs = [ref('a-b', 'a', 'b'), ref('c-b', 'c', 'b')];
    const pos = { a: { x: 0, y: 0 }, b: { x: 600, y: 300 }, c: { x: 650, y: 700 } };
    const cache = new EdgeRouteCache();
    cache.routeAll(refs, boxes(pos), rowY);
    for (const x of [100, 450, 0, 801, -300]) {
      pos.a = { x, y: 0 };
      expect(cache.routeMoved(['a'], boxes(pos), rowY)).toEqual(routeRefs(refs, boxes(pos), rowY));
    }
  });

  it('matches a full re-route over random drags that keep crossing the overlap boundary', () => {
    let seed = 11;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    // A narrow x band (~3 table widths) so most drags flip some pair in or out of x-overlap.
    const names = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const pos: Record<string, { x: number; y: number }> = {};
    for (const n of names) pos[n] = { x: Math.round(rand() * 600), y: Math.round(rand() * 3000) };
    const many: Ref[] = [];
    for (let i = 0; i < 28; i++) {
      const s = names[Math.floor(rand() * names.length)]!;
      const t = i % 9 === 0 ? s : names[Math.floor(rand() * names.length)]!;
      many.push(ref(`r${i}`, s, t));
    }
    const layouts = new Map<string, EdgeLayout>([
      ['r1', { sourceSide: 'right', targetSide: 'left' }],
      ['r2', { sourceSide: 'left' }],
      ['r3', { sourceSide: 'top', targetSide: 'bottom' }],
      ['r4', { waypoints: [{ x: 300, y: 500 }, { x: 300, y: 900 }] }],
    ]);
    const layoutOf = (id: string) => layouts.get(id);
    const vertical = (routes: EdgeRoute[]) => new Set(routes.filter((r) => !r.loop && r.segments[0]?.axis === 'v').map((r) => r.id));

    const cache = new EdgeRouteCache();
    let prevVertical = vertical(cache.routeAll(many, boxes(pos), rowY, layoutOf));
    let crossings = 0;
    for (let step = 0; step < 200; step++) {
      const moved = new Set<string>();
      const k = 1 + Math.floor(rand() * 3);
      for (let j = 0; j < k; j++) moved.add(names[Math.floor(rand() * names.length)]!);
      for (const n of moved) {
        const p = pos[n]!;
        pos[n] = { x: Math.max(-200, Math.min(800, p.x + Math.round((rand() - 0.5) * 500))), y: p.y + Math.round((rand() - 0.5) * 400) };
      }
      const inc = cache.routeMoved(moved, boxes(pos), rowY, layoutOf);
      expect(inc).toEqual(routeRefs(many, boxes(pos), rowY, layoutOf));
      const now = vertical(inc);
      for (const id of now) if (!prevVertical.has(id)) crossings++;
      for (const id of prevVertical) if (!now.has(id)) crossings++;
      prevVertical = now;
    }
    expect(crossings).toBeGreaterThan(20);
  });
});
