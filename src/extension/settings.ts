import * as vscode from 'vscode';
import { defaultSettings, type AppSettings, type FlatSettingsPatch, type UiDensity } from '../shared/types';

const UI_DENSITY_VALUES: readonly UiDensity[] = ['compact', 'cozy', 'comfortable'];

const CONFIG_ROOT = 'dddbml';

export function loadSettings(): AppSettings {
  const cfg = vscode.workspace.getConfiguration(CONFIG_ROOT);
  const defaults = defaultSettings();
  return {
    zoomStep: numberOr(cfg.get<number>('zoomStep'), defaults.zoomStep),
    zoomMin: numberOr(cfg.get<number>('zoomMin'), defaults.zoomMin),
    zoomMax: numberOr(cfg.get<number>('zoomMax'), defaults.zoomMax),
    lod: {
      mediumThreshold: numberOr(cfg.get<number>('lod.mediumThreshold'), defaults.lod.mediumThreshold),
      lowThreshold: numberOr(cfg.get<number>('lod.lowThreshold'), defaults.lod.lowThreshold),
    },
    ui: {
      density: uiDensityOr(cfg.get<string>('ui.density'), defaults.ui.density),
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

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
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
