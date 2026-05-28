import { store, useAppStore } from '../state/store';
import { postToHost } from '../vscode';
import { IconClose } from '../icons';
import type { FlatSettingsPatch, UiDensity } from '../../shared/types';

type PatchKey = keyof FlatSettingsPatch;

export function SettingsPanel() {
  const open = useAppStore((s) => s.settingsPanelOpen);
  const settings = useAppStore((s) => s.settings);

  if (!open) return null;

  const apply = <K extends PatchKey>(key: K, value: FlatSettingsPatch[K]) => {
    postToHost({ type: 'settings:update', payload: { [key]: value } as Partial<FlatSettingsPatch> });
  };

  return (
    <div class="ddd-modal-overlay" onClick={close}>
      <div class="ddd-modal ddd-modal--wide" onClick={(e) => e.stopPropagation()}>
        <div class="ddd-modal__head">
          <span class="ddd-modal__title">Settings</span>
          <button class="ddd-icon-btn" onClick={close} title="Close"><IconClose size={12} /></button>
        </div>

        <div class="ddd-modal__body">
          <h4 class="ddd-modal__section">UI</h4>
          <RadioGroupRow
            label="Density"
            hint="Table width, row height, and font size."
            value={settings.ui.density}
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'cozy', label: 'Cozy' },
              { value: 'comfortable', label: 'Comfortable' },
            ]}
            onCommit={(v) => apply('ui.density', v)}
          />

          <h4 class="ddd-modal__section">Viewport</h4>
          <NumberRow
            label="Zoom step"
            hint="Factor applied per zoom in/out (must be > 1)."
            value={settings.zoomStep}
            min={1.01}
            max={4}
            step={0.05}
            onCommit={(v) => apply('zoomStep', v)}
          />
          <NumberRow
            label="Zoom min"
            value={settings.zoomMin}
            min={0.01}
            max={1}
            step={0.01}
            onCommit={(v) => apply('zoomMin', v)}
          />
          <NumberRow
            label="Zoom max"
            value={settings.zoomMax}
            min={1}
            max={16}
            step={0.5}
            onCommit={(v) => apply('zoomMax', v)}
          />

          <h4 class="ddd-modal__section">LOD thresholds</h4>
          <NumberRow
            label="Medium threshold"
            hint="Zoom below this renders header-only LOD."
            value={settings.lod.mediumThreshold}
            min={0.05}
            max={1}
            step={0.05}
            onCommit={(v) => apply('lod.mediumThreshold', v)}
          />
          <NumberRow
            label="Low threshold"
            hint="Zoom below this renders rect-only LOD. Must be < medium."
            value={settings.lod.lowThreshold}
            min={0.01}
            max={1}
            step={0.05}
            onCommit={(v) => apply('lod.lowThreshold', v)}
          />

          <h4 class="ddd-modal__section">Export defaults</h4>
          <TextRow
            label="Default format"
            value={settings.export.defaultFormat}
            onCommit={(v) => apply('export.defaultFormat', v)}
          />
          <TextRow
            label="TypeORM dialect"
            value={settings.export.typeorm.dialect}
            onCommit={(v) => apply('export.typeorm.dialect', v)}
          />
          <BoolRow
            label="Singularize class names"
            value={settings.export.typeorm.singularize}
            onCommit={(v) => apply('export.typeorm.singularize', v)}
          />
          <BoolRow
            label="Include typeorm imports"
            value={settings.export.typeorm.includeImports}
            onCommit={(v) => apply('export.typeorm.includeImports', v)}
          />
          <BoolRow
            label="Emit nullable explicit"
            value={settings.export.typeorm.emitNullableExplicit}
            onCommit={(v) => apply('export.typeorm.emitNullableExplicit', v)}
          />
        </div>
      </div>
    </div>
  );
}

function close() {
  store.getState().setSettingsPanelOpen(false);
}

interface NumberRowProps {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit(value: number): void;
}

function NumberRow({ label, hint, value, min, max, step, onCommit }: NumberRowProps) {
  return (
    <label class="ddd-field">
      <span class="ddd-field__label">{label}</span>
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
      {hint ? <small class="ddd-field__hint">{hint}</small> : null}
    </label>
  );
}

function TextRow({ label, value, onCommit }: { label: string; value: string; onCommit(v: string): void }) {
  return (
    <label class="ddd-field">
      <span class="ddd-field__label">{label}</span>
      <input
        class="ddd-field__control"
        type="text"
        value={value}
        onChange={(e) => onCommit((e.currentTarget as HTMLInputElement).value)}
      />
    </label>
  );
}

function BoolRow({ label, value, onCommit }: { label: string; value: boolean; onCommit(v: boolean): void }) {
  return (
    <label class="ddd-field ddd-field--inline">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onCommit((e.currentTarget as HTMLInputElement).checked)}
      />
      <span class="ddd-field__label">{label}</span>
    </label>
  );
}

interface RadioGroupRowProps {
  label: string;
  hint?: string;
  value: UiDensity;
  options: Array<{ value: UiDensity; label: string }>;
  onCommit(value: UiDensity): void;
}

function RadioGroupRow({ label, hint, value, options, onCommit }: RadioGroupRowProps) {
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
            class={`ddd-radio-group__option${value === opt.value ? ' is-active' : ''}`}
            onClick={() => onCommit(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {hint ? <small class="ddd-field__hint">{hint}</small> : null}
    </div>
  );
}
