import { store } from '../state/store';
import { memo } from 'preact/compat';
import { schedulePersist } from '../persistence';
import { withAlpha } from '../groups/bcPalette';
import { lodForZoom } from './lod';

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
function GroupContainerImpl({ name, x, y, w, h, color }: GroupContainerProps) {
  const onLabelDblClick = (e: Event) => {
    e.stopPropagation();
    store.getState().setGroup(name, { collapsed: true });
    schedulePersist();
  };
  // At low zoom (`rect` LOD) the scaled-down label is hard to read, so hovering it
  // surfaces the group name as a screen-space label — same shared tooltip slot the
  // tables use, so a table-inside-a-group hover and a group hover never collide.
  const onLabelEnter = (e: Event) => {
    const s = store.getState();
    if (lodForZoom(s.viewport.zoom, s.settings.lod) !== 'rect') return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    s.setTooltip({ title: name, body: '', x: r.left, y: r.top });
  };
  const onLabelLeave = () => {
    if (store.getState().tooltip) store.getState().setTooltip(null);
  };
  return (
    <div
      class="ddd-group-container"
      data-group-id={name}
      style={{
        position: 'absolute',
        transform: `translate(${x}px, ${y}px)`,
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
        onMouseEnter={onLabelEnter}
        onMouseLeave={onLabelLeave}
        title={`${name} (double-click label to collapse)`}
      >
        {name}
      </div>
    </div>
  );
}

// memo: App re-renders on many store slices; this only re-renders via its own subscriptions.
export const GroupContainer = memo(GroupContainerImpl);
