import { store } from '../state/store';
import { memo } from 'preact/compat';
import { schedulePersist } from '../persistence';
import { lodForZoom } from './lod';

interface CollapsedGroupNodeProps {
  name: string;
  tableCount: number;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

function CollapsedGroupNodeImpl({ name, tableCount, x, y, w, h, color }: CollapsedGroupNodeProps) {
  const onDblClick = () => {
    store.getState().setGroup(name, { collapsed: false });
    schedulePersist();
  };
  // At low zoom (`rect` LOD) the scaled-down name is hard to read — reveal it as a
  // screen-space label on hover (shared tooltip slot ⇒ at most one label visible).
  const onEnter = (e: Event) => {
    const s = store.getState();
    if (lodForZoom(s.viewport.zoom, s.settings.lod) !== 'rect') return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    s.setTooltip({ title: name, body: '', x: r.left, y: r.top });
  };
  const onLeave = () => {
    if (store.getState().tooltip) store.getState().setTooltip(null);
  };
  return (
    <div
      class="ddd-group-node"
      data-group-id={name}
      onDblClick={onDblClick}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      title={`${name} — ${tableCount} tables (double-click to expand)`}
      style={{
        position: 'absolute',
        transform: `translate(${x}px, ${y}px)`,
        width: `${w}px`,
        height: `${h}px`,
        background: color,
        borderColor: color,
      }}
    >
      <div class="ddd-group-node__name">{name}</div>
      <div class="ddd-group-node__count">{tableCount} tables</div>
    </div>
  );
}

// memo: App re-renders on many store slices; this only re-renders via its own subscriptions.
export const CollapsedGroupNode = memo(CollapsedGroupNodeImpl);
