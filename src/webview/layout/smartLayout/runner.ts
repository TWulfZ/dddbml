import type { QualifiedName } from '../../../shared/types';
import { store } from '../../state/store';
import { buildArrangeCommand, buildEdgesResetCommand } from '../../state/history';
import { schedulePersist } from '../../persistence';
import { postToHost } from '../../vscode';
import { estimateSize } from '../autoLayout';
import { smartLayout, type SmartLayoutMode } from './layout';
import { computeEdgeResets, computeSelectionEdgeResets, movedNames } from './edgeReset';

/**
 * Host glue: read state → run smart layout → reset stranded edge waypoints → batch-apply
 * positions + edge resets as a single undoable ArrangeCommand → schedule persist.
 *
 * Async because ELK is async. Snapshots are taken BEFORE the await so undo restores the
 * exact pre-arrange state even if the store changed meanwhile (it won't — single-threaded).
 */
export async function runSmartLayout(mode: SmartLayoutMode): Promise<void> {
  const s = store.getState();
  if (s.schema.tables.length === 0) return;

  const colCount = new Map<QualifiedName, number>();
  for (const t of s.schema.tables) colCount.set(t.name, t.columns.length);
  const sizeOf = (name: QualifiedName) => estimateSize(colCount.get(name) ?? 0);

  const before = new Map(s.positions);
  const edgesBefore = new Map(s.edgeLayouts);

  let result: Map<QualifiedName, { x: number; y: number }>;
  try {
    result = await smartLayout({
      tables: s.schema.tables,
      refs: s.schema.refs,
      groups: s.schema.groups,
      sizeOf,
      mode,
      existing: before,
      selection: s.selection,
    });
  } catch (err) {
    postToHost({
      type: 'error:log',
      payload: { message: `smart auto-layout failed: ${String(err)}`, stack: err instanceof Error ? err.stack : undefined },
    });
    return;
  }
  if (result.size === 0) return;

  const moved = movedNames(before, result);
  const edgeResets = computeEdgeResets(s.schema.refs, moved, edgesBefore);

  // Apply positions + edge resets, then record one composite undo unit.
  store.getState().setPositionsBatch([...result]);
  if (edgeResets.length > 0) store.getState().applyEdgeLayouts(edgeResets);

  const cmd = buildArrangeCommand(before, store.getState().positions, edgesBefore, edgeResets);
  if (cmd) store.getState().pushArrangeCommand(cmd);

  schedulePersist();
}

/**
 * Reset the relations of the currently-selected tables: every edge touching the selection
 * is reset to default routing (waypoints + legacy + sides cleared, color kept). One undoable
 * step. No-op when nothing is selected or nothing has a manual shape.
 */
export function resetSelectedEdges(): void {
  const s = store.getState();
  if (s.selection.size === 0) return;

  const edgesBefore = new Map(s.edgeLayouts);
  const resets = computeSelectionEdgeResets(s.schema.refs, s.selection, s.edgeLayouts);
  if (resets.length === 0) return;

  store.getState().applyEdgeLayouts(resets);
  const cmd = buildEdgesResetCommand(
    edgesBefore,
    resets,
    `Reset ${resets.length} relation${resets.length === 1 ? '' : 's'}`,
  );
  if (cmd) store.getState().pushArrangeCommand(cmd);
  schedulePersist();
}

/** Count of selected tables' edges that currently carry a manual shape (for menu labels). */
export function countResettableSelectionEdges(): number {
  const s = store.getState();
  if (s.selection.size === 0) return 0;
  return computeSelectionEdgeResets(s.schema.refs, s.selection, s.edgeLayouts).length;
}
