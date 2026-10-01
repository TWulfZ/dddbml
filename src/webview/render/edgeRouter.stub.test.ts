import { describe, expect, it } from 'vitest';
import { routeRefs, type EdgeRoute } from './edgeRouter';
import type { EdgeLayout, Ref } from '../../shared/types';
import type { Bbox } from './spatialIndex';

const mkRef = (overrides?: Partial<Ref>): Ref => ({
  id: 'a::col|b::col',
  source: { table: 'public.a', columns: ['col'], relation: '*' },
  target: { table: 'public.b', columns: ['col'], relation: '1' },
  ...overrides,
});

const bbox = (x: number, y: number, w = 200, h = 100): Bbox => ({ x, y, w, h });

// a port right = (200, 50); b port left = (400, 250) — offset row, so the path must bend.
const offsetBboxOf = (n: string): Bbox | undefined => {
  if (n === 'public.a') return bbox(0, 0);
  if (n === 'public.b') return bbox(400, 200);
  return undefined;
};

const routeWith = (layout?: EdgeLayout, bboxOf = offsetBboxOf): EdgeRoute =>
  routeRefs([mkRef()], bboxOf, undefined, layout ? () => layout : undefined)[0]!;

describe('routeRefs — minimum end stub (MIN_STUB = 24)', () => {
  const firstSeg = (r: EdgeRoute) => r.segments[0]!;
  const lastSeg = (r: EdgeRoute) => r.segments[r.segments.length - 1]!;
  const len = (s: { x1: number; y1: number; x2: number; y2: number }) =>
    Math.abs(s.x2 - s.x1) + Math.abs(s.y2 - s.y1);

  it('first and last segments are horizontal (marker never flush-vertical to the table)', () => {
    const layouts: Array<EdgeLayout | undefined> = [undefined, { waypoints: [{ x: 300, y: 150 }] }];
    for (const layout of layouts) {
      const r = routeWith(layout);
      expect(firstSeg(r).axis).toBe('h');
      expect(lastSeg(r).axis).toBe('h');
    }
  });

  it('keeps a >= MIN_STUB horizontal gap at both ports when the gap allows it (right->left)', () => {
    const r = routeWith(); // gap = 200 >> 2*24
    expect(firstSeg(r).axis).toBe('h');
    expect(len(firstSeg(r))).toBeGreaterThanOrEqual(24);
    expect(lastSeg(r).axis).toBe('h');
    expect(len(lastSeg(r))).toBeGreaterThanOrEqual(24);
  });

  it('first and last segments are RIGID stubs of fixed length; interior is editable', () => {
    for (const layout of [undefined, { waypoints: [{ x: 300, y: 150 }] }] as Array<EdgeLayout | undefined>) {
      const r = routeWith(layout);
      expect(r.segments.length).toBeGreaterThanOrEqual(3);
      expect(firstSeg(r).rigid).toBe(true);
      expect(lastSeg(r).rigid).toBe(true);
      expect(len(firstSeg(r))).toBe(24); // exactly MIN_STUB
      expect(len(lastSeg(r))).toBe(24);
      // At least one interior, non-rigid (subdividable) section exists.
      expect(r.segments.some((s) => !s.rigid)).toBe(true);
      // Interior segments are never marked rigid.
      for (let i = 1; i < r.segments.length - 1; i++) expect(r.segments[i]!.rigid).toBe(false);
    }
  });

  it('never backtracks (no spike) when tables are closer than 2*MIN_STUB', () => {
    // Stub length is clamped to half the port distance so the two stubs meet instead of crossing.
    const hasBacktrack = (r: EdgeRoute): boolean =>
      r.segments.some((s, i) => {
        const prev = r.segments[i - 1];
        if (!prev) return false;
        if (s.axis === 'h' && prev.axis === 'h') return Math.sign(s.x2 - s.x1) * Math.sign(prev.x2 - prev.x1) < 0;
        if (s.axis === 'v' && prev.axis === 'v') return Math.sign(s.y2 - s.y1) * Math.sign(prev.y2 - prev.y1) < 0;
        return false;
      });
    const at = (bx: number, by: number) => (n: string): Bbox | undefined =>
      n === 'public.a' ? bbox(0, 0) : n === 'public.b' ? bbox(bx, by) : undefined;
    for (const [bx, by] of [[247, 0], [248, 0], [220, 0], [210, 200], [205, 200]] as Array<[number, number]>) {
      const r = routeRefs([mkRef()], at(bx, by), undefined, undefined)[0]!;
      expect(hasBacktrack(r)).toBe(false);
      expect(firstSeg(r).axis).toBe('h');
      expect(lastSeg(r).axis).toBe('h');
    }
  });

  it('offset tables close in x still expose an editable (vertical) middle', () => {
    const closeOffset = (n: string): Bbox | undefined =>
      n === 'public.a' ? bbox(0, 0) : n === 'public.b' ? bbox(210, 200) : undefined;
    const r = routeRefs([mkRef()], closeOffset, undefined, undefined)[0]!;
    expect(r.segments.some((s) => !s.rigid)).toBe(true); // a vertical trunk remains subdividable
  });

  it('keeps the stub on a flipped left->right routing', () => {
    // Force source=left (exits -x) and target=right (enters +x). Tables far apart so both fit.
    const farBboxOf = (n: string): Bbox | undefined => {
      if (n === 'public.a') return bbox(400, 0);
      if (n === 'public.b') return bbox(0, 200);
      return undefined;
    };
    const r = routeWith({ sourceSide: 'left', targetSide: 'right' }, farBboxOf);
    expect(firstSeg(r).axis).toBe('h');
    expect(len(firstSeg(r))).toBeGreaterThanOrEqual(24);
    expect(lastSeg(r).axis).toBe('h');
    expect(len(lastSeg(r))).toBeGreaterThanOrEqual(24);
  });
});

const segLen = (s: { x1: number; y1: number; x2: number; y2: number }) => Math.abs(s.x2 - s.x1) + Math.abs(s.y2 - s.y1);

/** Two consecutive segments on the same axis pointing in opposite directions (a spur/backtrack). */
const hasBacktrack = (r: EdgeRoute): boolean =>
  r.segments.some((s, i) => {
    const prev = r.segments[i - 1];
    if (!prev || prev.axis !== s.axis) return false;
    return s.axis === 'h'
      ? Math.sign(s.x2 - s.x1) * Math.sign(prev.x2 - prev.x1) < 0
      : Math.sign(s.y2 - s.y1) * Math.sign(prev.y2 - prev.y1) < 0;
  });

/** Any segment running inside `b` or along one of its horizontal borders (not just touching a port). */
const runsAlongOrInside = (r: EdgeRoute, b: Bbox): boolean =>
  r.segments.some((s) => {
    if (s.axis === 'h') {
      const lo = Math.min(s.x1, s.x2);
      const hi = Math.max(s.x1, s.x2);
      return s.y1 >= b.y && s.y1 <= b.y + b.h && hi > b.x && lo < b.x + b.w;
    }
    const lo = Math.min(s.y1, s.y2);
    const hi = Math.max(s.y1, s.y2);
    return s.x1 > b.x && s.x1 < b.x + b.w && hi > b.y && lo < b.y + b.h;
  });

describe('routeRefs — same-direction ports (F52)', () => {
  const A = bbox(0, 0);
  const C = bbox(0, 300);
  const stacked = (n: string): Bbox | undefined => (n === 'public.a' ? A : n === 'public.b' ? C : undefined);

  for (const side of ['left', 'right'] as const) {
    it(`both ends on '${side}' keep full rigid stubs and an editable C-route`, () => {
      const r = routeWith({ sourceSide: side, targetSide: side }, stacked);
      const first = r.segments[0]!;
      const last = r.segments[r.segments.length - 1]!;
      expect(first.axis).toBe('h');
      expect(last.axis).toBe('h');
      expect(first.rigid && last.rigid).toBe(true);
      expect(segLen(first)).toBe(24);
      expect(segLen(last)).toBe(24);
      expect(r.segments.some((s) => !s.rigid)).toBe(true);
      expect(hasBacktrack(r)).toBe(false);
      expect(runsAlongOrInside(r, A)).toBe(false);
      expect(runsAlongOrInside(r, C)).toBe(false);
    });
  }

  it('C-route trunk clears the wider-reaching stub when the tables are x-offset', () => {
    const offset = (n: string): Bbox | undefined => (n === 'public.a' ? bbox(0, 0) : n === 'public.b' ? bbox(80, 300) : undefined);
    const r = routeWith({ sourceSide: 'left', targetSide: 'left' }, offset);
    expect(hasBacktrack(r)).toBe(false);
    expect(runsAlongOrInside(r, bbox(0, 0))).toBe(false);
    expect(runsAlongOrInside(r, bbox(80, 300))).toBe(false);
  });
});

describe('routeRefs — persisted top/bottom sides (F51)', () => {
  const A = bbox(0, 0);
  const B = bbox(60, 400);
  const stacked = (n: string): Bbox | undefined => (n === 'public.a' ? A : n === 'public.b' ? B : undefined);
  const layouts: EdgeLayout[] = [
    { sourceSide: 'bottom', targetSide: 'top' },
    { sourceSide: 'bottom', targetSide: 'top', waypoints: [{ x: 100, y: 250 }, { x: 160, y: 250 }] },
  ];

  it('stubs leave the border vertically and the path never runs along a table border', () => {
    for (const layout of layouts) {
      const r = routeWith(layout, stacked);
      const first = r.segments[0]!;
      const last = r.segments[r.segments.length - 1]!;
      expect(first.axis).toBe('v');
      expect(last.axis).toBe('v');
      expect(segLen(first)).toBe(24);
      expect(segLen(last)).toBe(24);
      expect(first.y2).toBeGreaterThan(A.y + A.h);
      expect(last.y1).toBeLessThan(B.y);
      expect(hasBacktrack(r)).toBe(false);
      expect(runsAlongOrInside(r, A)).toBe(false);
      expect(runsAlongOrInside(r, B)).toBe(false);
    }
  });

  it('aligned ports still leave an editable middle segment', () => {
    const aligned = (n: string): Bbox | undefined => (n === 'public.a' ? A : n === 'public.b' ? bbox(0, 400) : undefined);
    const r = routeWith({ sourceSide: 'bottom', targetSide: 'top' }, aligned);
    expect(r.segments.some((s) => !s.rigid)).toBe(true);
    expect(r.segments.every((s) => s.axis === 'v')).toBe(true);
  });

  it('a mixed side pair (right -> top) renders an L without backtracking', () => {
    const mixed = (n: string): Bbox | undefined => (n === 'public.a' ? A : n === 'public.b' ? bbox(400, 300) : undefined);
    const r = routeWith({ sourceSide: 'right', targetSide: 'top' }, mixed);
    expect(r.segments[0]!.axis).toBe('h');
    expect(r.segments[r.segments.length - 1]!.axis).toBe('v');
    expect(hasBacktrack(r)).toBe(false);
  });
});
