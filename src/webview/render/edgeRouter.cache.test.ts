import { describe, expect, it } from 'vitest';
import type { EdgeLayout, Ref } from '../../shared/types';
import { EdgeRouteCache, routeRefs, type EdgeRoute } from './edgeRouter';
import type { Bbox } from './spatialIndex';

function ref(id: string, source: string, target: string): Ref {
  return {
    id,
    source: { table: source, columns: ['fk'], relation: '*' },
    target: { table: target, columns: ['id'], relation: '1' },
  };
}

const W = 200;
const H = 100;

function boxes(pos: Record<string, { x: number; y: number }>) {
  return (name: string): Bbox | undefined => {
    const p = pos[name];
    return p ? { x: p.x, y: p.y, w: W, h: H } : undefined;
  };
}

const byId = (routes: EdgeRoute[], id: string): EdgeRoute => {
  const r = routes.find((x) => x.id === id);
  if (!r) throw new Error(`route ${id} missing`);
  return r;
};

describe('EdgeRouteCache — incremental drag re-route', () => {
  // `a` and `b` both enter `u` on its left side; `c -> d` is unrelated to all of them.
  const refs = [ref('a-u', 'a', 'u'), ref('b-u', 'b', 'u'), ref('c-d', 'c', 'd')];
  const start = {
    a: { x: 0, y: 0 },
    b: { x: 200, y: 300 },
    u: { x: 1000, y: 0 },
    c: { x: 0, y: 2000 },
    d: { x: 600, y: 2000 },
  };

  it('keeps every route the move cannot change by identity', () => {
    const cache = new EdgeRouteCache();
    const before = cache.routeAll(refs, boxes(start));
    const pos = { ...start, a: { x: 0, y: 40 } };
    const after = cache.routeMoved(['a'], boxes(pos));
    expect(after).toEqual(routeRefs(refs, boxes(pos)));
    expect(byId(after, 'c-d')).toBe(byId(before, 'c-d'));
    expect(byId(after, 'a-u')).not.toBe(byId(before, 'a-u'));
  });

  it('returns the previous array when no ref touches the moved table', () => {
    const cache = new EdgeRouteCache();
    const before = cache.routeAll(refs, boxes({ ...start, z: { x: 9000, y: 0 } }));
    expect(cache.routeMoved(['z'], boxes({ ...start, z: { x: 9100, y: 0 } }))).toBe(before);
  });

  it('re-spreads a sibling stub when the dragged far end reorders a shared port side', () => {
    const cache = new EdgeRouteCache();
    const before = cache.routeAll(refs, boxes(start));
    // `a` slides past `b` along x: the (u, left) group re-sorts and `b-u` swaps its port slot
    // although neither `b` nor `u` moved.
    const pos = { ...start, a: { x: 400, y: 0 } };
    const after = cache.routeMoved(['a'], boxes(pos));
    expect(after).toEqual(routeRefs(refs, boxes(pos)));
    expect(byId(after, 'b-u').target).not.toEqual(byId(before, 'b-u').target);
  });

  it('re-spreads the side a dragged far end leaves', () => {
    const cache = new EdgeRouteCache();
    const before = cache.routeAll(refs, boxes(start));
    // `a` crosses to the right of `u`: `a-u` now enters u's right side and `b-u` is alone on the left.
    const pos = { ...start, a: { x: 1600, y: 0 } };
    const after = cache.routeMoved(['a'], boxes(pos));
    expect(after).toEqual(routeRefs(refs, boxes(pos)));
    expect(byId(after, 'b-u').target.y).not.toBe(byId(before, 'b-u').target.y);
  });

  it('matches a full re-route over random multi-table drags (self refs, side overrides, waypoints)', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const names = Array.from({ length: 14 }, (_, i) => `t${i}`);
    const pos: Record<string, { x: number; y: number }> = {};
    for (const n of names) pos[n] = { x: Math.round(rand() * 3000), y: Math.round(rand() * 2000) };
    const many: Ref[] = [];
    for (let i = 0; i < 30; i++) {
      const s = names[Math.floor(rand() * names.length)]!;
      const t = i % 9 === 0 ? s : names[Math.floor(rand() * names.length)]!;
      many.push(ref(`r${i}`, s, t));
    }
    many.push(ref('r-missing', 't0', 'ghost'));
    const layouts = new Map<string, EdgeLayout>([
      ['r1', { sourceSide: 'top', targetSide: 'bottom' }],
      ['r2', { waypoints: [{ x: 500, y: 500 }, { x: 500, y: 900 }] }],
      ['r3', { targetSide: 'top', dx: 30 }],
    ]);
    const layoutOf = (id: string) => layouts.get(id);
    const columnY = (table: string, column: string) => (column === 'fk' && table !== 't3' ? 40 : undefined);

    const cache = new EdgeRouteCache();
    cache.routeAll(many, boxes(pos), columnY, layoutOf);
    for (let step = 0; step < 200; step++) {
      const moved = new Set<string>();
      const k = 1 + Math.floor(rand() * 3);
      for (let j = 0; j < k; j++) moved.add(names[Math.floor(rand() * names.length)]!);
      for (const n of moved) {
        const p = pos[n]!;
        pos[n] = { x: p.x + Math.round((rand() - 0.5) * 900), y: p.y + Math.round((rand() - 0.5) * 600) };
      }
      const inc = cache.routeMoved(moved, boxes(pos), columnY, layoutOf);
      expect(inc).toEqual(routeRefs(many, boxes(pos), columnY, layoutOf));
    }
  });
});
