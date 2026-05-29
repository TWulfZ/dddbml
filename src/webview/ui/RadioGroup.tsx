import { cn } from './cn';

/**
 * Segmented radio group (= legacy `.ddd-radio-group`). Renders `role=radio`
 * option buttons; the active one gets `.is-active`. Wraps the existing classes.
 */
export interface RadioOption<T extends string> {
  value: T;
  label: string;
}

export interface RadioGroupProps<T extends string> {
  label: string;
  hint?: string;
  value: T;
  options: ReadonlyArray<RadioOption<T>>;
  onChange: (value: T) => void;
}

export function RadioGroup<T extends string>({ label, hint, value, options, onChange }: RadioGroupProps<T>) {
  return (
    <div class="ddd-field">
      <span class="ddd-field__label">{label}</span>
      <div class="ddd-radio-group" role="radiogroup" aria-label={label}>
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={value === opt.value}
            class={cn('ddd-radio-group__option', value === opt.value && 'is-active')}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {hint ? <small class="ddd-field__hint">{hint}</small> : null}
    </div>
  );
}
