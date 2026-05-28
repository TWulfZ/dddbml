import { describe, expect, it } from 'vitest';
import { routeRefs, computeSegmentDrag, simplifyWaypoints, type EdgeRoute } from './edgeRouter';
import type { EdgeLayout, Ref } from '../../shared/types';
import type { Bbox } from './spatialIndex';

const mkRef = (overrides?: Partial<Ref>): Ref => ({
  id: 'a::col|b::col',
  source: { table: 'public.a', columns: ['col'], relation: '*' },
  target: { table: 'public.b', columns: ['col'], relation: '1' },
  ...overrides,
});

const bbox = (x: number, y: number, w = 200, h = 100): Bbox => ({ x, y, w, h });

// Two tables offset horizontally + vertically → default route is H-V-H (seg1 is the vertical trunk).
const offsetBboxOf = (n: string): Bbox | undefined => {
  if (n === 'public.a') return bbox(0, 0); // source port right = (200, 50)
  if (n === 'public.b') return bbox(400, 200); // target port left = (400, 250)
  return undefined;
};

const routeWith = (layout?: EdgeLayout): EdgeRoute =>
  routeRefs([mkRef()], offsetBboxOf, undefined, layout ? () => layout : undefined)[0]!;

const allOrthogonal = (r: EdgeRoute): boolean =>
  r.segments.every((s) => s.x1 === s.x2 || s.y1 === s.y2);

describe('computeSegmentDrag — segment dragging (no spikes)', () => {
  it('dragging the vertical trunk inserts one waypoint at the new x (clean trunk)', () => {
    const r = routeWith();
    const trunk = r.segments.findIndex((s) => s.axis === 'v');
    expect(trunk).toBeGreaterThanOrEqual(0);
    const wps = computeSegmentDrag(r, trunk, 40, 0);
    expect(wps).toHaveLength(1);
    expect(wps[0]!.x).toBe(340); // 300 (midX) + 40

    // Re-route through the new waypoints: still strictly orthogonal, trunk moved to x=340.
    const r2 = routeWith({ waypoints: wps });
    expect(allOrthogonal(r2)).toBe(true);
    expect(r2.d).toContain('340');
  });

  it('horizontal drag of the trunk leaves x untouched (1-DOF: only the normal axis moves)', () => {
    const r = routeWith();
    const trunk = r.segments.findIndex((s) => s.axis === 'v');
    const wps = computeSegmentDrag(r, trunk, 0, 80); // dy ignored for a vertical segment
    // Vertical segment only responds to dx; dy=... still inserts at midX (no vertical displacement).
    expect(wps[0]!.x).toBe(300);
  });

  it('snaps the dragged coordinate to the grid when a snapper is supplied', () => {
    const r = routeWith();
    const trunk = r.segments.findIndex((s) => s.axis === 'v');
    const snap = (n: number) => Math.round(n / 16) * 16;
    const wps = computeSegmentDrag(r, trunk, 40, 0, snap);
    expect(wps[0]!.x).toBe(336); // round(340/16)*16
    expect(wps[0]!.x % 16).toBe(0);
  });

  it('is idempotent from the original route + cumulative delta (no index drift)', () => {
    const r = routeWith();
    const trunk = r.segments.findIndex((s) => s.axis === 'v');
    const a = computeSegmentDrag(r, trunk, 25, 0);
    const b = computeSegmentDrag(r, trunk, 25, 0);
    expect(a).toEqual(b);
  });

  it('routes the last vertex straight into the port — no midX backtrack/spike', () => {
    // Waypoint sits to the RIGHT of the target port (400). v1 inserted a backward midX (500)
    // bridge here, producing the cross/spike. Now it drops at the vertex x and goes straight in.
    const r = routeWith({ waypoints: [{ x: 600, y: 150 }] });
    expect(allOrthogonal(r)).toBe(true);
    expect(r.d).toContain('600,250'); // vertical drop happens at the vertex x
    expect(r.d).not.toContain('500,'); // no centered midX bridge
  });

  it('moving an existing waypoint-bounded trunk shifts that waypoint (no new vertex)', () => {
    const r = routeWith({ waypoints: [{ x: 340, y: 150 }] });
    const trunk = r.segments.findIndex((s) => s.axis === 'v');
    const wps = computeSegmentDrag(r, trunk, 20, 0);
    expect(wps).toHaveLength(1); // still one vertex, just moved
    expect(wps[0]!.x).toBe(360);
  });
});

describe('simplifyWaypoints', () => {
  it('drops a waypoint that is colinear with its neighbors', () => {
    const out = simplifyWaypoints(
      [{ x: 100, y: 50 }, { x: 200, y: 50 }],
      { x: 0, y: 50 },
      { x: 300, y: 50 },
    );
    expect(out).toEqual([]);
  });

  it('keeps a waypoint that actually bends the path', () => {
    const out = simplifyWaypoints([{ x: 100, y: 200 }], { x: 0, y: 50 }, { x: 300, y: 50 });
    expect(out).toEqual([{ x: 100, y: 200 }]);
  });
});

describe('routeRefs — port side overrides', () => {
  it('honors sourceSide/targetSide over chooseSides', () => {
    const r = routeWith({ sourceSide: 'left', targetSide: 'right' });
    // source forced to left edge of bbox a (x=0); target forced to right edge of bbox b (x=600).
    expect(r.source.x).toBe(0);
    expect(r.target.x).toBe(600);
  });

  it('falls back to chooseSides when no override is set', () => {
    const r = routeWith();
    expect(r.source.x).toBe(200); // right edge of a
    expect(r.target.x).toBe(400); // left edge of b
  });
});
