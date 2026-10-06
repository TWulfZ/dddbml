import { describe, expect, it } from 'vitest';
import type { EdgeLayout, Ref, Waypoint } from '../../shared/types';
import { EdgeRouteCache, notchAtQuarter, routeRefs, slideSegment, type EdgeRoute } from './edgeRouter';
import { STUB_JOG_MIN, TIDY_MAX, tidyStubEnds } from './edgeTidy';
import type { Bbox } from './spatialIndex';

const R = { x: 1, y: 0 };
const L = { x: -1, y: 0 };
// a(0,0) → b(600,300), 200×100 tables, row 40: facing Z, full stubs.
const A_STUB = { x: 224, y: 40 };
const B_STUB = { x: 576, y: 340 };
const tidy = (wps: Waypoint[]) => tidyStubEnds(A_STUB, B_STUB, R, L, wps);

const ref = (id: string, source: string, target: string): Ref => ({
  id,
  source: { table: source, columns: ['fk'], relation: '*' },
  target: { table: target, columns: ['id'], relation: '1' },
});
const W = 200;
const H = 100;
const boxes = (pos: Record<string, { x: number; y: number }>) => (n: string): Bbox | undefined => {
  const p = pos[n];
  return p ? { x: p.x, y: p.y, w: W, h: H } : undefined;
};
const routeAB = (pos: Record<string, { x: number; y: number }>, layout?: EdgeLayout, row = 40): EdgeRoute =>
  routeRefs([ref('a-b', 'a', 'b')], boxes(pos), () => row, layout ? () => layout : undefined)[0]!;

/** Drawn polyline with zero-length pieces dropped. */
function polyline(r: EdgeRoute): Waypoint[] {
  const pts: Waypoint[] = [{ x: r.segments[0]!.x1, y: r.segments[0]!.y1 }];
  for (const s of r.segments) pts.push({ x: s.x2, y: s.y2 });
  return pts;
}

/** Stair, spur or hook within the two runs after either stub: what spec 05 §11 tidies away. */
function stubArtifacts(r: EdgeRoute): string[] {
  const out: string[] = [];
  const check = (pts: Waypoint[], end: string) => {
    const [p0, p1, p2, p3] = pts;
    if (!p0 || !p1 || !p2) return;
    const dot = (a: Waypoint, b: Waypoint, c: Waypoint, d: Waypoint) => (b.x - a.x) * (d.x - c.x) + (b.y - a.y) * (d.y - c.y);
    const len = (a: Waypoint, b: Waypoint) => Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    const sameAxis = (a: Waypoint, b: Waypoint, c: Waypoint, d: Waypoint) => (a.y === b.y) === (c.y === d.y);
    if (sameAxis(p0, p1, p1, p2) && dot(p0, p1, p1, p2) < 0) out.push(`${end}: hook`);
    if (!sameAxis(p0, p1, p1, p2) && len(p1, p2) < STUB_JOG_MIN && p3) out.push(`${end}: ${len(p1, p2)}px jog`);
    if (p3 && sameAxis(p1, p2, p2, p3) && dot(p1, p2, p2, p3) < 0) out.push(`${end}: spur`);
  };
  const pts = polyline(r);
  check(pts, 'source');
  check(pts.slice().reverse(), 'target');
  return out;
}

describe('tidyStubEnds — kink types measured on a real pre-0.4 file (spec 05 §11)', () => {
  // Offsets are the ones measured: 3 px port-row drift, 8 px stub-length drift (old 16 px stubs), one row ± 3.
  it('stair at the target stub (row drift, trunk before it): the last corner joins the stub axis', () => {
    expect(tidy([{ x: 568, y: 40 }, { x: 568, y: 337 }])).toEqual([{ x: 568, y: 40 }, { x: 568, y: 340 }]);
  });

  it('spur at the source trunk (row drift, trunk going the other way): the first corner joins the axis', () => {
    expect(tidy([{ x: 300, y: 37 }, { x: 300, y: 340 }])).toEqual([{ x: 300, y: 40 }, { x: 300, y: 340 }]);
  });

  it('invisible drift (trunk going the same way) is normalized too, drawing the same line', () => {
    const aStub = { x: 224, y: 340 };
    expect(tidyStubEnds(aStub, { x: 576, y: 40 }, R, L, [{ x: 300, y: 337 }, { x: 300, y: 40 }])).toEqual([{ x: 300, y: 340 }, { x: 300, y: 40 }]);
  });

  it('hook over the source stub (16 px stub era): the trunk moves onto the stub end, the corner on it drops', () => {
    expect(tidy([{ x: 216, y: 40 }, { x: 216, y: 340 }])).toEqual([{ x: 224, y: 340 }]);
  });

  it('row drift and hook together: axis first, then the column', () => {
    expect(tidy([{ x: 216, y: 37 }, { x: 216, y: 340 }])).toEqual([{ x: 224, y: 340 }]);
    expect(tidy([{ x: 400, y: 40 }, { x: 400, y: 337 }, { x: 584, y: 337 }])).toEqual([{ x: 400, y: 40 }, { x: 400, y: 340 }]);
  });

  it('one row ± drift (17 px) still joins the axis', () => {
    expect(tidy([{ x: 400, y: 40 }, { x: 400, y: 357 }])).toEqual([{ x: 400, y: 40 }, { x: 400, y: 340 }]);
  });

  it('a level run a step off the axis keeps its level: the jog moves to the stub end', () => {
    expect(tidy([{ x: 232, y: -21 }, { x: 500, y: -21 }, { x: 500, y: 340 }])).toEqual([{ x: 224, y: -21 }, { x: 500, y: -21 }, { x: 500, y: 340 }]);
  });

  it('a smudge-sized level run follows its port', () => {
    expect(tidy([{ x: 300, y: 43 }, { x: 500, y: 43 }, { x: 500, y: 340 }])).toEqual([{ x: 500, y: 40 }, { x: 500, y: 340 }]);
  });

  it('a smudge jog at the stub end (under one corner radius) flattens', () => {
    expect(tidy([{ x: 224, y: 43 }, { x: 500, y: 43 }, { x: 500, y: 340 }])).toEqual([{ x: 500, y: 40 }, { x: 500, y: 340 }]);
    expect(tidy([{ x: 400, y: 40 }, { x: 400, y: 339 }, { x: 576, y: 339 }])).toEqual([{ x: 400, y: 40 }, { x: 400, y: 340 }]);
  });
});

describe('tidyStubEnds — what it leaves alone', () => {
  it('shapes aligned with their stub ends, a deliberate jog at a stub end included', () => {
    for (const wps of [
      [{ x: 300, y: 40 }, { x: 300, y: 340 }],
      [{ x: 224, y: 30 }, { x: 500, y: 30 }, { x: 500, y: 340 }],
      [{ x: 224, y: 40 - STUB_JOG_MIN }, { x: 500, y: 40 - STUB_JOG_MIN }, { x: 500, y: 340 }],
      [{ x: 300, y: 40 }, { x: 300, y: 200 }, { x: 576, y: 200 }],
    ]) {
      expect(tidy(wps)).toBe(wps);
    }
  });

  it('offsets of a stub or more: a bend of its own, or a side the zone rule changed', () => {
    for (const wps of [
      [{ x: 300, y: 40 - TIDY_MAX }, { x: 300, y: 340 }],
      [{ x: 300, y: 71 }, { x: 300, y: 340 }],
      [{ x: 224 - TIDY_MAX, y: 40 }, { x: 224 - TIDY_MAX, y: 340 }],
      [{ x: -80, y: 40 }, { x: -80, y: 340 }],
    ]) {
      expect(tidy(wps)).toEqual(wps);
    }
  });

  it('never collapses or reverses the run after the moved one', () => {
    const wps = [{ x: 300, y: 37 }, { x: 300, y: 39 }, { x: 450, y: 39 }, { x: 450, y: 340 }];
    expect(tidy(wps)).toEqual(wps);
  });

  it('never empties a saved shape', () => {
    expect(tidy([{ x: 216, y: 40 }])).toEqual([{ x: 216, y: 40 }]);
  });

  it('ignores vertical stubs (never drawn since 0.4.1)', () => {
    const wps = [{ x: 300, y: 37 }, { x: 300, y: 340 }];
    expect(tidyStubEnds(A_STUB, B_STUB, { x: 0, y: 1 }, L, wps)).toBe(wps);
  });
});

describe('tidyStubEnds — a deliberate step survives a single-table drag', () => {
  // Dragging one table leaves the saved corners in place, so the stub end lands either side of the step.
  const STEPS = [STUB_JOG_MIN, 12, 16, TIDY_MAX - 1, -STUB_JOG_MIN, -16];
  const DX = [-23, -16, -8, -1, 1, 4, 8, 12, 16, 23];

  it('at the source stub: the step keeps its level and its corner follows the stub end', () => {
    for (const s of STEPS) {
      const wps = [{ x: 224, y: 40 + s }, { x: 400, y: 40 + s }, { x: 400, y: 340 }];
      for (const dx of DX) {
        const r = routeAB({ a: { x: dx, y: 0 }, b: { x: 600, y: 300 } }, { waypoints: wps });
        expect(r.waypoints).toEqual([{ x: 224 + dx, y: 40 + s }, ...wps.slice(1)]);
        expect(stubArtifacts(r)).toEqual([]);
      }
    }
  });

  it('at the target stub, mirrored', () => {
    for (const s of STEPS) {
      const wps = [{ x: 400, y: 40 }, { x: 400, y: 340 + s }, { x: 576, y: 340 + s }];
      for (const dx of DX) {
        const r = routeAB({ a: { x: 0, y: 0 }, b: { x: 600 + dx, y: 300 } }, { waypoints: wps });
        expect(r.waypoints).toEqual([...wps.slice(0, 2), { x: 576 + dx, y: 340 + s }]);
        expect(stubArtifacts(r)).toEqual([]);
      }
    }
  });

  it('a drag of a stub or more draws the step as saved', () => {
    const wps = [{ x: 224, y: 56 }, { x: 400, y: 56 }, { x: 400, y: 340 }];
    for (const dx of [-TIDY_MAX, -40, TIDY_MAX, 40]) {
      expect(routeAB({ a: { x: dx, y: 0 }, b: { x: 600, y: 300 } }, { waypoints: wps }).waypoints).toEqual(wps);
    }
  });
});

describe('routeRefs draws the tidied corners (render, export and edits read them)', () => {
  const pos = { a: { x: 0, y: 0 }, b: { x: 600, y: 300 } };

  it('the drawn route of each measured kink has no stair, spur or hook next to its stubs', () => {
    const kinks: Waypoint[][] = [
      [{ x: 568, y: 40 }, { x: 568, y: 337 }],
      [{ x: 300, y: 37 }, { x: 300, y: 340 }],
      [{ x: 216, y: 40 }, { x: 216, y: 340 }],
      [{ x: 216, y: 37 }, { x: 216, y: 340 }],
      [{ x: 224, y: 43 }, { x: 500, y: 43 }, { x: 500, y: 340 }],
    ];
    for (const waypoints of kinks) {
      const r = routeAB(pos, { waypoints });
      expect(stubArtifacts(r)).toEqual([]);
      expect(r.waypoints).toEqual(tidy(waypoints));
      // Segment → waypoint indices follow the drawn corners, so inserting a bend lands where it is seen.
      const ends = r.segments.filter((s) => s.endWaypointIndex !== null).map((s) => s.endWaypointIndex);
      expect(ends).toEqual(r.waypoints.map((_, i) => i));
    }
  });
});

/** Deterministic PRNG (mulberry32) so a failing fuzz case is reproducible. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (rand: () => number, lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

/**
 * The two shapes the tidy also corrects in an aligned list, as magnets while sliding a run next to a
 * stub: a run doubling back over its stub, and a jog at a stub end under one corner radius.
 */
function inMagnetZone(r: EdgeRoute, wps: Waypoint[]): boolean {
  const zone = (stub: Waypoint, dir: number, w0: Waypoint, w1: Waypoint | undefined) => {
    const fwd = (w0.x - stub.x) * dir;
    const off = w0.y - stub.y;
    return (off === 0 && fwd < 0 && -fwd < TIDY_MAX) || (fwd === 0 && off !== 0 && Math.abs(off) < STUB_JOG_MIN && w1?.y === w0.y);
  };
  const dirA = Math.sign(r.sourceStub.x - r.source.x);
  const dirB = Math.sign(r.targetStub.x - r.target.x);
  return zone(r.sourceStub, dirA, wps[0]!, wps[1]) || zone(r.targetStub, dirB, wps[wps.length - 1]!, wps[wps.length - 2]);
}

/** Random edit sequences (slides and notches on random runs) on random two-table geometries. */
type Pair = { a: { x: number; y: number }; b: { x: number; y: number } };

function editedShapes(seed: number, count: number): Array<{ pos: Pair; wps: Waypoint[] }> {
  const rand = rng(seed);
  const out: Array<{ pos: Pair; wps: Waypoint[] }> = [];
  while (out.length < count) {
    const pos: Pair = { a: { x: 0, y: 0 }, b: { x: int(rand, -150, 700), y: int(rand, -500, 500) } };
    let route = routeAB(pos);
    for (let step = int(rand, 1, 4); step > 0; step--) {
      const editable = route.segments.map((s, i) => (s.rigid ? -1 : i)).filter((i) => i >= 0);
      if (editable.length === 0) break;
      const seg = editable[int(rand, 0, editable.length - 1)]!;
      const d = int(rand, -80, 80);
      const wps = rand() < 0.7 ? slideSegment(route, seg, d, d) : notchAtQuarter(route, seg, rand() < 0.5 ? 0.25 : 0.75, d, d);
      if (wps.length === 0) break;
      route = routeAB(pos, { waypoints: wps });
      out.push({ pos, wps });
    }
  }
  return out;
}

describe('tidyStubEnds — fixed points and stability (fuzz)', () => {
  it('every shape the edits write is drawn exactly as saved (outside the two magnet zones)', () => {
    let checked = 0;
    let magnet = 0;
    for (const { pos, wps } of editedShapes(7, 1500)) {
      const r = routeAB(pos, { waypoints: wps });
      if (inMagnetZone(r, wps)) {
        magnet++;
        continue;
      }
      checked++;
      expect(r.waypoints).toEqual(wps);
    }
    expect(checked).toBeGreaterThan(1200);
    expect(magnet).toBeGreaterThan(0);
  });

  it('after a drift (table moved, row changed) the tidied shape is stable, close to the saved one, and no busier', () => {
    const rand = rng(11);
    let tidied = 0;
    for (const { pos, wps } of editedShapes(13, 800)) {
      const moved = rand() < 0.5 ? 'a' : 'b';
      const drifted = { ...pos, [moved]: { x: pos[moved].x + int(rand, -30, 30), y: pos[moved].y + int(rand, -30, 30) } };
      const row = 40 + int(rand, -5, 5);
      const r = routeAB(drifted, { waypoints: wps }, row);
      if (r.waypoints.length !== wps.length || r.waypoints.some((w, i) => w.x !== wps[i]!.x || w.y !== wps[i]!.y)) tidied++;
      // Saving what is drawn draws it again (the edit path persists exactly this).
      const again = routeAB(drifted, { waypoints: r.waypoints }, row);
      expect(again.waypoints).toEqual(r.waypoints);
      expect(again.d).toBe(r.d);
      expect(r.waypoints.length).toBeGreaterThan(0);
      expect(r.waypoints.length).toBeLessThanOrEqual(wps.length);
      for (const w of r.waypoints) {
        expect(wps.some((s) => Math.abs(s.x - w.x) < TIDY_MAX && Math.abs(s.y - w.y) < TIDY_MAX)).toBe(true);
      }
      expect(r.segments.length).toBeLessThanOrEqual(untidiedSegmentCount(r, wps));
    }
    expect(tidied).toBeGreaterThan(100);
  });

  it('a step of STUB_JOG_MIN or more at a stub end keeps its level when one table moves under a stub in x', () => {
    const rand = rng(17);
    let steps = 0;
    for (const { pos, wps } of editedShapes(19, 1500)) {
      const r0 = routeAB(pos, { waypoints: wps });
      for (const [end, table] of [['source', 'a'], ['target', 'b']] as const) {
        const list = end === 'source' ? wps : wps.slice().reverse();
        const stub = end === 'source' ? r0.sourceStub : r0.targetStub;
        const [lead, next] = list;
        if (!lead || !next || lead.x !== stub.x || next.y !== lead.y || Math.abs(lead.y - stub.y) < STUB_JOG_MIN) continue;
        const dx = int(rand, 1 - TIDY_MAX, TIDY_MAX - 1);
        const r = routeAB({ ...pos, [table]: { x: pos[table].x + dx, y: pos[table].y } }, { waypoints: wps });
        steps++;
        // The other end may still flatten a smudge-sized jog of that same run (rule 3), never more.
        expect(r.waypoints.some((w) => Math.abs(w.y - lead.y) < STUB_JOG_MIN)).toBe(true);
      }
    }
    expect(steps).toBeGreaterThan(100);
  });
});

/** Segments `cornersThrough` would draw from the saved corners as is: what the tidy may only reduce. */
function untidiedSegmentCount(r: EdgeRoute, wps: Waypoint[]): number {
  const pts: Waypoint[] = [r.source, r.sourceStub];
  let cur = r.sourceStub;
  for (const p of [...wps, r.targetStub]) {
    if (p.x !== cur.x && p.y !== cur.y) pts.push({ x: p.x, y: cur.y });
    pts.push(p);
    cur = p;
  }
  pts.push(r.target);
  return pts.filter((p, i) => i === 0 || p.x !== pts[i - 1]!.x || p.y !== pts[i - 1]!.y).length - 1;
}

describe('EdgeRouteCache.routeMoved with tidied shapes', () => {
  it('equals a full rebuild through drags that move ends in and out of the tidy range', () => {
    const refs = [ref('a-b', 'a', 'b'), ref('c-b', 'c', 'b'), ref('a-d', 'a', 'd')];
    const layouts: Record<string, EdgeLayout> = {
      'a-b': { waypoints: [{ x: 300, y: 37 }, { x: 300, y: 340 }] },
      'c-b': { waypoints: [{ x: 216, y: 637 }, { x: 216, y: 360 }, { x: 560, y: 360 }] },
      'a-d': { waypoints: [{ x: 232, y: -21 }, { x: 900, y: -21 }, { x: 900, y: 43 }] },
    };
    const layoutOf = (id: string) => layouts[id];
    const rowY = () => 40;
    let pos: Record<string, { x: number; y: number }> = { a: { x: 0, y: 0 }, b: { x: 600, y: 300 }, c: { x: 0, y: 600 }, d: { x: 1100, y: 0 } };
    const cache = new EdgeRouteCache();
    cache.routeAll(refs, boxes(pos), rowY, layoutOf);
    const rand = rng(5);
    for (let i = 0; i < 200; i++) {
      const name = ['a', 'b', 'c', 'd'][int(rand, 0, 3)]!;
      pos = { ...pos, [name]: { x: pos[name]!.x + int(rand, -12, 12), y: pos[name]!.y + int(rand, -12, 12) } };
      const moved = cache.routeMoved([name], boxes(pos), rowY, layoutOf);
      expect(moved).toEqual(routeRefs(refs, boxes(pos), rowY, layoutOf));
    }
  });
});
