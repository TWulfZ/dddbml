import { describe, expect, it } from 'vitest';
import { defaultSettings, flattenSettings, type AppSettings, type FlatSettingsPatch } from './types';

describe('flattenSettings', () => {
  it('maps every nested field to its dotted key (guards against mis-wiring)', () => {
    // Distinct sentinel per field so a swapped mapping (e.g. min↔max) fails loudly.
    const s: AppSettings = {
      zoomStep: 1.5,
      zoomMin: 0.1,
      zoomMax: 8,
      lod: { lowThreshold: 0.22 },
      ui: { density: 'compact', snapToGrid: true, gridSize: 24 },
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
