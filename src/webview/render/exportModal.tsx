import { useEffect, useMemo, useState } from 'preact/hooks';
import { store, useAppStore } from '../state/store';
import { postToHost } from '../vscode';
import { Button } from '../ui/Button';
import { IconClose } from '../icons';
import type { ExporterMeta, ExporterOptionField } from '../../shared/exporters/types';

type Scope = 'all' | 'selected';

export function ExportModal() {
  const open = useAppStore((s) => s.exportPromptOpen);
  const exporters = useAppStore((s) => s.exporters);
  const defaultFormat = useAppStore((s) => s.settings.export.defaultFormat);
  const settingsTypeorm = useAppStore((s) => s.settings.export.typeorm);
  const selection = useAppStore((s) => s.selection);
  const tableCount = useAppStore((s) => s.schema.tables.length);

  const [formatId, setFormatId] = useState<string>(defaultFormat);
  const [scope, setScope] = useState<Scope>('all');
  const [options, setOptions] = useState<Record<string, unknown>>({});

  const currentExporter = useMemo<ExporterMeta | null>(() => {
    if (exporters.length === 0) return null;
    return exporters.find((e) => e.id === formatId) ?? exporters[0]!;
  }, [exporters, formatId]);

  useEffect(() => {
    if (!open) return;
    setFormatId(exporters.find((e) => e.id === defaultFormat)?.id ?? exporters[0]?.id ?? defaultFormat);
    setScope(selection.size > 0 ? 'selected' : 'all');
  }, [open]);

  useEffect(() => {
    if (!currentExporter) {
      setOptions({});
      return;
    }
    const next: Record<string, unknown> = {};
    for (const field of currentExporter.optionsSchema) {
      next[field.id] = settingsDefaultFor(currentExporter.id, field, settingsTypeorm);
    }
    setOptions(next);
  }, [currentExporter, settingsTypeorm]);

  if (!open) return null;
  if (exporters.length === 0) {
    return (
      <div class="ddd-modal-overlay" onClick={close}>
        <div class="ddd-modal" onClick={(e) => e.stopPropagation()}>
          <div class="ddd-modal__head">
            <span class="ddd-modal__title">Export Schema</span>
            <Button variant="ghost" size="icon" onClick={close} title="Close"><IconClose size={12} /></Button>
          </div>
          <div class="ddd-modal__body">
            <p>No exporters registered. This is a bug — please file an issue.</p>
          </div>
        </div>
      </div>
    );
  }

  const submit = () => {
    if (!currentExporter) return;
    postToHost({
      type: 'command:export',
      payload: {
        formatId: currentExporter.id,
        scope,
        selection: [...selection],
        options,
      },
    });
  };

  const setOption = (id: string, value: unknown) => {
    setOptions((prev) => ({ ...prev, [id]: value }));
  };

  const selectedCount = selection.size;
  const scopeSelectedDisabled = selectedCount === 0;

  return (
    <div class="ddd-modal-overlay" onClick={close}>
      <div class="ddd-modal" onClick={(e) => e.stopPropagation()}>
        <div class="ddd-modal__head">
          <span class="ddd-modal__title">Export Schema</span>
          <Button variant="ghost" size="icon" onClick={close} title="Close"><IconClose size={12} /></Button>
        </div>

        <div class="ddd-modal__body">
          <label class="ddd-field">
            <span class="ddd-field__label">Format</span>
            <select
              class="ddd-field__control"
              value={formatId}
              onChange={(e) => setFormatId((e.currentTarget as HTMLSelectElement).value)}
            >
              {exporters.map((e) => (
                <option key={e.id} value={e.id}>{e.label}</option>
              ))}
            </select>
            {currentExporter?.description ? (
              <small class="ddd-field__hint">{currentExporter.description}</small>
            ) : null}
          </label>

          <fieldset class="ddd-field">
            <legend class="ddd-field__label">Scope</legend>
            <label class="ddd-radio">
              <input
                type="radio"
                name="scope"
                checked={scope === 'all'}
                onChange={() => setScope('all')}
              />
              <span>All tables <small class="ddd-field__hint">({tableCount})</small></span>
            </label>
            <label class={`ddd-radio ${scopeSelectedDisabled ? 'is-disabled' : ''}`}>
              <input
                type="radio"
                name="scope"
                checked={scope === 'selected'}
                onChange={() => setScope('selected')}
                disabled={scopeSelectedDisabled}
              />
              <span>Selected only <small class="ddd-field__hint">({selectedCount})</small></span>
            </label>
          </fieldset>

          {currentExporter?.optionsSchema.map((field) => (
            <FieldEditor
              key={field.id}
              field={field}
              value={options[field.id]}
              onChange={(v) => setOption(field.id, v)}
            />
          ))}
        </div>

        <div class="ddd-modal__foot">
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={scope === 'selected' && scopeSelectedDisabled}
          >Export</Button>
        </div>
      </div>
    </div>
  );
}

function close() {
  store.getState().setExportPromptOpen(false);
}

interface FieldEditorProps {
  field: ExporterOptionField;
  value: unknown;
  onChange(v: unknown): void;
}

function FieldEditor({ field, value, onChange }: FieldEditorProps) {
  if (field.type === 'boolean') {
    return (
      <label class="ddd-field ddd-field--inline">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)}
        />
        <span>
          <span class="ddd-field__label">{field.label}</span>
          {field.description ? <small class="ddd-field__hint">{field.description}</small> : null}
        </span>
      </label>
    );
  }

  if (field.type === 'enum') {
    return (
      <label class="ddd-field">
        <span class="ddd-field__label">{field.label}</span>
        <select
          class="ddd-field__control"
          value={typeof value === 'string' ? value : field.default}
          onChange={(e) => onChange((e.currentTarget as HTMLSelectElement).value)}
        >
          {field.choices.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        {field.description ? <small class="ddd-field__hint">{field.description}</small> : null}
      </label>
    );
  }

  return (
    <label class="ddd-field">
      <span class="ddd-field__label">{field.label}</span>
      <input
        class="ddd-field__control"
        type="text"
        value={typeof value === 'string' ? value : field.default}
        onInput={(e) => onChange((e.currentTarget as HTMLInputElement).value)}
      />
      {field.description ? <small class="ddd-field__hint">{field.description}</small> : null}
    </label>
  );
}

function settingsDefaultFor(
  exporterId: string,
  field: ExporterOptionField,
  typeorm: { dialect: string; singularize: boolean; includeImports: boolean; emitNullableExplicit: boolean },
): unknown {
  if (exporterId === 'typeorm') {
    if (field.id === 'dialect') return typeorm.dialect;
    if (field.id === 'singularize') return typeorm.singularize;
    if (field.id === 'includeImports') return typeorm.includeImports;
    if (field.id === 'emitNullableExplicit') return typeorm.emitNullableExplicit;
  }
  return field.default;
}
