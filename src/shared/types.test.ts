import { describe, expect, it } from 'vitest';
import pkg from '../../package.json';
import { clampSetting, defaultSettings, flattenSettings, SETTING_RANGES, type AppSettings, type FlatSettingsPatch } from './types';

describe('flattenSettings', () => {
  it('maps every nested field to its dotted key (guards against mis-wiring)', () => {
    // Distinct sentinel per field so a swapped mapping (e.g. min↔max) fails loudly.
    const s: AppSettings = {
      zoomStep: 1.5,
      zoomMin: 0.1,
      zoomMax: 8,
      lod: { lowThreshold: 0.22 },
      ui: { density: 'compact', snapToGrid: true, gridSize: 24, layoutSpacing: 1.3 },
      export: {
        defaultFormat: 'sql',
        typeorm: { dialect: 'mysql', singularize: false, includeImports: false, emitNullableExplicit: false },
      },
    };
    const expected: FlatSettingsPatch = {
      'zoomStep': 1.5,
      'zoomMin': 0.1,
      'zoomMax': 8,
      'lod.lowThreshold': 0.22,
      'ui.density': 'compact',
      'ui.snapToGrid': true,
      'ui.gridSize': 24,
      'ui.layoutSpacing': 1.3,
      'export.defaultFormat': 'sql',
      'export.typeorm.dialect': 'mysql',
      'export.typeorm.singularize': false,
      'export.typeorm.includeImports': false,
      'export.typeorm.emitNullableExplicit': false,
    };
    // toEqual enforces the exact key set too, so a key dropped from flatten() fails here.
    expect(flattenSettings(s)).toEqual(expected);
  });

  it('flattens the factory defaults for whole-settings reset', () => {
    expect(flattenSettings(defaultSettings())['ui.gridSize']).toBe(16);
  });
});

describe('numeric setting ranges', () => {
  it('match the package.json minimum/maximum of every numeric dddbml.* setting', () => {
    const props: Record<string, { type: string; minimum?: number; maximum?: number }> =
      pkg.contributes.configuration.properties;
    const fromPkg: Record<string, [number | undefined, number | undefined]> = {};
    for (const [key, p] of Object.entries(props)) {
      if (p.type === 'number') fromPkg[key.replace(/^dddbml\./, '')] = [p.minimum, p.maximum];
    }
    expect(SETTING_RANGES).toEqual(fromPkg);
  });

  it('clamps out-of-range values and falls back on non-numbers (a cleared field saved 0)', () => {
    expect(clampSetting('zoomMax', 0, 4)).toBe(1);
    expect(clampSetting('zoomStep', 0, 1.2)).toBe(1.01);
    expect(clampSetting('lod.lowThreshold', 0, 0.3)).toBe(0.01);
    expect(clampSetting('ui.gridSize', 999, 16)).toBe(128);
    expect(clampSetting('zoomMin', Number.NaN, 0.08)).toBe(0.08);
    expect(clampSetting('zoomMin', '0.5', 0.08)).toBe(0.08);
    expect(clampSetting('zoomMin', 0.5, 0.08)).toBe(0.5);
  });
});
