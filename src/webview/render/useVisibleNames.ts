import { useEffect, useReducer, useRef } from 'preact/hooks';
import { store } from '../state/store';
import type { SpatialIndex } from './spatialIndex';
import type { QualifiedName } from '../../shared/types';
import type { ViewportLayout } from '../../shared/types';

/** Extra world-space margin around the viewport so nodes entering the screen are already mounted. */
export const VISIBILITY_MARGIN = 256;

export interface ViewportRect {
  w: number;
  h: number;
}

/** True when both sets hold exactly the same names (order-insensitive). */
export function sameNameSet(a: Set<QualifiedName> | null, b: Set<QualifiedName> | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const n of a) if (!b.has(n)) return false;
  return true;
}

function queryVisible(index: SpatialIndex, rect: ViewportRect, ready: boolean, vp: ViewportLayout): Set<QualifiedName> | null {
  if (!ready || rect.w === 0 || rect.h === 0) return null;
  return index.query({
    x: -vp.x / vp.zoom - VISIBILITY_MARGIN,
    y: -vp.y / vp.zoom - VISIBILITY_MARGIN,
    w: rect.w / vp.zoom + VISIBILITY_MARGIN * 2,
    h: rect.h / vp.zoom + VISIBILITY_MARGIN * 2,
  });
}

/**
 * Viewport culling that does NOT subscribe the component tree to `viewport`.
 *
 * Pan/zoom mutate `viewport` on every pointer frame; if the culled set were a `useMemo` on it, the
 * whole `App` (and every child that takes the set as a prop) would re-render per frame — the
 * "re-render full tree on each pan frame" anti-pattern of spec 04. Instead this hook listens to the
 * store directly and only re-renders its host when a table actually enters or leaves the visible
 * area. When the membership is unchanged it returns the *previous* Set instance, so downstream
 * memos (`visibleRefIds`, `visibleRoutes`) stay cached across frames.
 */
export function useVisibleNames(index: SpatialIndex, rect: ViewportRect, ready: boolean): Set<QualifiedName> | null {
  const [, force] = useReducer((c: number, _a: void) => c + 1, 0);
  const lastRef = useRef<Set<QualifiedName> | null>(null);
  const depsRef = useRef<[SpatialIndex, number, number, boolean] | null>(null);

  // Synchronous recompute when the non-viewport inputs change (new index after a move, resize,
  // ready flip). Refs are mutated during render on purpose: Preact renders synchronously, so this
  // is the cheapest way to keep the value coherent with the current inputs without an extra pass.
  const d = depsRef.current;
  if (!d || d[0] !== index || d[1] !== rect.w || d[2] !== rect.h || d[3] !== ready) {
    depsRef.current = [index, rect.w, rect.h, ready];
    const next = queryVisible(index, rect, ready, store.getState().viewport);
    if (!sameNameSet(lastRef.current, next)) lastRef.current = next;
  }

  useEffect(() => {
    return store.subscribe((s, prev) => {
      if (s.viewport === prev.viewport) return;
      const next = queryVisible(index, rect, ready, s.viewport);
      if (sameNameSet(lastRef.current, next)) return;
      lastRef.current = next;
      force();
    });
  }, [index, rect.w, rect.h, ready]);

  return lastRef.current;
}
