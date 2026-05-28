import { store } from '../state/store';
import { schedulePersist } from '../persistence';

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
 * Mirrors dbdiagram's group rendering: dashed border rect with a colored label on top.
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
        background: colorWithAlpha(color, 0.08),
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

function colorWithAlpha(color: string, alpha: number): string {
  // Accepts hsl(...) or hex or hsla(...). Builds an rgba-like low-opacity fill.
  if (color.startsWith('hsl(')) {
    return color.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`);
  }
  if (color.startsWith('hsla(')) return color;
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const n = hex.length === 3
      ? hex.split('').map((c) => c + c).join('')
      : hex.padEnd(6, '0');
    const r = parseInt(n.slice(0, 2), 16);
    const g = parseInt(n.slice(2, 4), 16);
    const b = parseInt(n.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}
