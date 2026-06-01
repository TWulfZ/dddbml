import type { Bbox } from '../../render/spatialIndex';
import { ASTAR_CELL, CLEARANCE } from './constants';

/**
 * Grid + obstacle rasterization for the on-demand A* edge router (spec 05 §9).
 *
 * Pure and framework-free. The blocked mask is a flat `Uint8Array` (no Map in the
 * hot path → no iteration-order dependence). Obstacle rasterization is a commutative
 * membership test (a cell is blocked iff its CENTRE lies inside any inflated obstacle),
 * so the order obstacles arrive in can never change the resulting mask — the
 * determinism anchor for the whole router.
 */

/** The four table sides an edge endpoint can attach to. Structurally identical to `edgeRouter.Side`. */
export type Side = 'left' | 'right' | 'top' | 'bottom';

export interface Cell {
  cx: number;
  cy: number;
}

/**
 * World-space crossing-usage counter shared across all edges in one batch. Keyed by world cell
 * (independent of any per-edge window origin) so two edges searching different windows still see
 * each other's cells. Counts only; the Map is NEVER iterated for a routing decision.
 */
export class WorldUsage {
  private readonly m = new Map<number, number>();
  constructor(private readonly cell: number = ASTAR_CELL) {}

  /**
   * Deterministic collision-free key for world point → cell bucket. Offsets both axes into the
   * non-negative range; valid while |cell coordinate| < 2^20 (≈ ±25M world units at cell 24),
   * far beyond any windowed search (the grid-too-big guard rejects anything near that).
   */
  private key(wx: number, wy: number): number {
    const cx = Math.floor(wx / this.cell) + 0x100000;
    const cy = Math.floor(wy / this.cell) + 0x100000;
    return cy * 0x200000 + cx;
  }

  at(wx: number, wy: number): number {
    return this.m.get(this.key(wx, wy)) ?? 0;
  }

  add(worldPoints: ReadonlyArray<{ x: number; y: number }>): void {
    for (const p of worldPoints) {
      const k = this.key(p.x, p.y);
      this.m.set(k, (this.m.get(k) ?? 0) + 1);
    }
  }
}

export class RouteGrid {
  readonly cols: number;
  readonly rows: number;
  private readonly blocked: Uint8Array;
  private usage: WorldUsage | null = null;
  /** Local usage fallback for single-edge unit tests (no bound WorldUsage). */
  private readonly localUsage = new Map<number, number>();

  constructor(
    readonly originX: number,
    readonly originY: number,
    cols: number,
    rows: number,
    readonly cell: number,
  ) {
    this.cols = cols;
    this.rows = rows;
    this.blocked = new Uint8Array(cols * rows);
  }

  /** Floor a world coord to a cell, clamped into the grid. */
  toCell(x: number, y: number): Cell {
    const cx = Math.floor((x - this.originX) / this.cell);
    const cy = Math.floor((y - this.originY) / this.cell);
    return {
      cx: cx < 0 ? 0 : cx >= this.cols ? this.cols - 1 : cx,
      cy: cy < 0 ? 0 : cy >= this.rows ? this.rows - 1 : cy,
    };
  }

  /** Integer world coordinate of a cell's centre (cell is even, so the centre is an integer). */
  toWorld(cx: number, cy: number): { x: number; y: number } {
    const half = this.cell / 2;
    return { x: this.originX + cx * this.cell + half, y: this.originY + cy * this.cell + half };
  }

  /** Stable row-major ordinal — the final A* priority-queue tie-break, pure in (cx,cy). */
  ordinal(cx: number, cy: number): number {
    return cy * this.cols + cx;
  }

  /** Out-of-bounds reads as blocked (the search can never leave the window). */
  isBlocked(cx: number, cy: number): boolean {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return true;
    return this.blocked[cy * this.cols + cx] === 1;
  }

  private setBlocked(cx: number, cy: number, v: boolean): void {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return;
    this.blocked[cy * this.cols + cx] = v ? 1 : 0;
  }

  /** Set a cell's blocked state, returning the previous value — for reversible per-candidate carving. */
  setCell(cx: number, cy: number, blocked: boolean): boolean {
    const prev = this.isBlocked(cx, cy);
    this.setBlocked(cx, cy, blocked);
    return prev;
  }

  /** Mark every cell whose centre lies inside `rect` (already inflated). Commutative. */
  rasterize(rect: Bbox): void {
    const x0 = rect.x;
    const y0 = rect.y;
    const x1 = rect.x + rect.w;
    const y1 = rect.y + rect.h;
    const cMin = this.toCell(x0, y0);
    const cMax = this.toCell(x1, y1);
    for (let cy = cMin.cy; cy <= cMax.cy; cy++) {
      for (let cx = cMin.cx; cx <= cMax.cx; cx++) {
        const c = this.toWorld(cx, cy);
        if (c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1) this.setBlocked(cx, cy, true);
      }
    }
  }

  /**
   * Force the stub cell and the one cell in the port's outward direction to be walkable, so a
   * neighbouring obstacle's inflation can't wall in the start/goal. Runs AFTER all rasterization.
   * Returns an undo list so a per-candidate carve can be reverted (candidates share one grid).
   */
  carveEndpoint(worldX: number, worldY: number, side: Side): Array<{ cx: number; cy: number; prev: boolean }> {
    const c = this.toCell(worldX, worldY);
    const dx = side === 'left' ? -1 : side === 'right' ? 1 : 0;
    const dy = side === 'top' ? -1 : side === 'bottom' ? 1 : 0;
    const undo: Array<{ cx: number; cy: number; prev: boolean }> = [];
    undo.push({ cx: c.cx, cy: c.cy, prev: this.setCell(c.cx, c.cy, false) });
    undo.push({ cx: c.cx + dx, cy: c.cy + dy, prev: this.setCell(c.cx + dx, c.cy + dy, false) });
    return undo;
  }

  /** Revert cells touched by a reversible carve. */
  restore(undo: ReadonlyArray<{ cx: number; cy: number; prev: boolean }>): void {
    for (const u of undo) this.setCell(u.cx, u.cy, u.prev);
  }

  bindUsage(u: WorldUsage): void {
    this.usage = u;
  }

  /** Crossing usage at a cell (world-keyed when bound; local Map otherwise). */
  usageAt(cx: number, cy: number): number {
    const w = this.toWorld(cx, cy);
    if (this.usage) return this.usage.at(w.x, w.y);
    return this.localUsage.get(this.ordinal(cx, cy)) ?? 0;
  }

  /** Record a routed path's cells in the local usage map (single-edge unit-test path). */
  addUsage(cells: ReadonlyArray<Cell>): void {
    for (const c of cells) {
      const k = this.ordinal(c.cx, c.cy);
      this.localUsage.set(k, (this.localUsage.get(k) ?? 0) + 1);
    }
  }
}

/**
 * Build a route grid over `window`, rasterizing each obstacle bbox inflated by `CLEARANCE`. The
 * origin snaps DOWN to a multiple of `cell` so identical geometry yields identical cells regardless
 * of world translation. Returns `null` when the window would exceed `MAX_GRID_CELLS` (caller falls
 * back to default H-V-H).
 */
export function buildRouteGrid(
  window: Bbox,
  obstacles: ReadonlyArray<Bbox>,
  maxCells: number,
  cell: number = ASTAR_CELL,
): RouteGrid | null {
  const originX = Math.floor(window.x / cell) * cell;
  const originY = Math.floor(window.y / cell) * cell;
  const cols = Math.ceil((window.x + window.w - originX) / cell) + 1;
  const rows = Math.ceil((window.y + window.h - originY) / cell) + 1;
  if (cols <= 0 || rows <= 0 || cols * rows > maxCells) return null;

  const grid = new RouteGrid(originX, originY, cols, rows, cell);
  for (const o of obstacles) {
    grid.rasterize({ x: o.x - CLEARANCE, y: o.y - CLEARANCE, w: o.w + 2 * CLEARANCE, h: o.h + 2 * CLEARANCE });
  }
  return grid;
}
