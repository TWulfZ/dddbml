import { store } from '../state/store';
import { estimateSize } from '../layout/autoLayout';
import type { Bbox } from './spatialIndex';

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

/* ----- Diff-focus camera (merge conflict stepper, spec 14 §Tier-3) ----- */

const FOCUS_PADDING = 120; // screen px of breathing room around the framed diff
const FOCUS_DURATION_MS = 220; // ~--ddd-duration-medium
/** If fitting both ghosts would zoom out below this, hold a comfortable zoom on the midpoint instead. */
const COMFORTABLE_FLOOR = 0.45;
const COMFORTABLE_ZOOM = 0.8;

let focusRaf: number | null = null;

function viewportSize(): { width: number; height: number } | null {
  const el = document.querySelector('.ddd-viewport');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { width: r.width, height: r.height };
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Ease the viewport to a target over `duration` ms (easeOutCubic). Reduced-motion / 0ms → instant.
 *  Cancelable: a new call supersedes an in-flight tween so rapid next/prev never fights itself. */
export function animateViewport(target: { x: number; y: number; zoom: number }, duration = FOCUS_DURATION_MS): void {
  if (focusRaf !== null) { cancelAnimationFrame(focusRaf); focusRaf = null; }
  const setViewport = store.getState().setViewport;
  if (duration <= 0 || prefersReducedMotion()) { setViewport(target); return; }
  const start = { ...store.getState().viewport };
  const t0 = performance.now();
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);
  const tick = (now: number) => {
    const k = ease(Math.min(1, (now - t0) / duration));
    setViewport({
      x: start.x + (target.x - start.x) * k,
      y: start.y + (target.y - start.y) * k,
      zoom: start.zoom + (target.zoom - start.zoom) * k,
    });
    focusRaf = k < 1 ? requestAnimationFrame(tick) : null;
  };
  focusRaf = requestAnimationFrame(tick);
}

/** Center + zoom-to-fit a world bbox. Below the comfort floor it stops zooming out and just centers
 *  the midpoint at a fixed comfortable zoom (so a far-apart diff doesn't shrink to nothing). */
export function fitToBbox(bbox: Bbox, opts?: { padding?: number; animate?: boolean }): void {
  const size = viewportSize();
  if (!size) return;
  const padding = opts?.padding ?? FOCUS_PADDING;
  const { zoomMin, zoomMax } = store.getState().settings;
  const availW = Math.max(1, size.width - padding * 2);
  const availH = Math.max(1, size.height - padding * 2);
  let zoom = clamp(Math.min(availW / Math.max(1, bbox.w), availH / Math.max(1, bbox.h)), zoomMin, zoomMax);
  if (zoom < COMFORTABLE_FLOOR) zoom = clamp(COMFORTABLE_ZOOM, zoomMin, zoomMax);
  const cx = bbox.x + bbox.w / 2;
  const cy = bbox.y + bbox.h / 2;
  const target = { x: size.width / 2 - cx * zoom, y: size.height / 2 - cy * zoom, zoom };
  if (opts?.animate === false) store.getState().setViewport(target);
  else animateViewport(target);
}

/** Frame BOTH sides of a diff (union of the two table bboxes) so mine + theirs are visible at once. */
export function focusDiff(a: Bbox, b: Bbox, opts?: { padding?: number; animate?: boolean }): void {
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.w, b.x + b.w);
  const maxY = Math.max(a.y + a.h, b.y + b.h);
  fitToBbox({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, opts);
}
