import { describe, expect, it } from 'vitest';
import { insertDepWaypoint, routeDep } from './depRouter';
import type { Bbox } from './spatialIndex';

const bbox = (x: number, y: number, w = 200, h = 100): Bbox => ({ x, y, w, h });
const src = { bbox: bbox(0, 0), portY: 14 };
const tgt = { bbox: bbox(400, 200), portY: 214 };

/** Parses "M x y L x y C x y x y x y … L x y" into its command groups. */
function commands(d: string): Array<{ op: string; pts: Array<{ x: number; y: number }> }> {
  const out: Array<{ op: string; pts: Array<{ x: number; y: number }> }> = [];
  for (const m of d.matchAll(/([MLC])([^MLC]*)/g)) {
    const nums = m[2]!.trim().split(/\s+/).map(Number);
    const pts = [];
    for (let i = 0; i < nums.length; i += 2) pts.push({ x: nums[i]!, y: nums[i + 1]! });
    out.push({ op: m[1]!, pts });
  }
  return out;
}

describe('routeDep', () => {
  it('leaves and enters through horizontal 24px stubs on facing sides', () => {
    const r = routeDep('dep:a', src, tgt, []);
    expect(r.source).toEqual({ x: 200, y: 14 });
    expect(r.target).toEqual({ x: 400, y: 214 });
    expect(r.sourceStub).toEqual({ x: 224, y: 14 });
    expect(r.targetStub).toEqual({ x: 376, y: 214 });
    const cmds = commands(r.d);
    expect(cmds[0]).toEqual({ op: 'M', pts: [r.source] });
    expect(cmds[1]).toEqual({ op: 'L', pts: [r.sourceStub] });
    expect(cmds[cmds.length - 1]).toEqual({ op: 'L', pts: [r.target] });
  });

  it('mirrors sides when the downstream table sits to the left', () => {
    const r = routeDep('dep:a', { bbox: bbox(400, 0), portY: 14 }, { bbox: bbox(0, 200), portY: 214 }, []);
    expect(r.source.x).toBe(400);
    expect(r.sourceStub.x).toBe(376);
    expect(r.target.x).toBe(200);
    expect(r.targetStub.x).toBe(224);
  });

  it('passes through every waypoint as a curve span end, in order', () => {
    const wps = [{ x: 300, y: 60 }, { x: 320, y: 180 }];
    const r = routeDep('dep:a', src, tgt, wps);
    const curveEnds = commands(r.d).filter((c) => c.op === 'C').map((c) => c.pts[2]);
    expect(curveEnds).toEqual([...wps, r.targetStub]);
  });

  it('is tangent to the stubs (no kink where the curve leaves or enters a table)', () => {
    for (const wps of [[], [{ x: 300, y: 60 }]]) {
      const r = routeDep('dep:a', src, tgt, wps);
      const curves = commands(r.d).filter((c) => c.op === 'C');
      const firstCtrl = curves[0]!.pts[0]!;
      const lastCtrl = curves[curves.length - 1]!.pts[1]!;
      expect(firstCtrl.y).toBe(r.sourceStub.y);
      expect(firstCtrl.x).toBeGreaterThan(r.sourceStub.x);
      expect(lastCtrl.y).toBe(r.targetStub.y);
      expect(lastCtrl.x).toBeLessThan(r.targetStub.x);
    }
  });

  it('exposes one insert handle per span, indexed by the waypoint slot it creates', () => {
    const r = routeDep('dep:a', src, tgt, [{ x: 300, y: 60 }]);
    expect(r.inserts.map((h) => h.index)).toEqual([0, 1]);
    // The first span runs from the source stub to the waypoint, so its midpoint lies between them.
    expect(r.inserts[0]!.x).toBeGreaterThan(r.sourceStub.x);
    expect(r.inserts[0]!.x).toBeLessThan(300);
  });

  it('clamps stubs to half the port gap so close tables never get crossing stubs', () => {
    const r = routeDep('dep:a', src, { bbox: bbox(220, 200), portY: 214 }, []);
    expect(r.sourceStub.x).toBe(210);
    expect(r.targetStub.x).toBe(210);
  });
});

describe('insertDepWaypoint', () => {
  it('inserts at the handle index with integer coords for the sidecar', () => {
    const out = insertDepWaypoint([{ x: 1, y: 1 }, { x: 9, y: 9 }], 1, { x: 4.6, y: 5.2 });
    expect(out).toEqual([{ x: 1, y: 1 }, { x: 5, y: 5 }, { x: 9, y: 9 }]);
  });
});
