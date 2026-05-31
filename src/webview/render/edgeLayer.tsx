import { useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { QualifiedName, Ref, RefDiffStatus, Schema } from '../../shared/types';
import { columnCenterY, estimateSize } from '../layout/autoLayout';
import { routeRefs, isDipRun, type EdgeRoute } from './edgeRouter';
import type { Bbox } from './spatialIndex';
import type { LodLevel } from './lod';
import { store, useAppStore } from '../state/store';
import { startSegmentSlide, startNotchDrag, startEndpointDrag, resetEdgeWaypoints, readEdgeStyle, commitEdgeStyle, deleteEdgeNotch } from '../drag/dragController';
import type { EdgeStyle } from '../state/history';
import { ColorPopup, popupAnchorFor } from './colorPopup';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { IconReset, IconSettings } from '../icons';

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
  /** Ids of refs with ≥ 1 visible endpoint; `null` = render every route (e.g. before first cull). */
  visibleRefIds: Set<string> | null;
  /** Current zoom LOD. `'rect'` (low zoom) → straight lines, no markers/dots/overlay. */
  lod: LodLevel;
  positions: Map<QualifiedName, { x: number; y: number }>;
  tablesByName: Map<QualifiedName, Schema['tables'][number]>;
  groupSizes?: GroupSize[];
  worldBbox: { x: number; y: number; w: number; h: number };
  /** Diff overlay (spec 16): composite edge key → status. Tints added refs. Null = not diffing. */
  refDiff?: Map<string, RefDiffStatus> | null;
}

const GROUP_PREFIX = '__group__:';
const SEGMENT_HOVER_THICKNESS = 14;
/** Runs shorter than this (world units) get no centre (slide) handle — avoids handles on tiny legs. */
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

export function EdgeLayer({ refs, visibleRefIds, lod, positions, tablesByName, groupSizes, worldBbox, refDiff }: EdgeLayerProps) {
  const edgeLayouts = useAppStore((s) => s.edgeLayouts);
  const selectedEdgeId = useAppStore((s) => s.selectedEdgeId);
  const svgRef = useRef<SVGSVGElement>(null);
  const [colorPopup, setColorPopup] = useState<ColorPopupState | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [clickPos, setClickPos] = useState<{ x: number; y: number } | null>(null);

  const groupByName = new Map<string, GroupSize>();
  if (groupSizes) for (const g of groupSizes) groupByName.set(g.name, g);

  const bboxOf = (name: QualifiedName): Bbox | undefined => {
    if (name.startsWith(GROUP_PREFIX)) {
      const groupName = name.slice(GROUP_PREFIX.length);
      const g = groupByName.get(groupName);
      if (!g) return undefined;
      return { x: g.x, y: g.y, w: g.w, h: g.h };
    }
    const pos = positions.get(name);
    if (!pos) return undefined;
    const t = tablesByName.get(name);
    const size = estimateSize(t?.columns.length ?? 0);
    return { x: pos.x, y: pos.y, w: size.width, h: size.height };
  };

  const columnY = (tableName: QualifiedName, column: string): number | undefined => {
    const t = tablesByName.get(tableName);
    if (!t) return undefined;
    const idx = t.columns.findIndex((c) => c.name === column);
    if (idx < 0) return undefined;
    return columnCenterY(idx);
  };

  // Route ALL refs, memoized on geometry/layout only — NOT on viewport (pan/zoom keep world
  // positions fixed → only the CSS transform changes) nor hover/selection (local state). This is
  // what makes edges scale to thousands of relations: routing is O(refs) once per move, not per
  // frame. The bboxOf/columnY closures read exactly the deps below, so the cached result is valid
  // whenever the memo recomputes. See spec 05 §8.
  const routes = useMemo(
    () => routeRefs(refs, bboxOf, columnY, (id) => edgeLayouts.get(id)),
    [refs, positions, tablesByName, groupSizes, edgeLayouts],
  );

  // route-all-then-cull: render only the routes whose ref has a visible endpoint. `null` ⇒ all.
  const visibleRoutes = useMemo(
    () => (visibleRefIds ? routes.filter((r) => visibleRefIds.has(r.id)) : routes),
    [routes, visibleRefIds],
  );

  // Low zoom (text illegible): draw each edge as a straight port-to-port line, no markers/dots,
  // and skip the interactive overlay entirely. See spec 05 §8.4.
  const lowZoom = lod === 'rect';
  const straightPath = (r: EdgeRoute) => `M ${r.source.x} ${r.source.y} L ${r.target.x} ${r.target.y}`;

  const refById = new Map<string, Ref>();
  for (const r of refs) refById.set(r.id, r);

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
    startEndpointDrag(r.id, end, cx, e, e.currentTarget as SVGElement, clientToWorldX);
  };

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

  const selectedRoute = selectedEdgeId ? routes.find((r) => r.id === selectedEdgeId) ?? null : null;
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
        </defs>
        {visibleRoutes.map((r) => {
          const color = edgeLayouts.get(r.id)?.color;
          const diff = refDiff?.get(r.id);
          const diffCls = diff ? ` is-diff-${diff}` : '';
          if (lowZoom) {
            // Bird's-eye: straight port-to-port line, no crow's-foot, no direction dots.
            return <path key={r.id} d={straightPath(r)} class={`ddd-edge${diffCls}`} style={color ? { stroke: color } : undefined} />;
          }
          const ref = refById.get(r.id);
          const startMarker = ref?.source.relation === '*' ? 'url(#ddd-mk-many-s)' : 'url(#ddd-mk-one-s)';
          const endMarker = ref?.target.relation === '*' ? 'url(#ddd-mk-many)' : 'url(#ddd-mk-one)';
          return (
            <g key={r.id} style={color ? { color } : undefined}>
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
        })}
      </svg>

      {/* Overlay layer: interactive handles. z-index above tables so handles stay grabbable
          even where an edge crosses a table. SVG is pointer-transparent; only handles catch. */}
      <svg class="ddd-edges ddd-edges-overlay" {...svgSize} style={svgStyle}>
        {lowZoom ? null : visibleRoutes.map((r) => {
          const selected = r.id === selectedEdgeId;
          const color = edgeLayouts.get(r.id)?.color;
          return (
            <g key={r.id} style={color ? { color } : undefined}>
              {/* Selected highlight first, then the marching-dot flow ON TOP so it stays visible while
                  selected (the opaque highlight used to cover it). Flow shows on hover and selected. */}
              {selected ? (
                <path d={r.d} class="ddd-edge is-selected" style={color ? { stroke: color } : undefined} />
              ) : null}
              {selected || hover?.refId === r.id ? (
                <path d={r.d} class="ddd-edge-flow" style={color ? { stroke: color } : undefined} />
              ) : null}
              {/* Interactive editing DOM (per-segment slide/ghost handles + endpoint flips) is built
                  ONLY for the selected edge — see spec 05 §8.3. Every other visible edge gets a single
                  transparent hit-path that handles select-on-click + hover-flow, instead of a hit-line
                  per segment. This is what keeps the overlay's node/listener count flat at thousands
                  of relations. */}
              {selected ? (
                <>
              {r.segments.map((s, i) => {
                const len = Math.abs(s.x2 - s.x1) + Math.abs(s.y2 - s.y1);
                const hot = hover?.refId === r.id && hover.segIndex === i;
                // Two-tier control (dbdiagram): each editable run carries a REAL blue vertex at its
                // CENTRE — drag it (or grab the run anywhere) to SLIDE the whole run perpendicular —
                // plus two GHOST grey knobs at ¼ / ¾ that appear on hover; dragging a ghost carves a
                // local symmetric notch (a NEW vertex) and the rest of the run stays flat. Drag is
                // 1-DOF perpendicular with an axis-aware resize cursor. Double-click a notch's
                // dip-run → delete it. Rigid stubs / tiny legs get nothing; corners stay rounded.
                const editable = selected && !s.rigid && len >= MIN_HANDLE_LEN;
                const showGhost = editable && len >= MIN_GHOST_LEN && hot;
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
                    onPointerEnter={(e) => updateHover(r, i, e as unknown as PointerEvent)}
                    onPointerLeave={() => clearHover(r.id, i)}
                  >
                    <line
                      class={`ddd-edge-segment-handle${editable ? ` ${axisClass}` : ''}`}
                      x1={s.x1}
                      y1={s.y1}
                      x2={s.x2}
                      y2={s.y2}
                      stroke-width={SEGMENT_HOVER_THICKNESS}
                      onPointerMove={(e) => { if (editable) updateHover(r, i, e as unknown as PointerEvent); }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        if (editable) {
                          // Grab anywhere on the run → slide it perpendicular (selects + drags).
                          onSegmentSlideDown(r, i, e as unknown as PointerEvent);
                        } else {
                          setClickPos({ x: e.clientX, y: e.clientY });
                          store.getState().setSelectedEdge(r.id);
                        }
                      }}
                      onDblClick={(e) => onSegmentDblClick(r, i, e as unknown as PointerEvent)}
                    />
                    {editable ? (
                      <circle
                        class={`ddd-edge-handle ${axisClass}${hot ? ' is-hot' : ''}`}
                        cx={mid.x}
                        cy={mid.y}
                        r={hot ? 6 : 5}
                        onPointerDown={(e) => onSegmentSlideDown(r, i, e as unknown as PointerEvent)}
                        onDblClick={(e) => onSegmentDblClick(r, i, e as unknown as PointerEvent)}
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
                </>
              ) : (
                <path
                  d={r.d}
                  class="ddd-edge-hit"
                  stroke-width={SEGMENT_HOVER_THICKNESS}
                  onPointerEnter={() => setHover({ refId: r.id, segIndex: -1, near: 0.25 })}
                  onPointerLeave={() => setHover((h) => (h && h.refId === r.id ? null : h))}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setClickPos({ x: e.clientX, y: e.clientY });
                    store.getState().setSelectedEdge(r.id);
                  }}
                />
              )}
            </g>
          );
        })}
      </svg>

      {selectedRoute && toolbarPos
        ? createPortal(
            <div
              class="ddd-edge-toolbar"
              style={{ left: `${toolbarPos.x}px`, top: `${toolbarPos.y}px` }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <Tooltip label="Reset line">
                <Button
                  variant="toolbar"
                  size="tool"
                  onClick={() => resetEdgeWaypoints(selectedRoute.id)}
                >
                  <IconReset size={13} />
                </Button>
              </Tooltip>
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
            </div>,
            document.body,
          )
        : null}
      {colorPopup ? (
        <ColorPopup
          current={edgeLayouts.get(colorPopup.refId)?.color ?? '#888888'}
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
