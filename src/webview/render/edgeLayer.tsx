import { useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { QualifiedName, Ref, Schema } from '../../shared/types';
import { columnCenterY, estimateSize } from '../layout/autoLayout';
import { routeRefs, type EdgeRoute } from './edgeRouter';
import type { Bbox } from './spatialIndex';
import { store, useAppStore } from '../state/store';
import { startSegmentDrag, startEndpointDrag, resetEdgeWaypoints, readEdgeStyle, commitEdgeStyle } from '../drag/dragController';
import type { EdgeStyle } from '../state/history';
import { ColorPopup, popupAnchorFor } from './colorPopup';
import { IconReset, IconSettings } from '../icons';

interface GroupSize {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface EdgeLayerProps {
  refs: Ref[];
  positions: Map<QualifiedName, { x: number; y: number }>;
  tablesByName: Map<QualifiedName, Schema['tables'][number]>;
  groupSizes?: GroupSize[];
  worldBbox: { x: number; y: number; w: number; h: number };
}

const GROUP_PREFIX = '__group__:';
const SEGMENT_HOVER_THICKNESS = 14;
/** Segments shorter than this (world units) get no drag grip — avoids grips on tiny legs. */
const MIN_GRIP_LEN = 24;
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
}

export function EdgeLayer({ refs, positions, tablesByName, groupSizes, worldBbox }: EdgeLayerProps) {
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

  const routes = routeRefs(refs, bboxOf, columnY, (id) => edgeLayouts.get(id));

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

  const onSegmentPointerDown = (r: EdgeRoute, segIndex: number, e: PointerEvent) => {
    if (e.button !== 0) return;
    setClickPos({ x: e.clientX, y: e.clientY });
    store.getState().setSelectedEdge(r.id);
    startSegmentDrag(r, segIndex, e, e.currentTarget as SVGElement);
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
        {routes.map((r) => {
          const ref = refById.get(r.id);
          const startMarker = ref?.source.relation === '*' ? 'url(#ddd-mk-many-s)' : 'url(#ddd-mk-one-s)';
          const endMarker = ref?.target.relation === '*' ? 'url(#ddd-mk-many)' : 'url(#ddd-mk-one)';
          const color = edgeLayouts.get(r.id)?.color;
          return (
            <g key={r.id} style={color ? { color } : undefined}>
              <path
                d={r.d}
                class="ddd-edge"
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
        {routes.map((r) => {
          const selected = r.id === selectedEdgeId;
          const color = edgeLayouts.get(r.id)?.color;
          return (
            <g key={r.id} style={color ? { color } : undefined}>
              {selected ? (
                <path d={r.d} class="ddd-edge is-selected" style={color ? { stroke: color } : undefined} />
              ) : null}
              {r.segments.map((s, i) => {
                const len = Math.abs(s.x2 - s.x1) + Math.abs(s.y2 - s.y1);
                const showGhost = hover?.refId === r.id && hover.segIndex === i && len >= MIN_GRIP_LEN;
                return (
                  // pointerenter/leave on the <g> treat the grip as part of the segment, so
                  // moving from the line onto the ghost grip doesn't drop the hover (no flicker).
                  <g
                    key={`seg-${i}`}
                    onPointerEnter={() => setHover({ refId: r.id, segIndex: i })}
                    onPointerLeave={() => clearHover(r.id, i)}
                  >
                    <line
                      class="ddd-edge-segment-handle"
                      x1={s.x1}
                      y1={s.y1}
                      x2={s.x2}
                      y2={s.y2}
                      stroke-width={SEGMENT_HOVER_THICKNESS}
                      onPointerDown={(e) => { e.stopPropagation(); setClickPos({ x: e.clientX, y: e.clientY }); store.getState().setSelectedEdge(r.id); }}
                    />
                    {showGhost ? (
                      <circle
                        class={`ddd-edge-grip is-ghost ${s.axis === 'h' ? 'is-h' : 'is-v'}`}
                        cx={(s.x1 + s.x2) / 2}
                        cy={(s.y1 + s.y2) / 2}
                        r={5}
                        onPointerDown={(e) => onSegmentPointerDown(r, i, e as unknown as PointerEvent)}
                      />
                    ) : null}
                  </g>
                );
              })}
              {selected ? (
                <>
                  {r.waypoints.map((w, i) => (
                    <circle key={`wp-${i}`} class="ddd-edge-vertex" cx={w.x} cy={w.y} r={4} />
                  ))}
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
              ) : null}
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
              <button
                class="ddd-edge-toolbar__btn"
                title="Reset line"
                onClick={() => resetEdgeWaypoints(selectedRoute.id)}
              >
                <IconReset size={13} />
              </button>
              <button
                class="ddd-edge-toolbar__btn"
                title="Edge color"
                onClick={(e) => {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const { x, y } = popupAnchorFor(rect);
                  setColorPopup({ refId: selectedRoute.id, x, y, before: readEdgeStyle(selectedRoute.id) });
                }}
              >
                <IconSettings size={13} />
              </button>
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
