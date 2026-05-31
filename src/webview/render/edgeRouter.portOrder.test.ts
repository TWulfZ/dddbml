import { describe, it, expect } from 'vitest';
import type { Ref } from '../../shared/types';
import { routeRefs, type EdgeRoute } from './edgeRouter';
import type { Bbox } from './spatialIndex';

export {};

// Two edges leave table `a` on its right side, one to `b` (above) and one to `c` (below). They
// share the (a, right) port group, so their port Y is decided by the group sort. The assignment
// must depend only on geometry + ref ids — NOT on the refs[] array order, which @dbml/core can
// shuffle on re-parse (otherwise the sidecar would churn on an unrelated re-parse).
function makeRef(id: string, source: string, target: string): Ref {
  return {
    id,
    source: { table: source, columns: ['fk'], relation: '*' },
    target: { table: target, columns: ['id'], relation: '1' },
  };
}

function bboxOf(name: string): Bbox | undefined {
  const map: Record<string, Bbox> = {
    a: { x: 0, y: 100, w: 200, h: 100 }, // middle
    b: { x: 400, y: 0, w: 200, h: 100 }, // above
    c: { x: 400, y: 300, w: 200, h: 100 }, // below
  };
  return map[name];
}

function sourcePortY(routes: EdgeRoute[], id: string): number {
  const r = routes.find((x) => x.id === id);
  if (!r) throw new Error(`route ${id} missing`);
  return r.source.y;
}

describe('edgeRouter — port assignment determinism', () => {
  it('assigns the same port to each edge regardless of refs[] order', () => {
    const toB = makeRef('to-b', 'a', 'b');
    const toC = makeRef('to-c', 'a', 'c');

    const forward = routeRefs([toB, toC], bboxOf);
    const reversed = routeRefs([toC, toB], bboxOf);

    // Same ref id → same source port Y, independent of input order.
    expect(sourcePortY(forward, 'to-b')).toBe(sourcePortY(reversed, 'to-b'));
    expect(sourcePortY(forward, 'to-c')).toBe(sourcePortY(reversed, 'to-c'));
  });

  it('the edge to the higher target gets the higher port (barycentric crossing reduction)', () => {
    const toB = makeRef('to-b', 'a', 'b'); // b is above
    const toC = makeRef('to-c', 'a', 'c'); // c is below
    const routes = routeRefs([toB, toC], bboxOf);
    // Smaller y = higher on screen. Edge to the higher target (b) should exit higher.
    expect(sourcePortY(routes, 'to-b')).toBeLessThan(sourcePortY(routes, 'to-c'));
  });
});
