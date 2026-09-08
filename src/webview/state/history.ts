import type { EdgeLayout, EdgeSide, QualifiedName, Waypoint } from '../../shared/types';

/**
 * Action history entry for a table move (single or batch).
 *
 * `from` and `to` are snapshotted at push time so that undo→edit→redo stays
 * deterministic (redo jumps to the original target, not the latest store state).
 */
export interface MoveCommand {
  kind: 'move';
  from: Array<[QualifiedName, { x: number; y: number }]>;
  to: Array<[QualifiedName, { x: number; y: number }]>;
  label: string;
  timestamp: number;
}

/**
 * Action history entry for edge waypoint mutations (add, move, remove, clear).
 *
 * Same snapshot semantics as `MoveCommand`: `from`/`to` are the full waypoints
 * array before and after the operation, so undo/redo are pure replays.
 */
export interface WaypointCommand {
  kind: 'waypoint';
  refId: string;
  from: Waypoint[];
  to: Waypoint[];
  label: string;
  timestamp: number;
}

/** Snapshot of an edge's non-shape style fields (color + port side overrides). */
export interface EdgeStyle {
  color?: string;
  sourceSide?: EdgeSide;
  targetSide?: EdgeSide;
}

/**
 * Action history entry for edge style changes (color, port-side flip).
 * Same snapshot semantics as the others: `from`/`to` are full style snapshots.
 */
export interface EdgeStyleCommand {
  kind: 'edgeStyle';
  refId: string;
  from: EdgeStyle;
  to: EdgeStyle;
  label: string;
  timestamp: number;
}

/**
 * Action history entry for a bulk smart auto-arrange. Composite on purpose: a single
 * Ctrl+Z reverts both the table moves AND the edge-waypoint resets that the arrange
 * triggered (waypoints are absolute world coords that don't follow tables, so a bulk
 * move strands them — see spec 13). `edgesFrom`/`edgesTo` snapshot the full per-edge
 * layout before/after, mirroring the other commands' pure-replay semantics.
 */
export interface ArrangeCommand {
  kind: 'arrange';
  from: Array<[QualifiedName, { x: number; y: number }]>;
  to: Array<[QualifiedName, { x: number; y: number }]>;
  edgesFrom: Array<[string, EdgeLayout | null]>;
  edgesTo: Array<[string, EdgeLayout | null]>;
  label: string;
  timestamp: number;
}

export type EditCommand = MoveCommand | WaypointCommand | EdgeStyleCommand | ArrangeCommand;

/**
 * Build a MoveCommand from a drag's origins map and the post-drag positions.
 *
 * Returns `null` when:
 *   - All deltas are zero (click without drag, no-op filter).
 *   - `origins` is empty.
 *   - No target position can be resolved for any origin key.
 */
export function buildMoveCommand(
  origins: Map<QualifiedName, { x: number; y: number }>,
  currentPositions: Map<QualifiedName, { x: number; y: number }>,
): MoveCommand | null {
  if (origins.size === 0) return null;

  const from: MoveCommand['from'] = [];
  const to: MoveCommand['to'] = [];
  let moved = false;

  for (const [name, fromPos] of origins) {
    const toPos = currentPositions.get(name);
    if (!toPos) continue;
    from.push([name, { x: fromPos.x, y: fromPos.y }]);
    to.push([name, { x: toPos.x, y: toPos.y }]);
    if (toPos.x !== fromPos.x || toPos.y !== fromPos.y) moved = true;
  }

  if (!moved || from.length === 0) return null;

  const label = from.length === 1 ? `Move ${from[0]![0]}` : `Move ${from.length} tables`;

  return {
    kind: 'move',
    from,
    to,
    label,
    timestamp: Date.now(),
  };
}

export type WaypointOp = 'move' | 'add' | 'remove' | 'clear';

/**
 * Build a WaypointCommand. Returns null when from and to are identical
 * (no-op, e.g. drag with zero displacement).
 */
export function buildWaypointCommand(
  refId: string,
  from: Waypoint[],
  to: Waypoint[],
  op: WaypointOp,
): WaypointCommand | null {
  if (waypointsEqual(from, to)) return null;
  const label =
    op === 'move' ? 'Move waypoint'
      : op === 'add' ? 'Add waypoint'
        : op === 'remove' ? 'Remove waypoint'
          : 'Reset edge waypoints';
  return {
    kind: 'waypoint',
    refId,
    from: from.map((w) => ({ x: w.x, y: w.y })),
    to: to.map((w) => ({ x: w.x, y: w.y })),
    label,
    timestamp: Date.now(),
  };
}

function waypointsEqual(a: Waypoint[], b: Waypoint[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.x !== b[i]!.x || a[i]!.y !== b[i]!.y) return false;
  }
  return true;
}

/** Build an EdgeStyleCommand. Returns null when from and to are identical (no-op). */
export function buildEdgeStyleCommand(
  refId: string,
  from: EdgeStyle,
  to: EdgeStyle,
  label: string,
): EdgeStyleCommand | null {
  if (from.color === to.color && from.sourceSide === to.sourceSide && from.targetSide === to.targetSide) {
    return null;
  }
  return { kind: 'edgeStyle', refId, from: { ...from }, to: { ...to }, label, timestamp: Date.now() };
}

/**
 * Build an ArrangeCommand from before/after positions plus the edge resets the arrange applied.
 *
 * `before` is the position snapshot taken before layout ran; `after` the applied result. Only
 * tables present in `before` whose position changed are recorded (new tables have no prior state
 * to undo to). `edgesBefore` is the full pre-arrange edgeLayouts; `edgeResets` is the list of
 * `[refId, newLayout|null]` the arrange wrote. Returns null when nothing actually changed.
 */
export function buildArrangeCommand(
  before: Map<QualifiedName, { x: number; y: number }>,
  after: Map<QualifiedName, { x: number; y: number }>,
  edgesBefore: Map<string, EdgeLayout>,
  edgeResets: Array<[string, EdgeLayout | null]>,
): ArrangeCommand | null {
  const from: ArrangeCommand['from'] = [];
  const to: ArrangeCommand['to'] = [];
  for (const [name, fromPos] of before) {
    const toPos = after.get(name);
    if (!toPos) continue;
    if (toPos.x === fromPos.x && toPos.y === fromPos.y) continue;
    from.push([name, { x: fromPos.x, y: fromPos.y }]);
    to.push([name, { x: toPos.x, y: toPos.y }]);
  }

  const edgesFrom: ArrangeCommand['edgesFrom'] = [];
  const edgesTo: ArrangeCommand['edgesTo'] = [];
  for (const [refId, next] of edgeResets) {
    edgesFrom.push([refId, edgesBefore.get(refId) ?? null]);
    edgesTo.push([refId, next]);
  }

  if (from.length === 0 && edgesFrom.length === 0) return null;

  return {
    kind: 'arrange',
    from,
    to,
    edgesFrom,
    edgesTo,
    label: `Auto-arrange ${from.length} table${from.length === 1 ? '' : 's'}`,
    timestamp: Date.now(),
  };
}

/**
 * Build an edges-only ArrangeCommand for a manual "reset relations" of selected tables.
 * Reuses the composite `arrange` kind with empty position arrays so a single undo restores
 * the cleared edge shapes. Returns null when there's nothing to reset.
 */
export function buildEdgesResetCommand(
  edgesBefore: Map<string, EdgeLayout>,
  edgeResets: Array<[string, EdgeLayout | null]>,
  label: string,
): ArrangeCommand | null {
  if (edgeResets.length === 0) return null;
  const edgesFrom: ArrangeCommand['edgesFrom'] = [];
  const edgesTo: ArrangeCommand['edgesTo'] = [];
  for (const [refId, next] of edgeResets) {
    edgesFrom.push([refId, edgesBefore.get(refId) ?? null]);
    edgesTo.push([refId, next]);
  }
  return { kind: 'arrange', from: [], to: [], edgesFrom, edgesTo, label, timestamp: Date.now() };
}
