import { cloneElement, type VNode } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';

/**
 * Lightweight, reusable tooltip for icon-only buttons (and any focusable trigger).
 *
 * Distinct from the rich, store-driven canvas tooltip in `render/tooltip.tsx` (that one carries
 * table/column detail). This one shows a short label (+ optional shortcut hint) on hover AND
 * keyboard focus, fades+rises in, and is dismissible with Escape.
 *
 * It CLONES its single child to inject the hover/focus handlers plus `aria-label` /
 * `aria-describedby`, so the accessibility metadata lands on the real `<button>` and the native
 * `title` can be dropped (no doubled OS tooltip). The tip is portaled to <body> so it escapes any
 * `overflow: hidden` on the floating bar, positioned from the trigger's bounding rect.
 *
 * Motion respects `prefers-reduced-motion` via the global CSS rule (durations zeroed).
 */

const OPEN_DELAY_MS = 400;

interface TooltipProps {
  label: string;
  /** Optional keyboard-shortcut hint, rendered as a muted key chip (e.g. "Ctrl+Z"). */
  shortcut?: string;
  placement?: 'top' | 'bottom';
  /** A single focusable trigger (e.g. a <Button>); cloned to receive hover/focus + aria wiring. */
  children: VNode;
}

interface TipPos {
  x: number;
  y: number;
  placement: 'top' | 'bottom';
}

function compute(rect: DOMRect, placement: 'top' | 'bottom'): TipPos {
  const x = Math.round(rect.left + rect.width / 2);
  const gap = 6;
  const y = Math.round(placement === 'top' ? rect.top - gap : rect.bottom + gap);
  return { x, y, placement };
}

export function Tooltip({ label, shortcut, placement = 'top', children }: TooltipProps) {
  const id = useId();
  const [pos, setPos] = useState<TipPos | null>(null);
  const timer = useRef<number | undefined>(undefined);

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
  useEffect(() => {
    if (!pos) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [pos]);

  const trigger = cloneElement(children, {
    'aria-label': label,
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
            <div class={`ddd-tip-pos ddd-tip--${pos.placement}`} style={{ left: `${pos.x}px`, top: `${pos.y}px` }}>
              <div class="ddd-tip" id={id} role="tooltip">
                <span class="ddd-tip__label">{label}</span>
                {shortcut ? <span class="ddd-tip__key">{shortcut}</span> : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
