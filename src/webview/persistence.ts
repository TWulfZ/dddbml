import { store, toTableLayoutRecord } from './state/store';
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
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const state = store.getState();
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
  }, PERSIST_DEBOUNCE_MS);
}
