import { describe, expect, it } from 'vitest';
import type { EdgeLayout, Ref } from '../../shared/types';
import { chooseSides, EdgeRouteCache, LOOP_OFFSET, LOOP_STEP, loopReach, routeRefs, type EdgeRoute } from './edgeRouter';
import type { Bbox } from './spatialIndex';
import { boxesIntersect, narrowGapSJog } from '../layout/edgeSides';

const W = 200;
const H = 160;

const ref = (id: string, source: string, sCol: string, target: string, tCol = 'id'): Ref => ({
  id,
  source: { table: source, columns: [sCol], relation: '*' },
  target: { table: target, columns: [tCol], relation: '1' },
});

const boxes = (pos: Record<string, { x: number; y: number }>) => (name: string): Bbox | undefined => {
  const p = pos[name];
  return p ? { x: p.x, y: p.y, w: W, h: H } : undefined;
};

/** Column rows 20 px apart from the header down: `id`, then `c1`… `c6`. */
const ROW: Record<string, number> = { id: 40, c1: 60, c2: 80, c3: 100, c4: 120, c5: 140 };
const colY = (_t: string, c: string) => ROW[c];
const MIN_STUB_T = 24;

const byId = (routes: EdgeRoute[], id: string): EdgeRoute => {
  const r = routes.find((x) => x.id === id);
  if (!r) throw new Error(`route ${id} missing`);
  return r;
};

/** The editable vertical run of a C or a loop: its trunk. */
const trunk = (r: EdgeRoute) => {
  const v = r.segments.filter((s) => s.axis === 'v' && !s.rigid);
  expect(v).toHaveLength(1);
  const s = v[0]!;
  return { x: s.x1, lo: Math.min(s.y1, s.y2), hi: Math.max(s.y1, s.y2) };
};

const isC = (r: EdgeRoute) => {
  const out = Math.sign(r.sourceStub.x - r.source.x);
  return !r.loop && r.waypoints.length === 0 && out !== 0 && out === Math.sign(r.targetStub.x - r.target.x);
};

/** Every pair of loop/C trunks whose vertical extents overlap sits at least LOOP_STEP apart. */
function expectNoSharedTrunk(routes: EdgeRoute[]): void {
  const trunks = routes.filter((r) => r.loop || isC(r)).map((r) => ({ id: r.id, ...trunk(r) }));
  for (let i = 0; i < trunks.length; i++) {
    for (let j = i + 1; j < trunks.length; j++) {
      const p = trunks[i]!;
      const q = trunks[j]!;
      if (p.lo > q.hi || q.lo > p.hi) continue;
      expect(Math.abs(p.x - q.x), `${p.id} vs ${q.id}`).toBeGreaterThanOrEqual(LOOP_STEP);
    }
  }
}

describe('C trunks nest outside loops (spec 05 §1 "Anidado de C")', () => {
  // emp has two loops on its right; proj sits below it in the same column.
  const pos = { emp: { x: 0, y: 0 }, proj: { x: 0, y: 400 } };
  const loops = [ref('emp-manager', 'emp', 'c1', 'emp'), ref('emp-mentor', 'emp', 'c2', 'emp')];

  it('sits LOOP_STEP outside the farthest loop of its source table', () => {
    const routes = routeRefs([...loops, ref('proj-owner', 'proj', 'c1', 'emp')], boxes(pos), colY);
    const farthestLoop = Math.max(...loops.map((l) => trunk(byId(routes, l.id)).x));
    expect(farthestLoop).toBe(W + LOOP_OFFSET + LOOP_STEP);
    const c = trunk(byId(routes, 'proj-owner'));
    expect(c.x).toBe(farthestLoop + LOOP_STEP);
    expect(c.x).toBe(W + loopReach(loops.length + 1));
  });

  it('clears loops of either end, even when its ports run outside their rows', () => {
    // The C leaves emp at its id row, below neither loop's span: still outside both.
    const routes = routeRefs([...loops, ref('emp-proj', 'emp', 'c5', 'proj', 'c3')], boxes(pos), colY);
    expect(trunk(byId(routes, 'emp-proj')).x).toBe(W + loopReach(3));
  });

  it('a loop on the other side leaves the C at its plain stub reach', () => {
    const left = new Map<string, EdgeLayout>(loops.map((l) => [l.id, { sourceSide: 'left', targetSide: 'left' }]));
    const routes = routeRefs([...loops, ref('proj-owner', 'proj', 'c1', 'emp')], boxes(pos), colY, (id) => left.get(id));
    expect(trunk(byId(routes, 'proj-owner')).x).toBe(W + 24);
  });

  it('a manual left/left C nests mirrored outside left-side loops', () => {
    const layouts = new Map<string, EdgeLayout>([
      ...loops.map((l): [string, EdgeLayout] => [l.id, { sourceSide: 'left', targetSide: 'left' }]),
      ['proj-owner', { sourceSide: 'left', targetSide: 'left' }],
    ]);
    const routes = routeRefs([...loops, ref('proj-owner', 'proj', 'c1', 'emp')], boxes(pos), colY, (id) => layouts.get(id));
    expect(trunk(byId(routes, 'proj-owner')).x).toBe(-loopReach(3));
    expectNoSharedTrunk(routes);
  });

  it('a C with waypoints keeps them (manual shapes are never nested)', () => {
    const wp = [{ x: 260, y: 60 }, { x: 260, y: 460 }];
    const layouts = new Map<string, EdgeLayout>([['proj-owner', { waypoints: wp }]]);
    const r = byId(routeRefs([...loops, ref('proj-owner', 'emp', 'c1', 'proj', 'c1')], boxes(pos), colY, (id) => layouts.get(id)), 'proj-owner');
    expect(r.waypoints).toEqual(wp);
  });
});

describe('C trunks nest among themselves', () => {
  // One column a / b / c: a→b spans one gap, a→c two.
  const pos = { a: { x: 0, y: 0 }, b: { x: 0, y: 300 }, c: { x: 0, y: 600 } };
  const short = ref('z-short', 'a', 'c1', 'b');
  const long = ref('a-long', 'a', 'c2', 'c');

  it('puts the shorter span inside, LOOP_STEP apart, whatever the ids or refs[] order', () => {
    for (const refs of [[short, long], [long, short]]) {
      const routes = routeRefs(refs, boxes(pos), colY);
      expect(trunk(byId(routes, 'z-short')).x).toBe(W + 24);
      expect(trunk(byId(routes, 'a-long')).x).toBe(W + 24 + LOOP_STEP);
    }
  });

  it('breaks a span tie by ref id', () => {
    // a→b and c→d: same span, overlapping extents (c sits between a and b).
    const p = { a: { x: 0, y: 0 }, c: { x: 0, y: 200 }, b: { x: 0, y: 400 }, d: { x: 0, y: 600 } };
    const ab = ref('m-ab', 'a', 'c1', 'b', 'c1');
    const cd = ref('n-cd', 'c', 'c1', 'd', 'c1');
    for (const refs of [[ab, cd], [cd, ab]]) {
      const routes = routeRefs(refs, boxes(p), colY);
      expect(trunk(byId(routes, 'm-ab')).x).toBe(W + 24);
      expect(trunk(byId(routes, 'n-cd')).x).toBe(W + 24 + LOOP_STEP);
    }
  });

  it('Cs whose vertical extents do not overlap share the plain reach', () => {
    const p = { a: { x: 0, y: 0 }, b: { x: 0, y: 300 }, c: { x: 0, y: 1000 }, d: { x: 0, y: 1300 } };
    const routes = routeRefs([ref('ab', 'a', 'c1', 'b'), ref('cd', 'c', 'c1', 'd')], boxes(p), colY);
    expect(trunk(byId(routes, 'ab')).x).toBe(W + 24);
    expect(trunk(byId(routes, 'cd')).x).toBe(W + 24);
  });

  it('a C beside another column is not pushed by it', () => {
    const p = { a: { x: 0, y: 0 }, b: { x: 0, y: 300 }, c: { x: 800, y: 0 }, d: { x: 800, y: 300 } };
    const routes = routeRefs([ref('ab', 'a', 'c1', 'b'), ref('cd', 'c', 'c1', 'd')], boxes(p), colY);
    expect(trunk(byId(routes, 'ab')).x).toBe(W + 24);
    expect(trunk(byId(routes, 'cd')).x).toBe(800 + W + 24);
  });

  it('the selfloop.dbml column: no two trunks share a vertical line', () => {
    // employees (2 loops) / projects / departments (1 loop), stacked 16 apart as the first layout does.
    const p = { emp: { x: 0, y: 0 }, proj: { x: 0, y: H + 16 }, dept: { x: 0, y: 2 * (H + 16) } };
    const refs = [
      ref('emp.manager', 'emp', 'c1', 'emp'),
      ref('emp.mentor', 'emp', 'c2', 'emp'),
      ref('emp.dept', 'emp', 'c3', 'dept'),
      ref('dept.parent', 'dept', 'c1', 'dept'),
      ref('proj.owner', 'proj', 'c1', 'emp'),
    ];
    const routes = routeRefs(refs, boxes(p), colY);
    expectNoSharedTrunk(routes);
    for (const id of ['emp.dept', 'proj.owner']) expect(trunk(byId(routes, id)).x).toBeGreaterThanOrEqual(W + loopReach(3));
  });

  it('random single-column stacks never put two overlapping trunks on one line', () => {
    let seed = 5;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const cols = Object.keys(ROW);
    for (let round = 0; round < 30; round++) {
      const names = Array.from({ length: 6 }, (_, i) => `t${i}`);
      const p: Record<string, { x: number; y: number }> = {};
      let y = 0;
      for (const n of names) {
        p[n] = { x: 0, y };
        y += H + 16 + Math.round(rand() * 60);
      }
      const refs: Ref[] = [];
      const layouts = new Map<string, EdgeLayout>();
      for (let i = 0; i < 12; i++) {
        const s = names[Math.floor(rand() * names.length)]!;
        const t = rand() < 0.3 ? s : names[Math.floor(rand() * names.length)]!;
        const r = ref(`r${i}`, s, cols[1 + Math.floor(rand() * 5)]!, t, cols[Math.floor(rand() * 6)]!);
        refs.push(r);
        if (rand() < 0.25) layouts.set(r.id, { sourceSide: 'left', targetSide: 'left' });
      }
      expectNoSharedTrunk(routeRefs(refs, boxes(p), colY, (id) => layouts.get(id)));
    }
  });
});

describe('intersecting tables: right C, else left C, else the facing connector (spec 05 §1)', () => {
  const a: Bbox = { x: 0, y: 0, w: W, h: H };
  const pair = (b: Bbox) => (n: string): Bbox | undefined => (n === 'a' ? a : n === 'b' ? b : undefined);
  /** The segment runs through the bbox interior (on its border is fine). */
  const crosses = (s: EdgeRoute['segments'][number], bb: Bbox) =>
    Math.min(s.x1, s.x2) < bb.x + bb.w && Math.max(s.x1, s.x2) > bb.x && Math.min(s.y1, s.y2) < bb.y + bb.h && Math.max(s.y1, s.y2) > bb.y;
  /** A port is visible when it does not sit inside the other table's interior. */
  const hidden = (p: { x: number; y: number }, bb: Bbox) => p.x > bb.x && p.x < bb.x + bb.w && p.y > bb.y && p.y < bb.y + bb.h;

  it('b overlapping a\'s lower-right corner ⇒ the left C, both ends visible', () => {
    // Source row 140 runs through b, so the right C would cross it; b's row 240 is below a.
    const b: Bbox = { x: 50, y: 100, w: W, h: H };
    const [r] = routeRefs([ref('a-b', 'a', 'c5', 'b', 'c5')], pair(b), colY);
    expect(r!.source).toEqual({ x: 0, y: 140 });
    expect(r!.target).toEqual({ x: 50, y: 240 });
    expect(isC(r!)).toBe(true);
    expect(trunk(r!).x).toBe(-MIN_STUB_T);
    expect(r!.segments.some((s) => crosses(s, a) || crosses(s, b))).toBe(false);
    expect(hidden(r!.source, b) || hidden(r!.target, a)).toBe(false);
  });

  it('an overlap the right C clears ⇒ the right C (favoured)', () => {
    const b: Bbox = { x: 50, y: 80, w: W, h: H };
    const [r] = routeRefs([ref('a-b', 'a', 'c1', 'b')], pair(b), colY);
    expect(r!.source.x).toBe(W);
    expect(r!.target.x).toBe(50 + W);
    expect(trunk(r!).x).toBe(50 + W + MIN_STUB_T);
    expect(r!.segments.some((s) => crosses(s, a) || crosses(s, b))).toBe(false);
  });

  for (const [label, bx, sourceSide] of [['right', W, 'right'], ['left', -W, 'left']] as const) {
    it(`touching side by side on the ${label} ⇒ the direct facing connector on the shared border`, () => {
      // Each row runs through the other table, so both Cs would cross it.
      const b: Bbox = { x: bx, y: 30, w: W, h: H };
      expect(chooseSides(a, b, { source: 60, target: 70 })).toEqual({ sourceSide, targetSide: sourceSide === 'right' ? 'left' : 'right' });
      const [r] = routeRefs([ref('a-b', 'a', 'c1', 'b')], pair(b), colY);
      const border = sourceSide === 'right' ? W : 0;
      expect(r!.source).toEqual({ x: border, y: 60 });
      expect(r!.target).toEqual({ x: border, y: 70 });
      expect(r!.segments.every((s) => s.x1 === border && s.x2 === border)).toBe(true);
      expect(r!.d).not.toMatch(/NaN/);
    });
  }

  for (const [label, b] of [
    ['stacked, touching top to bottom', { x: 30, y: H, w: W, h: H }],
    ['exactly on top of each other', { x: 0, y: 0, w: W, h: H }],
  ] as const) {
    it(`${label} ⇒ the right C (nothing to cross), no NaN`, () => {
      const [r] = routeRefs([ref('a-b', 'a', 'c1', 'b')], pair(b), colY);
      expect(isC(r!)).toBe(true);
      expect(r!.source.x).toBe(W);
      expect(r!.d).not.toMatch(/NaN/);
    });
  }

  it('a clear vertical gap keeps the C', () => {
    expect(chooseSides(a, { x: 30, y: H + 1, w: W, h: H })).toEqual({ sourceSide: 'right', targetSide: 'right' });
  });

  it('a neighbour mirrors an intersecting C only into a C that clears both tables', () => {
    const blocker = { x: W + 40, y: -200, w: W, h: 800 };
    const obstacles = () => ['n'];
    // Both Cs clear (b straight below, touching): the neighbour flips it left.
    const below: Bbox = { x: 0, y: H, w: W, h: H };
    const boxOf = (b: Bbox) => (n: string): Bbox | undefined => (n === 'a' ? a : n === 'b' ? b : n === 'n' ? blocker : undefined);
    const [flipped] = routeRefs([ref('a-b', 'a', 'c1', 'b')], boxOf(below), colY, undefined, undefined, obstacles);
    expect(flipped!.source.x).toBe(0);
    // b's left row runs through a, so the left C would cross it: the C keeps its right side.
    const overlap: Bbox = { x: 50, y: 80, w: W, h: H };
    const [kept] = routeRefs([ref('a-b', 'a', 'c1', 'b')], boxOf(overlap), colY, undefined, undefined, obstacles);
    expect(kept!.source.x).toBe(W);
  });
});

describe('EdgeRouteCache — nested trunks match a full rebuild', () => {
  it('over random drags of a narrow column with loops, Cs, manual sides and waypoints', () => {
    let seed = 23;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const names = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const pos: Record<string, { x: number; y: number }> = {};
    names.forEach((n, i) => { pos[n] = { x: Math.round(rand() * 300), y: i * 220 }; });
    const cols = Object.keys(ROW);
    const many: Ref[] = [];
    for (let i = 0; i < 30; i++) {
      const s = names[Math.floor(rand() * names.length)]!;
      const t = i % 4 === 0 ? s : names[Math.floor(rand() * names.length)]!;
      many.push(ref(`r${i}`, s, cols[1 + Math.floor(rand() * 5)]!, t, cols[Math.floor(rand() * 6)]!));
    }
    const layouts = new Map<string, EdgeLayout>([
      ['r1', { sourceSide: 'left', targetSide: 'left' }],
      ['r4', { sourceSide: 'left', targetSide: 'left' }],
      ['r5', { sourceSide: 'right', targetSide: 'right' }],
      ['r6', { waypoints: [{ x: 600, y: 300 }, { x: 600, y: 900 }] }],
      ['r7', { dx: 30 }],
      ['r8', { sourceSide: 'left', targetSide: 'left' }],
    ]);
    const layoutOf = (id: string) => layouts.get(id);
    const nested = (routes: EdgeRoute[]) =>
      routes.filter((r) => isC(r) && Math.abs(trunk(r).x - (r.sourceStub.x > r.source.x ? Math.max(r.sourceStub.x, r.targetStub.x) : Math.min(r.sourceStub.x, r.targetStub.x))) > 0.5).length;

    const cache = new EdgeRouteCache();
    cache.routeAll(many, boxes(pos), colY, layoutOf);
    let pushed = 0;
    for (let step = 0; step < 200; step++) {
      const moved = new Set<string>();
      const k = 1 + Math.floor(rand() * 2);
      for (let j = 0; j < k; j++) moved.add(names[Math.floor(rand() * names.length)]!);
      for (const n of moved) {
        const p = pos[n]!;
        pos[n] = { x: Math.max(-150, Math.min(450, p.x + Math.round((rand() - 0.5) * 300))), y: p.y + Math.round((rand() - 0.5) * 300) };
      }
      const inc = cache.routeMoved(moved, boxes(pos), colY, layoutOf);
      expect(inc).toEqual(routeRefs(many, boxes(pos), colY, layoutOf));
      pushed += nested(inc);
    }
    expect(pushed).toBeGreaterThan(50);
  });

  it('over random drags through the narrow-gap S and every intersecting regime (right C, left C, facing)', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    // A tight cluster: tables keep overlapping, touching and sitting a few px apart.
    const names = Array.from({ length: 8 }, (_, i) => `t${i}`);
    const pos: Record<string, { x: number; y: number }> = {};
    for (const n of names) pos[n] = { x: Math.round(rand() * 450), y: Math.round(rand() * 700) };
    const cols = Object.keys(ROW);
    const many: Ref[] = [];
    for (let i = 0; i < 24; i++) {
      const s = names[Math.floor(rand() * names.length)]!;
      const t = i % 8 === 0 ? s : names[Math.floor(rand() * names.length)]!;
      many.push(ref(`r${i}`, s, cols[1 + Math.floor(rand() * 5)]!, t, cols[Math.floor(rand() * 6)]!));
    }
    const layouts = new Map<string, EdgeLayout>([
      ['r1', { sourceSide: 'left', targetSide: 'left' }],
      ['r2', { waypoints: [{ x: 300, y: 300 }, { x: 300, y: 500 }] }],
      ['r3', { sourceSide: 'right', targetSide: 'left' }],
    ]);
    const layoutOf = (id: string) => layouts.get(id);
    const all = () => names;
    const seen = { s: 0, rightC: 0, leftC: 0, facing: 0 };
    const tally = (routes: EdgeRoute[]) => {
      for (const r of routes) {
        if (r.loop) continue;
        const ref0 = many.find((m) => m.id === r.id)!;
        const sb = boxes(pos)(ref0.source.table)!;
        const tb = boxes(pos)(ref0.target.table)!;
        const sSide = r.sourceStub.x < r.source.x ? 'left' : 'right';
        const tSide = r.targetStub.x < r.target.x ? 'left' : 'right';
        if (!layouts.has(r.id) && narrowGapSJog(r.source, r.target, sSide, tSide, sb, tb) !== undefined) seen.s++;
        if (layouts.has(r.id) || !boxesIntersect(sb, tb)) continue;
        if (isC(r)) seen[sSide === 'right' ? 'rightC' : 'leftC']++;
        else seen.facing++;
      }
    };

    const cache = new EdgeRouteCache();
    cache.routeAll(many, boxes(pos), colY, layoutOf, undefined, all);
    for (let step = 0; step < 250; step++) {
      const moved = new Set<string>();
      const k = 1 + Math.floor(rand() * 2);
      for (let j = 0; j < k; j++) moved.add(names[Math.floor(rand() * names.length)]!);
      for (const n of moved) {
        const p = pos[n]!;
        pos[n] = { x: Math.max(-100, Math.min(550, p.x + Math.round((rand() - 0.5) * 260))), y: Math.max(-100, Math.min(800, p.y + Math.round((rand() - 0.5) * 260))) };
      }
      const inc = cache.routeMoved(moved, boxes(pos), colY, layoutOf);
      expect(inc).toEqual(routeRefs(many, boxes(pos), colY, layoutOf, undefined, all));
      tally(inc);
    }
    expect(seen.s).toBeGreaterThan(50);
    expect(seen.rightC).toBeGreaterThan(30);
    expect(seen.leftC).toBeGreaterThan(30);
    expect(seen.facing).toBeGreaterThan(30);
  });

  it('dragging a third table re-nests a C it does not touch', () => {
    // a→b is pushed out by c→d only while c sits between a and b.
    const refs = [ref('a-b', 'a', 'c1', 'b', 'c1'), ref('c-d', 'c', 'c1', 'd', 'c1')];
    const pos = { a: { x: 0, y: 0 }, b: { x: 0, y: 400 }, c: { x: 0, y: 200 }, d: { x: 0, y: 600 } };
    const cache = new EdgeRouteCache();
    const before = cache.routeAll(refs, boxes(pos), colY);
    expect(trunk(byId(before, 'c-d')).x).toBe(W + 24 + LOOP_STEP);
    const next = { ...pos, a: { x: 0, y: -400 }, b: { x: 0, y: -200 } };
    const after = cache.routeMoved(['a', 'b'], boxes(next), colY);
    expect(after).toEqual(routeRefs(refs, boxes(next), colY));
    expect(trunk(byId(after, 'c-d')).x).toBe(W + 24);
  });
});

/** Every named box, scanned linearly: the router filters exactly through `bboxOf`. */
const obstaclesOf = (pos: Record<string, { x: number; y: number }>) => () => Object.keys(pos);

/** Whether any drawn segment of `r` enters a node other than its own two tables. */
const crossesThird = (r: EdgeRoute, ref: Ref, bboxOf: (n: string) => Bbox | undefined, names: string[]) =>
  names.some((n) => {
    if (n === ref.source.table || n === ref.target.table) return false;
    const o = bboxOf(n)!;
    return r.segments.some((s) => {
      const x0 = Math.min(s.x1, s.x2);
      const x1 = Math.max(s.x1, s.x2);
      const y0 = Math.min(s.y1, s.y2);
      const y1 = Math.max(s.y1, s.y2);
      return x0 < o.x + o.w && x1 > o.x && y0 < o.y + o.h && y1 > o.y;
    });
  });

describe('a neighbour that blocks a C side flips it to the mirrored C (spec 05 §1 "Anidado de C")', () => {
  // emp's two right loops push proj-owner's trunk to W + loopReach(3) = 272; audit sits at the
  // default 64 px column gap (x = 264), beside the C's vertical run.
  const loops = [ref('emp-manager', 'emp', 'c1', 'emp'), ref('emp-mentor', 'emp', 'c2', 'emp')];
  const owner = ref('proj-owner', 'proj', 'c1', 'emp');
  const pos = { emp: { x: 0, y: 0 }, proj: { x: 0, y: 400 }, audit: { x: W + 64, y: 100 } };

  it('without an obstacle query the trunk keeps its nested slot (and runs under the neighbour)', () => {
    const routes = routeRefs([...loops, owner], boxes(pos), colY);
    expect(trunk(byId(routes, owner.id)).x).toBe(W + loopReach(3));
  });

  it('with one, the C wraps the clear left side instead, and the loops move in to keep 8 px off the neighbour', () => {
    const routes = routeRefs([...loops, owner], boxes(pos), colY, undefined, undefined, obstaclesOf(pos));
    const c = byId(routes, owner.id);
    expect(c.sourceStub.x).toBeLessThan(c.source.x);
    expect(c.targetStub.x).toBeLessThan(c.target.x);
    expect(trunk(c).x).toBe(-24);
    expect(crossesThird(c, owner, boxes(pos), Object.keys(pos))).toBe(false);
    // Unclamped they would reach W + 48 / W + 60, 4 px from audit at W + 64.
    expect(loops.map((l) => trunk(byId(routes, l.id)).x)).toEqual([W + 64 - 8 - LOOP_STEP, W + 64 - 8]);
  });

  it('blocked on both sides it keeps its own side', () => {
    const p = { ...pos, left: { x: -W - 40, y: 100 } };
    const routes = routeRefs([...loops, owner], boxes(p), colY, undefined, undefined, obstaclesOf(p));
    expect(trunk(byId(routes, owner.id)).x).toBe(W + loopReach(3));
  });

  it('a C with persisted sides never flips', () => {
    const layouts = new Map<string, EdgeLayout>([[owner.id, { sourceSide: 'right', targetSide: 'right' }]]);
    const routes = routeRefs([...loops, owner], boxes(pos), colY, (id) => layouts.get(id), undefined, obstaclesOf(pos));
    expect(trunk(byId(routes, owner.id)).x).toBe(W + loopReach(3));
  });

  it('Cs fill the gap LOOP_STEP apart until the next slot would reach the neighbour', () => {
    // Four nested Cs out of one column, no loops: slots W+24 and W+36 clear audit by MIN_STUB, W+48 does not.
    const p = { a: { x: 0, y: 0 }, b: { x: 0, y: 300 }, c: { x: 0, y: 600 }, d: { x: 0, y: 900 }, e: { x: 0, y: 1200 }, audit: { x: W + 64, y: 0 } };
    const big = (name: string): Bbox | undefined => (name === 'audit' ? { x: W + 64, y: 0, w: W, h: 1400 } : boxes(p)(name));
    const refs = [ref('ab', 'a', 'c1', 'b'), ref('ac', 'a', 'c2', 'c'), ref('ad', 'a', 'c3', 'd'), ref('ae', 'a', 'c4', 'e')];
    for (const order of [refs, [...refs].reverse()]) {
      const routes = routeRefs(order, big, colY, undefined, undefined, obstaclesOf(p));
      expect(['ab', 'ac', 'ad', 'ae'].map((id) => trunk(byId(routes, id)).x)).toEqual([W + 24, W + 36, -24, -36]);
      expectNoSharedTrunk(routes);
    }
  });

  it('routeMoved matches a full rebuild while free tables (no refs) drift through the trunk band', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const p: Record<string, { x: number; y: number }> = {
      emp: { x: 0, y: 0 }, proj: { x: 0, y: 400 }, dept: { x: 0, y: 800 },
      f1: { x: W + 64, y: 100 }, f2: { x: -W - 64, y: 500 }, f3: { x: 600, y: 600 },
    };
    const refs = [...loops, owner, ref('emp-dept', 'emp', 'c3', 'dept'), ref('dept-parent', 'dept', 'c1', 'dept'), ref('proj-dept', 'proj', 'c2', 'dept', 'c2')];
    const cache = new EdgeRouteCache();
    cache.routeAll(refs, boxes(p), colY, undefined, undefined, obstaclesOf(p));
    let flips = 0;
    for (let step = 0; step < 150; step++) {
      const moved = new Set<string>();
      const n = ['f1', 'f2', 'f3', 'proj', 'dept'][Math.floor(rand() * 5)]!;
      moved.add(n);
      const q = p[n]!;
      p[n] = { x: Math.max(-500, Math.min(600, q.x + Math.round((rand() - 0.5) * 240))), y: Math.max(-200, Math.min(1200, q.y + Math.round((rand() - 0.5) * 240))) };
      const inc = cache.routeMoved(moved, boxes(p), colY);
      expect(inc).toEqual(routeRefs(refs, boxes(p), colY, undefined, undefined, obstaclesOf(p)));
      flips += inc.filter((r) => isC(r) && r.sourceStub.x < r.source.x).length;
    }
    expect(flips).toBeGreaterThan(20);
  });
});
