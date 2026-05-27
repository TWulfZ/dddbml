import { store } from '../state/store';
import { estimateSize } from '../layout/autoLayout';

export interface Point { x: number; y: number }

export function screenToWorld(screen: Point): Point {
  const vp = store.getState().viewport;
  return {
    x: (screen.x - vp.x) / vp.zoom,
    y: (screen.y - vp.y) / vp.zoom,
  };
}

export function worldToScreen(world: Point): Point {
  const vp = store.getState().viewport;
  return {
    x: world.x * vp.zoom + vp.x,
    y: world.y * vp.zoom + vp.y,
  };
}

export function zoomAt(screen: Point, factor: number): void {
  const state = store.getState();
  const { zoomMin, zoomMax } = state.settings;
  const vp = state.viewport;
  const nextZoom = clamp(vp.zoom * factor, zoomMin, zoomMax);
  if (nextZoom === vp.zoom) return;
  const world = { x: (screen.x - vp.x) / vp.zoom, y: (screen.y - vp.y) / vp.zoom };
  const nextX = screen.x - world.x * nextZoom;
  const nextY = screen.y - world.y * nextZoom;
  state.setViewport({ x: nextX, y: nextY, zoom: nextZoom });
}

export function panBy(dx: number, dy: number): void {
  const state = store.getState();
  state.setViewport({ x: state.viewport.x + dx, y: state.viewport.y + dy });
}

export function zoomAtCenter(factor: number, viewportEl: HTMLElement): void {
  const rect = viewportEl.getBoundingClientRect();
  zoomAt({ x: rect.width / 2, y: rect.height / 2 }, factor);
}

export function resetView(): void {
  store.getState().setViewport({ x: 0, y: 0, zoom: 1 });
}

export function fitToContent(viewportEl: HTMLElement, padding = 48): void {
  const state = store.getState();
  const { zoomMin, zoomMax } = state.settings;
  const tables = state.schema.tables;
  if (tables.length === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of tables) {
    const pos = state.positions.get(t.name);
    if (!pos) continue;
    const size = estimateSize(t.columns.length);
    if (pos.x < minX) minX = pos.x;
    if (pos.y < minY) minY = pos.y;
    if (pos.x + size.width > maxX) maxX = pos.x + size.width;
    if (pos.y + size.height > maxY) maxY = pos.y + size.height;
  }
  if (!Number.isFinite(minX)) return;
  const rect = viewportEl.getBoundingClientRect();
  const availW = Math.max(1, rect.width - padding * 2);
  const availH = Math.max(1, rect.height - padding * 2);
  const worldW = Math.max(1, maxX - minX);
  const worldH = Math.max(1, maxY - minY);
  const zoom = clamp(Math.min(availW / worldW, availH / worldH), zoomMin, zoomMax);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const x = rect.width / 2 - cx * zoom;
  const y = rect.height / 2 - cy * zoom;
  store.getState().setViewport({ x, y, zoom });
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
