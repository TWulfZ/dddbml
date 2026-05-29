import { store } from '../state/store';
import { schedulePersist } from '../persistence';
import { withAlpha } from '../groups/bcPalette';

interface GroupContainerProps {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

/**
 * Visual container behind the member tables of a non-collapsed, non-hidden group.
 * Standard ERD group rendering: dashed border rect with a colored label on top.
 *
 * Interaction:
 *   - Body is pointer-events: none so pan / wheel pass through to the viewport
 *     and clicks on tables inside are unaffected.
 *   - Label is clickable: double-click collapses the group.
 */
export function GroupContainer({ name, x, y, w, h, color }: GroupContainerProps) {
  const onLabelDblClick = (e: Event) => {
    e.stopPropagation();
    store.getState().setGroup(name, { collapsed: true });
    schedulePersist();
  };
  return (
    <div
      class="ddd-group-container"
      data-group-id={name}
      style={{
        position: 'absolute',
        transform: `translate3d(${x}px, ${y}px, 0)`,
        width: `${w}px`,
        height: `${h}px`,
        borderColor: color,
        background: withAlpha(color, 0.08),
      }}
    >
      <div
        class="ddd-group-container__label"
        style={{ background: color }}
        onDblClick={onLabelDblClick}
        title={`${name} (double-click label to collapse)`}
      >
        {name}
      </div>
    </div>
  );
}
