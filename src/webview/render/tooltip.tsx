import { useAppStore } from '../state/store';

export function Tooltip() {
  const tooltip = useAppStore((s) => s.tooltip);
  if (!tooltip) return null;
  return (
    <div
      class="ddd-tooltip"
      style={{
        left: `${tooltip.x}px`,
        top: `${tooltip.y}px`,
      }}
    >
      <div class="ddd-tooltip__head">
        <span class="ddd-tooltip__title">{tooltip.title}</span>
        {tooltip.subtitle ? <span class="ddd-tooltip__subtitle">{tooltip.subtitle}</span> : null}
      </div>
      <div class="ddd-tooltip__body">{tooltip.body}</div>
    </div>
  );
}
