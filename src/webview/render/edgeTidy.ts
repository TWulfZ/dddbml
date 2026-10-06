import type { Waypoint } from '../../shared/types';
import { EDGE_CORNER_RADIUS, EDGE_STUB } from '../layout/edgeSides';

type Point = { x: number; y: number };
/** A corner being tidied, with where it was saved: no snap may take it `TIDY_MAX` or more from there. */
type Corner = Point & { readonly ox: number; readonly oy: number };

/**
 * Largest distance a saved corner is moved to meet its stub (spec 05 §11): one rigid stub, the length
 * the user can never edit inside. The drifts seen in real pre-0.4 files are 3 px (port row), 8 px (stub
 * length) and one row ± 3 px; the next offset there is 31 px, a bend of its own.
 */
export const TIDY_MAX = EDGE_STUB;

/**
 * Shortest jog right at a stub end that is drawn as a step: below one corner radius neither fillet of
 * the step can form (each clamps to half the jog), so it reads as a smudge beside the table. The ones
 * seen in real files are 1 and 3 px port-row drift.
 */
export const STUB_JOG_MIN = EDGE_CORNER_RADIUS;

/**
 * The saved corners an FK route is drawn through, with the small artifacts next to its rigid stubs
 * normalized (spec 05 §11 "Tidy de extremos"). Saved corners are absolute, so a port row, a stub length
 * or a table that moved since they were saved leaves the first (or last) corner just off its stub end,
 * and `cornersThrough` bridges it with an elbow or a run back over the stub: a few-px stair, spur or
 * hook beside the table. Each end, in order:
 *
 * 1. Elbow: the corner is off the stub axis and off the stub end's column. A step (level run after it,
 *    `|off| >= STUB_JOG_MIN`) keeps its level: the corner moves onto that column from either side
 *    (`|fwd| < TIDY_MAX`), or stays. Otherwise its run moves onto the stub axis (`|off| < TIDY_MAX`), so
 *    a trunk just gets longer and a smudge-sized level run follows its port; behind the stub end with
 *    the axis out of reach, the column (2 then follows).
 * 2. Hook: the corner is on the stub axis behind the stub end; its column moves onto the stub end
 *    (`TIDY_MAX`).
 * 3. Smudge: the corner sits on the stub end's column with a level run after it, a jog under
 *    `STUB_JOG_MIN` off the axis; the level run moves onto the axis.
 *
 * A corner left on its stub end, or on the axis in front of it with the run going on, is dropped. No
 * corner ends `TIDY_MAX` or more from where it was saved (summed over both ends), a snap never
 * collapses or reverses the run after the moved one, and the list never empties, so the turns keep
 * their order. The result is a fixed point: saving what is drawn draws it again. A corner already
 * aligned with its stub end (what the router and the edits write) is left alone except by 2 and 3,
 * which act as magnets while sliding a run next to a stub.
 * Horizontal stubs only: top/bottom ports are never drawn (spec 05 §11).
 */
export function tidyStubEnds(aStub: Point, bStub: Point, dirA: Point, dirB: Point, waypoints: Waypoint[]): Waypoint[] {
  if (waypoints.length === 0 || dirA.y !== 0 || dirB.y !== 0) return waypoints;
  const tidied = settle(aStub, bStub, dirA.x, dirB.x, waypoints);
  // The cap can stop a corner short of a zone (both ends moving it): then the result would tidy again
  // once saved, and an edit would make the line jump. Such a shape is drawn as saved instead.
  if (!tidied || settle(aStub, bStub, dirA.x, dirB.x, tidied)) return waypoints;
  return tidied;
}

/** Both ends tidied until neither changes (one end's snap can reach the other's corners), or null. */
function settle(aStub: Point, bStub: Point, dirA: number, dirB: number, waypoints: readonly Waypoint[]): Waypoint[] | null {
  let out: Corner[] = waypoints.map((w) => ({ x: w.x, y: w.y, ox: w.x, oy: w.y }));
  let changed = false;
  for (let pass = 0; pass <= waypoints.length; pass++) {
    const head = tidyEnd(aStub, dirA, out);
    const tail = tidyEnd(bStub, dirB, (head ?? out).slice().reverse());
    if (!head && !tail) break;
    out = tail?.reverse() ?? head ?? out;
    changed = true;
  }
  return changed ? out.map((c) => ({ x: c.x, y: c.y })) : null;
}

/** The corners with the end at `pts[0]` tidied, or null when nothing changed. */
function tidyEnd(stub: Point, dir: number, pts: readonly Corner[]): Corner[] | null {
  const out = pts.map((p) => ({ ...p }));
  let changed = false;
  // Dropping a corner makes the next one the lead, which may sit in a zone of its own.
  for (let guard = 0; guard < pts.length && tidyLead(stub, dir, out); guard++) changed = true;
  // A lone corner on the stub end would leave a saved shape with no corner of its own: keep the original.
  if (!changed || (out.length === 1 && out[0]!.x === stub.x && out[0]!.y === stub.y)) return null;
  return out;
}

/** Applies rules 1–3 to `pts[0]` in place, then drops the leads they made redundant; whether anything changed. */
function tidyLead(stub: Point, dir: number, pts: Corner[]): boolean {
  let moved = false;
  const snap = (axis: 'x' | 'y', value: number): boolean => {
    const run = snappableRun(pts, axis, value);
    for (let i = 0; i < run; i++) pts[i]![axis] = value;
    if (run > 0) moved = true;
    return run > 0;
  };
  const off = pts[0]!.y - stub.y;
  const fwd = (pts[0]!.x - stub.x) * dir;
  const levelNext = pts[1] !== undefined && pts[1].y === pts[0]!.y;
  if (off !== 0 && fwd !== 0) {
    // A single-table drag leaves the saved corners where they were, so the stub end can land on either
    // side of a user's step: flattening it onto the port row would lose a bend no legacy drift makes.
    if (levelNext && Math.abs(off) >= STUB_JOG_MIN) {
      if (Math.abs(fwd) < TIDY_MAX) snap('x', stub.x);
    } else if (!(Math.abs(off) < TIDY_MAX && snap('y', stub.y)) && fwd < 0 && -fwd < TIDY_MAX) {
      snap('x', stub.x);
    }
  }
  const behind = (pts[0]!.x - stub.x) * dir;
  if (pts[0]!.y === stub.y && behind < 0 && -behind < TIDY_MAX) snap('x', stub.x);
  const jog = pts[0]!.y - stub.y;
  if (pts[0]!.x === stub.x && jog !== 0 && Math.abs(jog) < STUB_JOG_MIN && pts[1]?.y === pts[0]!.y) snap('y', stub.y);
  if (!moved) return false;
  while (pts.length > 1 && isRedundantLead(stub, dir, pts[0]!, pts[1]!)) pts.shift();
  return true;
}

/** A leading corner on the stub end itself, or on its axis in front of it with the next run going straight on. */
function isRedundantLead(stub: Point, dir: number, p: Point, next: Point): boolean {
  if (p.x === stub.x && p.y === stub.y) return true;
  return p.y === stub.y && next.y === stub.y && (p.x - stub.x) * dir > 0 && (next.x - p.x) * dir > 0;
}

/**
 * Length of the run through `pts[0]` along `axis` (corners sharing its `axis` coordinate) when moving
 * it to `value` keeps every corner under `TIDY_MAX` from where it was saved and the leg after it going
 * the same way, else 0. A run reaching the last corner has no leg after it in the list: the far end's
 * own tidy and `cornersThrough` connect it.
 */
function snappableRun(pts: readonly Corner[], axis: 'x' | 'y', value: number): number {
  const level = pts[0]![axis];
  let k = 1;
  while (k < pts.length && pts[k]![axis] === level) k++;
  const saved = axis === 'x' ? 'ox' : 'oy';
  // Both ends may move one corner: the cap is on the total, not on each snap.
  for (let i = 0; i < k; i++) if (Math.abs(value - pts[i]![saved]) >= TIDY_MAX) return 0;
  const next = pts[k];
  if (!next) return k;
  return Math.sign(next[axis] - value) === Math.sign(next[axis] - level) && next[axis] !== value ? k : 0;
}
