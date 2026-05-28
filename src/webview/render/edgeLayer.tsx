import { useRef, useState } from 'preact/hooks';
import type { QualifiedName, Ref, Schema, Waypoint } from '../../shared/types';
import { columnCenterY, estimateSize } from '../layout/autoLayout';
import { routeRefs, type EdgeRoute, type EdgeSegment } from './edgeRouter';
import type { Bbox } from './spatialIndex';
import { useAppStore } from '../state/store';
import { removeWaypoint, resetEdgeWaypoints, startSegmentAddWaypoint, startWaypointDrag } from '../drag/dragController';
import { ContextMenu, clampMenuAnchor } from './contextMenu';

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

interface GhostState {
  refId: string;
  segmentIndex: number;
  insertIndex: number;
  x: number;
  y: number;
}

interface ContextMenuState {
  refId: string;
  waypointIndex: number;
  screenX: number;
  screenY: number;
}

export function EdgeLayer({ refs, positions, tablesByName, groupSizes, worldBbox }: EdgeLayerProps) {
  const edgeLayouts = useAppStore((s) => s.edgeLayouts);
  const svgRef = useRef<SVGSVGElement>(null);
  const [ghost, setGhost] = useState<GhostState | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

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

  const pointToWorld = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const w = pt.matrixTransform(ctm.inverse());
    return { x: w.x, y: w.y };
  };

  const projectOnSegment = (p: { x: number; y: number }, seg: EdgeSegment): Waypoint => {
    if (seg.axis === 'h') {
      const minX = Math.min(seg.x1, seg.x2);
      const maxX = Math.max(seg.x1, seg.x2);
      return { x: Math.round(Math.max(minX, Math.min(maxX, p.x))), y: seg.y1 };
    }
    const minY = Math.min(seg.y1, seg.y2);
    const maxY = Math.max(seg.y1, seg.y2);
    return { x: seg.x1, y: Math.round(Math.max(minY, Math.min(maxY, p.y))) };
  };

  const insertIndexFor = (r: EdgeRoute, segIndex: number): number => {
    const seg = r.segments[segIndex];
    if (!seg) return r.waypoints.length;
    if (seg.endWaypointIndex !== null) return seg.endWaypointIndex;
    return r.waypoints.length;
  };

  const onSegmentMove = (r: EdgeRoute, segIndex: number, e: PointerEvent) => {
    const seg = r.segments[segIndex];
    if (!seg) return;
    const world = pointToWorld(e.clientX, e.clientY);
    if (!world) return;
    const proj = projectOnSegment(world, seg);
    setGhost({ refId: r.id, segmentIndex: segIndex, insertIndex: insertIndexFor(r, segIndex), x: proj.x, y: proj.y });
  };

  const onSegmentLeave = (r: EdgeRoute) => {
    setGhost((g) => (g && g.refId === r.id ? null : g));
  };

  const onSegmentPointerDown = (r: EdgeRoute, segIndex: number, e: PointerEvent) => {
    if (e.button !== 0) return;
    const seg = r.segments[segIndex];
    if (!seg) return;
    const world = pointToWorld(e.clientX, e.clientY);
    if (!world) return;
    const proj = projectOnSegment(world, seg);
    const insertIndex = insertIndexFor(r, segIndex);
    setGhost(null);
    startSegmentAddWaypoint(r.id, insertIndex, proj, e, e.currentTarget as SVGElement);
  };

  const onWaypointPointerDown = (r: EdgeRoute, waypointIndex: number, e: PointerEvent) => {
    if (e.button !== 0) return;
    startWaypointDrag(r.id, waypointIndex, e, e.currentTarget as SVGElement);
  };

  const onWaypointDblClick = (r: EdgeRoute, waypointIndex: number) => {
    removeWaypoint(r.id, waypointIndex);
  };

  const onWaypointContextMenu = (r: EdgeRoute, waypointIndex: number, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = clampMenuAnchor(e.clientX, e.clientY);
    setMenu({ refId: r.id, waypointIndex, screenX: x, screenY: y });
  };

  return (
    <>
      <svg
        ref={svgRef}
        class="ddd-edges"
        width={worldBbox.w}
        height={worldBbox.h}
        viewBox={`${worldBbox.x} ${worldBbox.y} ${worldBbox.w} ${worldBbox.h}`}
        style={{
          position: 'absolute',
          left: `${worldBbox.x}px`,
          top: `${worldBbox.y}px`,
        }}
      >
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
          return (
            <g key={r.id}>
              <path
                d={r.d}
                class="ddd-edge"
                marker-start={startMarker}
                marker-end={endMarker}
              />
              {r.segments.map((s, i) => (
                <line
                  key={`seg-${i}`}
                  class="ddd-edge-segment-handle"
                  x1={s.x1}
                  y1={s.y1}
                  x2={s.x2}
                  y2={s.y2}
                  stroke-width={SEGMENT_HOVER_THICKNESS}
                  onPointerEnter={(e) => onSegmentMove(r, i, e as unknown as PointerEvent)}
                  onPointerMove={(e) => onSegmentMove(r, i, e as unknown as PointerEvent)}
                  onPointerLeave={() => onSegmentLeave(r)}
                  onPointerDown={(e) => onSegmentPointerDown(r, i, e as unknown as PointerEvent)}
                />
              ))}
              {r.waypoints.map((w, i) => (
                <circle
                  key={`wp-${i}`}
                  class="ddd-edge-waypoint"
                  cx={w.x}
                  cy={w.y}
                  r={5}
                  onPointerDown={(e) => onWaypointPointerDown(r, i, e as unknown as PointerEvent)}
                  onDblClick={() => onWaypointDblClick(r, i)}
                  onContextMenu={(e) => onWaypointContextMenu(r, i, e as unknown as MouseEvent)}
                />
              ))}
              {ghost && ghost.refId === r.id ? (
                <circle
                  class="ddd-edge-waypoint--ghost"
                  cx={ghost.x}
                  cy={ghost.y}
                  r={5}
                />
              ) : null}
            </g>
          );
        })}
      </svg>
      {menu ? (
        <ContextMenu
          x={menu.screenX}
          y={menu.screenY}
          items={[
            {
              label: 'Remove waypoint',
              onClick: () => removeWaypoint(menu.refId, menu.waypointIndex),
            },
            {
              label: 'Reset edge waypoints',
              onClick: () => resetEdgeWaypoints(menu.refId),
              danger: true,
            },
          ]}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </>
  );
}
