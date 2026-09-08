import { useEffect, useMemo, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import { store, useAppStore } from '../state/store';
import { postToHost } from '../vscode';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { SelectField, TextField, Checkbox } from '../ui/Field';
import type { ExporterMeta, ExporterOptionField } from '../../shared/exporters/types';

type Scope = 'all' | 'selected';

function ExportModalImpl() {
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

  const submit = () => {
    if (!currentExporter) return;
    postToHost({
      type: 'command:export',
      payload: { formatId: currentExporter.id, scope, selection: [...selection], options },
    });
  };

  const setOption = (id: string, value: unknown) => {
    setOptions((prev) => ({ ...prev, [id]: value }));
  };

  const selectedCount = selection.size;
  const scopeSelectedDisabled = selectedCount === 0;
  const hasExporters = exporters.length > 0;

  return (
    <Modal
      open={open}
      onClose={close}
      title="Export Schema"
      footer={
        hasExporters ? (
          <>
            <Button variant="secondary" onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              onClick={submit}
              disabled={scope === 'selected' && scopeSelectedDisabled}
            >Export</Button>
          </>
        ) : undefined
      }
    >
      {!hasExporters ? (
        <p>No exporters registered. This is a bug — please file an issue.</p>
      ) : (
        <>
          <SelectField
            label="Format"
            hint={currentExporter?.description}
            value={formatId}
            options={exporters.map((e) => ({ value: e.id, label: e.label }))}
            onChange={setFormatId}
          />

          <fieldset class="ddd-field">
            <legend class="ddd-field__label">Scope</legend>
            <label class="ddd-radio">
              <input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} />
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
            <FieldEditor key={field.id} field={field} value={options[field.id]} onChange={(v) => setOption(field.id, v)} />
          ))}
        </>
      )}
    </Modal>
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
    return <Checkbox label={field.label} hint={field.description} value={value === true} onCommit={onChange} />;
  }
  if (field.type === 'enum') {
    return (
      <SelectField
        label={field.label}
        hint={field.description}
        value={typeof value === 'string' ? value : field.default}
        options={field.choices.map((c) => ({ value: c.value, label: c.label }))}
        onChange={onChange}
      />
    );
  }
  return (
    <TextField
      label={field.label}
      hint={field.description}
      value={typeof value === 'string' ? value : field.default}
      onCommit={onChange}
    />
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

// memo: App re-renders on many store slices; this only re-renders via its own subscriptions.
export const ExportModal = memo(ExportModalImpl);
