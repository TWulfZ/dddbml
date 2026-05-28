import { useEffect, useRef } from 'preact/hooks';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/**
 * Generic floating context menu rendered at fixed screen coords so it escapes any
 * parent `overflow: hidden`. Closes on outside click, Escape, or item selection.
 *
 * Positioning mirrors `popupAnchorFor` in colorPopup.tsx: anchor at `(x, y)` and clamp
 * inside the viewport. Selection invokes the item's `onClick` then `onClose`.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      const el = ref.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Defer attachment one tick so the click that opened the menu doesn't immediately close it.
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDocDown);
      document.addEventListener('keydown', onEsc);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [onClose]);

  return (
    <div
      class="ddd-context-menu"
      ref={ref}
      style={{ left: `${x}px`, top: `${y}px` }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <button
          key={i}
          class={`ddd-context-menu__item${item.danger ? ' is-danger' : ''}`}
          disabled={item.disabled}
          onClick={() => { if (!item.disabled) { item.onClick(); onClose(); } }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Clamp a context-menu anchor inside the viewport given its estimated size.
 * Default size is 200x40 (typical 2-3 items) which fits within the user's mouse pointer area.
 */
export function clampMenuAnchor(x: number, y: number, menuWidth = 200, menuHeight = 80): { x: number; y: number } {
  const px = Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8));
  const py = Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8));
  return { x: px, y: py };
}
