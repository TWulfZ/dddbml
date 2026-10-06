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

const len = (s: EdgeRoute['segments'][number]) => Math.abs(s.x2 - s.x1) + Math.abs(s.y2 - s.y1);

/** Two consecutive segments on one axis pointing opposite ways (a spur doubling back). */
const hasBacktrack = (r: EdgeRoute): boolean =>
  r.segments.some((s, i) => {
    const prev = r.segments[i - 1];
    if (!prev || prev.axis !== s.axis) return false;
    return s.axis === 'h'
      ? Math.sign(s.x2 - s.x1) * Math.sign(prev.x2 - prev.x1) < 0
      : Math.sign(s.y2 - s.y1) * Math.sign(prev.y2 - prev.y1) < 0;
  });

const trunkOf = (r: EdgeRoute) => r.segments.find((s) => s.axis === 'v' && !s.rigid);

/** Both stubs leave towards +x / -x the same way: a C, not a Z. */
const isC = (r: EdgeRoute) => Math.sign(r.sourceStub.x - r.source.x) === Math.sign(r.targetStub.x - r.target.x);

const route = (pos: Record<string, { x: number; y: number }>, layout?: EdgeLayout) =>
  routeRefs([ref('a-b', 'a', 'b')], boxes(pos), rowY, layout ? () => layout : undefined)[0]!;

describe('routeRefs — side zones, right favoured (spec 05 §1)', () => {
  it('target entirely to the right ⇒ Z from the source right side, trunk at the gap midpoint', () => {
    const r = route({ a: { x: 0, y: 0 }, b: { x: W + 100, y: 300 } });
    expect(r.source).toEqual({ x: W, y: 40 });
    expect(r.target).toEqual({ x: W + 100, y: 340 });
    expect(trunkOf(r)!.x1).toBe(W + 50);
    expect(hasBacktrack(r)).toBe(false);
  });

  it('target entirely to the left ⇒ mirrored Z from the source left side', () => {
    const r = route({ a: { x: 0, y: 0 }, b: { x: -W - 100, y: 300 } });
    expect(r.source).toEqual({ x: 0, y: 40 });
    expect(r.target).toEqual({ x: -100, y: 340 });
    expect(trunkOf(r)!.x1).toBe(-50);
    expect(hasBacktrack(r)).toBe(false);
  });

  // Ports at rows 40 (a) and 40 + dy (b); a's right border at x = W.
  const narrow = (gap: number, dy: number, layout?: EdgeLayout) => route({ a: { x: 0, y: 0 }, b: { x: W + gap, y: dy } }, layout);

  for (const gap of [1, 2, 3, 10, 24, 32, 40, 47]) {
    it(`a ${gap}px gap is the S: full stubs, a ${48 - gap}px jog at the rows' midpoint`, () => {
      const r = narrow(gap, 300);
      expect(isC(r)).toBe(false);
      expect(r.sourceStub).toEqual({ x: W + 24, y: 40 });
      expect(r.targetStub).toEqual({ x: W + gap - 24, y: 340 });
      expect(r.segments.map((s) => [s.axis, s.rigid])).toEqual([['h', true], ['v', false], ['h', false], ['v', false], ['h', true]]);
      expect(r.segments.slice(1, 4).map((s) => [s.x1, s.y1, s.x2, s.y2])).toEqual([
        [W + 24, 40, W + 24, 190],
        [W + 24, 190, W + gap - 24, 190],
        [W + gap - 24, 190, W + gap - 24, 340],
      ]);
      expect(hasBacktrack(r)).toBe(false);
    });
  }

  it('the S mirrors for a narrow gap on the left, and rounds an odd midpoint', () => {
    const r = route({ a: { x: 0, y: 0 }, b: { x: -W - 10, y: -151 } });
    expect(r.sourceStub).toEqual({ x: -24, y: 40 });
    expect(r.targetStub).toEqual({ x: -10 + 24, y: -111 });
    expect(r.segments.slice(1, 4).map((s) => [s.x1, s.y1, s.x2, s.y2])).toEqual([
      [-24, 40, -24, -35],
      [-24, -35, 14, -35],
      [14, -35, 14, -111],
    ]);
  });

  it('the S needs a row distance of at least one stub; nearer rows keep the clamped midpoint trunk', () => {
    // Rows 24 apart need overlapping 100-high boxes; at gap 32 both verticals still clear them.
    expect(narrow(32, 24).sourceStub.x).toBe(W + 24);
    expect(narrow(47, 23).sourceStub.x).toBe(W + 11);
    for (const dy of [23, 10, 1, -23]) {
      const r = narrow(10, dy);
      expect(r.sourceStub.x).toBe(W + 2);
      expect(r.targetStub.x).toBe(W + 8);
      expect(trunkOf(r)!.x1).toBe(W + 5);
    }
  });

  it('at gap 48 both full stubs meet on the midpoint: one straight vertical, the Z from there on', () => {
    const r = narrow(48, 300);
    expect(r.sourceStub.x).toBe(W + 12);
    const verticals = r.segments.filter((s) => !s.rigid && s.axis === 'v');
    expect(verticals.map((s) => s.x1)).toEqual([W + 24]);
    expect(r.d).toBe(`M${W},40 L${W + 12},40 L${W + 16},40 Q${W + 24},40 ${W + 24},48 L${W + 24},332 Q${W + 24},340 ${W + 32},340 L${W + 36},340 L${W + 48},340`);
    for (const gap of [49, 60, 95]) {
      const z = narrow(gap, 300);
      expect(z.sourceStub.x).toBe(W + Math.floor(gap / 4));
      expect(Math.abs(trunkOf(z)!.x1 - (W + gap / 2))).toBeLessThanOrEqual(0.5);
      expect(z.segments.filter((s) => !s.rigid && s.axis === 'v')).toHaveLength(1);
    }
  });

  it('the shape is continuous across 47 → 48 → 49: fillet corners move by at most 1 px, same radius', () => {
    const qs = (r: EdgeRoute) => [...r.d.matchAll(/Q(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(qs(narrow(47, 300))).toEqual([[W + 24, 40], [W + 24, 190], [W + 23, 190], [W + 23, 340]]);
    expect(qs(narrow(48, 300))).toEqual([[W + 24, 40], [W + 24, 340]]);
    expect(qs(narrow(49, 300))).toEqual([[W + 25, 40], [W + 25, 340]]);
    // The trunk corner keeps the full 8 radius whether its run is one stub (S) or a clamped stub + arm (Z).
    expect(narrow(47, 300).d).toContain(`L${W + 16},40 Q${W + 24},40 ${W + 24},48`);
    expect(narrow(48, 300).d).toContain(`L${W + 16},40 Q${W + 24},40 ${W + 24},48`);
    expect(narrow(49, 300).d).toContain(`L${W + 17},40 Q${W + 25},40 ${W + 25},48`);
  });

  for (const gap of [41, 45, 46, 47]) {
    it(`a ${48 - gap}px jog (gap ${gap}) renders as a clean stair: clamped fillets, never doubling back`, () => {
      const r = narrow(gap, 300);
      expect(r.d).not.toMatch(/NaN/);
      // Every drawn point, fillet ends included, moves monotonically: down in y, never back in x
      // except the single jog leftwards.
      const pts = [...r.d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
      for (let i = 1; i < pts.length; i++) expect(pts[i]!.y).toBeGreaterThanOrEqual(pts[i - 1]!.y);
      const jog = pts.filter((p) => p.y === 190).map((p) => p.x);
      for (let i = 1; i < jog.length; i++) expect(jog[i]!).toBeLessThanOrEqual(jog[i - 1]!);
      expect(Math.max(...jog) - Math.min(...jog)).toBeLessThanOrEqual(48 - gap);
    });
  }

  // Packed layouts (BASE_MIN_GAP 16): the full stubs reach past the other table's border.
  const packedRoute = (sb: Bbox, tb: Bbox, sRow: number, tRow: number) =>
    routeRefs([ref('s-t', 's', 't')], (n) => (n === 's' ? sb : n === 't' ? tb : undefined), (t) => (t === 's' ? sRow : tRow))[0]!;

  for (const gap of [10, 16]) {
    it(`side by side with overlapping rows, gap ${gap}: no S through the tables, the clamped trunk stays in the gap`, () => {
      const sb = { x: 24, y: 495, w: 240, h: 120 };
      const tb = { x: 264 + gap, y: 576, w: 240, h: 240 };
      const r = packedRoute(sb, tb, 40, 90);
      expect(r.sourceStub.x).toBe(264 + Math.floor(gap / 4));
      expect(insideAny(r, sb, tb)).toBe(false);
      const trunk = trunkOf(r)!;
      expect(trunk.x1).toBeGreaterThan(264);
      expect(trunk.x1).toBeLessThan(264 + gap);
    });
  }

  it('one table above the other: the S jogs in the vertical gap when the rows\' midpoint falls inside a table', () => {
    // Shape of isga's evaluation_coordinator_assignments → indicator_evidences: rows midpoint 4521 is inside tb.
    const sb = { x: 416, y: 4624, w: 240, h: 120 };
    const tb = { x: 160, y: 4308, w: 240, h: 300 };
    const r = packedRoute(sb, tb, 50, 50);
    expect(r.sourceStub).toEqual({ x: 392, y: 4674 });
    expect(r.targetStub).toEqual({ x: 424, y: 4358 });
    expect(r.segments.slice(1, 4).map((s) => [s.x1, s.y1, s.x2, s.y2])).toEqual([
      [392, 4674, 392, 4616],
      [392, 4616, 424, 4616],
      [424, 4616, 424, 4358],
    ]);
    expect(insideAny(r, sb, tb)).toBe(false);
  });

  it('a vertical gap too thin to keep the jog off both outlines keeps the clamp', () => {
    const r = route({ a: { x: 0, y: 0 }, b: { x: -W - 10, y: -101 } });
    expect(r.sourceStub.x).toBe(-2);
    expect(trunkOf(r)!.x1).toBe(-5);
  });

  for (const gap of [1, 3, 47]) {
    it(`a ${gap}px gap with nearly aligned rows is still a Z, trunk at the exact midpoint, no spike`, () => {
      const r = narrow(gap, 10);
      const trunk = trunkOf(r)!;
      expect(trunk.x1).toBeGreaterThan(r.sourceStub.x);
      expect(trunk.x1).toBeLessThan(r.targetStub.x);
      expect(Math.abs(trunk.x1 - (W + gap / 2))).toBeLessThanOrEqual(0.5);
      expect(len(r.segments[0]!)).toBeGreaterThan(0);
      expect(hasBacktrack(r)).toBe(false);
    });
  }

  it('gap 1 with nearly aligned rows puts the trunk exactly half-way, off both stub ends', () => {
    expect(trunkOf(narrow(1, 10))!.x1).toBe(W + 0.5);
  });

  const overlaps: Array<[string, { x: number; y: number }]> = [
    ['leaning right', { x: 50, y: 300 }],
    ['leaning left', { x: -50, y: 300 }],
    ['exactly stacked', { x: 0, y: 300 }],
    ['touching (gap 0) on the right', { x: W, y: 300 }],
    ['touching (gap 0) on the left', { x: -W, y: 300 }],
    ['above, leaning left', { x: -120, y: -300 }],
  ];
  for (const [label, b] of overlaps) {
    it(`x-overlap ${label} ⇒ C round the right of both tables, never inside either`, () => {
      const pos = { a: { x: 0, y: 0 }, b };
      const bboxOf = boxes(pos);
      const r = route(pos);
      expect(r.source.x).toBe(W);
      expect(r.target.x).toBe(b.x + W);
      expect(isC(r)).toBe(true);
      expect(trunkOf(r)!.x1).toBeGreaterThan(Math.max(W, b.x + W));
      expect(r.segments[0]!.axis).toBe('h');
      expect(r.segments[r.segments.length - 1]!.axis).toBe('h');
      expect(insideAny(r, bboxOf('a')!, bboxOf('b')!)).toBe(false);
      expect(hasBacktrack(r)).toBe(false);
    });
  }

  it('never exits through top or bottom on its own', () => {
    for (const b of [{ x: 0, y: 300 }, { x: 0, y: -300 }, { x: 30, y: 60 }, { x: W + 5, y: 600 }, { x: -W - 5, y: -600 }]) {
      const r = route({ a: { x: 0, y: 0 }, b });
      expect(r.segments[0]!.axis).toBe('h');
      expect(r.segments[r.segments.length - 1]!.axis).toBe('h');
    }
  });

  it('leaves self-loops on their side', () => {
    const r = routeRefs([{ ...ref('a-a', 'a', 'a'), target: { table: 'a', columns: ['id'], relation: '1' } }], boxes({ a: { x: 0, y: 0 } }), rowY)[0]!;
    expect(r.loop).toBe(true);
    expect(r.source.x).toBe(W);
  });
});

describe('routeRefs — aligned tables get a midpoint division (spec 05 §2)', () => {
  for (const gap of [20, 40, 47, 48, 100, 400]) {
    it(`same row, gap ${gap}: the middle is split at its midpoint into two editable runs`, () => {
      const r = route({ a: { x: 0, y: 0 }, b: { x: W + gap, y: 0 } });
      expect(r.source.y).toBe(r.target.y);
      const editable = r.segments.filter((s) => !s.rigid);
      expect(editable).toHaveLength(2);
      for (const s of editable) {
        expect(s.axis).toBe('h');
        expect(len(s)).toBeGreaterThan(0);
      }
      expect(Math.abs(editable[0]!.x2 - (W + gap / 2))).toBeLessThanOrEqual(0.5);
      // The editable middle is at least the central half of the gap.
      expect(r.targetStub.x - r.sourceStub.x).toBeGreaterThanOrEqual(gap / 2);
    });
  }

  it('renders as one straight line (the division adds no visible bend)', () => {
    const r = route({ a: { x: 0, y: 0 }, b: { x: W + 100, y: 0 } });
    expect(r.d).toBe(`M${W},40 L${W + 24},40 L${W + 50},40 L${W + 76},40 L${W + 100},40`);
  });
});

/** The route minus its `shapeIgnored` flag: what is actually drawn. */
const drawn = (r: EdgeRoute) => {
  const { shapeIgnored: _ignored, ...rest } = r;
  return rest;
};

describe('routeRefs — persisted sides', () => {
  const stacked = { a: { x: 0, y: 0 }, b: { x: 50, y: 300 } };

  it('ignores a legacy auto top/bottom shape whole (sides and waypoints)', () => {
    const legacy: EdgeLayout = {
      auto: true,
      sourceSide: 'bottom',
      targetSide: 'top',
      waypoints: [{ x: 100, y: 200 }, { x: 150, y: 200 }],
      color: '#ff0000',
    };
    const r = route(stacked, legacy);
    expect(r.shapeIgnored).toBe(true);
    expect(drawn(r)).toEqual(route(stacked));
    expect(drawn(route(stacked, { auto: true, targetSide: 'top' }))).toEqual(route(stacked));
  });

  it('ignores v0.3.0 side-less auto waypoints between stacked tables (routed for its bottom/top default)', () => {
    // Exact computeEdgeOrdering output at v0.3.0 for a(0,0) → b(0,600) round m(0,300), 240×100 tables.
    const v030: EdgeLayout = {
      auto: true,
      waypoints: [{ x: 120, y: 132 }, { x: 120, y: 276 }, { x: 276, y: 276 }, { x: 276, y: 564 }, { x: 120, y: 564 }],
    };
    const pos: Record<string, Bbox> = {
      a: { x: 0, y: 0, w: 240, h: 100 },
      m: { x: 0, y: 300, w: 240, h: 100 },
      b: { x: 0, y: 600, w: 240, h: 100 },
    };
    const rowAt = () => 45;
    const routeWith = (layout?: EdgeLayout) =>
      routeRefs([ref('a-b', 'a', 'b')], (n) => pos[n], rowAt, layout ? () => layout : undefined)[0]!;
    const r = routeWith(v030);
    expect(r.shapeIgnored).toBe(true);
    expect(drawn(r)).toEqual(routeWith());
    expect(hasBacktrack(r)).toBe(false);
    expect(insideAny(r, pos.a!, pos.b!)).toBe(false);
  });

  it('keeps side-less auto waypoints between tables that do not x-overlap (their zone never changed)', () => {
    const layout: EdgeLayout = { auto: true, waypoints: [{ x: W + 50, y: 40 }, { x: W + 50, y: 340 }] };
    const r = route({ a: { x: 0, y: 0 }, b: { x: W + 100, y: 300 } }, layout);
    expect(r.shapeIgnored).toBeUndefined();
    expect(r.waypoints).toEqual(layout.waypoints);
  });

  it('keeps auto waypoints that carry their right/right sides (what the A* pass writes now)', () => {
    const layout: EdgeLayout = { auto: true, sourceSide: 'right', targetSide: 'right', waypoints: [{ x: W + 60, y: 40 }, { x: W + 60, y: 340 }] };
    const r = route(stacked, layout);
    expect(r.shapeIgnored).toBeUndefined();
    expect(r.waypoints).toEqual(layout.waypoints);
  });

  it('keeps an auto left/right shape (only vertical auto shapes are legacy)', () => {
    const r = route(stacked, { auto: true, sourceSide: 'left', targetSide: 'left' });
    expect(r.source.x).toBe(0);
    expect(r.target.x).toBe(50);
  });

  it('ignores a manual top/bottom override whole too: no UI writes one, only pre-0.4 routers did', () => {
    const r = route({ a: { x: 0, y: 0 }, b: { x: 600, y: 300 } }, { sourceSide: 'bottom', targetSide: 'top', waypoints: [{ x: 100, y: 200 }] });
    expect(r.shapeIgnored).toBe(true);
    expect(r.source).toEqual({ x: W, y: 40 });
    expect(r.target.x).toBe(600);
    expect(r.waypoints).toEqual([]);
  });

  it('respects a manual left/right override on both ends', () => {
    const r = route(stacked, { sourceSide: 'right', targetSide: 'left' });
    expect(r.source).toEqual({ x: W, y: 40 });
    expect(r.target).toEqual({ x: 50, y: 340 });
  });
});

describe('EdgeRouteCache — drags across gap = 0 (Z ↔ C)', () => {
  it('routeMoved matches a full rebuild while a table crosses every zone boundary', () => {
    const refs = [ref('a-b', 'a', 'b'), ref('c-b', 'c', 'b')];
    const pos = { a: { x: 0, y: 0 }, b: { x: 600, y: 300 }, c: { x: 650, y: 700 } };
    const cache = new EdgeRouteCache();
    cache.routeAll(refs, boxes(pos), rowY);
    // b spans [600, 800]: a's right edge at 399/400/401 straddles gap 0 on the left of b, a's left
    // edge at 799/800/801 on its right.
    for (const x of [100, 399, 400, 401, 500, 599, 600, 601, 800, 801, 799, 0, -300]) {
      pos.a = { x, y: 0 };
      expect(cache.routeMoved(['a'], boxes(pos), rowY)).toEqual(routeRefs(refs, boxes(pos), rowY));
    }
  });

  it('matches a full re-route over random drags that keep crossing the Z/C boundary', () => {
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
      ['r5', { auto: true, sourceSide: 'bottom', targetSide: 'top', waypoints: [{ x: 100, y: 100 }, { x: 400, y: 100 }] }],
    ]);
    const layoutOf = (id: string) => layouts.get(id);
    const cShaped = (routes: EdgeRoute[]) => new Set(routes.filter((r) => !r.loop && isC(r)).map((r) => r.id));

    const cache = new EdgeRouteCache();
    let prev = cShaped(cache.routeAll(many, boxes(pos), rowY, layoutOf));
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
      const now = cShaped(inc);
      for (const id of now) if (!prev.has(id)) crossings++;
      for (const id of prev) if (!now.has(id)) crossings++;
      prev = now;
    }
    expect(crossings).toBeGreaterThan(20);
  });
});
