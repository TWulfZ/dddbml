import { useEffect, useRef } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { BC_PALETTE_SIZE, bcVar } from '../groups/bcPalette';

interface ColorPopupProps {
  current: string;
  x: number;
  y: number;
  onPick: (color: string) => void;
  /** Live preview while dragging inside the native picker; `onPick` then runs once on commit.
   *  Without it every input event is a pick. */
  onPreview?: (color: string) => void;
  onClose: () => void;
  onReset?: () => void;
}

interface BcPreset {
  name: string;
  border: string;
}

const BC_NAMES: readonly string[] = [
  'Steel', 'Teal', 'Terracotta', 'Amethyst',
  'Mustard', 'Cyan', 'Rose', 'Olive',
  'Periwinkle', 'Slate', 'Clay', 'Moss',
];

const PRESETS: BcPreset[] = Array.from({ length: BC_PALETTE_SIZE }, (_, i) => ({
  name: BC_NAMES[i] ?? `BC ${i + 1}`,
  border: bcVar(i + 1, 'border'),
}));

/**
 * Color picker overlay rendered at fixed screen coords so it escapes any parent
 * `overflow: hidden` (table headers, panel lists, group containers).
 *
 * Presets are the 12 BC palette colors. Custom hex input remains as escape hatch.
 */
export function ColorPopup({ current, x, y, onPick, onPreview, onClose, onReset }: ColorPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  /** A previewed color the picker has not committed yet. */
  const uncommitted = useRef<string | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const commit = () => {
      const color = uncommitted.current;
      uncommitted.current = null;
      if (color !== null) onPickRef.current(color);
    };
    // Native listener: preact/compat rewrites a JSX onChange on <input> into oninput.
    input.addEventListener('change', commit);
    return () => {
      input.removeEventListener('change', commit);
      commit(); // closed before the picker committed: the previewed color is on screen, so save it
    };
  }, []);

  // Any other pick supersedes the preview, or closing the popup would re-apply it.
  const pick = (color: string) => {
    uncommitted.current = null;
    onPick(color);
  };
  const reset = onReset
    ? () => {
        uncommitted.current = null;
        onReset();
      }
    : null;

  useEffect(() => {
    const onDocDown = (e: PointerEvent) => {
      const el = popupRef.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const t = setTimeout(() => {
      // Capture-phase pointerdown: see ContextMenu.
      document.addEventListener('pointerdown', onDocDown, true);
      document.addEventListener('keydown', onEsc);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('keydown', onEsc);
    };
  }, [onClose]);

  return createPortal(
    <div
      class="ddd-color-popup"
      ref={popupRef}
      style={{ left: `${x}px`, top: `${y}px` }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div class="ddd-color-popup__grid">
        {PRESETS.map((preset) => (
          <button
            key={preset.border}
            class={`ddd-color-chip${preset.border === current ? ' is-active' : ''}`}
            style={{ background: preset.border }}
            title={preset.name}
            aria-label={preset.name}
            onClick={() => { pick(preset.border); onClose(); }}
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
            ref={inputRef}
            onInput={(e) => {
              const value = (e.currentTarget as HTMLInputElement).value;
              if (!onPreview) { pick(value); return; }
              uncommitted.current = value;
              onPreview(value);
            }}
          />
          <span>Custom…</span>
        </label>
        {reset ? (
          <button class="ddd-color-popup__reset" onClick={() => { reset(); onClose(); }}>Reset</button>
        ) : null}
      </div>
    </div>
  , document.body);
}

/**
 * Best-effort hex extraction used to seed `<input type="color">`. Returns a fallback
 * hex when the color is a CSS var() / color-mix() / hsl() that the picker cannot resolve.
 */
function toHex(color: string): string {
  if (!color) return '#888888';
  if (color.startsWith('#')) {
    return color.length === 4
      ? '#' + color.slice(1).split('').map((c) => c + c).join('')
      : color.slice(0, 7);
  }
  if (color.startsWith('var(') || color.startsWith('color-mix(')) return '#888888';
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
export function popupAnchorFor(rect: DOMRect, popupWidth = 240, popupHeight = 220): { x: number; y: number } {
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
