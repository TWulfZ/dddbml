import type { Waypoint } from '../../shared/types';
import { startEndpointDrag, deleteWaypoint, startWaypointInsert, startWaypointMove } from '../drag/dragController';
import { store } from '../state/store';
import { screenToWorld } from './viewport';
import type { Bbox } from './spatialIndex';

export interface WaypointInsert extends Waypoint { index: number }

export function startWaypointOnPath(
  id: string, spans: readonly (readonly Waypoint[])[], event: PointerEvent, target: SVGElement,
): void {
  const rect = target.closest('.ddd-viewport')?.getBoundingClientRect();
  const point = screenToWorld({ x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) });
  let closest: WaypointInsert | undefined;
  let distance = Infinity;
  spans.forEach((span, index) => {
    for (let i = 1; i < span.length; i++) {
      const a = span[i - 1]!, b = span[i]!;
      const dx = b.x - a.x, dy = b.y - a.y;
      const length = dx * dx + dy * dy;
      if (!length) continue;
      const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
      const x = a.x + t * dx, y = a.y + t * dy;
      const gap = Math.hypot(point.x - x, point.y - y);
      if (gap < distance) { distance = gap; closest = { x, y, index }; }
    }
  });
  if (closest) startWaypointInsert(id, closest.index, closest, event, target);
}

export function orthogonalInserts(spans: readonly (readonly Waypoint[])[]): WaypointInsert[] {
  return spans.flatMap((span, index) => {
    let longest = 0;
    let handle: WaypointInsert | undefined;
    for (let i = 1; i < span.length; i++) {
      const a = span[i - 1]!, b = span[i]!;
      const length = Math.hypot(a.x - b.x, a.y - b.y);
      if (length <= longest) continue;
      longest = length;
      handle = { index, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    return handle ? [handle] : [];
  });
}

export function WaypointHandles({ id, inserts, waypoints }: {
  id: string;
  inserts: readonly WaypointInsert[];
  waypoints: readonly Waypoint[];
}) {
  const canDrag = (event: PointerEvent): boolean => {
    const { panMode, spacePan } = store.getState();
    if (panMode || spacePan || event.button !== 0) return false;
    store.getState().setTooltip(null);
    return true;
  };
  return <>
    {inserts.map((handle) => <circle key={`insert-${handle.index}`} class="ddd-waypoint-insert"
      cx={handle.x} cy={handle.y} r={4} onPointerDown={(event) => {
        if (canDrag(event)) startWaypointInsert(id, handle.index, handle, event, event.currentTarget.ownerSVGElement!);
      }}><title>Drag to add a bend</title></circle>)}
    {waypoints.map((point, i) => <circle key={`point-${i}`} class="ddd-waypoint"
      cx={point.x} cy={point.y} r={5} onPointerDown={(event) => {
        if (canDrag(event)) startWaypointMove(id, i, event, event.currentTarget);
      }} onDblClick={(event) => {
        event.stopPropagation();
        deleteWaypoint(id, i);
      }}><title>Drag to move. Double-click to remove.</title></circle>)}
  </>;
}

export function EndpointHandles({ id, source, target, sourceBox, targetBox }: {
  id: string;
  source: Waypoint;
  target: Waypoint;
  sourceBox: Bbox;
  targetBox: Bbox;
}) {
  return <>{(['source', 'target'] as const).map((end) => {
    const point = end === 'source' ? source : target;
    return <circle key={end} class="ddd-movable-endpoint" cx={point.x} cy={point.y} r={5}
      onPointerDown={(event) => {
        store.getState().setTooltip(null);
        startEndpointDrag(id, end, end === 'source' ? sourceBox : targetBox, event, event.currentTarget, undefined, true);
      }}><title>Drag to move the {end} attachment</title></circle>;
  })}</>;
}
