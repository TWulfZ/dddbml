import { store } from '../state/store';
import { schedulePersist } from '../persistence';

interface CollapsedGroupNodeProps {
  name: string;
  tableCount: number;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

export function CollapsedGroupNode({ name, tableCount, x, y, w, h, color }: CollapsedGroupNodeProps) {
  const onDblClick = () => {
    store.getState().setGroup(name, { collapsed: false });
    schedulePersist();
  };
  return (
    <div
      class="ddd-group-node"
      data-group-id={name}
      onDblClick={onDblClick}
      title={`${name} — ${tableCount} tables (double-click to expand)`}
      style={{
        position: 'absolute',
        transform: `translate3d(${x}px, ${y}px, 0)`,
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
