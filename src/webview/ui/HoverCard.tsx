import { cloneElement, type VNode, type ComponentChildren } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';

/**
 * Rich hover/focus card — the third tooltip tier (see specs/12-design-system.md):
 *
 *  - `ui/Tooltip`        → short text tip for icon-only buttons.
 *  - `render/tooltip.tsx`→ store-driven canvas tooltip with table/column detail.
 *  - `ui/HoverCard`      → THIS: a floating card rendering arbitrary `content`
 *                          (e.g. the LOD-mode preview), opened from an info icon.
 *
 * Like `Tooltip`, it CLONES its single focusable child trigger to inject the
 * hover/focus handlers plus `aria-describedby`, opens on hover AND keyboard
 * focus after a short delay, and closes on pointer-leave / blur / Escape.
 *
 * Unlike `Tooltip` (which portals to <body>), this triggers from INSIDE the
 * Settings `<dialog showModal>` — a top-layer element. A plain body portal would
 * render *behind* the modal, so the card uses the native **Popover API**
 * (`popover="manual"` + `showPopover()`), which promotes it into the top layer
 * above the modal regardless of DOM position or ancestor `overflow`. Motion
 * respects `prefers-reduced-motion` via the global CSS rule (durations zeroed).
 *
 * The card is non-interactive (preview content), so leaving the trigger closes
 * it (standard tip behavior). The positioner is centered on the trigger and
 * clamped to the viewport so a wide card never clips off-screen.
 */

const OPEN_DELAY_MS = 300;
const VIEWPORT_MARGIN = 8;
/** Must stay >= the `.ddd-hovercard` `max-width` in style.css (clamp budget). */
const MAX_CARD_WIDTH = 460;

interface HoverCardProps {
  /** The rich card body (rendered once the card opens). */
  content: ComponentChildren;
  placement?: 'top' | 'bottom';
  /** A single focusable trigger (e.g. an info <button>); cloned for handlers + aria. */
  children: VNode;
}

interface CardPos {
  x: number;
  y: number;
  placement: 'top' | 'bottom';
}

function compute(rect: DOMRect, placement: 'top' | 'bottom'): CardPos {
  const half = MAX_CARD_WIDTH / 2;
  const min = VIEWPORT_MARGIN + half;
  const max = window.innerWidth - VIEWPORT_MARGIN - half;
  const center = rect.left + rect.width / 2;
  const x = Math.round(Math.min(Math.max(center, min), Math.max(min, max)));
  const gap = 8;
  const y = Math.round(placement === 'top' ? rect.top - gap : rect.bottom + gap);
  return { x, y, placement };
}

export function HoverCard({ content, placement = 'bottom', children }: HoverCardProps) {
  const id = useId();
  const [pos, setPos] = useState<CardPos | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const cardRef = useRef<HTMLDivElement>(null);

  const clear = () => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
  };
  const show = (el: HTMLElement) => {
    clear();
    timer.current = window.setTimeout(() => setPos(compute(el.getBoundingClientRect(), placement)), OPEN_DELAY_MS);
  };
  const hide = () => {
    clear();
    setPos(null);
  };

  useEffect(() => () => clear(), []);

  // Promote the card into the top layer (above the modal dialog) and close on Escape.
  useEffect(() => {
    const el = cardRef.current;
    if (!pos || !el) return;
    if (!el.hasAttribute('popover')) el.setAttribute('popover', 'manual');
    try {
      el.showPopover();
    } catch {
      /* already open / unsupported */
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('keydown', onEsc);
      try {
        el.hidePopover();
      } catch {
        /* not open */
      }
    };
  }, [pos]);

  const trigger = cloneElement(children, {
    'aria-describedby': pos ? id : undefined,
    onPointerEnter: (e: PointerEvent) => show(e.currentTarget as HTMLElement),
    onPointerLeave: hide,
    onFocus: (e: FocusEvent) => show(e.currentTarget as HTMLElement),
    onBlur: hide,
  });

  return (
    <>
      {trigger}
      {pos
        ? createPortal(
            <div
              ref={cardRef}
              class={`ddd-hovercard-pos ddd-hovercard--${pos.placement}`}
              style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
            >
              <div class="ddd-hovercard" id={id} role="tooltip">
                {content}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
