import { store } from '../state/store';
import { buildMoveCommand, buildWaypointCommand } from '../state/history';
import { schedulePersist } from '../persistence';
import type { Waypoint } from '../../shared/types';

/**
 * Pointer-driven drag for a table node.
 *
 * During drag:
 *   - Mutates the dragged node's transform directly (GPU compositing, no Preact re-render for the move).
 *   - Writes to the store on every frame so Preact re-renders edges + LOD in sync with the move.
 *     For large diagrams this stays at 60fps because only the visible subset renders (M3 culling).
 *
 * On drop:
 *   - Final store commit.
 *   - Push MoveCommand to undo history (skipped if zero displacement).
 *   - Debounced layout:persist message to the host.
 */

let active = false;

export function startDrag(e: PointerEvent, tableName: string, node: HTMLElement): void {
  if (active || e.button !== 0) return;
  const state = store.getState();
  const pos = state.positions.get(tableName);
  if (!pos) return;

  // Multi-drag: if this table is in the current selection (size >= 2), drag all selected.
  const selectionNames: string[] = state.selection.has(tableName) && state.selection.size > 1
    ? Array.from(state.selection)
    : [tableName];
  if (!state.selection.has(tableName)) {
    state.clearSelection();
  }

  const origins = new Map<string, { x: number; y: number }>();
  for (const n of selectionNames) {
    const p = state.positions.get(n);
    if (p) origins.set(n, { x: p.x, y: p.y });
  }

  active = true;
  e.stopPropagation();
  e.preventDefault();

  const pointerStartX = e.clientX;
  const pointerStartY = e.clientY;

  node.style.willChange = 'transform';
  try { node.setPointerCapture(e.pointerId); } catch { /* noop */ }
  document.body.classList.add('ddd-is-dragging');

  const onMove = (ev: PointerEvent) => {
    const currentZoom = store.getState().viewport.zoom;
    const dx = (ev.clientX - pointerStartX) / currentZoom;
    const dy = (ev.clientY - pointerStartY) / currentZoom;
    const entries: Array<[string, { x: number; y: number }]> = [];
    for (const [n, o] of origins) {
      const nx = Math.round(o.x + dx);
      const ny = Math.round(o.y + dy);
      entries.push([n, { x: nx, y: ny }]);
      if (n === tableName) {
        node.style.transform = `translate3d(${nx}px, ${ny}px, 0)`;
      }
    }
    store.getState().setPositionsBatch(entries);
  };

  const onUp = (ev: PointerEvent) => {
    active = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    node.style.willChange = '';
    try { node.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
    document.body.classList.remove('ddd-is-dragging');
    const cmd = buildMoveCommand(origins, store.getState().positions);
    if (cmd) store.getState().pushMoveCommand(cmd);
    schedulePersist();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

const NEIGHBOR_COLLAPSE_THRESHOLD = 12;

function snapshotWaypoints(refId: string): Waypoint[] {
  const layout = store.getState().edgeLayouts.get(refId);
  return layout?.waypoints ? layout.waypoints.map((w) => ({ x: w.x, y: w.y })) : [];
}

function adjacentWaypoint(refId: string, index: number, side: -1 | 1): Waypoint | null {
  const layout = store.getState().edgeLayouts.get(refId);
  const wps = layout?.waypoints;
  if (!wps) return null;
  const i = index + side;
  if (i < 0 || i >= wps.length) return null;
  return wps[i] ?? null;
}

/**
 * Drag an existing waypoint. The user's pointer maps directly to world coords (clamped to
 * integers). On drop, if the dragged waypoint lands within `NEIGHBOR_COLLAPSE_THRESHOLD`
 * world units of either neighbor, the dragged waypoint is removed instead (collapse UX).
 */
export function startWaypointDrag(refId: string, waypointIndex: number, e: PointerEvent, target: SVGElement | HTMLElement): void {
  e.stopPropagation();
  e.preventDefault();
  const from = snapshotWaypoints(refId);
  if (waypointIndex < 0 || waypointIndex >= from.length) return;
  const origin = from[waypointIndex]!;
  const startX = e.clientX;
  const startY = e.clientY;
  try { target.setPointerCapture(e.pointerId); } catch { /* noop */ }
  document.body.classList.add('ddd-is-edge-dragging');

  const onMove = (ev: PointerEvent) => {
    const zoom = store.getState().viewport.zoom;
    const dxWorld = (ev.clientX - startX) / zoom;
    const dyWorld = (ev.clientY - startY) / zoom;
    store.getState().moveWaypoint(refId, waypointIndex, {
      x: Math.round(origin.x + dxWorld),
      y: Math.round(origin.y + dyWorld),
    });
  };

  const onUp = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    try { target.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
    document.body.classList.remove('ddd-is-edge-dragging');

    // Drop-to-collapse: if the dragged waypoint lands near a neighbor, remove it.
    const layout = store.getState().edgeLayouts.get(refId);
    const current = layout?.waypoints?.[waypointIndex];
    if (current) {
      const prev = adjacentWaypoint(refId, waypointIndex, -1);
      const next = adjacentWaypoint(refId, waypointIndex, +1);
      const near = (w: Waypoint | null): boolean =>
        w !== null && Math.hypot(w.x - current.x, w.y - current.y) <= NEIGHBOR_COLLAPSE_THRESHOLD;
      if (near(prev) || near(next)) {
        store.getState().removeWaypoint(refId, waypointIndex);
      }
    }

    const to = snapshotWaypoints(refId);
    const op = to.length < from.length ? 'remove' : 'move';
    const cmd = buildWaypointCommand(refId, from, to, op);
    if (cmd) store.getState().pushWaypointCommand(cmd);
    schedulePersist();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

/**
 * Click on a segment → insert a waypoint at `projectedPoint`, then drag it with the same
 * pointer stream so the user can fine-tune position before releasing.
 */
export function startSegmentAddWaypoint(
  refId: string,
  insertIndex: number,
  projectedPoint: Waypoint,
  e: PointerEvent,
  target: SVGElement | HTMLElement,
): void {
  e.stopPropagation();
  e.preventDefault();
  const from = snapshotWaypoints(refId);
  store.getState().insertWaypoint(refId, insertIndex, projectedPoint);
  const startX = e.clientX;
  const startY = e.clientY;
  try { target.setPointerCapture(e.pointerId); } catch { /* noop */ }
  document.body.classList.add('ddd-is-edge-dragging');

  const onMove = (ev: PointerEvent) => {
    const zoom = store.getState().viewport.zoom;
    const dxWorld = (ev.clientX - startX) / zoom;
    const dyWorld = (ev.clientY - startY) / zoom;
    store.getState().moveWaypoint(refId, insertIndex, {
      x: Math.round(projectedPoint.x + dxWorld),
      y: Math.round(projectedPoint.y + dyWorld),
    });
  };

  const onUp = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    try { target.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
    document.body.classList.remove('ddd-is-edge-dragging');

    const to = snapshotWaypoints(refId);
    const cmd = buildWaypointCommand(refId, from, to, 'add');
    if (cmd) store.getState().pushWaypointCommand(cmd);
    schedulePersist();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

/** Remove a waypoint and push history. Used by double-click on the circle. */
export function removeWaypoint(refId: string, index: number): void {
  const from = snapshotWaypoints(refId);
  if (index < 0 || index >= from.length) return;
  store.getState().removeWaypoint(refId, index);
  const to = snapshotWaypoints(refId);
  const cmd = buildWaypointCommand(refId, from, to, 'remove');
  if (cmd) store.getState().pushWaypointCommand(cmd);
  schedulePersist();
}

/** Clear all waypoints of an edge and push history. Used by context menu "Reset edge". */
export function resetEdgeWaypoints(refId: string): void {
  const from = snapshotWaypoints(refId);
  if (from.length === 0) return;
  store.getState().clearWaypoints(refId);
  const cmd = buildWaypointCommand(refId, from, [], 'clear');
  if (cmd) store.getState().pushWaypointCommand(cmd);
  schedulePersist();
}
