import { store, toTableLayoutRecord, isCanvasReadOnly } from './state/store';
import { postToHost } from './vscode';
import { hasAutoShape, type EdgeLayout } from '../shared/types';

/**
 * layout:persist post to the extension host.
 *
 * Owned here (not in dragController) so that any mutation source — table drag, waypoint
 * edits, undo/redo, future history actions — can trigger the same write pipeline without
 * creating import cycles through the store.
 *
 * Posted at once, not debounced (F22): a timer dies with the webview iframe when the panel is
 * hidden or closed, and an unload-time post is relayed through a frame being torn down, so the
 * edit was lost. The host's own debounce coalesces bursts and is flushed on hide/close.
 */
export function schedulePersist(): void {
  const state = store.getState();
  // Read-only canvas (spec 14/16): a merge shows a provisional layout that must NOT be written
  // until applied; a git overlay (time-travel/diff) shows a past/other revision.
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
    if (v.auto && hasAutoShape(id, { ...e, auto: true })) e.auto = true;
    if (e.waypoints || e.color || e.sourceSide || e.targetSide || e.dx !== undefined || e.dy !== undefined) {
      edges[id] = e;
    }
  }
  postToHost({
    type: 'layout:persist',
    payload: {
      tables: toTableLayoutRecord(state.positions, state.hiddenTables, state.tableColors),
      groups: state.groups,
      edges,
      // Hidden but not yet placed (no position to carry `hidden` on); always sent, it rides with tables.
      hiddenUnplaced: [...state.hiddenTables].filter((n) => !state.positions.has(n)),
      version: 1,
    },
  });
}

const VIEWPORT_PERSIST_DEBOUNCE_MS = 300;
let viewportTimer: ReturnType<typeof setTimeout> | null = null;

// The camera is personal view-state (spec 03, F26): saved once a pan/zoom burst settles, in its own
// message so a camera never rides a layout write, and not gated by read-only (panning a past
// revision or a merge is still this user's camera).
store.subscribe((s, prev) => {
  if (s.viewport === prev.viewport) return;
  if (viewportTimer) clearTimeout(viewportTimer);
  viewportTimer = setTimeout(() => {
    viewportTimer = null;
    postToHost({ type: 'viewport:persist', payload: { ...store.getState().viewport } });
  }, VIEWPORT_PERSIST_DEBOUNCE_MS);
});
