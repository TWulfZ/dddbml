import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal, memo } from 'preact/compat';
import type { QualifiedName, Ref, RefDiffStatus } from '../../shared/types';
import { columnCenterY, estimateSize, headerCenterY } from '../layout/autoLayout';
import { densityMetrics } from '../layout/density';
import type { KeyedDepEdge } from './edgeKey';
import { DepMarkerDef, DepOverlay, DepPaths } from './depEdges';
import { DepRouteCache, depColor } from './depRouter';
import type { RowGeometry } from '../layout/tableRows';
import { EdgeRouteCache, isDipRun, type EdgeRoute, type ObstacleQuery } from './edgeRouter';
import type { Bbox } from './spatialIndex';
import type { LodLevel } from './lod';
import { routeReachBoxes, useVisibleEdgeIds, type ViewportRect } from './useVisibleNames';
import { store, useAppStore, isCanvasReadOnly } from '../state/store';
import { smallPositionsDelta } from '../state/positionsDelta';
import { startSegmentSlide, startNotchDrag, startEndpointDrag, resetEdgeWaypoints, readEdgeStyle, commitEdgeStyle, deleteEdgeNotch, flipLoopSide, forgetIgnoredShape } from '../drag/dragController';
import type { EdgeStyle } from '../state/history';
import { ColorPopup, popupAnchorFor } from './colorPopup';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { IconReset, IconSettings, IconSwap, IconTrash } from '../icons';
import { postToHost } from '../vscode';
import { ContextMenu, clampMenuAnchor } from './contextMenu';

interface GroupSize {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface EdgeLayerProps {
  /** ALL effective refs — routed once (memoized) and culled to `visibleRefIds` at render. */
  refs: Ref[];
  /** Parser `Ref.id` → edge key; deleting an edge names the ref by its parser id (spec 19). */
  refKeyByStableId: ReadonlyMap<string, string>;
  /** Ids of refs with ≥ 1 visible endpoint; `null` = render every route (e.g. before first cull). */
  visibleRefIds: Set<string> | null;
  /** The culling inputs: routes drawn outside their tables (C trunks, loops) are also culled on their own extent. */
  viewportRect: ViewportRect;
  ready: boolean;
  /** Current zoom LOD. `'rect'` (low zoom) → straight lines, no markers/dots/overlay. */
  lod: LodLevel;
  /** The store's table positions; collapsed group nodes are resolved from `groupSizes`. */
  positions: ReadonlyMap<QualifiedName, { x: number; y: number }>;
  /** Rendered rows per table (PK/FK filter, inline diff) — sizes and column ports follow these. */
  rows: RowGeometry;
  groupSizes?: GroupSize[];
  worldBbox: { x: number; y: number; w: number; h: number };
  /** Diff overlay (spec 16): composite edge key → status. Tints added refs. Null = not diffing. */
  refDiff?: Map<string, RefDiffStatus> | null;
  /** DBML `Dep` edges (spec 18), already remapped/keyed; culled by the same `visibleRefIds`. */
  deps: KeyedDepEdge[];
  /** The scene's rendered nodes, so an automatic C can leave a side a neighbour blocks (spec 05 §1). */
  obstacles?: ObstacleQuery;
}

const GROUP_PREFIX = '__group__:';
const SEGMENT_HOVER_THICKNESS = 14;
/** Runs shorter than this (world units) show no centre knob (still slidable by their hit line). */
const MIN_HANDLE_LEN = 16;
/** Runs shorter than this get no ¼/¾ ghost handles — too short to fit 3 knobs without overlap. */
const MIN_GHOST_LEN = 40;
/** Toolbar offset from the click point (screen px). Tweak to taste. */
const TOOLBAR_OFFSET_X = 10;
const TOOLBAR_OFFSET_Y = -40;

interface ColorPopupState {
  refId: string;
  x: number;
  y: number;
  before: EdgeStyle;
}

interface HoverState {
  refId: string;
  segIndex: number;
  /** Quarter handle nearest the cursor on the hovered run: 0.25 (first half) or 0.75 (second half). */
  near: number;
}

interface EdgeStrokeProps {
  route: EdgeRoute;
  edgeRef: Ref | undefined;
  color: string | undefined;
  diff: RefDiffStatus | undefined;
  focused: boolean;
  lowZoom: boolean;
}

// A loop's port-to-port line would lie on its own table border, so it keeps its shape.
const straightPath = (r: EdgeRoute) => (r.loop ? r.d : `M ${r.source.x} ${r.source.y} L ${r.target.x} ${r.target.y}`);

/**
 * One edge stroke in the shared base SVG. Memoized on the route object: a drag frame keeps every
 * route it cannot change by identity, so only the moved edges re-diff (spec 04).
 */
const EdgeStroke = memo(function EdgeStroke({ route: r, edgeRef: ref, color, diff, focused, lowZoom }: EdgeStrokeProps) {
  const diffCls = diff ? ` is-diff-${diff}` : '';
  const groupCls = `ddd-edge-group${focused ? ' is-focused' : ''}`;
  if (lowZoom) {
    // Bird's-eye: straight port-to-port line, no crow's-foot, no direction dots.
    return (
      <g class={groupCls}>
        <path d={straightPath(r)} class={`ddd-edge${diffCls}`} style={color ? { stroke: color } : undefined} />
      </g>
    );
  }
  const startMarker = ref?.source.relation === '*' ? 'url(#ddd-mk-many-s)' : 'url(#ddd-mk-one-s)';
  const endMarker = ref?.target.relation === '*' ? 'url(#ddd-mk-many)' : 'url(#ddd-mk-one)';
  return (
    <g class={groupCls} style={color ? { color } : undefined}>
      <path
        d={r.d}
        class={`ddd-edge${diffCls}`}
        style={color ? { stroke: color } : undefined}
        marker-start={startMarker}
        marker-end={endMarker}
      />
      {/* Direction dots (visual only): origin endpoint (PK) and destination endpoint (FK). */}
      <circle class="ddd-edge-end-dot is-source" cx={r.source.x} cy={r.source.y} r={3} />
      <circle class="ddd-edge-end-dot is-target" cx={r.target.x} cy={r.target.y} r={3} />
    </g>
  );
});

interface EdgeHitProps {
  route: EdgeRoute;
  color: string | undefined;
  hovered: boolean;
  onHover: (refId: string) => void;
  onUnhover: (refId: string) => void;
  onSelect: (refId: string, e: PointerEvent) => void;
}

/** Hit path (+ hover flow) of an unselected edge in the overlay SVG; memoized like EdgeStroke. */
const EdgeHit = memo(function EdgeHit({ route: r, color, hovered, onHover, onUnhover, onSelect }: EdgeHitProps) {
  return (
    <g data-edge={r.id} style={color ? { color } : undefined}>
      {hovered ? <path d={r.d} class="ddd-edge-flow" style={color ? { stroke: color } : undefined} /> : null}
      <path
        d={r.d}
        class="ddd-edge-hit"
        stroke-width={SEGMENT_HOVER_THICKNESS}
        onPointerEnter={() => onHover(r.id)}
        onPointerLeave={() => onUnhover(r.id)}
        onPointerDown={(e) => onSelect(r.id, e as unknown as PointerEvent)}
      />
    </g>
  );
});

interface SelectedEdgeRunsProps {
  route: EdgeRoute;
  hover: HoverState | null;
  onRunHover: (r: EdgeRoute, segIndex: number, e: PointerEvent) => void;
  onRunUnhover: (refId: string, segIndex: number) => void;
  onRunGrab: (r: EdgeRoute, segIndex: number, e: PointerEvent) => void;
  onSelect: (refId: string, e: PointerEvent) => void;
  onRunDblClick: (r: EdgeRoute, segIndex: number, e: PointerEvent) => void;
  onGhostDown: (r: EdgeRoute, segIndex: number, quarter: number, e: PointerEvent) => void;
}

/**
 * Per-run hit lines and slide/notch handles of the selected edge (spec 05 §8.3). Hook-free, so the
 * rendered controls can be inspected without a DOM.
 */
export function SelectedEdgeRuns({ route: r, hover, onRunHover, onRunUnhover, onRunGrab, onSelect, onRunDblClick, onGhostDown }: SelectedEdgeRunsProps) {
  return (
    <>
      {r.segments.map((s, i) => {
        const len = Math.abs(s.x2 - s.x1) + Math.abs(s.y2 - s.y1);
        const hot = hover?.refId === r.id && hover.segIndex === i;
        // Two-tier control (dbdiagram): each editable run carries a REAL blue vertex at its
        // CENTRE — drag it (or grab the run anywhere) to SLIDE the whole run perpendicular —
        // plus two GHOST grey knobs at ¼ / ¾ that appear on hover; dragging a ghost carves a
        // local symmetric notch (a NEW vertex) and the rest of the run stays flat. Drag is
        // 1-DOF perpendicular with an axis-aware resize cursor. Double-click a notch's
        // dip-run → delete it. Rigid stubs get nothing; corners stay rounded.
        // A loop's runs only keep it selectable: its sole edit is the side flip (spec 05 §Self-loops).
        // A run too short for a knob is still grabbed by its hit line: the halves of a close aligned
        // pair's midpoint division can be 10 px and must stay slidable (spec 05 §2).
        const editable = !r.loop && !s.rigid && len > 0;
        const showHandle = editable && len >= MIN_HANDLE_LEN;
        const showGhost = showHandle && len >= MIN_GHOST_LEN && hot;
        const axisClass = s.axis === 'h' ? 'is-h' : 'is-v';
        const at = (f: number) => ({ x: s.x1 + (s.x2 - s.x1) * f, y: s.y1 + (s.y2 - s.y1) * f });
        const mid = at(0.5);
        // Show only the ghost nearest the cursor (¼ for the first half, ¾ for the second).
        const nearF = hover?.near ?? 0.25;
        const ghost = at(nearF);
        return (
          // pointerenter/leave on the <g> treat the handles as part of the segment, so
          // moving from the line onto a handle doesn't drop the hover (no flicker).
          <g
            key={`seg-${i}`}
            onPointerEnter={(e) => onRunHover(r, i, e as unknown as PointerEvent)}
            onPointerLeave={() => onRunUnhover(r.id, i)}
          >
            <line
              class={`ddd-edge-segment-handle${editable ? ` ${axisClass}` : ''}`}
              x1={s.x1}
              y1={s.y1}
              x2={s.x2}
              y2={s.y2}
              stroke-width={SEGMENT_HOVER_THICKNESS}
              onPointerMove={(e) => { if (editable) onRunHover(r, i, e as unknown as PointerEvent); }}
              onPointerDown={(e) => {
                // Grab anywhere on an editable run → slide it perpendicular (selects + drags).
                if (editable) {
                  e.stopPropagation();
                  onRunGrab(r, i, e as unknown as PointerEvent);
                } else {
                  onSelect(r.id, e as unknown as PointerEvent);
                }
              }}
              onDblClick={(e) => onRunDblClick(r, i, e as unknown as PointerEvent)}
            />
            {showHandle ? (
              <circle
                class={`ddd-edge-handle ${axisClass}${hot ? ' is-hot' : ''}`}
                cx={mid.x}
                cy={mid.y}
                r={hot ? 6 : 5}
                onPointerDown={(e) => onRunGrab(r, i, e as unknown as PointerEvent)}
                onDblClick={(e) => onRunDblClick(r, i, e as unknown as PointerEvent)}
              />
            ) : null}
            {showGhost ? (
              <circle
                class={`ddd-edge-ghost ${axisClass}`}
                cx={ghost.x}
                cy={ghost.y}
                r={4}
                onPointerDown={(e) => onGhostDown(r, i, nearF, e as unknown as PointerEvent)}
              />
            ) : null}
          </g>
        );
      })}
    </>
  );
}

function EdgeLayerImpl({ refs, refKeyByStableId, visibleRefIds, viewportRect, ready, lod, positions, rows, groupSizes, worldBbox, refDiff, deps, obstacles }: EdgeLayerProps) {
  const density = useAppStore((s) => s.settings.ui.density);
  const edgeLayouts = useAppStore((s) => s.edgeLayouts);
  const selectedEdgeId = useAppStore((s) => s.selectedEdgeId);
  // Edges are faded by default; they reveal (full opacity) when their table or the edge is focused.
  const hoveredTable = useAppStore((s) => s.hoveredTable);
  const selection = useAppStore((s) => s.selection);
  const svgRef = useRef<SVGSVGElement>(null);
  const [colorPopup, setColorPopup] = useState<ColorPopupState | null>(null);
  // Merge / git overlay (spec 14/16): no edge selection, handles, toolbar or colour edits.
  const readOnly = useAppStore(isCanvasReadOnly);
  useEffect(() => {
    if (readOnly) setColorPopup(null);
  }, [readOnly]);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [clickPos, setClickPos] = useState<{ x: number; y: number } | null>(null);
  const [edgeMenu, setEdgeMenu] = useState<{ x: number; y: number; refId: string } | null>(null);
  const closeEdgeMenu = useCallback(() => setEdgeMenu(null), []);

  const groupByName = useMemo(() => {
    const m = new Map<string, GroupSize>();
    if (groupSizes) for (const g of groupSizes) m.set(g.name, g);
    return m;
  }, [groupSizes]);

  const bboxOf = (name: QualifiedName): Bbox | undefined => {
    if (name.startsWith(GROUP_PREFIX)) {
      const groupName = name.slice(GROUP_PREFIX.length);
      const g = groupByName.get(groupName);
      if (!g) return undefined;
      return { x: g.x, y: g.y, w: g.w, h: g.h };
    }
    const pos = positions.get(name);
    if (!pos) return undefined;
    const size = estimateSize(rows.count(name));
    return { x: pos.x, y: pos.y, w: size.width, h: size.height };
  };

  const columnY = (tableName: QualifiedName, column: string): number | undefined => {
    const idx = rows.indexOf(tableName, column);
    if (idx < 0) return undefined;
    return columnCenterY(idx);
  };

  // Route ALL refs, memoized on geometry/layout only — NOT on viewport (pan/zoom keep world
  // positions fixed → only the CSS transform changes) nor hover/selection (local state). This is
  // what makes edges scale to thousands of relations: routing is O(refs) once per move, not per
  // frame. The bboxOf/columnY closures read exactly the deps below, so the cached result is valid
  // whenever the memo recomputes. See spec 05 §8.
  // A positions-only delta recorded by the store (a drag frame) re-routes just the refs it can
  // change and keeps every other route object, so the memoized strokes below skip their diff.
  const [routeCache] = useState(() => new EdgeRouteCache());
  const routedRef = useRef<{ refs: Ref[]; positions: EdgeLayerProps['positions']; rows: RowGeometry; groupSizes?: GroupSize[]; edgeLayouts: typeof edgeLayouts; density: typeof density; obstacles?: ObstacleQuery } | null>(null);
  const routes = useMemo(() => {
    const prev = routedRef.current;
    routedRef.current = { refs, positions, rows, groupSizes, edgeLayouts, density, obstacles };
    const layoutOf = (id: string) => edgeLayouts.get(id);
    if (prev && prev.refs === refs && prev.rows === rows && prev.groupSizes === groupSizes && prev.edgeLayouts === edgeLayouts && prev.density === density && prev.obstacles === obstacles) {
      const moved = smallPositionsDelta(prev.positions, positions);
      if (moved) return routeCache.routeMoved(moved, bboxOf, columnY, layoutOf);
    }
    return routeCache.routeAll(refs, bboxOf, columnY, layoutOf, densityMetrics(density).rowHeight, obstacles);
  }, [refs, positions, rows, groupSizes, edgeLayouts, density, obstacles]);

  const [depRouteCache] = useState(() => new DepRouteCache());
  const depRoutedRef = useRef<{ deps: KeyedDepEdge[]; positions: EdgeLayerProps['positions']; rows: RowGeometry; groupSizes?: GroupSize[]; edgeLayouts: typeof edgeLayouts; density: typeof density } | null>(null);
  const depRoutes = useMemo(() => {
    const prev = depRoutedRef.current;
    depRoutedRef.current = { deps, positions, rows, groupSizes, edgeLayouts, density };
    const headerCenter = headerCenterY();
    const portY = (table: QualifiedName, columns: readonly string[], b: Bbox): number => {
      const y = columns[0] ? columnY(table, columns[0]) : undefined;
      return b.y + (y ?? headerCenter);
    };
    const layoutOf = (id: string) => edgeLayouts.get(id);
    if (prev && prev.deps === deps && prev.rows === rows && prev.groupSizes === groupSizes && prev.edgeLayouts === edgeLayouts && prev.density === density) {
      const moved = smallPositionsDelta(prev.positions, positions);
      if (moved) return depRouteCache.routeMoved(moved, bboxOf, portY, layoutOf);
    }
    return depRouteCache.routeAll(deps, bboxOf, portY, layoutOf);
  }, [deps, positions, rows, groupSizes, edgeLayouts, density]);
  const visibleDepRoutes = useMemo(
    () => (visibleRefIds ? depRoutes.filter((r) => visibleRefIds.has(r.id)) : depRoutes),
    [depRoutes, visibleRefIds],
  );
  const depById = useMemo(() => {
    const m = new Map<string, KeyedDepEdge>();
    for (const d of deps) m.set(d.id, d);
    return m;
  }, [deps]);

  // route-all-then-cull: render only the routes whose ref has a visible endpoint, or whose trunk is
  // on screen though both tables are not (the scene's edge boxes cannot see a nested trunk). `null` ⇒ all.
  const reachBoxes = useMemo(() => routeReachBoxes(routes), [routes]);
  const reachVisible = useVisibleEdgeIds(reachBoxes, viewportRect, ready);
  const visibleRoutes = useMemo(
    () => (visibleRefIds ? routes.filter((r) => visibleRefIds.has(r.id) || reachVisible?.has(r.id) === true) : routes),
    [routes, visibleRefIds, reachVisible],
  );

  // Low zoom (text illegible): draw each edge as a straight port-to-port line, no markers/dots,
  // and skip the interactive overlay entirely. See spec 05 §8.4.
  const lowZoom = lod === 'rect';

  const refById = useMemo(() => {
    const m = new Map<string, Ref>();
    for (const r of refs) m.set(r.id, r);
    return m;
  }, [refs]);

  const worldToScreen = (x: number, y: number): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = x;
    pt.y = y;
    const s = pt.matrixTransform(ctm);
    return { x: s.x, y: s.y };
  };

  const clientToWorldX = (clientX: number): number | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = 0;
    return pt.matrixTransform(ctm.inverse()).x;
  };

  const tableCenterX = (table: QualifiedName | undefined): number | null => {
    if (!table) return null;
    const b = bboxOf(table);
    return b ? b.x + b.w / 2 : null;
  };

  // Centre handle / run grab → SLIDE the whole run perpendicular (real blue vertex).
  const onSegmentSlideDown = (r: EdgeRoute, segIndex: number, e: PointerEvent) => {
    if (e.button !== 0) return;
    setClickPos({ x: e.clientX, y: e.clientY });
    store.getState().setSelectedEdge(r.id);
    startSegmentSlide(r, segIndex, e, e.currentTarget as SVGElement);
  };

  // Ghost handle at ¼ / ¾ → CREATE a local symmetric notch (ghost becomes a real vertex on release).
  const onGhostDown = (r: EdgeRoute, segIndex: number, quarter: number, e: PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setClickPos({ x: e.clientX, y: e.clientY });
    store.getState().setSelectedEdge(r.id);
    startNotchDrag(r, segIndex, quarter, e, e.currentTarget as SVGElement);
  };

  const onSegmentDblClick = (r: EdgeRoute, segIndex: number, e: PointerEvent) => {
    // Double-click a notch's dip-run to delete the whole notch (restore the flat run).
    if (!isDipRun(r, segIndex)) return;
    e.stopPropagation();
    deleteEdgeNotch(r, segIndex);
  };

  const onEndpointPointerDown = (r: EdgeRoute, end: 'source' | 'target', e: PointerEvent) => {
    if (e.button !== 0) return;
    const ref = refById.get(r.id);
    const cx = tableCenterX(end === 'source' ? ref?.source.table : ref?.target.table);
    if (cx === null) return;
    store.getState().setSelectedEdge(r.id);
    forgetIgnoredShape(r);
    startEndpointDrag(r.id, end, cx, e, e.currentTarget as SVGElement, clientToWorldX, r.loop === true);
  };

  // Stable identities so the memoized per-edge hit paths only re-render when their own route changes.
  const hoverEdge = useCallback((refId: string) => setHover({ refId, segIndex: -1, near: 0.25 }), []);
  const unhoverEdge = useCallback((refId: string) => setHover((h) => (h && h.refId === refId ? null : h)), []);
  const selectEdge = useCallback((refId: string, e: PointerEvent) => {
    e.stopPropagation();
    setClickPos({ x: e.clientX, y: e.clientY });
    store.getState().setSelectedEdge(refId);
  }, []);

  const clearHover = (refId: string, segIndex: number) =>
    setHover((h) => (h && h.refId === refId && h.segIndex === segIndex ? null : h));

  // While hovering a run, pick the ¼ or ¾ ghost nearest the cursor (only that one is shown). Projects
  // the pointer onto the run in screen space → first/second half. Re-renders only when the half flips.
  const updateHover = (r: EdgeRoute, segIndex: number, e: { clientX: number; clientY: number }) => {
    const s = r.segments[segIndex];
    let near = 0.25;
    if (s) {
      const a = worldToScreen(s.x1, s.y1);
      const b = worldToScreen(s.x2, s.y2);
      if (a && b) {
        const vx = b.x - a.x;
        const vy = b.y - a.y;
        const l2 = vx * vx + vy * vy;
        const t = l2 > 0 ? ((e.clientX - a.x) * vx + (e.clientY - a.y) * vy) / l2 : 0;
        near = t < 0.5 ? 0.25 : 0.75;
      }
    }
    setHover((h) =>
      h && h.refId === r.id && h.segIndex === segIndex && h.near === near
        ? h
        : { refId: r.id, segIndex, near },
    );
  };

  /** The single parser ref drawn as edge `key`; null when several refs share it (ambiguous delete). */
  const stableRefIdOf = (key: string): string | null => {
    let found: string | null = null;
    for (const [id, k] of refKeyByStableId) {
      if (k !== key) continue;
      if (found !== null) return null;
      found = id;
    }
    return found;
  };
  const deleteRelation = (key: string) => {
    const refId = stableRefIdOf(key);
    if (refId === null || isCanvasReadOnly(store.getState())) return;
    postToHost({ type: 'schema:delete', payload: { kind: 'ref', refId } });
  };
  const onOverlayContextMenu = (e: MouseEvent) => {
    const key = (e.target as Element).closest('[data-edge]')?.getAttribute('data-edge');
    if (!key) return;
    e.preventDefault();
    e.stopPropagation();
    setClickPos({ x: e.clientX, y: e.clientY });
    store.getState().setSelectedEdge(key);
    setEdgeMenu({ ...clampMenuAnchor(e.clientX, e.clientY, 200, 40), refId: key });
  };

  const selectedRoute = selectedEdgeId
    ? routes.find((r) => r.id === selectedEdgeId) ?? depRoutes.find((r) => r.id === selectedEdgeId) ?? null
    : null;
  // Screen anchor: click position + constant offset. Adjust TOOLBAR_OFFSET_X/Y at top of file.
  const toolbarPos = selectedRoute && clickPos
    ? { x: clickPos.x + TOOLBAR_OFFSET_X, y: clickPos.y + TOOLBAR_OFFSET_Y }
    : null;

  const svgSize = {
    width: worldBbox.w,
    height: worldBbox.h,
    viewBox: `${worldBbox.x} ${worldBbox.y} ${worldBbox.w} ${worldBbox.h}`,
  };
  const svgStyle = {
    position: 'absolute' as const,
    left: `${worldBbox.x}px`,
    top: `${worldBbox.y}px`,
  };

  return (
    <>
      {/* Base layer: edge strokes, arrowheads, direction dots. Painted behind the tables. */}
      <svg ref={svgRef} class="ddd-edges" {...svgSize} style={svgStyle}>
        <defs>
          <marker id="ddd-mk-many" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto">
            <path d="M2,2 L10,6 L2,10 M10,2 L10,10" fill="none" stroke="currentColor" stroke-width="1.2" />
          </marker>
          <marker id="ddd-mk-one" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto">
            <path d="M10,2 L10,10" fill="none" stroke="currentColor" stroke-width="1.4" />
          </marker>
          <marker id="ddd-mk-many-s" viewBox="0 0 12 12" refX="1" refY="6" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto">
            <path d="M10,2 L2,6 L10,10 M2,2 L2,10" fill="none" stroke="currentColor" stroke-width="1.2" />
          </marker>
          <marker id="ddd-mk-one-s" viewBox="0 0 12 12" refX="1" refY="6" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto">
            <path d="M2,2 L2,10" fill="none" stroke="currentColor" stroke-width="1.4" />
          </marker>
          <DepMarkerDef />
        </defs>
        {visibleRoutes.map((r) => {
          const diff = refDiff?.get(r.id);
          const ref = refById.get(r.id);
          const focused =
            diff != null || // a changed (added/removed) ref stays full in diff mode
            r.id === selectedEdgeId ||
            hover?.refId === r.id ||
            (hoveredTable != null && (ref?.source.table === hoveredTable || ref?.target.table === hoveredTable)) ||
            (ref != null && (selection.has(ref.source.table) || selection.has(ref.target.table)));
          return (
            <EdgeStroke
              key={r.id}
              route={r}
              edgeRef={ref}
              color={edgeLayouts.get(r.id)?.color}
              diff={diff}
              focused={focused}
              lowZoom={lowZoom}
            />
          );
        })}
        <DepPaths
          routes={visibleDepRoutes}
          depById={depById}
          edgeLayouts={edgeLayouts}
          lowZoom={lowZoom}
          isFocused={(d, id) =>
            id === selectedEdgeId ||
            (hoveredTable != null && (d.upstream.table === hoveredTable || d.downstream.table === hoveredTable)) ||
            selection.has(d.upstream.table) ||
            selection.has(d.downstream.table)}
        />
      </svg>

      {/* Overlay layer: interactive handles. z-index above tables so handles stay grabbable
          even where an edge crosses a table. SVG is pointer-transparent; only handles catch. */}
      <svg class="ddd-edges ddd-edges-overlay" {...svgSize} style={svgStyle} onContextMenu={onOverlayContextMenu}>
        {/* FK drag draft line (spec 19); `d` is written imperatively by fkDrag.ts, never by Preact. */}
        <path class="ddd-fk-draft" />
        {lowZoom || readOnly ? null : visibleRoutes.map((r) => {
          const selected = r.id === selectedEdgeId;
          const color = edgeLayouts.get(r.id)?.color;
          if (!selected) {
            return (
              <EdgeHit
                key={r.id}
                route={r}
                color={color}
                hovered={hover?.refId === r.id}
                onHover={hoverEdge}
                onUnhover={unhoverEdge}
                onSelect={selectEdge}
              />
            );
          }
          return (
            <g key={r.id} data-edge={r.id} style={color ? { color } : undefined}>
              {/* Selected highlight first, then the marching-dot flow ON TOP so it stays visible while
                  selected (the opaque highlight used to cover it). */}
              <path d={r.d} class="ddd-edge is-selected" style={color ? { stroke: color } : undefined} />
              <path d={r.d} class="ddd-edge-flow" style={color ? { stroke: color } : undefined} />
              {/* Interactive editing DOM (per-segment slide/ghost handles + endpoint flips) is built
                  ONLY for the selected edge — see spec 05 §8.3. Every other visible edge gets a single
                  transparent hit-path (EdgeHit) that handles select-on-click + hover-flow, instead of a
                  hit-line per segment. This is what keeps the overlay's node/listener count flat at
                  thousands of relations. */}
              <SelectedEdgeRuns
                route={r}
                hover={hover}
                onRunHover={updateHover}
                onRunUnhover={clearHover}
                onRunGrab={onSegmentSlideDown}
                onSelect={selectEdge}
                onRunDblClick={onSegmentDblClick}
                onGhostDown={onGhostDown}
              />
                {/* No handles on corners: bends are rounded turns (roundedPathString), and editing
                    is done via the segment-midpoint handles above. Only the 2 endpoints get a
                    handle (port-side flip). */}
                <circle
                  class="ddd-edge-endpoint"
                  cx={r.source.x}
                  cy={r.source.y}
                  r={5}
                  onPointerDown={(e) => onEndpointPointerDown(r, 'source', e as unknown as PointerEvent)}
                />
                <circle
                  class="ddd-edge-endpoint"
                  cx={r.target.x}
                  cy={r.target.y}
                  r={5}
                  onPointerDown={(e) => onEndpointPointerDown(r, 'target', e as unknown as PointerEvent)}
                />
            </g>
          );
        })}
        {lowZoom || readOnly ? null : (
          <DepOverlay
            routes={visibleDepRoutes}
            depById={depById}
            edgeLayouts={edgeLayouts}
            selectedId={selectedEdgeId}
            onSelect={(id, x, y) => {
              setClickPos({ x, y });
              store.getState().setSelectedEdge(id);
            }}
          />
        )}
      </svg>

      {selectedRoute && toolbarPos && !readOnly
        ? createPortal(
            <div
              class="ddd-edge-toolbar"
              style={{ left: `${toolbarPos.x}px`, top: `${toolbarPos.y}px` }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {'loop' in selectedRoute && selectedRoute.loop ? (
                <Tooltip label="Flip side">
                  <Button
                    variant="toolbar"
                    size="tool"
                    onClick={() => flipLoopSide(selectedRoute.id)}
                  >
                    <IconSwap size={13} />
                  </Button>
                </Tooltip>
              ) : (
                <Tooltip label="Reset line">
                  <Button
                    variant="toolbar"
                    size="tool"
                    onClick={() => resetEdgeWaypoints(selectedRoute.id)}
                  >
                    <IconReset size={13} />
                  </Button>
                </Tooltip>
              )}
              <Tooltip label="Edge color">
                <Button
                  variant="toolbar"
                  size="tool"
                  onClick={(e) => {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const { x, y } = popupAnchorFor(rect);
                    setColorPopup({ refId: selectedRoute.id, x, y, before: readEdgeStyle(selectedRoute.id) });
                  }}
                >
                  <IconSettings size={13} />
                </Button>
              </Tooltip>
              {refById.has(selectedRoute.id) ? (
                <Tooltip label="Delete relation">
                  <Button
                    variant="toolbar"
                    size="tool"
                    disabled={stableRefIdOf(selectedRoute.id) === null}
                    onClick={() => deleteRelation(selectedRoute.id)}
                  >
                    <IconTrash size={13} />
                  </Button>
                </Tooltip>
              ) : null}
            </div>,
            document.body,
          )
        : null}
      {edgeMenu && !readOnly ? (
        <ContextMenu
          x={edgeMenu.x}
          y={edgeMenu.y}
          items={[{ label: 'Delete relation', danger: true, disabled: stableRefIdOf(edgeMenu.refId) === null, onClick: () => deleteRelation(edgeMenu.refId) }]}
          onClose={closeEdgeMenu}
        />
      ) : null}
      {colorPopup && !readOnly ? (
        <ColorPopup
          current={depColor(depById.get(colorPopup.refId), edgeLayouts.get(colorPopup.refId)) ?? '#888888'}
          x={colorPopup.x}
          y={colorPopup.y}
          onPick={(c) => store.getState().setEdgeColor(colorPopup.refId, c)}
          onReset={() => store.getState().setEdgeColor(colorPopup.refId, null)}
          onClose={() => {
            commitEdgeStyle(colorPopup.refId, colorPopup.before, 'Edge color');
            setColorPopup(null);
          }}
        />
      ) : null}
    </>
  );
}

// memo: App re-renders on many store slices; this only re-renders via its own subscriptions.
export const EdgeLayer = memo(EdgeLayerImpl);
