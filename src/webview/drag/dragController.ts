import { store, toTableLayoutRecord } from '../state/store';
import { postToHost } from '../vscode';

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
 *   - Debounced layout:persist message to the host (M5: writes sidecar JSON).
 */

let active = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 300;

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
    // Clicking an unselected table clears selection so the user isn't confused about what's dragging.
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
      // Directly mutate the primary node for zero-latency feedback on the dragged one.
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
    schedulePersist();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

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

/**
 * Drag the middle segment of a Manhattan edge. Updates `edgeOffsets` on each frame
 * and schedules persist on pointer up.
 */
export function startEdgeDrag(refId: string, axis: 'v' | 'h', e: PointerEvent, target: HTMLElement): void {
  e.stopPropagation();
  e.preventDefault();
  const state = store.getState();
  const origin = state.edgeOffsets.get(refId) ?? {};
  const startX = e.clientX;
  const startY = e.clientY;
  try { target.setPointerCapture(e.pointerId); } catch { /* noop */ }
  document.body.classList.add('ddd-is-edge-dragging');

  const onMove = (ev: PointerEvent) => {
    const zoom = store.getState().viewport.zoom;
    const dxScreen = ev.clientX - startX;
    const dyScreen = ev.clientY - startY;
    const dxWorld = dxScreen / zoom;
    const dyWorld = dyScreen / zoom;
    if (axis === 'v') {
      store.getState().setEdgeOffset(refId, { dx: Math.round((origin.dx ?? 0) + dxWorld) });
    } else {
      store.getState().setEdgeOffset(refId, { dy: Math.round((origin.dy ?? 0) + dyWorld) });
    }
  };
  const onUp = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    try { target.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
    document.body.classList.remove('ddd-is-edge-dragging');
    schedulePersist();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}
