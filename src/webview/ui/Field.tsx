import type { ComponentChildren } from 'preact';
import { cn } from './cn';

/**
 * Form-field primitives. They wrap the existing `.ddd-field*` `@layer` classes
 * (label + hint + control). `Field` is the block wrapper; the typed inputs
 * (`TextField`/`NumberField`/`SelectField`) compose it; `Checkbox` is the inline
 * variant. These replace the per-file `Row*` / `FieldEditor` components that
 * settingsPanel and exportModal each reimplemented.
 */
export interface FieldProps {
  label: string;
  hint?: string;
  children: ComponentChildren;
  class?: string;
}

export function Field({ label, hint, children, class: extra }: FieldProps) {
  return (
    <label class={cn('ddd-field', extra)}>
      <span class="ddd-field__label">{label}</span>
      {children}
      {hint ? <small class="ddd-field__hint">{hint}</small> : null}
    </label>
  );
}

export interface TextFieldProps {
  label: string;
  hint?: string;
  value: string;
  /** Fired on `change` (blur/commit), not per keystroke. */
  onCommit: (value: string) => void;
}

export function TextField({ label, hint, value, onCommit }: TextFieldProps) {
  return (
    <Field label={label} hint={hint}>
      <input
        class="ddd-field__control"
        type="text"
        value={value}
        onChange={(e) => onCommit((e.currentTarget as HTMLInputElement).value)}
      />
    </Field>
  );
}

export interface NumberFieldProps {
  label: string;
  hint?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onCommit: (value: number) => void;
}

export function NumberField({ label, hint, value, min, max, step, onCommit }: NumberFieldProps) {
  return (
    <Field label={label} hint={hint}>
      <input
        class="ddd-field__control"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const n = Number((e.currentTarget as HTMLInputElement).value);
          if (Number.isFinite(n)) onCommit(n);
        }}
      />
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps {
  label: string;
  hint?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}

export function SelectField({ label, hint, value, options, onChange }: SelectFieldProps) {
  return (
    <Field label={label} hint={hint}>
      <select
        class="ddd-field__control"
        value={value}
        onChange={(e) => onChange((e.currentTarget as HTMLSelectElement).value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export interface CheckboxProps {
  label: string;
  hint?: string;
  value: boolean;
  onCommit: (value: boolean) => void;
}

/** Inline label + checkbox (= legacy `.ddd-field.ddd-field--inline`). */
export function Checkbox({ label, hint, value, onCommit }: CheckboxProps) {
  return (
    <label class="ddd-field ddd-field--inline">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onCommit((e.currentTarget as HTMLInputElement).checked)}
      />
      <span>
        <span class="ddd-field__label">{label}</span>
        {hint ? <small class="ddd-field__hint">{hint}</small> : null}
      </span>
    </label>
  );
}
