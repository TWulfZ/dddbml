import { store, isCanvasReadOnly } from '../state/store';
import { buildArrangeCommand, buildEdgeStyleCommand, buildEdgesResetCommand, buildMoveCommand, buildWaypointCommand, type EdgeStyle, type MoveCommand } from '../state/history';
import { schedulePersist } from '../persistence';
import { slideSegment, notchAtQuarter, deleteNotch, type EdgeRoute } from '../render/edgeRouter';
import { screenToWorld, type Point } from '../render/viewport';
import { gridSnapper } from '../layout/grid';
import { computeDragEdgeChanges, hasShape, rawLayoutDeps, rawLayoutRefs } from '../layout/smartLayout/edgeReset';
import type { Waypoint } from '../../shared/types';
import { isFkDragActive } from './fkDrag';

/**
 * Pointer-driven drag for a table node.
 *
 * During drag:
 *   - Pointer/camera events only record the latest pointer; the move is applied at most once per
 *     animation frame (spec 04, "Commit del drag por frame"): the dragged node's transform is written
 *     directly and the store gets one positions commit, so edges follow the table live while the
 *     scene and the router update incrementally from that positions-only delta.
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
  return active || edgeDragActive || isFkDragActive();
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

  let frame: number | null = null;
  /** The positions map this drag last wrote; identity per entry tells a drag frame from an overlay reload. */
  let committed: Map<string, { x: number; y: number }> | null = null;
  const apply = () => {
    frame = null;
    // A merge / git overlay can lock the canvas while a deferred frame is still pending.
    if (!dragging || isCanvasReadOnly(store.getState())) return;
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
    committed = store.getState().positions;
  };

  const schedule = () => {
    if (dragging && frame === null) frame = requestAnimationFrame(apply);
  };

  const onMove = (ev: PointerEvent) => {
    lastX = ev.clientX;
    lastY = ev.clientY;
    // Latched per pointer event, not per frame: an excursion past the threshold that a later event
    // in the same frame undoes is still a drag.
    if (!dragging && Math.hypot(lastX - pointerStartX, lastY - pointerStartY) >= CLICK_THRESHOLD_PX) dragging = true;
    schedule();
  };
  const unsubViewport = store.subscribe((s, prev) => {
    if (s.viewport !== prev.viewport) schedule();
  });

  const onUp = (ev: PointerEvent) => {
    active = false;
    unsubViewport();
    // The release must land where the pointer last was, even if that frame never got painted.
    if (frame !== null) {
      cancelAnimationFrame(frame);
      apply();
    }
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

    const s = store.getState();
    if (isCanvasReadOnly(s)) {
      // A lock mid-gesture pushes no command and persists nothing, so committed frames would linger
      // with no undo; put back only entries this drag still owns (time travel swaps in its own layout).
      const owned = committed;
      if (owned === null) return;
      const back = [...origins].filter(([n]) => s.positions.get(n) === owned.get(n));
      if (back.length > 0) s.setPositionsBatch(back);
      const home = origins.get(tableName);
      if (home && back.some(([n]) => n === tableName)) node.style.transform = `translate(${home.x}px, ${home.y}px)`;
      return;
    }
    const cmd = buildMoveCommand(origins, s.positions);
    if (cmd) commitMove(cmd);
    schedulePersist();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

/**
 * Push a table move. Edge shapes the move invalidates (A* shapes with one end moved) or carries
 * along (waypoints of edges with both ends dragged) change in the same undo step, as an
 * arrange-kind command, which snapshots edge layouts (F20, spec 05 "Arrastre de tablas").
 */
function commitMove(cmd: MoveCommand): void {
  const s = store.getState();
  const before = new Map(cmd.from);
  const after = new Map(cmd.to);
  const changes = isCanvasReadOnly(s)
    ? []
    : computeDragEdgeChanges(rawLayoutRefs(s.schema.refs), rawLayoutDeps(s.schema.deps), before, after, s.edgeLayouts);
  if (changes.length === 0) {
    s.pushMoveCommand(cmd);
    return;
  }
  const edgesBefore = new Map(s.edgeLayouts);
  s.applyEdgeLayouts(changes);
  const arrange = buildArrangeCommand(before, after, edgesBefore, changes, cmd.label);
  if (arrange) s.pushArrangeCommand(arrange);
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
  const before = store.getState().edgeLayouts.get(refId);
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
    const cmd = buildWaypointCommand(refId, from, to, op, before?.auto === true);
    if (cmd) store.getState().pushWaypointCommand(cmd);
    // A gesture that ended where it began edited nothing: hand back the pre-drag layout, `auto` included.
    else if (before?.auto) store.getState().applyEdgeLayouts([[refId, before]]);
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
  const fromAuto = store.getState().edgeLayouts.get(refId)?.auto === true;
  const to = deleteNotch(route, segIndex);
  store.getState().setEdgeWaypoints(refId, to);
  const cmd = buildWaypointCommand(refId, from, to, to.length < from.length ? 'remove' : 'move', fromAuto);
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
  if (!before || !hasShape(before)) return; // nothing to reset: don't clear the redo stack
  state.resetEdgeShape(refId);
  const after = store.getState().edgeLayouts.get(refId) ?? null;
  const cmd = buildEdgesResetCommand(new Map([[refId, before]]), [[refId, after]], 'Reset line');
  if (cmd) store.getState().pushArrangeCommand(cmd);
  schedulePersist();
}

/** Snapshot an edge's style (color + side overrides + A* marker) for history diffing. */
export function readEdgeStyle(refId: string): EdgeStyle {
  const l = store.getState().edgeLayouts.get(refId);
  const s: EdgeStyle = {};
  if (l?.color) s.color = l.color;
  if (l?.sourceSide) s.sourceSide = l.sourceSide;
  if (l?.targetSide) s.targetSide = l.targetSide;
  if (l?.auto) s.auto = true;
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
    const after = readEdgeStyle(refId);
    const current = store.getState().edgeLayouts.get(refId);
    // Flipped and dragged back: no edit, so the shape stays A*'s and no history entry is pushed.
    if (before.auto && current && after.sourceSide === before.sourceSide && after.targetSide === before.targetSide) {
      store.getState().applyEdgeLayouts([[refId, { ...current, auto: true }]]);
    }
    commitEdgeStyle(refId, before, 'Flip edge port');
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

/**
 * Dep edges (spec 18) use FREE waypoints the curve passes through, not orthogonal corners. Dragging a
 * span's insert handle adds a waypoint at `index` (behind the same 8px anti-graze threshold as notches).
 */
export function startDepWaypointInsert(
  depKey: string,
  index: number,
  at: Point,
  e: PointerEvent,
  target: SVGElement | HTMLElement,
): void {
  const from = snapshotWaypoints(depKey);
  runEdgeDrag(depKey, e, target, (dxWorld, dyWorld, ev, startX, startY) => {
    if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < CREATE_THRESHOLD_PX) return null;
    const snap = gridSnapper();
    const out = from.map((w) => ({ x: w.x, y: w.y }));
    out.splice(index, 0, { x: snap(at.x + dxWorld), y: snap(at.y + dyWorld) });
    return out;
  });
}

export function startDepWaypointMove(depKey: string, index: number, e: PointerEvent, target: SVGElement | HTMLElement): void {
  const from = snapshotWaypoints(depKey);
  const origin = from[index];
  if (!origin) return;
  runEdgeDrag(depKey, e, target, (dxWorld, dyWorld) => {
    const snap = gridSnapper();
    return from.map((w, i) => (i === index ? { x: snap(origin.x + dxWorld), y: snap(origin.y + dyWorld) } : { x: w.x, y: w.y }));
  });
}

export function deleteDepWaypoint(depKey: string, index: number): void {
  if (isCanvasReadOnly(store.getState())) return;
  const from = snapshotWaypoints(depKey);
  if (index < 0 || index >= from.length) return;
  const to = from.filter((_, i) => i !== index);
  store.getState().setEdgeWaypoints(depKey, to);
  const cmd = buildWaypointCommand(depKey, from, to, 'remove');
  if (cmd) store.getState().pushWaypointCommand(cmd);
  schedulePersist();
}
