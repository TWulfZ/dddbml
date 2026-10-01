import { store, isCanvasReadOnly } from '../state/store';
import { buildEdgeStyleCommand, buildEdgesResetCommand, buildMoveCommand, buildWaypointCommand, type EdgeStyle } from '../state/history';
import { schedulePersist } from '../persistence';
import { slideSegment, notchAtQuarter, deleteNotch, type EdgeRoute } from '../render/edgeRouter';
import { screenToWorld, type Point } from '../render/viewport';
import { gridSnapper } from '../layout/grid';
import { hasManualShape } from '../layout/smartLayout/edgeReset';
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
/** One edge gesture at a time: a second pointerdown mid-drag would stack a second listener set. */
let edgeDragActive = false;

/** Min screen-px the pointer must travel from the press before a press becomes a drag (not a click). */
const CLICK_THRESHOLD_PX = 4;

/** True while a table or edge gesture owns the pointer; undo/redo must not run under it (spec 11). */
export function isGestureActive(): boolean {
  return active || edgeDragActive;
}

interface ClientOrigin { left: number; top: number }

/** Client-space origin of the viewport element, which `viewport.x/y` are relative to. */
function viewportOrigin(el: Element): ClientOrigin {
  const rect = el.closest('.ddd-viewport')?.getBoundingClientRect();
  return { left: rect?.left ?? 0, top: rect?.top ?? 0 };
}

function clientToWorld(clientX: number, clientY: number, origin: ClientOrigin): Point {
  return screenToWorld({ x: clientX - origin.left, y: clientY - origin.top });
}

export function startDrag(e: PointerEvent, tableName: string, node: HTMLElement): void {
  if (active || e.button !== 0) return;
  const state = store.getState();
  if (isCanvasReadOnly(state)) return; // read-only during merge / git overlay (spec 14/16); belt to the CSS lock
  // Pan tool active (toggle or spacebar held): let the event bubble to the viewport so it pans.
  // Returning BEFORE stopPropagation is what lets the viewport handler take over (spec 04).
  if (state.panMode || state.spacePan) return;
  const pos = state.positions.get(tableName);
  if (!pos) return;

  // Click vs drag is decided on pointerup by distance travelled; selection is applied there.
  // Shift = additive/toggle (matches the marquee). A plain press on an unselected table selects
  // it now (select-on-press) so a drag moves just it; additive presses defer to the click handler.
  const additive = e.shiftKey;
  const wasSelected = state.selection.has(tableName);
  if (!additive && !wasSelected) {
    state.setSelection([tableName]);
  }

  // Multi-drag: if this table is in the current selection (size >= 2), drag all selected.
  const liveSelection = store.getState().selection;
  const selectionNames: string[] = liveSelection.has(tableName) && liveSelection.size > 1
    ? Array.from(liveSelection)
    : [tableName];

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
  // Deltas are measured in world space from the grabbed point, so a wheel zoom/pan mid-drag keeps
  // the table under the cursor instead of rescaling the screen delta by the new zoom.
  const origin = viewportOrigin(node);
  const grab = clientToWorld(pointerStartX, pointerStartY, origin);
  let lastX = pointerStartX;
  let lastY = pointerStartY;
  // Latched: nothing moves until the threshold is crossed once, so a jittery click never shifts
  // tables without an undo entry, and a drag that comes back near its start stays a drag.
  let dragging = false;

  node.style.willChange = 'transform';
  try { node.setPointerCapture(e.pointerId); } catch { /* noop */ }
  document.body.classList.add('ddd-is-dragging');

  const apply = () => {
    if (!dragging) {
      if (Math.hypot(lastX - pointerStartX, lastY - pointerStartY) < CLICK_THRESHOLD_PX) return;
      dragging = true;
    }
    const snap = gridSnapper();
    const cur = clientToWorld(lastX, lastY, origin);
    const dx = cur.x - grab.x;
    const dy = cur.y - grab.y;
    const entries: Array<[string, { x: number; y: number }]> = [];
    for (const [n, o] of origins) {
      const nx = snap(o.x + dx);
      const ny = snap(o.y + dy);
      entries.push([n, { x: nx, y: ny }]);
      if (n === tableName) {
        node.style.transform = `translate(${nx}px, ${ny}px)`;
      }
    }
    store.getState().setPositionsBatch(entries);
  };

  const onMove = (ev: PointerEvent) => {
    lastX = ev.clientX;
    lastY = ev.clientY;
    apply();
  };
  const unsubViewport = store.subscribe((s, prev) => {
    if (s.viewport !== prev.viewport) apply();
  });

  const onUp = (ev: PointerEvent) => {
    active = false;
    unsubViewport();
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    node.style.willChange = '';
    try { node.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
    document.body.classList.remove('ddd-is-dragging');

    if (!dragging) {
      // A click, not a drag: resolve selection (no move command — zero displacement).
      const sel = store.getState().selection;
      if (additive) {
        const next = new Set(sel);
        if (next.has(tableName)) next.delete(tableName);
        else next.add(tableName);
        store.getState().setSelection(next);
      } else {
        // Collapse any multi-selection down to just the clicked table.
        store.getState().setSelection([tableName]);
      }
      return;
    }

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
  if (edgeDragActive || e.button !== 0) return;
  if (isCanvasReadOnly(store.getState())) return;
  edgeDragActive = true;
  e.stopPropagation();
  e.preventDefault();
  const from = snapshotWaypoints(refId);
  const startX = e.clientX;
  const startY = e.clientY;
  const origin = viewportOrigin(target);
  const grab = clientToWorld(startX, startY, origin);
  let lastEv: PointerEvent | null = null;
  try { target.setPointerCapture(e.pointerId); } catch { /* noop */ }
  document.body.classList.add('ddd-is-edge-dragging');

  const apply = () => {
    if (!lastEv) return;
    const cur = clientToWorld(lastEv.clientX, lastEv.clientY, origin);
    const wps = build(cur.x - grab.x, cur.y - grab.y, lastEv, startX, startY);
    store.getState().setEdgeWaypoints(refId, wps ?? from);
  };
  const onMove = (ev: PointerEvent) => {
    lastEv = ev;
    apply();
  };
  const unsubViewport = store.subscribe((s, prev) => {
    if (s.viewport !== prev.viewport) apply();
  });

  const onUp = (ev: PointerEvent) => {
    edgeDragActive = false;
    unsubViewport();
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
  if (isCanvasReadOnly(store.getState())) return;
  const refId = route.id;
  const from = snapshotWaypoints(refId);
  const to = deleteNotch(route, segIndex);
  store.getState().setEdgeWaypoints(refId, to);
  const cmd = buildWaypointCommand(refId, from, to, to.length < from.length ? 'remove' : 'move');
  if (cmd) store.getState().pushWaypointCommand(cmd);
  schedulePersist();
}

/**
 * Reset an edge's shape (waypoints, side overrides, legacy dx/dy) as ONE undo entry. Keeps color.
 * Uses the composite edges-reset command because it snapshots the full EdgeLayout, which is the
 * only command that can restore a legacy dx/dy offset.
 */
export function resetEdgeWaypoints(refId: string): void {
  const state = store.getState();
  if (isCanvasReadOnly(state)) return;
  const before = state.edgeLayouts.get(refId);
  if (!before || !hasManualShape(before)) return; // nothing to reset: don't clear the redo stack
  state.resetEdgeShape(refId);
  const after = store.getState().edgeLayouts.get(refId) ?? null;
  const cmd = buildEdgesResetCommand(new Map([[refId, before]]), [[refId, after]], 'Reset line');
  if (cmd) store.getState().pushArrangeCommand(cmd);
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
  if (isCanvasReadOnly(store.getState())) return;
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
  if (edgeDragActive || e.button !== 0) return;
  if (isCanvasReadOnly(store.getState())) return;
  edgeDragActive = true;
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
    edgeDragActive = false;
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
