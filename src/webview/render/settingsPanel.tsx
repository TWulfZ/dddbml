import { store, useAppStore } from '../state/store';
import { postToHost } from '../vscode';
import { Modal } from '../ui/Modal';
import { NumberField, TextField, Checkbox } from '../ui/Field';
import { RadioGroup } from '../ui/RadioGroup';
import type { FlatSettingsPatch, UiDensity } from '../../shared/types';

type PatchKey = keyof FlatSettingsPatch;

export function SettingsPanel() {
  const open = useAppStore((s) => s.settingsPanelOpen);
  const settings = useAppStore((s) => s.settings);

  const apply = <K extends PatchKey>(key: K, value: FlatSettingsPatch[K]) => {
    postToHost({ type: 'settings:update', payload: { [key]: value } as Partial<FlatSettingsPatch> });
  };

  return (
    <Modal open={open} onClose={close} title="Settings" wide>
      <h4 class="ddd-modal__section">UI</h4>
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

      <h4 class="ddd-modal__section">Viewport</h4>
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

      <h4 class="ddd-modal__section">LOD thresholds</h4>
      <NumberField
        label="Medium threshold"
        hint="Zoom below this renders header-only LOD."
        value={settings.lod.mediumThreshold}
        min={0.05}
        max={1}
        step={0.05}
        onCommit={(v) => apply('lod.mediumThreshold', v)}
      />
      <NumberField
        label="Low threshold"
        hint="Zoom below this renders rect-only LOD. Must be < medium."
        value={settings.lod.lowThreshold}
        min={0.01}
        max={1}
        step={0.05}
        onCommit={(v) => apply('lod.lowThreshold', v)}
      />

      <h4 class="ddd-modal__section">Export defaults</h4>
      <TextField label="Default format" value={settings.export.defaultFormat} onCommit={(v) => apply('export.defaultFormat', v)} />
      <TextField label="TypeORM dialect" value={settings.export.typeorm.dialect} onCommit={(v) => apply('export.typeorm.dialect', v)} />
      <Checkbox label="Singularize class names" value={settings.export.typeorm.singularize} onCommit={(v) => apply('export.typeorm.singularize', v)} />
      <Checkbox label="Include typeorm imports" value={settings.export.typeorm.includeImports} onCommit={(v) => apply('export.typeorm.includeImports', v)} />
      <Checkbox label="Emit nullable explicit" value={settings.export.typeorm.emitNullableExplicit} onCommit={(v) => apply('export.typeorm.emitNullableExplicit', v)} />
    </Modal>
  );
}

function close() {
  store.getState().setSettingsPanelOpen(false);
}
