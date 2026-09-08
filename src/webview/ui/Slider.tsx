import { useEffect, useState } from 'preact/hooks';
import { Field } from './Field';

/**
 * Continuous range slider built on the shared `.ddd-field*` block (label + hint) wrapping a native
 * `<input type="range">` with a live value readout and optional end labels. Drag updates the readout
 * locally (`onInput`); the value is committed once on release (`onChange`) so we don't spam a
 * settings write per pixel. Chromium-only (VS Code webview) → uses `::-webkit-slider-*` in CSS.
 */
export interface SliderProps {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  minLabel?: string;
  maxLabel?: string;
  /** Format the live value readout (e.g. `(v) => v.toFixed(1)`). */
  format?: (v: number) => string;
  /** Fired on release, not per drag tick. */
  onCommit: (value: number) => void;
}

export function Slider({ label, hint, value, min, max, step, minLabel, maxLabel, format, onCommit }: SliderProps) {
  const [live, setLive] = useState(value);
  // Keep the readout in sync when the committed value changes from outside (e.g. reset to default).
  useEffect(() => setLive(value), [value]);
  const shown = format ? format(live) : String(live);

  return (
    <Field label={label} hint={hint}>
      <div class="ddd-slider">
        <input
          class="ddd-slider__input"
          type="range"
          min={min}
          max={max}
          step={step}
          value={live}
          onInput={(e) => {
            const n = Number((e.currentTarget as HTMLInputElement).value);
            if (Number.isFinite(n)) setLive(n);
          }}
          onChange={(e) => {
            const n = Number((e.currentTarget as HTMLInputElement).value);
            if (Number.isFinite(n)) onCommit(n);
          }}
        />
        <div class="ddd-slider__scale">
          <span>{minLabel ?? ''}</span>
          <span class="ddd-slider__value">{shown}</span>
          <span>{maxLabel ?? ''}</span>
        </div>
      </div>
    </Field>
  );
}
