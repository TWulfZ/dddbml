import { describe, expect, it } from 'vitest';
import type { Bbox } from '../../render/spatialIndex';
import { buildRouteGrid, RouteGrid, WorldUsage } from './grid';
import { ASTAR_CELL, CLEARANCE } from './constants';

const bbox = (x: number, y: number, w: number, h: number): Bbox => ({ x, y, w, h });

/** Serialize the full blocked mask so two grids can be compared cell-for-cell. */
function maskOf(grid: RouteGrid): string {
  const rows: string[] = [];
  for (let cy = 0; cy < grid.rows; cy++) {
    let row = '';
    for (let cx = 0; cx < grid.cols; cx++) row += grid.isBlocked(cx, cy) ? '1' : '0';
    rows.push(row);
  }
  return rows.join('\n');
}

describe('buildRouteGrid — origin snap + bounds', () => {
  it('snaps origin DOWN to a multiple of the cell size (translation-invariant cells)', () => {
    const g = buildRouteGrid(bbox(100, 50, 240, 240), [], 1_000_000)!;
    expect(g.originX % ASTAR_CELL).toBe(0);
    expect(g.originY % ASTAR_CELL).toBe(0);
    expect(g.originX).toBeLessThanOrEqual(100);
    expect(g.originY).toBeLessThanOrEqual(50);
  });

  it('emits integer cell-centre world coordinates (cell is even)', () => {
    const g = buildRouteGrid(bbox(0, 0, 240, 240), [], 1_000_000)!;
    const w = g.toWorld(3, 5);
    expect(Number.isInteger(w.x)).toBe(true);
    expect(Number.isInteger(w.y)).toBe(true);
  });

  it('returns null when the window would exceed the cell ceiling (caller falls back)', () => {
    expect(buildRouteGrid(bbox(0, 0, 100_000, 100_000), [], 4_000_000)).toBeNull();
  });

  it('round-trips a world point through toCell→toWorld back into the same cell', () => {
    const g = buildRouteGrid(bbox(0, 0, 480, 480), [], 1_000_000)!;
    const c = g.toCell(247, 121);
    const w = g.toWorld(c.cx, c.cy);
    expect(g.toCell(w.x, w.y)).toEqual(c);
  });
});

describe('rasterization is commutative (determinism anchor)', () => {
  it('produces an identical blocked mask regardless of obstacle order', () => {
    const obstacles = [
      bbox(48, 48, 96, 96),
      bbox(240, 120, 72, 144),
      bbox(120, 300, 200, 60),
    ];
    const win = bbox(0, 0, 480, 480);
    const a = buildRouteGrid(win, obstacles, 1_000_000)!;
    const b = buildRouteGrid(win, [...obstacles].reverse(), 1_000_000)!;
    expect(maskOf(a)).toBe(maskOf(b));
    // Sanity: SOME cells are blocked (the test would be vacuous otherwise).
    expect(maskOf(a)).toContain('1');
  });

  it('inflates obstacles by CLEARANCE (a cell whose centre sits in the inflation band is blocked)', () => {
    // Raw rect [192,288]²; inflated by CLEARANCE=16 → [176,304]². Origin 0, cell 24.
    const g = buildRouteGrid(bbox(0, 0, 480, 480), [bbox(192, 192, 96, 96)], 1_000_000)!;
    // Cell 7 spans [168,192); its centre x=180 is < 192 (outside the RAW rect) but ≥ 176 (inside
    // the inflated band), so it is blocked ONLY because of CLEARANCE.
    const c = g.toCell(180, 240);
    expect(c.cx).toBe(7);
    expect(g.isBlocked(c.cx, c.cy)).toBe(true);
    expect(180).toBeLessThan(192); // documents: this cell centre is outside the raw obstacle
  });
});

describe('carveEndpoint — start/goal never walled in', () => {
  it('clears the stub cell and the outward corridor cell even if an obstacle painted them', () => {
    // An obstacle covering the whole window blocks everything…
    const g = buildRouteGrid(bbox(0, 0, 240, 240), [bbox(-50, -50, 340, 340)], 1_000_000)!;
    const port = { x: 120, y: 120 };
    const c = g.toCell(port.x, port.y);
    expect(g.isBlocked(c.cx, c.cy)).toBe(true); // blocked before carve
    g.carveEndpoint(port.x, port.y, 'right');
    expect(g.isBlocked(c.cx, c.cy)).toBe(false); // stub cell now walkable
    expect(g.isBlocked(c.cx + 1, c.cy)).toBe(false); // outward (right) corridor walkable
  });
});

describe('WorldUsage — window-independent crossing key', () => {
  it('two points in the same world cell collide regardless of which grid produced them', () => {
    const u = new WorldUsage(ASTAR_CELL);
    // Use a cell-aligned base so the bucket math is unambiguous: cell spans [96, 96+ASTAR_CELL).
    const base = 4 * ASTAR_CELL; // 96
    u.add([{ x: base, y: base }]);
    expect(u.at(base, base)).toBe(1);
    expect(u.at(base + ASTAR_CELL - 1, base)).toBe(1); // last world unit still in the same cell
    expect(u.at(base + ASTAR_CELL, base)).toBe(0); // first unit of the next cell: independent
  });

  it('accumulates counts additively', () => {
    const u = new WorldUsage(ASTAR_CELL);
    u.add([{ x: 0, y: 0 }]);
    u.add([{ x: 0, y: 0 }]);
    expect(u.at(0, 0)).toBe(2);
  });
});
