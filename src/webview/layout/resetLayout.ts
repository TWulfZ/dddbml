import type { EdgeLayout, QualifiedName } from '../../shared/types';
import { store, isCanvasReadOnly } from '../state/store';
import { schedulePersist } from '../persistence';
import { estimateSize } from './autoLayout';
import { placeMissingTables } from './placeMissing';
import { buildArrangeCommand } from '../state/history';

/**
 * `dddbml: Reset Layout` (spec 03, F24). Runs here, not on the host: only the webview can lay
 * tables out, and a host-side `tables: {}` also dropped colors and personal hidden flags. Positions
 * are recomputed exactly as on first open (smartLayout 'all', spec 03 decision 2026-10-01); every
 * edge loses its shape (absolute waypoints would dangle once the tables move) but keeps its color.
 * Orphan entries are left for Prune Orphans.
 */
export function resetLayout(): void {
  const s = store.getState();
  if (isCanvasReadOnly(s) || s.schema.tables.length === 0) return;

  const columnCount = new Map(s.schema.tables.map((t) => [t.name, t.columns.length]));
  const placed = placeMissingTables({
    tables: s.schema.tables,
    refs: s.schema.refs,
    groups: s.schema.groups,
    positions: new Map(),
    sizeOf: (name: QualifiedName) => estimateSize(columnCount.get(name) ?? 0),
    spacing: s.settings.ui.layoutSpacing,
  });
  const edgeResets: Array<[string, EdgeLayout | null]> = [];
  for (const [id, e] of s.edgeLayouts) edgeResets.push([id, e.color ? { color: e.color } : null]);

  const before = new Map(s.positions);
  const edgesBefore = new Map(s.edgeLayouts);
  s.setPositionsBatch(placed);
  s.applyEdgeLayouts(edgeResets);
  // Undoable instead of confirmed (spec 03): one command carries the old positions and shapes.
  const cmd = buildArrangeCommand(before, store.getState().positions, edgesBefore, edgeResets, 'Reset layout');
  if (cmd) s.pushArrangeCommand(cmd);
  schedulePersist();
}
