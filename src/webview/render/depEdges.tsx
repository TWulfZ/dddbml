import { useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import type { EdgeLayout, QualifiedName } from '../../shared/types';
import type { KeyedDepEdge } from './edgeKey';
import { depColor, type DepRoute } from './depRouter';
import { store } from '../state/store';
import { deleteDepWaypoint, startDepWaypointInsert, startDepWaypointMove } from '../drag/dragController';

const HIT_THICKNESS = 14;
const GROUP_PREFIX = '__group__:';

/** Arrow marker for dep edges; lives in the edge layer's single `<defs>`. */
export function DepMarkerDef() {
  return (
    <marker id="ddd-mk-dep" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
      <path d="M1,1 L9,5 L1,9 Z" fill="currentColor" />
    </marker>
  );
}

interface DepPathsProps {
  routes: DepRoute[];
  depById: Map<string, KeyedDepEdge>;
  edgeLayouts: Map<string, EdgeLayout>;
  lowZoom: boolean;
  isFocused: (dep: KeyedDepEdge, id: string) => boolean;
}

interface DepStrokeProps {
  route: DepRoute;
  color: string | undefined;
  focused: boolean;
  lowZoom: boolean;
}

/** Memoized on the route object like `EdgeStroke`: a drag frame only re-diffs the deps it re-routed. */
const DepStroke = memo(function DepStroke({ route: r, color, focused, lowZoom }: DepStrokeProps) {
  return (
    <g class={`ddd-dep-group${focused ? ' is-focused' : ''}`} style={color ? { color } : undefined}>
      <path
        d={lowZoom ? `M ${r.source.x} ${r.source.y} L ${r.target.x} ${r.target.y}` : r.d}
        class="ddd-dep"
        marker-end={lowZoom ? undefined : 'url(#ddd-mk-dep)'}
      />
    </g>
  );
});

/** Base-layer strokes (behind tables), in the same SVG as FK edges. */
export function DepPaths({ routes, depById, edgeLayouts, lowZoom, isFocused }: DepPathsProps) {
  return (
    <>
      {routes.map((r) => {
        const dep = depById.get(r.id);
        if (!dep) return null;
        return (
          <DepStroke
            key={r.id}
            route={r}
            color={depColor(dep, edgeLayouts.get(r.id))}
            focused={isFocused(dep, r.id)}
            lowZoom={lowZoom}
          />
        );
      })}
    </>
  );
}

interface DepOverlayProps {
  routes: DepRoute[];
  depById: Map<string, KeyedDepEdge>;
  edgeLayouts: Map<string, EdgeLayout>;
  selectedId: string | null;
  onSelect: (id: string, clientX: number, clientY: number) => void;
}

/**
 * Interactive layer (above tables). Mirrors the ref overlay's rule (spec 05 §8.3): only the selected
 * dep builds handles; every other dep is one transparent hit path.
 */
export function DepOverlay({ routes, depById, edgeLayouts, selectedId, onSelect }: DepOverlayProps) {
  const [hoverId, setHoverId] = useState<string | null>(null);

  const showTooltip = (dep: KeyedDepEdge, e: PointerEvent) => {
    store.getState().setTooltip({
      title: tableLabel(dep.upstream.table, dep.upstream.columns),
      subtitle: `↳ ${tableLabel(dep.downstream.table, dep.downstream.columns)}`,
      body: dep.note ?? '',
      x: e.clientX + 12,
      y: e.clientY + 12,
    });
  };
  const hideTooltip = () => store.getState().setTooltip(null);

  return (
    <>
      {routes.map((r) => {
        const dep = depById.get(r.id);
        if (!dep) return null;
        const color = depColor(dep, edgeLayouts.get(r.id));
        const selected = r.id === selectedId;
        const select = (e: PointerEvent) => {
          e.stopPropagation();
          onSelect(r.id, e.clientX, e.clientY);
        };
        return (
          <g key={r.id} style={{ color: color ?? 'var(--ddd-dep)' }}>
            {selected || hoverId === r.id ? <path d={r.d} class="ddd-dep is-selected" /> : null}
            <path
              d={r.d}
              class="ddd-edge-hit"
              stroke-width={HIT_THICKNESS}
              onPointerEnter={(e) => { setHoverId(r.id); showTooltip(dep, e as unknown as PointerEvent); }}
              onPointerMove={(e) => showTooltip(dep, e as unknown as PointerEvent)}
              onPointerLeave={() => { setHoverId((h) => (h === r.id ? null : h)); hideTooltip(); }}
              onPointerDown={(e) => select(e as unknown as PointerEvent)}
            />
            {selected ? (
              <>
                {r.inserts.map((h) => (
                  <circle
                    key={`ins-${h.index}`}
                    class="ddd-edge-ghost ddd-dep-insert"
                    cx={h.x}
                    cy={h.y}
                    r={4}
                    onPointerDown={(e) => {
                      hideTooltip();
                      startDepWaypointInsert(r.id, h.index, h, e as unknown as PointerEvent, e.currentTarget as SVGElement);
                    }}
                  />
                ))}
                {r.waypoints.map((w, i) => (
                  <circle
                    key={`wp-${i}`}
                    class="ddd-edge-handle ddd-dep-waypoint"
                    cx={w.x}
                    cy={w.y}
                    r={5}
                    onPointerDown={(e) => {
                      hideTooltip();
                      startDepWaypointMove(r.id, i, e as unknown as PointerEvent, e.currentTarget as SVGElement);
                    }}
                    onDblClick={(e) => { e.stopPropagation(); deleteDepWaypoint(r.id, i); }}
                  />
                ))}
              </>
            ) : null}
          </g>
        );
      })}
    </>
  );
}

function tableLabel(table: QualifiedName, columns: readonly string[]): string {
  const name = table.startsWith(GROUP_PREFIX)
    ? table.slice(GROUP_PREFIX.length)
    : table.startsWith('public.') ? table.slice('public.'.length) : table;
  return columns.length > 0 ? `${name}.${columns.join(', ')}` : name;
}
