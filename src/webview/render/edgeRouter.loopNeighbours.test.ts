import { describe, expect, it } from 'vitest';
import type { Ref } from '../../shared/types';
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

  it('keeps the midpoint when the gap has no free x (default 64 px gap beside two loops)', () => {
    // Loops clamp to W + 44 / W + 56; with 8 px of clearance the whole stub-to-stub range is taken.
    const z = byId(route(scene(64)), deptAudit.id);
    expect(verticals(z).map((s) => s.x1)).toEqual([W + 32]);
  });

  it("ignores its own tables' loops and loops outside its rows", () => {
    const own = [ref('dept-parent', 'dept', 'c1', 'dept'), deptAudit];
    const pos = { dept: { x: 0, y: 0 }, audit: { x: W + 120, y: 300 } };
    expect(verticals(byId(route(pos, own), deptAudit.id)).map((s) => s.x1)).toEqual([W + 60]);
    // employees' loops sit above the Z's rows.
    const below = { emp: { x: 0, y: 0 }, dept: { x: 0, y: 400 }, audit: { x: W + 120, y: 600 } };
    expect(verticals(byId(route(below), deptAudit.id)).map((s) => s.x1)).toEqual([W + 60]);
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
