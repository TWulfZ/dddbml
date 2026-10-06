import { describe, expect, it } from 'vitest';
import type { EdgeLayout, Ref } from '../../shared/types';
import { clampedLoopReach, EdgeRouteCache, LOOP_OFFSET, LOOP_STEP, loopReach, routeRefs, type EdgeRoute } from './edgeRouter';
import type { Bbox } from './spatialIndex';

const W = 240;
const H = 156;

const ref = (id: string, source: string, sCol: string, target: string, tCol = 'id'): Ref => ({
  id,
  source: { table: source, columns: [sCol], relation: '*' },
  target: { table: target, columns: [tCol], relation: '1' },
});

const boxes = (pos: Record<string, { x: number; y: number }>) => (name: string): Bbox | undefined => {
  const p = pos[name];
  return p ? { x: p.x, y: p.y, w: W, h: H } : undefined;
};

const ROW: Record<string, number> = { id: 52, c1: 80, c2: 108, c3: 136 };
const colY = (_t: string, c: string) => ROW[c];
const obstaclesOf = (pos: Record<string, { x: number; y: number }>) => () => Object.keys(pos);

const byId = (routes: EdgeRoute[], id: string): EdgeRoute => {
  const r = routes.find((x) => x.id === id);
  if (!r) throw new Error(`route ${id} missing`);
  return r;
};

const verticals = (r: EdgeRoute) => r.segments.filter((s) => s.axis === 'v' && !s.rigid);

// selfloop.dbml + audit: employees' two right loops (manager_id, mentor_id), departments below it in
// the same column, departments → audit a Z across the column gap through employees' rows.
const loops = [ref('emp-manager', 'emp', 'c1', 'emp'), ref('emp-mentor', 'emp', 'c2', 'emp')];
const deptAudit = ref('audit-dept', 'audit', 'c1', 'dept');
const scene = (gap: number) => ({ emp: { x: 0, y: 0 }, dept: { x: 0, y: 312 }, audit: { x: W + gap, y: 0 } });

describe('clampedLoopReach (spec 05 §Self-loops)', () => {
  it('keeps the loopReach stack when it fits the room', () => {
    expect([0, 1].map((k) => clampedLoopReach(k, 2, 60))).toEqual([LOOP_OFFSET, LOOP_OFFSET + LOOP_STEP]);
    expect(clampedLoopReach(0, 1, Infinity)).toBe(loopReach(1));
  });

  it('moves a crowded stack in so its outermost loop ends at the room, LOOP_STEP apart', () => {
    expect([0, 1].map((k) => clampedLoopReach(k, 2, 56))).toEqual([44, 56]);
    expect(clampedLoopReach(0, 1, 40)).toBe(40);
  });

  it('compresses the spacing down to half a step above one fillet past the stub, then gives up', () => {
    expect([0, 1, 2].map((k) => clampedLoopReach(k, 3, 48))).toEqual([32, 40, 48]);
    expect([0, 1, 2].map((k) => clampedLoopReach(k, 3, 20))).toEqual([32, 38, 44]);
  });
});

describe('self-loops keep off a neighbouring column (spec 05 §Self-loops)', () => {
  it('two loops beside a column 64 px away end 8 px short of it instead of 4', () => {
    const pos = scene(64);
    const routes = routeRefs(loops, boxes(pos), colY, undefined, undefined, obstaclesOf(pos));
    expect(loops.map((l) => verticals(byId(routes, l.id))[0]!.x1)).toEqual([W + 44, W + 56]);
    // Without the obstacle query (tests, old callers) nothing moves.
    const free = routeRefs(loops, boxes(pos), colY);
    expect(loops.map((l) => verticals(byId(free, l.id))[0]!.x1)).toEqual([W + 48, W + 60]);
  });

  it('a neighbour below or above the table, or past the stack, leaves the loops alone', () => {
    for (const audit of [{ x: W + 64, y: H + 10 }, { x: W + 64, y: -H - 10 }, { x: W + 69, y: 0 }]) {
      const pos = { emp: { x: 0, y: 0 }, audit };
      const routes = routeRefs(loops, boxes(pos), colY, undefined, undefined, obstaclesOf(pos));
      expect(loops.map((l) => verticals(byId(routes, l.id))[0]!.x1)).toEqual([W + 48, W + 60]);
    }
  });

  it('mirrors on the left side', () => {
    const left = loops.map((l) => l.id);
    const pos = { emp: { x: 0, y: 0 }, west: { x: -W - 64, y: 0 } };
    const routes = routeRefs(loops, boxes(pos), colY, (id) => (left.includes(id) ? { sourceSide: 'left', targetSide: 'left' } : undefined), undefined, obstaclesOf(pos));
    expect(loops.map((l) => verticals(byId(routes, l.id))[0]!.x1)).toEqual([-44, -56]);
  });
});

describe("a facing Z's trunk keeps off a third table's loops (spec 05 §1)", () => {
  const route = (pos: Record<string, { x: number; y: number }>, refs: Ref[] = [...loops, deptAudit]) =>
    routeRefs(refs, boxes(pos), colY, undefined, undefined, obstaclesOf(pos));

  it('slides to the first free x past the loop stack when the gap has room', () => {
    // Gap 120: loops at W + 48 / W + 60, stubs end at W + 24 / W + 96, midpoint W + 60 is a loop trunk.
    const z = byId(route(scene(120)), deptAudit.id);
    expect(verticals(z).map((s) => s.x1)).toEqual([W + 60 + 8]);
    // Without loops in its way it stays on the midpoint.
    const plain = byId(route(scene(120), [deptAudit]), deptAudit.id);
    expect(verticals(plain).map((s) => s.x1)).toEqual([W + 60]);
  });

  it("keeps the midpoint when it clears its own table's loop trunk, and ignores loops outside its rows", () => {
    const own = [ref('dept-parent', 'dept', 'c1', 'dept'), deptAudit];
    const pos = { dept: { x: 0, y: 0 }, audit: { x: W + 120, y: 300 } };
    expect(verticals(byId(route(pos, own), deptAudit.id)).map((s) => s.x1)).toEqual([W + 60]);
    // employees' loops sit above the Z's rows.
    const below = { emp: { x: 0, y: 0 }, dept: { x: 0, y: 400 }, audit: { x: W + 120, y: 600 } };
    expect(verticals(byId(route(below), deptAudit.id)).map((s) => s.x1)).toEqual([W + 60]);
  });

  it("slides off its own table's loop trunk: gap 96 puts the midpoint exactly on departments' W+48 loop", () => {
    const deptLoop = ref('dept-parent', 'dept', 'c1', 'dept');
    const z = ref('dept-audit', 'dept', 'c2', 'audit');
    const pos = { dept: { x: 0, y: 312 }, audit: { x: W + 96, y: 0 } };
    const routes = route(pos, [deptLoop, z]);
    expect(verticals(byId(routes, deptLoop.id))[0]!.x1).toBe(W + 48);
    const x = verticals(byId(routes, z.id))[0]!.x1;
    expect(Math.abs(x - (W + 48))).toBeGreaterThanOrEqual(8);
    expect(byId(routes, z.id).laneClaim).toBeUndefined();
  });

  it('routeMoved matches a full rebuild while loop tables, Z ends and neighbours move', () => {
    let seed = 11;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const p: Record<string, { x: number; y: number }> = { ...scene(120), proj: { x: 0, y: 600 }, f1: { x: 700, y: 0 } };
    const refs = [...loops, deptAudit, ref('proj-audit', 'proj', 'c2', 'audit'), ref('proj-self', 'proj', 'c3', 'proj')];
    const cache = new EdgeRouteCache();
    cache.routeAll(refs, boxes(p), colY, undefined, undefined, obstaclesOf(p));
    let slid = 0;
    for (let step = 0; step < 200; step++) {
      const n = ['emp', 'dept', 'audit', 'proj', 'f1'][Math.floor(rand() * 5)]!;
      const q = p[n]!;
      p[n] = { x: Math.max(-200, Math.min(700, q.x + Math.round((rand() - 0.5) * 120))), y: Math.max(-200, Math.min(900, q.y + Math.round((rand() - 0.5) * 160))) };
      const inc = cache.routeMoved([n], boxes(p), colY);
      const full = routeRefs(refs, boxes(p), colY, undefined, undefined, obstaclesOf(p));
      expect(inc).toEqual(full);
      const z = byId(full, deptAudit.id);
      const v = verticals(z);
      if (v.length === 1 && Math.abs(v[0]!.x1 - (z.sourceStub.x + z.targetStub.x) / 2) > 1) slid++;
    }
    expect(slid).toBeGreaterThan(5);
  });
});

// Spec 05 §Self-loops "Carril para Z ajenas": a stack yields a lane to a facing Z it would otherwise block.
describe('loop stacks yield a lane to a passing facing Z (spec 05 §Self-loops)', () => {
  type Pos = Record<string, { x: number; y: number }>;
  const route = (pos: Pos, refs: Ref[], layouts: Record<string, EdgeLayout> = {}, col = colY) =>
    routeRefs(refs, boxes(pos), col, (id) => layouts[id], undefined, obstaclesOf(pos));
  const trunkOf = (r: EdgeRoute): number => verticals(r)[0]!.x1;
  const loopTrunks = (routes: EdgeRoute[], ids: readonly string[]) => ids.map((id) => trunkOf(byId(routes, id)));
  const loopIds = loops.map((l) => l.id);

  /** The Z's trunk sits strictly outside every loop envelope (plus its 8 px clearance) its rows overlap. */
  const laneFree = (z: EdgeRoute, routes: EdgeRoute[]): boolean => {
    const v = verticals(z);
    if (v.length !== 1) return false;
    const { x1: x, y1, y2 } = v[0]!;
    return routes.filter((r) => r.loop).every((l) => {
      const x0 = Math.min(l.source.x, trunkOf(l));
      const x1 = Math.max(l.source.x, trunkOf(l));
      const rowsMeet = Math.max(l.source.y, l.target.y) >= Math.min(y1, y2) && Math.min(l.source.y, l.target.y) <= Math.max(y1, y2);
      return !rowsMeet || x <= x0 - 8 || x >= x1 + 8;
    });
  };
  /** No vertical run of the Z comes within 8 px of any loop's trunk (own tables' included) over shared rows. */
  const offTrunks = (z: EdgeRoute, routes: EdgeRoute[]): boolean =>
    verticals(z).every((v) => routes.filter((r) => r.loop).every((l) => {
      const lo = Math.min(l.source.y, l.target.y);
      const hi = Math.max(l.source.y, l.target.y);
      const rowsMeet = hi >= Math.min(v.y1, v.y2) && lo <= Math.max(v.y1, v.y2);
      return !rowsMeet || Math.abs(v.x1 - trunkOf(l)) >= 8;
    }));
  /** No horizontal run of the Z lies on a horizontal run of a loop (same row, overlapping x). */
  const armsApart = (z: EdgeRoute, routes: EdgeRoute[]): boolean =>
    z.segments.filter((s) => s.axis === 'h').every((zs) => routes.filter((r) => r.loop).every((l) => l.segments.filter((s) => s.axis === 'h').every((ls) =>
      ls.y1 !== zs.y1 || Math.min(Math.max(ls.x1, ls.x2), Math.max(zs.x1, zs.x2)) <= Math.max(Math.min(ls.x1, ls.x2), Math.min(zs.x1, zs.x2)))));

  it('reference case (selfloop.dbml + audit at 64 px): loops compress to W+32/W+39 and the Z trunk moves out to W+47', () => {
    const routes = route(scene(64), [...loops, deptAudit]);
    expect(loopTrunks(routes, loopIds)).toEqual([W + 32, W + 39]);
    const z = byId(routes, deptAudit.id);
    expect(trunkOf(z)).toBe(W + 47);
    expect(z.laneClaim).toBe(true);
    expect(laneFree(z, routes)).toBe(true);
    expect(armsApart(z, routes)).toBe(true);
    // Each loop remembers where it returns without the claim (the neighbour-clamped W+44/W+56), for A*.
    expect(loopIds.map((id) => byId(routes, id).unyieldedTrunkX)).toEqual([W + 44, W + 56]);
  });

  it("full selfloop.dbml (departments' own parent_id loop) + audit at 64 px: both stacks compress, the Z touches no loop", () => {
    // departments.audit_id → audit.id leaves departments below its parent_id → id loop; employees' loops sit level with audit.
    const deptLoop = ref('dept-parent', 'dept', 'c1', 'dept');
    const z = ref('dept-audit', 'dept', 'c2', 'audit');
    const routes = route(scene(64), [...loops, deptLoop, z]);
    expect(loopTrunks(routes, [...loopIds, deptLoop.id])).toEqual([W + 32, W + 39, W + 39]);
    const zr = byId(routes, z.id);
    expect(trunkOf(zr)).toBe(W + 47);
    expect(zr.laneClaim).toBe(true);
    expect(offTrunks(zr, routes)).toBe(true);
    expect(armsApart(zr, routes)).toBe(true);
    expect(byId(routes, deptLoop.id).unyieldedTrunkX).toBe(W + 48);
    // Without the obstacle query nothing yields and the Z keeps its midpoint, inside both stacks.
    const blind = routeRefs([...loops, deptLoop, z], boxes(scene(64)), colY);
    expect(trunkOf(byId(blind, z.id))).toBe(W + 32);
  });

  it('falls back to the midpoint when even the tightest stack leaves no lane (three loops at 64 px)', () => {
    const third = ref('emp-c3', 'emp', 'c3', 'emp');
    const routes = route(scene(64), [...loops, third, deptAudit]);
    expect(loopTrunks(routes, [...loopIds, third.id])).toEqual([W + 32, W + 44, W + 56]);
    const z = byId(routes, deptAudit.id);
    expect(trunkOf(z)).toBe(W + 32);
    expect(z.laneClaim).toBeUndefined();
    expect(routes.some((r) => r.unyieldedTrunkX !== undefined)).toBe(false);
  });

  it('leaves the loops alone when the Z already has a free x (gap 120) or without an obstacle query', () => {
    const wide = route(scene(120), [...loops, deptAudit]);
    expect(loopTrunks(wide, loopIds)).toEqual([W + 48, W + 60]);
    expect(byId(wide, deptAudit.id).laneClaim).toBeUndefined();
    const blind = routeRefs([...loops, deptAudit], boxes(scene(64)), colY);
    expect(loopTrunks(blind, loopIds)).toEqual([W + 48, W + 60]);
    expect(trunkOf(byId(blind, deptAudit.id))).toBe(W + 32);
  });

  it("never yields its own table's loops, nor loops outside the Z's rows", () => {
    const own = [ref('dept-parent', 'dept', 'c1', 'dept'), deptAudit];
    const ownRoutes = route({ dept: { x: 0, y: 0 }, audit: { x: W + 64, y: 0 } }, own);
    expect(trunkOf(byId(ownRoutes, 'dept-parent'))).toBe(W + 48);
    expect(byId(ownRoutes, deptAudit.id).laneClaim).toBeUndefined();
    const below = route({ emp: { x: 0, y: 0 }, dept: { x: 0, y: 400 }, audit: { x: W + 64, y: 600 } }, [...loops, deptAudit]);
    expect(loopTrunks(below, loopIds)).toEqual([W + 48, W + 60]);
    expect(byId(below, deptAudit.id).laneClaim).toBeUndefined();
  });

  it('a Z with waypoints, legacy dx, an S shape or an unresolved column never claims', () => {
    const alone = (pos: Pos) => loopTrunks(route(pos, loops), loopIds);
    const cases: Array<[string, Pos, Record<string, EdgeLayout>, typeof colY]> = [
      ['waypoints', scene(64), { [deptAudit.id]: { waypoints: [{ x: W + 32, y: 80 }, { x: W + 32, y: 364 }] } }, colY],
      ['legacy dx', scene(64), { [deptAudit.id]: { dx: 4 } }, colY],
      ['narrow-gap S', scene(40), {}, colY],
      ['unresolved column', scene(64), {}, (t, c) => (t === 'audit' ? undefined : ROW[c])],
    ];
    for (const [label, pos, layouts, col] of cases) {
      const routes = route(pos, [...loops, deptAudit], layouts, col);
      expect(loopTrunks(routes, loopIds), label).toEqual(alone(pos));
      expect(byId(routes, deptAudit.id).laneClaim, label).toBeUndefined();
    }
  });

  it('mirrors on the left side', () => {
    const left = Object.fromEntries(loopIds.map((id) => [id, { sourceSide: 'left', targetSide: 'left' } as EdgeLayout]));
    const westDept = ref('west-dept', 'west', 'c1', 'dept');
    const pos = { emp: { x: 0, y: 0 }, dept: { x: 0, y: 312 }, west: { x: -W - 64, y: 0 } };
    const routes = route(pos, [...loops, westDept], left);
    expect(loopTrunks(routes, loopIds)).toEqual([-32, -39]);
    const z = byId(routes, westDept.id);
    expect(trunkOf(z)).toBe(-47);
    expect(z.laneClaim).toBe(true);
    expect(laneFree(z, routes)).toBe(true);
  });

  it('two stacks on the same side of the lane both yield; facing stacks on both sides fall back', () => {
    const emp2Loops = [ref('emp2-a', 'emp2', 'c1', 'emp2'), ref('emp2-b', 'emp2', 'c2', 'emp2')];
    const pos: Pos = { emp: { x: 0, y: 0 }, emp2: { x: 0, y: 170 }, dept: { x: 0, y: 400 }, audit: { x: W + 64, y: 0 } };
    const both = route(pos, [...loops, ...emp2Loops, deptAudit]);
    expect(loopTrunks(both, [...loopIds, ...emp2Loops.map((l) => l.id)])).toEqual([W + 32, W + 39, W + 32, W + 39]);
    expect(trunkOf(byId(both, deptAudit.id))).toBe(W + 47);
    expect(laneFree(byId(both, deptAudit.id), both)).toBe(true);

    // east's left loops reach into the lane from the other side: no single direction opens it.
    const eastLoops = [ref('east-a', 'east', 'c1', 'east'), ref('east-b', 'east', 'c2', 'east')];
    const leftEast = Object.fromEntries(eastLoops.map((l) => [l.id, { sourceSide: 'left', targetSide: 'left' } as EdgeLayout]));
    const mixedPos: Pos = { emp: { x: 0, y: 0 }, east: { x: W + 64, y: 170 }, dept: { x: 0, y: 400 }, audit: { x: W + 64, y: 0 } };
    const mixed = route(mixedPos, [...loops, ...eastLoops, deptAudit], leftEast);
    const without = route(mixedPos, [...loops, ...eastLoops], leftEast);
    expect(loopTrunks(mixed, [...loopIds, ...eastLoops.map((l) => l.id)])).toEqual(loopTrunks(without, [...loopIds, ...eastLoops.map((l) => l.id)]));
    expect(byId(mixed, deptAudit.id).laneClaim).toBeUndefined();
  });

  it('two Zs claiming one stack: the tighter claim wins and both lanes are free', () => {
    const z2 = ref('audit2-dept2', 'audit2', 'c1', 'dept2');
    const pos: Pos = { ...scene(64), audit2: { x: W + 72, y: -100 }, dept2: { x: 0, y: 600 } };
    const routes = route(pos, [...loops, deptAudit, z2]);
    expect(loopTrunks(routes, loopIds)).toEqual([W + 32, W + 39]);
    for (const id of [deptAudit.id, z2.id]) {
      expect(byId(routes, id).laneClaim, id).toBe(true);
      expect(laneFree(byId(routes, id), routes), id).toBe(true);
    }
  });

  it('sweeping the column gap 48 → 130 moves loops and trunk by a few px per step, jumping only at the admission threshold', () => {
    let prev: number[] | undefined;
    for (let g = 48; g <= 130; g++) {
      const routes = route(scene(g), [...loops, deptAudit]);
      const z = byId(routes, deptAudit.id);
      const now = [...loopTrunks(routes, loopIds), trunkOf(z)];
      if (z.laneClaim) expect(laneFree(z, routes), `gap ${g}`).toBe(true);
      // Below 62 two loops cannot open the 64 px-default lane (room 37 < 38): the fallback keeps the midpoint.
      expect(z.laneClaim === true, `gap ${g}`).toBe(g >= 62 && g < 91);
      if (prev && g !== 62) prev.forEach((p, k) => expect(Math.abs(now[k]! - p), `gap ${g} #${k}`).toBeLessThanOrEqual(LOOP_STEP / 2));
      prev = now;
    }
  });

  it('fractional positions still leave the claimed lane free', () => {
    for (const frac of [0.25, 0.5, 0.75]) {
      for (let g = 60; g <= 95; g++) {
        const pos: Pos = { emp: { x: frac, y: 0 }, dept: { x: -frac, y: 312 }, audit: { x: W + g + frac, y: 0.5 } };
        const routes = route(pos, [...loops, deptAudit]);
        const z = byId(routes, deptAudit.id);
        if (!z.laneClaim) continue;
        expect(laneFree(z, routes), `gap ${g} + ${frac}`).toBe(true);
        expect(trunkOf(z)).toBeGreaterThan(z.targetStub.x);
        expect(trunkOf(z)).toBeLessThan(z.sourceStub.x);
      }
    }
  });

  it('routeMoved matches a full rebuild while stacks, claimants and neighbours move (gaps 48..130, left stack)', () => {
    let seed = 5;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const eastLoops = [ref('east-a', 'east', 'c1', 'east'), ref('east-b', 'east', 'c3', 'east')];
    const layouts: Record<string, EdgeLayout> = Object.fromEntries(eastLoops.map((l) => [l.id, { sourceSide: 'left', targetSide: 'left' }]));
    const refs = [
      ...loops, deptAudit, ...eastLoops,
      ref('emp2-a', 'emp2', 'c2', 'emp2'),
      ref('proj-audit', 'proj', 'c2', 'audit'),
      ref('west-east', 'west', 'c1', 'east', 'c2'),
      ref('far-emp2', 'far', 'c3', 'emp2'),
      ref('dept-parent', 'dept', 'c1', 'dept'),
      ref('dept-audit', 'dept', 'c2', 'audit'),
    ];
    const p: Pos = {
      ...scene(64), emp2: { x: 0, y: 170 }, east: { x: W + 64, y: 500 }, proj: { x: W + 100, y: 700 },
      west: { x: -W - 70, y: 300 }, far: { x: W + 90, y: -150 }, f1: { x: W + 70, y: 300 },
    };
    const names = Object.keys(p);
    const home = { ...p };
    const cache = new EdgeRouteCache();
    const layoutOf = (id: string) => layouts[id];
    cache.routeAll(refs, boxes(p), colY, layoutOf, undefined, obstaclesOf(p));
    let claimed = 0;
    let toggles = 0;
    let before = '';
    for (let step = 0; step < 400; step++) {
      const n = names[Math.floor(rand() * names.length)]!;
      const o = home[n]!;
      // Jumps around each table's home, the right column across gaps 48..130, so claims start and stop often.
      const gap = 48 + Math.round(rand() * 82);
      const x = n === 'west' ? -W - gap : o.x > 0 ? W + gap : o.x + Math.round((rand() - 0.5) * 20);
      p[n] = { x, y: o.y + Math.round((rand() - 0.5) * 240) };
      const inc = cache.routeMoved([n], boxes(p), colY, layoutOf);
      const full = routeRefs(refs, boxes(p), colY, layoutOf, undefined, obstaclesOf(p));
      expect(inc).toEqual(full);
      for (const z of full) if (z.laneClaim) expect(offTrunks(z, full), `${z.id} step ${step}`).toBe(true);
      const now = full.filter((r) => r.laneClaim).map((r) => r.id).join();
      if (now) claimed++;
      if (now !== before) toggles++;
      before = now;
    }
    expect(claimed).toBeGreaterThan(100);
    expect(toggles).toBeGreaterThan(40);
  });
});
