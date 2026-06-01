/**
 * Single source of truth for the on-demand A* edge router (spec 05 §9).
 *
 * The engine imports NOTHING from `render/edgeRouter.ts`: `ASTAR_CELL = 24`
 * matching the render path's private `MIN_STUB` is a documented coincidence
 * (bends phase-aligned with the rigid stub ends so entry/exit collapse cleanly),
 * not a dependency. All values are integers; the cost units treat one cell of
 * straight travel as `STEP_COST`.
 */

/** Grid cell size (world units). 24 = MIN_STUB: a finer grid only adds sub-stub jogs the fillet swallows. */
export const ASTAR_CELL = 24;

/** Obstacle inflation (world units) = BASE_MIN_GAP. Routed lines stay one layout-gap off tables. */
export const CLEARANCE = 16;

/**
 * Per-edge search-window padding (world units) around the union of the two endpoint tables.
 * 128 (not 96) so a table whose body pokes just past the union corner is still seen as an
 * obstacle — a too-tight window would silently route THROUGH it (the failure this feature prevents).
 */
export const GRID_MARGIN = 128;

/** Hard ceiling on cols*rows per A* call. Above it the edge falls back to default H-V-H. */
export const MAX_GRID_CELLS = 4_000_000;

/** Cost of one cell of straight travel. */
export const STEP_COST = 10;

/** 90° turn penalty (~1.4 steps): suppresses staircase without forbidding necessary turns. */
export const TURN_COST = 14;

/** Per-unit penalty for entering a cell already used by a routed edge (crossing deterrent). */
export const CROSS_COST = 40;

/** Explored-node cap per edge. Exceeded ⇒ fallback to default H-V-H (no crash). */
export const MAX_EXPLORED = 6000;

/** Edges processed between cooperative yields + progress emits. */
export const YIELD_EVERY = 16;
