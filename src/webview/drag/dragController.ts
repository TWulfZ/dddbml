import { store } from '../state/store';
import { buildEdgeStyleCommand, buildMoveCommand, buildWaypointCommand, type EdgeStyle } from '../state/history';
import { schedulePersist } from '../persistence';
import { slideSegment, notchAtQuarter, deleteNotch, type EdgeRoute } from '../render/edgeRouter';
import { gridSnapper } from '../layout/grid';
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
  if (state.mergeConflicts) return; // read-only during conflict resolution (spec 14); belt to the CSS lock
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
    const snap = gridSnapper();
    const dx = (ev.clientX - pointerStartX) / currentZoom;
    const dy = (ev.clientY - pointerStartY) / currentZoom;
    const entries: Array<[string, { x: number; y: number }]> = [];
    for (const [n, o] of origins) {
      const nx = snap(o.x + dx);
      const ny = snap(o.y + dy);
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

function snapshotWaypoints(refId: string): Waypoint[] {
  const layout = store.getState().edgeLayouts.get(refId);
  return layout?.waypoints ? layout.waypoints.map((w) => ({ x: w.x, y: w.y })) : [];
}

/** Min screen-px a *creating* drag must travel before a new notch is committed (anti false-positive). */
const CREATE_THRESHOLD_PX = 8;

/** Shared pointer-drag loop for edge editing: recompute waypoints from a builder each frame, commit once. */
function runEdgeDrag(
  refId: string,
  e: PointerEvent,
  target: SVGElement | HTMLElement,
  build: (dxWorld: number, dyWorld: number, ev: PointerEvent, startX: number, startY: number) => Waypoint[] | null,
): void {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const from = snapshotWaypoints(refId);
  const startX = e.clientX;
  const startY = e.clientY;
  try { target.setPointerCapture(e.pointerId); } catch { /* noop */ }
  document.body.classList.add('ddd-is-edge-dragging');

  const onMove = (ev: PointerEvent) => {
    const zoom = store.getState().viewport.zoom;
    const dxWorld = (ev.clientX - startX) / zoom;
    const dyWorld = (ev.clientY - startY) / zoom;
    const wps = build(dxWorld, dyWorld, ev, startX, startY);
    store.getState().setEdgeWaypoints(refId, wps ?? from);
  };

  const onUp = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    try { target.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
    document.body.classList.remove('ddd-is-edge-dragging');

    const to = snapshotWaypoints(refId);
    const op = to.length > from.length ? 'add' : to.length < from.length ? 'remove' : 'move';
    const cmd = buildWaypointCommand(refId, from, to, op);
    if (cmd) store.getState().pushWaypointCommand(cmd);
    schedulePersist();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

/**
 * SLIDE a run perpendicular to itself — the gesture behind a run's REAL centre handle (and grabbing
 * the run anywhere). Immediate (no threshold): the whole run moves to a new parallel level. Sliding
 * a notch's dip-run deepens it; sliding it back to its pin level flattens the notch away. 1-DOF
 * perpendicular: a horizontal run reacts to ↑↓, a vertical run to ←→. Recomputes from the ORIGINAL
 * snapshot + cumulative delta (idempotent).
 */
export function startSegmentSlide(route: EdgeRoute, segIndex: number, e: PointerEvent, target: SVGElement | HTMLElement): void {
  runEdgeDrag(route.id, e, target, (dxWorld, dyWorld) =>
    slideSegment(route, segIndex, dxWorld, dyWorld, gridSnapper()),
  );
}

/**
 * NOTCH a run — the gesture behind the two GHOST handles at ¼ / ¾. Dragging perpendicular carves a
 * local symmetric notch centred on `quarter`; the rest of the run stays flat. Gated behind an 8px
 * screen threshold so a graze can't spawn one. 1-DOF perpendicular. Recomputes from the ORIGINAL
 * snapshot + cumulative delta (idempotent; the notch never drifts mid-drag).
 */
export function startNotchDrag(
  route: EdgeRoute,
  segIndex: number,
  quarter: number,
  e: PointerEvent,
  target: SVGElement | HTMLElement,
): void {
  const axis: 'h' | 'v' = route.segments[segIndex]?.axis ?? 'h';
  runEdgeDrag(route.id, e, target, (dxWorld, dyWorld, ev, startX, startY) => {
    const perpScreen = axis === 'v' ? ev.clientX - startX : ev.clientY - startY;
    if (Math.abs(perpScreen) < CREATE_THRESHOLD_PX) return null; // graze → no notch yet
    return notchAtQuarter(route, segIndex, quarter, dxWorld, dyWorld, gridSnapper());
  });
}

/** Double-click a notch's dip-run to delete the whole notch (restore the flat run). */
export function deleteEdgeNotch(route: EdgeRoute, segIndex: number): void {
  const refId = route.id;
  const from = snapshotWaypoints(refId);
  const to = deleteNotch(route, segIndex);
  store.getState().setEdgeWaypoints(refId, to);
  const cmd = buildWaypointCommand(refId, from, to, to.length < from.length ? 'remove' : 'move');
  if (cmd) store.getState().pushWaypointCommand(cmd);
  schedulePersist();
}

/** Reset an edge's shape (waypoints + side overrides) and push history. Keeps color. */
export function resetEdgeWaypoints(refId: string): void {
  const fromWps = snapshotWaypoints(refId);
  const fromStyle = readEdgeStyle(refId);
  store.getState().resetEdgeShape(refId);
  const wpCmd = buildWaypointCommand(refId, fromWps, [], 'clear');
  if (wpCmd) store.getState().pushWaypointCommand(wpCmd);
  // Reset also drops side overrides — capture that as a style command so undo restores them.
  const styleCmd = buildEdgeStyleCommand(refId, fromStyle, readEdgeStyle(refId), 'Reset edge port sides');
  if (styleCmd) store.getState().pushEdgeStyleCommand(styleCmd);
  schedulePersist();
}

/** Snapshot an edge's style (color + side overrides) for history diffing. */
export function readEdgeStyle(refId: string): EdgeStyle {
  const l = store.getState().edgeLayouts.get(refId);
  const s: EdgeStyle = {};
  if (l?.color) s.color = l.color;
  if (l?.sourceSide) s.sourceSide = l.sourceSide;
  if (l?.targetSide) s.targetSide = l.targetSide;
  return s;
}

/** Push an EdgeStyleCommand for the change since `before`, then persist. No-op if unchanged. */
export function commitEdgeStyle(refId: string, before: EdgeStyle, label: string): void {
  const cmd = buildEdgeStyleCommand(refId, before, readEdgeStyle(refId), label);
  if (cmd) store.getState().pushEdgeStyleCommand(cmd);
  schedulePersist();
}

/**
 * Drag an edge endpoint across its table to flip the port side (left <-> right). The side is
 * chosen by which half of the table the pointer is over; committed as one EdgeStyleCommand.
 */
export function startEndpointDrag(
  refId: string,
  end: 'source' | 'target',
  tableCenterX: number,
  e: PointerEvent,
  target: SVGElement | HTMLElement,
  toWorldX: (clientX: number) => number | null,
): void {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const before = readEdgeStyle(refId);
  try { target.setPointerCapture(e.pointerId); } catch { /* noop */ }
  document.body.classList.add('ddd-is-edge-dragging');

  const onMove = (ev: PointerEvent) => {
    const wx = toWorldX(ev.clientX);
    if (wx === null) return;
    store.getState().setEdgeSide(refId, end, wx >= tableCenterX ? 'right' : 'left');
  };

  const onUp = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    try { target.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
    document.body.classList.remove('ddd-is-edge-dragging');
    commitEdgeStyle(refId, before, 'Flip edge port');
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}
