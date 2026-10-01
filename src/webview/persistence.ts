import { store, toTableLayoutRecord, isCanvasReadOnly } from './state/store';
import { postToHost } from './vscode';
import type { EdgeLayout } from '../shared/types';

/**
 * Debounced layout:persist post to the extension host.
 *
 * Owned here (not in dragController) so that any mutation source — table drag, waypoint
 * edits, undo/redo, future history actions — can trigger the same write pipeline without
 * creating import cycles through the store.
 */

let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 300;

export function schedulePersist(): void {
  // Read-only canvas (spec 14/16): a merge shows a provisional layout that must NOT be written
  // until applied; a git overlay (time-travel/diff) shows a past/other revision. Drop every persist.
  if (isCanvasReadOnly(store.getState())) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    postPersist();
  }, PERSIST_DEBOUNCE_MS);
}

/** Post a debounced edit now — before asking the host for an overlay, whose gate would drop it. */
export function flushPendingPersist(): void {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  postPersist();
}

function cancelPendingPersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
}

// Entering read-only by any path (merge:begin, overlay enter, a reload re-post) kills a pending
// timer: by the time it fires the store holds the provisional or past layout (F27).
store.subscribe((s, prev) => {
  if (isCanvasReadOnly(s) && !isCanvasReadOnly(prev)) cancelPendingPersist();
});

function postPersist(): void {
  const state = store.getState();
  // Re-checked when the timer fires: the gate may have closed since it was scheduled.
  if (isCanvasReadOnly(state)) return;
  const edges: Record<string, EdgeLayout> = {};
  for (const [id, v] of state.edgeLayouts) {
    const e: EdgeLayout = {};
    if (v.waypoints && v.waypoints.length > 0) {
      // Soft-migrate: drop legacy dx/dy once waypoints take precedence.
      e.waypoints = v.waypoints.map((w) => ({ x: Math.round(w.x), y: Math.round(w.y) }));
    } else {
      if (v.dx !== undefined) e.dx = v.dx;
      if (v.dy !== undefined) e.dy = v.dy;
    }
    if (v.color) e.color = v.color;
    if (v.sourceSide) e.sourceSide = v.sourceSide;
    if (v.targetSide) e.targetSide = v.targetSide;
    if (e.waypoints || e.color || e.sourceSide || e.targetSide || e.dx !== undefined || e.dy !== undefined) {
      edges[id] = e;
    }
  }
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
}
