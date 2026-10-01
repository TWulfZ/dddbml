import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { createPortal } from 'preact/compat';

/** Screen-px gap kept between a menu and the window edge. */
const MENU_MARGIN = 8;

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  /**
   * When defined, the row renders as a checkbox (a check glyph shown iff `true`) and clicking it
   * TOGGLES without closing the menu — so a run of toggles can be flipped before choosing an action.
   * Plain action items (no `checked`) close the menu on click, as before.
   */
  checked?: boolean;
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
    const onDocDown = (e: PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Defer attachment one tick so the click that opened the menu doesn't immediately close it.
    const t = setTimeout(() => {
      // Capture phase: table/edge gestures stop propagation and preventDefault the pointerdown,
      // which also suppresses mousedown, so a bubbling or mousedown listener would miss them.
      document.addEventListener('pointerdown', onDocDown, true);
      document.addEventListener('keydown', onEsc);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('keydown', onEsc);
    };
  }, [onClose]);

  // Callers clamp the anchor with a size estimate that can't know the item count or the VS Code
  // font; re-clamp with the measured box before paint so the last rows are never off-screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.bottom > window.innerHeight - MENU_MARGIN) el.style.top = `${Math.max(MENU_MARGIN, window.innerHeight - r.height - MENU_MARGIN)}px`;
    if (r.right > window.innerWidth - MENU_MARGIN) el.style.left = `${Math.max(MENU_MARGIN, window.innerWidth - r.width - MENU_MARGIN)}px`;
  });

  return createPortal(
    <div
      class="ddd-context-menu"
      ref={ref}
      style={{ left: `${x}px`, top: `${y}px` }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item.separator ? (
          <hr key={i} class="ddd-context-menu__separator" />
        ) : item.checked !== undefined ? (
          <button
            key={i}
            class={`ddd-context-menu__item is-checkbox${item.checked ? ' is-checked' : ''}`}
            role="menuitemcheckbox"
            aria-checked={item.checked}
            disabled={item.disabled}
            onClick={() => { if (!item.disabled) item.onClick(); /* toggle: keep menu open */ }}
          >
            <span class="ddd-context-menu__check" aria-hidden="true">{item.checked ? '✓' : ''}</span>
            {item.label}
          </button>
        ) : (
          <button
            key={i}
            class={`ddd-context-menu__item${item.danger ? ' is-danger' : ''}`}
            disabled={item.disabled}
            onClick={() => { if (!item.disabled) { item.onClick(); onClose(); } }}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  , document.body);
}

/**
 * Clamp a context-menu anchor inside the viewport given its estimated size (default 200x80).
 * Only a first guess: ContextMenu re-clamps with its measured size before paint.
 */
export function clampMenuAnchor(x: number, y: number, menuWidth = 200, menuHeight = 80): { x: number; y: number } {
  const px = Math.max(MENU_MARGIN, Math.min(x, window.innerWidth - menuWidth - MENU_MARGIN));
  const py = Math.max(MENU_MARGIN, Math.min(y, window.innerHeight - menuHeight - MENU_MARGIN));
  return { x: px, y: py };
}
