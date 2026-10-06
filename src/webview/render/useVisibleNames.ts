import { useEffect, useReducer, useRef } from 'preact/hooks';
import { store } from '../state/store';
import type { Bbox, SpatialIndex } from './spatialIndex';
import type { QualifiedName } from '../../shared/types';
import type { ViewportLayout } from '../../shared/types';
import type { EdgeRoute } from './edgeRouter';

/** Extra world-space margin around the viewport so nodes entering the screen are already mounted. */
export const VISIBILITY_MARGIN = 256;

export interface ViewportRect {
  w: number;
  h: number;
}

/** World-space box an edge can occupy (endpoint nodes ∪ waypoints), used for edge culling. */
export interface EdgeBox {
  id: string;
  bbox: Bbox;
}

/**
 * Drawn extent of every route that can leave its tables' union, which is all an `EdgeBox` from the
 * scene knows: a C's trunk (nested outside loops and other Cs, spec 05 §1) and a self-loop's.
 */
export function routeReachBoxes(routes: readonly EdgeRoute[]): EdgeBox[] {
  const out: EdgeBox[] = [];
  for (const r of routes) {
    const out1 = Math.sign(r.sourceStub.x - r.source.x);
    if (!r.loop && (out1 === 0 || out1 !== Math.sign(r.targetStub.x - r.target.x))) continue;
    let minX = Math.min(r.source.x, r.target.x);
    let maxX = Math.max(r.source.x, r.target.x);
    let minY = Math.min(r.source.y, r.target.y);
    let maxY = Math.max(r.source.y, r.target.y);
    for (const s of r.segments) {
      minX = Math.min(minX, s.x1, s.x2);
      maxX = Math.max(maxX, s.x1, s.x2);
      minY = Math.min(minY, s.y1, s.y2);
      maxY = Math.max(maxY, s.y1, s.y2);
    }
    out.push({ id: r.id, bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } });
  }
  return out;
}

/** True when both sets hold exactly the same names (order-insensitive). */
export function sameNameSet(a: Set<QualifiedName> | null, b: Set<QualifiedName> | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const n of a) if (!b.has(n)) return false;
  return true;
}

/** The culling query: the visible world rect grown by VISIBILITY_MARGIN; null while unmeasured. */
export function cullingBox(rect: ViewportRect, ready: boolean, vp: ViewportLayout): Bbox | null {
  if (!ready || rect.w === 0 || rect.h === 0) return null;
  return {
    x: -vp.x / vp.zoom - VISIBILITY_MARGIN,
    y: -vp.y / vp.zoom - VISIBILITY_MARGIN,
    w: rect.w / vp.zoom + VISIBILITY_MARGIN * 2,
    h: rect.h / vp.zoom + VISIBILITY_MARGIN * 2,
  };
}

/**
 * Ids of the edges whose box intersects `query`. A linear scan on purpose: an edge's box spans the
 * whole distance between its tables, so a grid index would register long edges in hundreds of
 * cells on every rebuild, while ~1000 rect tests per camera frame cost microseconds.
 */
export function visibleEdgeIds(boxes: ReadonlyArray<EdgeBox>, query: Bbox): Set<string> {
  const out = new Set<string>();
  const qx1 = query.x + query.w;
  const qy1 = query.y + query.h;
  for (const { id, bbox: b } of boxes) {
    if (b.x + b.w < query.x || b.x > qx1 || b.y + b.h < query.y || b.y > qy1) continue;
    out.add(id);
  }
  return out;
}

/**
 * Viewport culling that does NOT subscribe the component tree to `viewport`.
 *
 * Pan/zoom mutate `viewport` on every pointer frame; if the culled set were a `useMemo` on it, the
 * whole `App` (and every child that takes the set as a prop) would re-render per frame — the
 * "re-render full tree on each pan frame" anti-pattern of spec 04. Instead this hook listens to the
 * store directly and only re-renders its host when an item actually enters or leaves the visible
 * area. When the membership is unchanged it returns the *previous* Set instance, so downstream
 * memos (`visibleRoutes`) stay cached across frames.
 */
function useCulledSet<S>(
  source: S,
  query: (source: S, box: Bbox) => Set<string>,
  rect: ViewportRect,
  ready: boolean,
  revision = 0,
): Set<string> | null {
  const [, force] = useReducer((c: number, _a: void) => c + 1, 0);
  const lastRef = useRef<Set<string> | null>(null);
  const depsRef = useRef<[S, number, number, boolean, number] | null>(null);
  const run = (vp: ViewportLayout): Set<string> | null => {
    const box = cullingBox(rect, ready, vp);
    return box ? query(source, box) : null;
  };

  // Synchronous recompute when the non-viewport inputs change (new or mutated source after a move,
  // resize, ready flip). Refs are mutated during render on purpose: Preact renders synchronously, so this
  // is the cheapest way to keep the value coherent with the current inputs without an extra pass.
  const d = depsRef.current;
  if (!d || d[0] !== source || d[1] !== rect.w || d[2] !== rect.h || d[3] !== ready || d[4] !== revision) {
    depsRef.current = [source, rect.w, rect.h, ready, revision];
    const next = run(store.getState().viewport);
    if (!sameNameSet(lastRef.current, next)) lastRef.current = next;
  }

  useEffect(() => {
    return store.subscribe((s, prev) => {
      if (s.viewport === prev.viewport) return;
      const next = run(s.viewport);
      if (sameNameSet(lastRef.current, next)) return;
      lastRef.current = next;
      force();
    });
  }, [source, rect.w, rect.h, ready]);

  return lastRef.current;
}

const queryIndex = (index: SpatialIndex, box: Bbox) => index.query(box);

/**
 * Culled node names (tables, collapsed groups, containers) from the spatial index. A drag moves
 * entries of the same index instance in place, so its `version` is part of the cache key.
 */
export function useVisibleNames(index: SpatialIndex, rect: ViewportRect, ready: boolean): Set<QualifiedName> | null {
  return useCulledSet(index, queryIndex, rect, ready, index.version);
}

/** Culled edge ids: an edge stays mounted while its box crosses the viewport, even with both tables off-screen. */
export function useVisibleEdgeIds(boxes: ReadonlyArray<EdgeBox>, rect: ViewportRect, ready: boolean): Set<string> | null {
  return useCulledSet(boxes, visibleEdgeIds, rect, ready);
}
