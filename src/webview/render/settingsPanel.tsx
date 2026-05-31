import type { ComponentChildren, VNode } from 'preact';
import { useState } from 'preact/hooks';
import { store, useAppStore } from '../state/store';
import { postToHost } from '../vscode';
import { Modal } from '../ui/Modal';
import { NumberField, TextField, Checkbox } from '../ui/Field';
import { Slider } from '../ui/Slider';
import { RadioGroup } from '../ui/RadioGroup';
import { Button } from '../ui/Button';
import { HoverCard } from '../ui/HoverCard';
import { LodPreview } from './lodPreview';
import { IconLayout, IconZoom, IconEye, IconExport, IconInfo, IconReset } from '../icons';
import { defaultSettings, flattenSettings, type FlatSettingsPatch, type UiDensity } from '../../shared/types';

type PatchKey = keyof FlatSettingsPatch;
type Category = 'interface' | 'viewport' | 'lod' | 'export';

const CATEGORIES: { id: Category; label: string; icon: VNode }[] = [
  { id: 'interface', label: 'Interface', icon: <IconLayout size={14} /> },
  { id: 'viewport', label: 'Viewport', icon: <IconZoom size={14} /> },
  { id: 'lod', label: 'Level of Detail', icon: <IconEye size={14} /> },
  { id: 'export', label: 'Export', icon: <IconExport size={14} /> },
];

const CATEGORY_KEYS: Record<Category, PatchKey[]> = {
  interface: ['ui.density', 'ui.snapToGrid', 'ui.gridSize', 'ui.layoutSpacing'],
  viewport: ['zoomStep', 'zoomMin', 'zoomMax'],
  lod: ['lod.lowThreshold'],
  export: [
    'export.defaultFormat',
    'export.typeorm.dialect',
    'export.typeorm.singularize',
    'export.typeorm.includeImports',
    'export.typeorm.emitNullableExplicit',
  ],
};

/** Frozen flat snapshot of the factory defaults — sliced for section/global resets. */
const DEFAULT_FLAT = flattenSettings(defaultSettings());

function patchFor(keys: PatchKey[]): Partial<FlatSettingsPatch> {
  const out: Partial<FlatSettingsPatch> = {};
  for (const k of keys) (out as Record<string, unknown>)[k] = DEFAULT_FLAT[k];
  return out;
}

function update(patch: Partial<FlatSettingsPatch>) {
  postToHost({ type: 'settings:update', payload: patch });
}

export function SettingsPanel() {
  const open = useAppStore((s) => s.settingsPanelOpen);
  const settings = useAppStore((s) => s.settings);
  const [active, setActive] = useState<Category>('interface');

  const apply = <K extends PatchKey>(key: K, value: FlatSettingsPatch[K]) => {
    update({ [key]: value } as Partial<FlatSettingsPatch>);
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Settings"
      wide
      footer={
        <Button variant="secondary" onClick={() => update(DEFAULT_FLAT)}>
          Reset all to defaults
        </Button>
      }
    >
      <div class="ddd-settings">
        <div class="ddd-settings__rail" role="tablist" aria-orientation="vertical" aria-label="Settings categories">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={active === c.id}
              class={`ddd-settings__rail-item${active === c.id ? ' is-active' : ''}`}
              onClick={() => setActive(c.id)}
            >
              {c.icon}
              <span>{c.label}</span>
            </button>
          ))}
        </div>

        <div class="ddd-settings__content">
          {active === 'interface' ? (
            <Section category="interface">
              <RadioGroup<UiDensity>
                label="Density"
                hint="Table width, row height, and font size."
                value={settings.ui.density}
                options={[
                  { value: 'compact', label: 'Compact' },
                  { value: 'cozy', label: 'Cozy' },
                  { value: 'comfortable', label: 'Comfortable' },
                ]}
                onChange={(v) => apply('ui.density', v)}
              />
              <Checkbox
                label="Snap to grid (magnet)"
                hint="Snap table positions and edge bends to the grid; shows a dotted background."
                value={settings.ui.snapToGrid}
                onCommit={(v) => apply('ui.snapToGrid', v)}
              />
              <NumberField
                label="Grid size (px)"
                hint="World-unit spacing of the snap grid used when magnet mode is on."
                value={settings.ui.gridSize}
                min={2}
                max={128}
                step={2}
                onCommit={(v) => apply('ui.gridSize', v)}
              />
              <Slider
                label="Layout spacing"
                hint="Auto-arrange density. Lower packs tables and groups tighter; higher spreads them out. Applies on the next auto-arrange."
                value={settings.ui.layoutSpacing}
                min={0.4}
                max={2.5}
                step={0.1}
                minLabel="Compact"
                maxLabel="Spacious"
                format={(v) => v.toFixed(1)}
                onCommit={(v) => apply('ui.layoutSpacing', v)}
              />
            </Section>
          ) : null}

          {active === 'viewport' ? (
            <Section category="viewport">
              <NumberField
                label="Zoom step"
                hint="Factor applied per zoom in/out (must be > 1)."
                value={settings.zoomStep}
                min={1.01}
                max={4}
                step={0.05}
                onCommit={(v) => apply('zoomStep', v)}
              />
              <NumberField label="Zoom min" value={settings.zoomMin} min={0.01} max={1} step={0.01} onCommit={(v) => apply('zoomMin', v)} />
              <NumberField label="Zoom max" value={settings.zoomMax} min={1} max={16} step={0.5} onCommit={(v) => apply('zoomMax', v)} />
            </Section>
          ) : null}

          {active === 'lod' ? (
            <Section
              category="lod"
              info={
                <HoverCard placement="top" content={<LodPreview />}>
                  <button type="button" class="ddd-settings__info" aria-label="Preview level-of-detail modes">
                    <IconInfo size={13} />
                  </button>
                </HoverCard>
              }
            >
              <NumberField
                label="Low threshold"
                hint="Below this zoom, tables render as colored rectangles (name on hover); at or above, full columns."
                value={settings.lod.lowThreshold}
                min={0.01}
                max={1}
                step={0.05}
                onCommit={(v) => apply('lod.lowThreshold', v)}
              />
            </Section>
          ) : null}

          {active === 'export' ? (
            <Section category="export">
              <TextField label="Default format" value={settings.export.defaultFormat} onCommit={(v) => apply('export.defaultFormat', v)} />
              <TextField label="TypeORM dialect" value={settings.export.typeorm.dialect} onCommit={(v) => apply('export.typeorm.dialect', v)} />
              <Checkbox label="Singularize class names" value={settings.export.typeorm.singularize} onCommit={(v) => apply('export.typeorm.singularize', v)} />
              <Checkbox label="Include typeorm imports" value={settings.export.typeorm.includeImports} onCommit={(v) => apply('export.typeorm.includeImports', v)} />
              <Checkbox label="Emit nullable explicit" value={settings.export.typeorm.emitNullableExplicit} onCommit={(v) => apply('export.typeorm.emitNullableExplicit', v)} />
            </Section>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

/** A content panel: header row (title + optional info + section reset) above its fields. */
function Section({ category, info, children }: { category: Category; info?: VNode; children: ComponentChildren }) {
  const meta = CATEGORIES.find((c) => c.id === category)!;
  return (
    <section class="ddd-settings__panel" role="tabpanel">
      <div class="ddd-settings__panel-head">
        <span class="ddd-settings__panel-title">
          {meta.icon}
          {meta.label}
        </span>
        <span class="ddd-settings__panel-actions">
          {info}
          <Button variant="subtle" size="icon" onClick={() => update(patchFor(CATEGORY_KEYS[category]))} title="Reset section to defaults">
            <IconReset size={13} />
          </Button>
        </span>
      </div>
      {children}
    </section>
  );
}

function close() {
  store.getState().setSettingsPanelOpen(false);
}
