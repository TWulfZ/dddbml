import { describe, expect, it } from 'vitest';
import { roundedPathString, routeRefs } from './edgeRouter';
import type { Ref } from '../../shared/types';
import type { Bbox } from './spatialIndex';

describe('roundedPathString — render-time corner fillets', () => {
  it('keeps a straight (colinear) polyline straight — no Q, no extra points', () => {
    expect(roundedPathString([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }], 8)).toBe(
      'M0,0 L50,0 L100,0',
    );
  });

  it('rounds an interior corner with a quadratic whose control point IS the corner', () => {
    // Corner at (100,0); both legs length 100 >> 2*radius, so radius is the full 8.
    expect(roundedPathString([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 8)).toBe(
      'M0,0 L92,0 Q100,0 100,8 L100,100',
    );
  });

  it('clamps the radius to half of the shorter adjacent segment', () => {
    // Both legs are length 10, so the fillet radius clamps from 8 down to 5 (= 10/2).
    expect(roundedPathString([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 8)).toBe(
      'M0,0 L5,0 Q10,0 10,5 L10,10',
    );
  });

  it('drops coincident points (e.g. stubs that met)', () => {
    expect(roundedPathString([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }], 8)).toBe(
      'M0,0 L100,0',
    );
  });

  it('emits a plain segment for <= 2 points', () => {
    expect(roundedPathString([{ x: 0, y: 0 }, { x: 100, y: 0 }], 8)).toBe('M0,0 L100,0');
    expect(roundedPathString([{ x: 5, y: 5 }], 8)).toBe('M5,5');
  });
});

describe('routeRefs — rounded corners in the rendered path', () => {
  const mkRef = (): Ref => ({
    id: 'a::col|b::col',
    source: { table: 'public.a', columns: ['col'], relation: '*' },
    target: { table: 'public.b', columns: ['col'], relation: '1' },
  });
  const bbox = (x: number, y: number, w = 200, h = 100): Bbox => ({ x, y, w, h });

  it('a same-row edge stays straight (no fillet)', () => {
    const of = (n: string): Bbox | undefined =>
      n === 'public.a' ? bbox(0, 0) : n === 'public.b' ? bbox(400, 0) : undefined;
    const r = routeRefs([mkRef()], of)[0]!;
    expect(r.d).not.toContain('Q');
  });

  it('a bent edge rounds its corners (the waypoint corner becomes a Q control point)', () => {
    const of = (n: string): Bbox | undefined =>
      n === 'public.a' ? bbox(0, 0) : n === 'public.b' ? bbox(400, 200) : undefined;
    const r = routeRefs([mkRef()], of, undefined, () => ({ waypoints: [{ x: 300, y: 150 }] }))[0]!;
    expect(r.d).toContain('Q'); // corners are filleted
    expect(r.d).toContain('Q300,150'); // the waypoint is a literal corner → quadratic control point
    expect(r.d).not.toContain('NaN');
  });
});
