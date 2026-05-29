import { describe, expect, it } from 'vitest';
import { routeRefs } from './edgeRouter';
import type { Ref } from '../../shared/types';
import type { Bbox } from './spatialIndex';

const mkRef = (overrides?: Partial<Ref>): Ref => ({
  id: 'a::col|b::col',
  source: { table: 'public.a', columns: ['col'], relation: '*' },
  target: { table: 'public.b', columns: ['col'], relation: '1' },
  ...overrides,
});

const bbox = (x: number, y: number, w = 200, h = 100): Bbox => ({ x, y, w, h });

describe('routeRefs — waypoint routing', () => {
  it('produces a straight path framed by two rigid stubs when no waypoints are set', () => {
    const bboxOf = (n: string): Bbox | undefined => {
      if (n === 'public.a') return bbox(0, 0);
      if (n === 'public.b') return bbox(400, 0);
      return undefined;
    };
    const routes = routeRefs([mkRef()], bboxOf);
    expect(routes).toHaveLength(1);
    const r = routes[0]!;
    expect(r.waypoints).toEqual([]);
    // Source port (200,50), target port (400,50). Rigid stubs are kept as distinct corners:
    // a(200,50) → aStub(224,50) → bStub(376,50) → b(400,50). Visually a straight line.
    expect(r.d).toBe('M200,50 L224,50 L376,50 L400,50');
    expect(r.sourceStub).toEqual({ x: 224, y: 50 });
    expect(r.targetStub).toEqual({ x: 376, y: 50 });
    // 3 segments: rigid stub, editable middle, rigid stub.
    expect(r.segments).toHaveLength(3);
    expect(r.segments[0]!.rigid).toBe(true);
    expect(r.segments[1]!.rigid).toBe(false); // editable middle (the only subdividable section)
    expect(r.segments[2]!.rigid).toBe(true);
  });

  it('routes through a single waypoint with alternating axes', () => {
    const bboxOf = (n: string): Bbox | undefined => {
      if (n === 'public.a') return bbox(0, 0);   // port at (200, 50)
      if (n === 'public.b') return bbox(400, 200); // port at (400, 250)
      return undefined;
    };
    const layoutResolver = (id: string) =>
      id === 'a::col|b::col' ? { waypoints: [{ x: 300, y: 150 }] } : undefined;
    const routes = routeRefs([mkRef()], bboxOf, undefined, layoutResolver);
    const r = routes[0]!;
    expect(r.waypoints).toEqual([{ x: 300, y: 150 }]);
    // a=(200,50), waypoint=(300,150), b=(400,250). The waypoint is a literal route corner, so it
    // appears as the rounded-corner control point (Q300,150), not a mid-segment line vertex.
    expect(r.d).toContain('M200,50');
    expect(r.d).toContain('300,150');
    expect(r.d).toContain('L400,250');
  });

  it('routes through multiple waypoints with strict orthogonality', () => {
    const bboxOf = (n: string): Bbox | undefined => {
      if (n === 'public.a') return bbox(0, 0);
      if (n === 'public.b') return bbox(800, 200);
      return undefined;
    };
    const wps = [{ x: 250, y: 100 }, { x: 500, y: 100 }, { x: 500, y: 300 }];
    const layoutResolver = (id: string) =>
      id === 'a::col|b::col' ? { waypoints: wps } : undefined;
    const routes = routeRefs([mkRef()], bboxOf, undefined, layoutResolver);
    const r = routes[0]!;
    expect(r.waypoints).toHaveLength(3);
    // Every segment must be either horizontal or vertical (orthogonality invariant).
    for (const s of r.segments) {
      const isH = s.y1 === s.y2;
      const isV = s.x1 === s.x2;
      expect(isH || isV).toBe(true);
    }
  });

  it('segments expose the correct insertion index per segment', () => {
    const bboxOf = (n: string): Bbox | undefined => {
      if (n === 'public.a') return bbox(0, 0);
      if (n === 'public.b') return bbox(600, 200);
      return undefined;
    };
    const wps = [{ x: 200, y: 100 }, { x: 400, y: 100 }];
    const layoutResolver = (_: string) => ({ waypoints: wps });
    const r = routeRefs([mkRef()], bboxOf, undefined, layoutResolver)[0]!;
    const endIndices = r.segments.map((s) => s.endWaypointIndex);
    // Must hit waypoint 0 before waypoint 1 before null (post-waypoints).
    let lastSeen = -1;
    for (const idx of endIndices) {
      if (idx === null) continue;
      expect(idx).toBeGreaterThanOrEqual(lastSeen);
      lastSeen = idx;
    }
    // At least one segment ends at each waypoint.
    expect(endIndices.includes(0)).toBe(true);
    expect(endIndices.includes(1)).toBe(true);
    expect(endIndices.includes(null)).toBe(true);
  });

  it('honors legacy dx when waypoints is absent', () => {
    const bboxOf = (n: string): Bbox | undefined => {
      if (n === 'public.a') return bbox(0, 0);
      if (n === 'public.b') return bbox(400, 200);
      return undefined;
    };
    const layoutResolver = (_: string) => ({ dx: 50 });
    const r = routeRefs([mkRef()], bboxOf, undefined, layoutResolver)[0]!;
    // Ports at (200,50) and (400,250). midX = (200+400)/2 + 50 = 350.
    // Path: (200,50) → (350,50) → (350,250) → (400,250). Corners are rounded, so 350,50 and
    // 350,250 appear as the quadratic control points (Q350,50 / Q350,250), not as line endpoints.
    expect(r.d).toContain('M200,50');
    expect(r.d).toContain('350,50');
    expect(r.d).toContain('350,250');
    expect(r.d).toContain('L400,250');
  });

  it('waypoints override legacy dx (no double-shift)', () => {
    const bboxOf = (n: string): Bbox | undefined => {
      if (n === 'public.a') return bbox(0, 0);
      if (n === 'public.b') return bbox(400, 0);
      return undefined;
    };
    const layoutResolver = (_: string) => ({ waypoints: [{ x: 100, y: 200 }], dx: 999 });
    const r = routeRefs([mkRef()], bboxOf, undefined, layoutResolver)[0]!;
    // dx must be ignored — the route should pass through (100, 200) (a corner → Q control point).
    expect(r.d).toContain('100,200');
    expect(r.d).not.toContain('999');
  });

  it('omits refs with missing bboxes (no crash)', () => {
    const bboxOf = (n: string): Bbox | undefined => (n === 'public.a' ? bbox(0, 0) : undefined);
    const routes = routeRefs([mkRef()], bboxOf);
    expect(routes).toHaveLength(0);
  });
});
