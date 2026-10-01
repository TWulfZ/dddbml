import * as vscode from 'vscode';
import { clampSetting, defaultSettings, type AppSettings, type FlatSettingsPatch, type UiDensity } from '../shared/types';

const UI_DENSITY_VALUES: readonly UiDensity[] = ['compact', 'cozy', 'comfortable'];

const CONFIG_ROOT = 'dddbml';

export function loadSettings(): AppSettings {
  const cfg = vscode.workspace.getConfiguration(CONFIG_ROOT);
  const defaults = defaultSettings();
  return {
    // Ranges also keep zoomMin <= 1 <= zoomMax and zoomStep > 1 consistent with each other.
    zoomStep: clampSetting('zoomStep', cfg.get<number>('zoomStep'), defaults.zoomStep),
    zoomMin: clampSetting('zoomMin', cfg.get<number>('zoomMin'), defaults.zoomMin),
    zoomMax: clampSetting('zoomMax', cfg.get<number>('zoomMax'), defaults.zoomMax),
    lod: {
      lowThreshold: clampSetting('lod.lowThreshold', cfg.get<number>('lod.lowThreshold'), defaults.lod.lowThreshold),
    },
    ui: {
      density: uiDensityOr(cfg.get<string>('ui.density'), defaults.ui.density),
      snapToGrid: boolOr(cfg.get<boolean>('ui.snapToGrid'), defaults.ui.snapToGrid),
      gridSize: clampSetting('ui.gridSize', cfg.get<number>('ui.gridSize'), defaults.ui.gridSize),
      layoutSpacing: clampSetting('ui.layoutSpacing', cfg.get<number>('ui.layoutSpacing'), defaults.ui.layoutSpacing),
    },
    export: {
      defaultFormat: stringOr(cfg.get<string>('export.defaultFormat'), defaults.export.defaultFormat),
      typeorm: {
        dialect: stringOr(cfg.get<string>('export.typeorm.dialect'), defaults.export.typeorm.dialect),
        singularize: boolOr(cfg.get<boolean>('export.typeorm.singularize'), defaults.export.typeorm.singularize),
        includeImports: boolOr(cfg.get<boolean>('export.typeorm.includeImports'), defaults.export.typeorm.includeImports),
        emitNullableExplicit: boolOr(
          cfg.get<boolean>('export.typeorm.emitNullableExplicit'),
          defaults.export.typeorm.emitNullableExplicit,
        ),
      },
    },
  };
}

export async function applySettingsPatch(patch: Partial<FlatSettingsPatch>): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(CONFIG_ROOT);
  const target = workspaceTarget();
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    try {
      await cfg.update(key, value, target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showWarningMessage(`dddbml: could not update setting "${key}" — ${message}`);
    }
  }
}

export function onSettingsChange(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(CONFIG_ROOT)) listener();
  });
}

function workspaceTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}
function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function uiDensityOr(v: unknown, fallback: UiDensity): UiDensity {
  return typeof v === 'string' && (UI_DENSITY_VALUES as readonly string[]).includes(v)
    ? (v as UiDensity)
    : fallback;
}
