import { describe, expect, it } from 'vitest';
import { routeRefs, slideSegment, notchAtQuarter, isDipRun, deleteNotch, type EdgeRoute } from './edgeRouter';
import type { EdgeLayout, Ref, Waypoint } from '../../shared/types';
import type { Bbox } from './spatialIndex';

const mkRef = (overrides?: Partial<Ref>): Ref => ({
  id: 'a::col|b::col',
  source: { table: 'public.a', columns: ['col'], relation: '*' },
  target: { table: 'public.b', columns: ['col'], relation: '1' },
  ...overrides,
});

const bbox = (x: number, y: number, w = 200, h = 100): Bbox => ({ x, y, w, h });

// Offset tables → default route is H-V-H: top arm (h), trunk (v), bottom arm (h).
// Source port right = (200,50); target port left = (400,250). Stub ends (224,50)/(376,250).
// Editable segments: [1]=top arm (224,50)→(300,50), [2]=trunk (300,50)→(300,250), [3]=bottom arm.
const offsetBboxOf = (n: string): Bbox | undefined => {
  if (n === 'public.a') return bbox(0, 0);
  if (n === 'public.b') return bbox(400, 200);
  return undefined;
};

const routeWith = (layout?: EdgeLayout): EdgeRoute =>
  routeRefs([mkRef()], offsetBboxOf, undefined, layout ? () => layout : undefined)[0]!;

const allOrthogonal = (r: EdgeRoute): boolean =>
  r.segments.every((s) => s.x1 === s.x2 || s.y1 === s.y2);

const firstEditable = (r: EdgeRoute, axis: 'h' | 'v') =>
  r.segments.findIndex((s) => s.axis === axis && !s.rigid);

describe('slideSegment — move a whole run perpendicular (real centre handle)', () => {
  it('slides the vertical trunk sideways: both its corners move, nothing is added', () => {
    const r = routeWith();
    const trunk = firstEditable(r, 'v'); // (300,50) → (300,250)
    expect(slideSegment(r, trunk, -40, 0)).toEqual([{ x: 260, y: 50 }, { x: 260, y: 250 }]);
  });

  it('a vertical run reacts to dx only (1-DOF); dy is ignored', () => {
    const r = routeWith();
    const trunk = firstEditable(r, 'v');
    expect(slideSegment(r, trunk, -40, 99)).toEqual(slideSegment(r, trunk, -40, 0));
  });

  it('sliding an arm (colinear with its rigid stub) inserts a jog so the stub anchor never moves', () => {
    const r = routeWith();
    const top = firstEditable(r, 'h'); // aStub(224,50) → (300,50)
    // Drag the top arm UP by 30 → the stub stays at y=50, a vertical jog drops to the slid arm.
    expect(slideSegment(r, top, 0, -30)).toEqual([{ x: 224, y: 20 }, { x: 300, y: 20 }, { x: 300, y: 250 }]);
  });

  it('a horizontal run reacts to dy only (1-DOF); dx is ignored', () => {
    const r = routeWith();
    const top = firstEditable(r, 'h');
    expect(slideSegment(r, top, 99, -30)).toEqual(slideSegment(r, top, 0, -30));
  });

  it('sliding a rigid stub is a no-op', () => {
    const r = routeWith();
    expect(slideSegment(r, 0, 0, 40)).toEqual([]); // no waypoints created
  });

  it('is idempotent from the original route + cumulative delta', () => {
    const r = routeWith();
    const trunk = firstEditable(r, 'v');
    expect(slideSegment(r, trunk, -40, 0)).toEqual(slideSegment(r, trunk, -40, 0));
  });

  it('no net perpendicular movement keeps the stored waypoints (an auto route stays auto)', () => {
    const trunk = firstEditable(routeWith(), 'v');
    expect(slideSegment(routeWith(), trunk, 0, 50)).toEqual([]);
    const explicit = routeWith({ waypoints: [{ x: 300, y: 150 }] });
    expect(slideSegment(explicit, firstEditable(explicit, 'v'), 0, 50)).toEqual([{ x: 300, y: 150 }]);
  });
});

describe('notchAtQuarter — carve a local symmetric notch (ghost handle)', () => {
  it('dragging the ¼ ghost of a horizontal run down carves a notch in its left portion (ends stay)', () => {
    const r = routeWith();
    const top = firstEditable(r, 'h'); // aStub(224,50) → (300,50)
    const w = notchAtQuarter(r, top, 0.25, 0, 40); // drag DOWN by 40
    // Pins at ¼∓⅛ of [224,300] → x≈234 / 253, at y=50; dipped bottom at y=90.
    expect(w.filter((p) => p.y === 90)).toHaveLength(2); // exactly one dipped run
    expect(w.some((p) => p.x === 234 && p.y === 50)).toBe(true); // pin (end stays at original level)
    expect(w.some((p) => p.x === 253 && p.y === 50)).toBe(true); // pin
    expect(w.some((p) => p.x === 300 && p.y === 50)).toBe(true); // run end unchanged
    expect(w.every((p) => p.x <= 300)).toBe(true); // notch is local (left), tail stays flat
    expect(allOrthogonal(routeWith({ waypoints: w }))).toBe(true);
  });

  it('the ¾ ghost carves the notch in the right portion instead', () => {
    const r = routeWith();
    const top = firstEditable(r, 'h');
    const q1 = notchAtQuarter(r, top, 0.25, 0, 40);
    const q3 = notchAtQuarter(r, top, 0.75, 0, 40);
    const dipXs = (w: { x: number; y: number }[]) => w.filter((p) => p.y === 90).map((p) => p.x).sort((a, b) => a - b);
    // ¾ notch sits to the right of the ¼ notch.
    expect(dipXs(q3)[0]!).toBeGreaterThan(dipXs(q1)[0]!);
  });

  it('dragging the ¼ ghost of the vertical trunk left carves a sideways notch (1-DOF, dx only)', () => {
    const r = routeWith();
    const trunk = firstEditable(r, 'v'); // (300,50) → (300,250)
    const w = notchAtQuarter(r, trunk, 0.25, -40, 0); // drag LEFT by 40 → x 300→260
    expect(w.filter((p) => p.x === 260)).toHaveLength(2); // dipped run at x=260
    expect(w.some((p) => p.x === 300)).toBe(true); // pins stay at x=300
    expect(notchAtQuarter(r, trunk, 0.25, -40, 99)).toEqual(w); // dy ignored for a vertical run
    expect(allOrthogonal(routeWith({ waypoints: w }))).toBe(true);
  });

  it('a zero-depth drag adds no notch (route shape unchanged)', () => {
    const r = routeWith();
    const top = firstEditable(r, 'h');
    const w = notchAtQuarter(r, top, 0.25, 0, 0);
    expect(w.some((p) => p.y === 90)).toBe(false);
    expect(routeWith({ waypoints: w }).d).toBe(r.d); // renders identically to the default
  });

  it('is idempotent from the original route + cumulative delta', () => {
    const r = routeWith();
    const top = firstEditable(r, 'h');
    expect(notchAtQuarter(r, top, 0.25, 0, 40)).toEqual(notchAtQuarter(r, top, 0.25, 0, 40));
  });
});

describe('notch deepen / delete', () => {
  // Build a route that already has a notch on the top arm (dip at y=90).
  const notched = (): EdgeRoute => {
    const r0 = routeWith();
    const top = firstEditable(r0, 'h');
    return routeWith({ waypoints: notchAtQuarter(r0, top, 0.25, 0, 40) });
  };
  const dipIndex = (r: EdgeRoute) =>
    r.segments.findIndex((s, i) => s.axis === 'h' && !s.rigid && isDipRun(r, i));

  it('isDipRun is true for the notch bottom, false for a flat run / the trunk', () => {
    const r = notched();
    expect(dipIndex(r)).toBeGreaterThanOrEqual(0);
    expect(isDipRun(r, firstEditable(r, 'v'))).toBe(false);
  });

  it('sliding the dip-run deeper moves only the dipped corners (pins stay)', () => {
    const r = notched();
    const w = slideSegment(r, dipIndex(r), 0, 30); // 90 → 120
    expect(w.filter((p) => p.y === 120)).toHaveLength(2); // deepened
    expect(w.some((p) => p.x === 234 && p.y === 50)).toBe(true); // pin unchanged
    expect(w.some((p) => p.y === 90)).toBe(false); // old depth gone
  });

  it('sliding the dip-run back to the pin level flattens the whole notch away (smart-delete)', () => {
    const r = notched();
    const w = slideSegment(r, dipIndex(r), 0, -40); // 90 → 50 (pin level)
    expect(w.some((p) => p.y === 90)).toBe(false);
    expect(w).toEqual([{ x: 300, y: 50 }, { x: 300, y: 250 }]); // only the trunk corners remain
  });

  it('deleteNotch removes the 4 notch corners', () => {
    const r = notched();
    expect(deleteNotch(r, dipIndex(r))).toEqual([{ x: 300, y: 50 }, { x: 300, y: 250 }]);
  });

  it('dragging the dip-run WITHIN the merge tolerance of the pin level dissolves the notch', () => {
    const r = notched(); // dip at y=90, pins at y=50 → 40 deep
    // Drag up by 32 → y=58, only 8 from the pin level (≤ NOTCH_MERGE_SNAP=10) → snaps flat, dissolves.
    const w = slideSegment(r, dipIndex(r), 0, -32);
    expect(w).toEqual([{ x: 300, y: 50 }, { x: 300, y: 250 }]);
  });

  it('dragging the dip-run just OUTSIDE the tolerance keeps the notch (moves, no dissolve)', () => {
    const r = notched();
    // Drag up by 28 → y=62, 12 from the pin level (> 10) → no snap; the notch stays, just shallower.
    const w = slideSegment(r, dipIndex(r), 0, -28);
    expect(w.filter((p) => p.y === 62)).toHaveLength(2); // dip moved to y=62
    expect(w.some((p) => p.y === 50)).toBe(true); // pins still there → notch intact
    expect(w.length).toBeGreaterThan(2);
  });
});

describe('editing the aligned-row and narrow-gap shapes (spec 05 §2)', () => {
  const pair = (bx: number, by: number) => (n: string): Bbox | undefined =>
    n === 'public.a' ? bbox(0, 0) : n === 'public.b' ? bbox(bx, by) : undefined;
  const routeAt = (bx: number, by: number, layout?: EdgeLayout): EdgeRoute =>
    routeRefs([mkRef()], pair(bx, by), undefined, layout ? () => layout : undefined)[0]!;
  const editableRuns = (r: EdgeRoute) => r.segments.flatMap((s, i) => (s.rigid ? [] : [i]));

  // Same row, gap 100: ports (200,50)/(300,50), stubs end at 224/276, division at x=250.
  it('aligned row: sliding either half of the divided middle bends the line, ports and stubs stay', () => {
    const r = routeAt(300, 0);
    const [first, second] = editableRuns(r);
    expect(slideSegment(r, first!, 0, -30)).toEqual([{ x: 224, y: 20 }, { x: 250, y: 20 }, { x: 250, y: 50 }]);
    expect(slideSegment(r, second!, 0, 30)).toEqual([{ x: 250, y: 50 }, { x: 250, y: 80 }, { x: 276, y: 80 }]);
    for (const idx of [first!, second!]) {
      const edited = routeAt(300, 0, { waypoints: slideSegment(r, idx, 0, -30) });
      expect(edited.source).toEqual(r.source);
      expect(edited.target).toEqual(r.target);
      expect(edited.sourceStub).toEqual(r.sourceStub);
      expect(edited.targetStub).toEqual(r.targetStub);
      expect(allOrthogonal(edited)).toBe(true);
    }
  });

  it('aligned row: a ghost notch on a half stays local to that half', () => {
    const r = routeAt(300, 0);
    const [first] = editableRuns(r);
    const w = notchAtQuarter(r, first!, 0.5, 0, 20);
    expect(w.filter((p) => p.y === 70)).toHaveLength(2);
    expect(w.every((p) => p.x >= 224 && p.x <= 250)).toBe(true);
    expect(allOrthogonal(routeAt(300, 0, { waypoints: w }))).toBe(true);
  });

  it('aligned row, tight gap: the halves are still separate runs that slide', () => {
    const r = routeAt(240, 0); // gap 40 → stubs 10, division at x=220
    const runs = editableRuns(r);
    expect(runs).toHaveLength(2);
    expect(slideSegment(r, runs[0]!, 0, 20)).toEqual([{ x: 210, y: 70 }, { x: 220, y: 70 }, { x: 220, y: 50 }]);
  });

  it('narrow-gap Z with nearly aligned rows: the midpoint trunk slides sideways, stubs never move', () => {
    const r = routeAt(210, 10); // gap 10, rows 50/60 → stubs 2, trunk x=205
    const trunk = firstEditable(r, 'v');
    expect(r.segments[trunk]!.x1).toBe(205);
    const w = slideSegment(r, trunk, 2, 0);
    expect(w).toEqual([{ x: 207, y: 50 }, { x: 207, y: 60 }]);
    const edited = routeAt(210, 10, { waypoints: w });
    expect(edited.sourceStub).toEqual(r.sourceStub);
    expect(edited.targetStub).toEqual(r.targetStub);
    expect(allOrthogonal(edited)).toBe(true);
  });

  // Gap 10, rows 50/250: full stubs end at (224,50)/(186,250), the jog runs at y=150.
  describe('narrow-gap S: each of its three middle runs is editable', () => {
    const S = () => routeAt(210, 200);
    const keepsEnds = (w: Waypoint[]) => {
      const edited = routeAt(210, 200, { waypoints: w });
      const r = S();
      expect(edited.source).toEqual(r.source);
      expect(edited.target).toEqual(r.target);
      expect(edited.sourceStub).toEqual(r.sourceStub);
      expect(edited.targetStub).toEqual(r.targetStub);
      expect(allOrthogonal(edited)).toBe(true);
      expect(edited.waypoints).toEqual(w);
      return edited;
    };

    it('has the three runs between the full stubs', () => {
      expect(editableRuns(S())).toEqual([1, 2, 3]);
    });

    it('sliding the first vertical run moves it sideways with a jog off the source stub', () => {
      const w = slideSegment(S(), 1, 20, 0);
      expect(w).toEqual([{ x: 244, y: 50 }, { x: 244, y: 150 }, { x: 186, y: 150 }]);
      keepsEnds(w);
    });

    it('sliding the jog moves it up or down, both its corners follow', () => {
      const w = slideSegment(S(), 2, 0, -40);
      expect(w).toEqual([{ x: 224, y: 110 }, { x: 186, y: 110 }]);
      keepsEnds(w);
    });

    it('sliding the last vertical run moves it sideways with a jog into the target stub', () => {
      const w = slideSegment(S(), 3, -30, 0);
      expect(w).toEqual([{ x: 224, y: 150 }, { x: 156, y: 150 }, { x: 156, y: 250 }]);
      keepsEnds(w);
    });

    it('a ghost notch on each run stays local and keeps the literal corners', () => {
      for (const idx of [1, 2, 3]) {
        const vertical = S().segments[idx]!.axis === 'v';
        const w = notchAtQuarter(S(), idx, 0.25, vertical ? 15 : 0, vertical ? 0 : 15);
        expect(w).toHaveLength(6);
        keepsEnds(w);
      }
    });
  });
});
