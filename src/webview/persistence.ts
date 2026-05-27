import { store, toTableLayoutRecord } from './state/store';
import { postToHost } from './vscode';

/**
 * Debounced layout:persist post to the extension host.
 *
 * Owned here (not in dragController) so that any mutation source — drag,
 * edge drag, undo/redo, future history actions — can trigger the same write
 * pipeline without creating import cycles through the store.
 */

let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 300;

export function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const state = store.getState();
    const edges: Record<string, { dx?: number; dy?: number }> = {};
    for (const [id, v] of state.edgeOffsets) edges[id] = { ...v };
    postToHost({
      type: 'layout:persist',
      payload: {
        tables: toTableLayoutRecord(state.positions, state.hiddenTables, state.tableColors),
        groups: state.groups,
        viewport: state.viewport,
        edges,
        version: 1,
      },
    });
  }, PERSIST_DEBOUNCE_MS);
}
