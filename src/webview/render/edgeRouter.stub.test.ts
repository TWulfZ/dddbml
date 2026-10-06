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
    // Opposed stubs take at most a quarter of the port distance each, so they never cross.
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

  it('clamps opposed stubs to a quarter of the gap, except the full-stub S of a gap under 48', () => {
    const at = (bx: number) => (n: string): Bbox | undefined =>
      n === 'public.a' ? bbox(0, 0) : n === 'public.b' ? bbox(bx, 200) : undefined;
    // Rows 200 apart: under 48 the full stubs cross (the S); from 48 the quarter clamp rules.
    for (const [gap, stub] of [[10, 24], [32, 24], [33, 24], [47, 24], [48, 12], [95, 23], [96, 24], [300, 24]] as Array<[number, number]>) {
      const r = routeRefs([mkRef()], at(200 + gap), undefined, undefined)[0]!;
      expect(len(firstSeg(r))).toBe(stub);
      expect(len(lastSeg(r))).toBe(stub);
      expect(firstSeg(r).rigid && lastSeg(r).rigid).toBe(true);
      expect(r.targetStub.x - r.sourceStub.x).toBe(gap - 2 * stub);
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

describe('routeRefs — persisted top/bottom sides are ignored whole (spec 05 §11)', () => {
  const A = bbox(0, 0);
  const stacked = (n: string): Bbox | undefined => (n === 'public.a' ? A : n === 'public.b' ? bbox(60, 400) : undefined);
  const mixed = (n: string): Bbox | undefined => (n === 'public.a' ? A : n === 'public.b' ? bbox(400, 300) : undefined);
  const cases: Array<[EdgeLayout, (n: string) => Bbox | undefined]> = [
    [{ sourceSide: 'bottom', targetSide: 'top' }, stacked],
    [{ sourceSide: 'bottom', targetSide: 'top', waypoints: [{ x: 100, y: 250 }, { x: 160, y: 250 }] }, stacked],
    [{ sourceSide: 'right', targetSide: 'top', waypoints: [{ x: 300, y: 50 }] }, mixed],
  ];

  it('manual or not, the edge is drawn as if it had no shape: horizontal stubs, no saved waypoints', () => {
    for (const [layout, bboxOf] of cases) {
      const r = routeWith(layout, bboxOf);
      const plain = routeWith(undefined, bboxOf);
      expect(r.shapeIgnored).toBe(true);
      expect(r.segments[0]!.axis).toBe('h');
      expect(r.segments[r.segments.length - 1]!.axis).toBe('h');
      expect(r.waypoints).toEqual(plain.waypoints);
      expect(r.segments).toEqual(plain.segments);
    }
  });
});
