import { useEffect, useRef } from 'preact/hooks';

interface ColorPopupProps {
  current: string;
  x: number;
  y: number;
  onPick: (color: string) => void;
  onClose: () => void;
  onReset?: () => void;
}

const PRESETS: string[] = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#84cc16', '#22c55e', '#10b981', '#14b8a6',
  '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
  '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
  '#64748b', '#78716c', '#737373', '#6b7280',
];

/**
 * Color picker overlay rendered at fixed screen coords so it escapes any parent
 * `overflow: hidden` (table headers, panel lists, group containers).
 */
export function ColorPopup({ current, x, y, onPick, onClose, onReset }: ColorPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      const el = popupRef.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
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
      class="ddd-color-popup"
      ref={popupRef}
      style={{ left: `${x}px`, top: `${y}px` }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div class="ddd-color-popup__grid">
        {PRESETS.map((c) => (
          <button
            key={c}
            class={`ddd-color-chip${sameColor(c, current) ? ' is-active' : ''}`}
            style={{ background: c }}
            title={c}
            onClick={() => { onPick(c); onClose(); }}
          />
        ))}
      </div>
      <div class="ddd-color-popup__custom">
        <label class="ddd-color-popup__custom-label">
          <span class="ddd-color-chip" style={{ background: current }} />
          <input
            type="color"
            class="ddd-color-popup__input"
            value={toHex(current)}
            onInput={(e) => onPick((e.currentTarget as HTMLInputElement).value)}
          />
          <span>Custom…</span>
        </label>
        {onReset ? (
          <button class="ddd-color-popup__reset" onClick={() => { onReset(); onClose(); }}>Reset</button>
        ) : null}
      </div>
    </div>
  );
}

function sameColor(a: string, b: string): boolean {
  return toHex(a).toLowerCase() === toHex(b).toLowerCase();
}

function toHex(color: string): string {
  if (!color) return '#888888';
  if (color.startsWith('#')) return color.length === 4 ? '#' + color.slice(1).split('').map((c) => c + c).join('') : color.slice(0, 7);
  const m = /^hsla?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%/.exec(color);
  if (!m) return '#888888';
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const mOff = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  const toH = (v: number) => Math.round((v + mOff) * 255).toString(16).padStart(2, '0');
  return `#${toH(r)}${toH(g)}${toH(b)}`;
}

/**
 * Anchor a popup adjacent to a trigger element.
 * Prefers placing to the right of the trigger (like tooltips); falls back to the left side if clipped.
 * Vertically clamps so the popup fits in the viewport.
 */
export function popupAnchorFor(rect: DOMRect, popupWidth = 220, popupHeight = 200): { x: number; y: number } {
  let x = rect.right + 8;
  if (x + popupWidth > window.innerWidth - 8) {
    x = rect.left - popupWidth - 8;
  }
  x = Math.max(8, x);
  let y = rect.top;
  if (y + popupHeight > window.innerHeight - 8) {
    y = Math.max(8, window.innerHeight - popupHeight - 8);
  }
  return { x, y };
}
