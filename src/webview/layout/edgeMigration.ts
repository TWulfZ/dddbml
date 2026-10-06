import { isDepEdgeKey, isLoopEdgeKey, type EdgeLayout } from '../../shared/types';
import { isCanvasReadOnly, store, type AppState } from '../state/store';
import { buildEdgesResetCommand } from '../state/history';
import { schedulePersist } from '../persistence';
import { hasShape } from './smartLayout/edgeReset';

/**
 * "Update relations" of the migration notice (spec 05 §Migración): every FK edge drops its saved
 * shape (waypoints, sides, legacy dx/dy) and keeps its color. Deps are left alone (their free-point
 * curves never went through the FK router), and so are self-loops: their only shape is the
 * left/right flip, which both routers draw alike. Loops are told apart by key, the same test the
 * detection (`hasRefEdgeShapes`) uses, so the notice never offers an update that changes nothing.
 */
export function computeLegacyEdgeResets(edgeLayouts: ReadonlyMap<string, EdgeLayout>): Array<[string, EdgeLayout | null]> {
  const out: Array<[string, EdgeLayout | null]> = [];
  for (const [key, layout] of edgeLayouts) {
    if (isDepEdgeKey(key) || isLoopEdgeKey(key) || !hasShape(layout)) continue;
    out.push([key, layout.color ? { color: layout.color } : null]);
  }
  return out;
}

/** Never over a read-only canvas: a merge, diff or past revision is not the file the answer is for. */
export function showEdgeMigrationNotice(s: AppState): boolean {
  return s.edgeMigrationPending && !isCanvasReadOnly(s);
}

/** One undo step; Ctrl+Z restores the shapes but not the question (the file stays marked). */
export function updateLegacyEdges(): void {
  const s = store.getState();
  if (!showEdgeMigrationNotice(s)) return;
  const resets = computeLegacyEdgeResets(s.edgeLayouts);
  const before = new Map(s.edgeLayouts);
  s.applyEdgeLayouts(resets);
  const cmd = buildEdgesResetCommand(before, resets, 'Update relations');
  if (cmd) s.pushArrangeCommand(cmd);
  s.stampEdgeRouting();
  schedulePersist();
}

/** "Keep": the saved shapes count as current; only the marker is written. */
export function keepLegacyEdges(): void {
  const s = store.getState();
  if (!showEdgeMigrationNotice(s)) return;
  s.stampEdgeRouting();
  schedulePersist();
}
