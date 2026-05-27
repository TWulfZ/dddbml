import type { QualifiedName } from '../../shared/types';

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
