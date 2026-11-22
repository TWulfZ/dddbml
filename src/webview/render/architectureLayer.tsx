import { useEffect, useRef } from 'preact/hooks';
import { gridSnapper } from '../layout/grid';
import type { ArchitectureScene, Point } from '../layout/architectureLayout';
import { schedulePersist } from '../persistence';
import { buildMoveCommand } from '../state/history';
import { isCanvasReadOnly, store, useAppStore } from '../state/store';
import { architectureCanvasPalette, renderArchitecture } from './architectureSvg';
import { EndpointHandles, orthogonalInserts, startWaypointOnPath, WaypointHandles } from './waypointHandles';
import { EdgeActions, useEdgeActions } from './edgeActions';
import type { Bbox } from './spatialIndex';

interface Drag {
  pointer: number;
  start: Point;
  zoom: number;
  origins: Map<string, Point>;
  moved: boolean;
}

export function ArchitectureLayer({ scene, bounds, printing }: { scene: ArchitectureScene; bounds: Bbox; printing: boolean }) {
  const selection = useAppStore((s) => s.selection);
  const selectedId = useAppStore((s) => s.selectedEdgeId);
  const editable = useAppStore((s) => !s.panMode && !s.spacePan && !isCanvasReadOnly(s));
  const { anchor, closeMenu, contextMenu, select } = useEdgeActions();
  const selectedRoute = scene.routes.find((route) => route.link.id === selectedId);
  const drag = useRef<Drag | null>(null);
  const cancel = () => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if (active.moved) store.getState().setArchitecturePositions([...active.origins]);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return <><svg class="ddd-architecture-surface" width={bounds.w} height={bounds.h}
    viewBox={`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`}
    style={{ left: bounds.x, top: bounds.y }}
    onContextMenu={contextMenu}
    onPointerDown={(event) => {
      const state = store.getState();
      if (event.button !== 0 || state.panMode || state.spacePan || isCanvasReadOnly(state)) return;
      const id = itemId(event.target);
      if (!id) return;
      event.stopPropagation();
      const nextSelection = event.shiftKey ? new Set([...state.selection, id]) : state.selection.has(id) ? state.selection : new Set([id]);
      state.setSelectedEdge(null);
      state.setSelection(nextSelection);
      const groups = new Map(scene.groups.map((group) => [group.id, group]));
      const positions = new Map<string, Point>([...scene.nodes, ...scene.groups].map((item) => [item.id, { x: item.x, y: item.y }]));
      for (const note of scene.notes) positions.set(note.layoutKey, { x: note.x, y: note.y });
      const keys = new Set([...nextSelection].flatMap((key) => groups.get(key)?.movable ?? [key]));
      const origins = new Map([...keys].flatMap((key) => positions.has(key) ? [[key, positions.get(key)!] as const] : []));
      drag.current = { pointer: event.pointerId, start: { x: event.clientX, y: event.clientY }, zoom: state.viewport.zoom, origins, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      const active = drag.current;
      if (!active || active.pointer !== event.pointerId) return;
      if (isCanvasReadOnly(store.getState())) { drag.current = null; return; }
      const dx = event.clientX - active.start.x, dy = event.clientY - active.start.y;
      if (!active.moved && Math.hypot(dx, dy) < 3) return;
      active.moved = true;
      // Snap the translation rather than each member to preserve relative group spacing.
      const snap = gridSnapper();
      store.getState().setArchitecturePositions([...active.origins].map(([key, p]) => [key, {
        x: p.x + snap(dx / active.zoom), y: p.y + snap(dy / active.zoom),
      }]));
    }}
    onPointerUp={(event) => {
      const active = drag.current;
      if (!active || active.pointer !== event.pointerId) return;
      drag.current = null;
      if (!active.moved || isCanvasReadOnly(store.getState())) return;
      const state = store.getState();
      const positions = new Map(state.positions);
      for (const key of active.origins.keys()) {
        const label = state.labelLayouts[key];
        if (key.startsWith('note:') && label?.x !== undefined && label.y !== undefined) positions.set(key, { x: label.x, y: label.y });
      }
      const command = buildMoveCommand(active.origins, positions);
      if (command) {
        state.pushMoveCommand({ ...command, label: 'Move architecture elements' });
        schedulePersist();
      }
    }}
    onLostPointerCapture={cancel}
    onPointerCancel={cancel}
    onKeyDown={(event) => {
      const id = itemId(event.target);
      if (id && event.key === 'Enter') store.getState().setSelection([id]);
    }}>
      {editable && scene.routes.map((route) => {
        const id = route.link.id;
        const selected = selectedId === id;
        return <g key={id} data-edge={id}>
          {selected && <path d={route.d} class="ddd-architecture-link-selected" />}
          <path d={route.d} class="ddd-waypoint-hit" stroke-width={14} onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            select(id, event.clientX, event.clientY);
            startWaypointOnPath(id, route.spans, event, event.currentTarget.ownerSVGElement!);
          }} />
        </g>;
      })}
      <g dangerouslySetInnerHTML={{ __html: renderArchitecture(scene, architectureCanvasPalette, printing, selection) }} />
      {editable && scene.routes.filter(({ link }) => link.id === selectedId).map((route) =>
        <g key={route.link.id}>
          <WaypointHandles id={route.link.id} inserts={orthogonalInserts(route.spans)} waypoints={route.waypoints} />
          <EndpointHandles id={route.link.id} source={route.corners[0]!} target={route.corners[route.corners.length - 1]!}
            sourceBox={route.sourceBox} targetBox={route.targetBox} />
        </g>)}
    </svg>
    <EdgeActions id={selectedRoute?.link.id} anchor={anchor} closeMenu={closeMenu}
      color={(id) => scene.routes.find((route) => route.link.id === id)?.color} />
  </>;
}

function itemId(target: EventTarget | null): string | null {
  return target instanceof Element ? target.closest('[data-arch-id]')?.getAttribute('data-arch-id') ?? null : null;
}
