import { describe, expect, it, vi } from 'vitest';

vi.mock('../vscode', () => ({ postToHost: vi.fn() }));

import { settingsDefaultFor } from './exportModal';
import type { ExporterOptionField } from '../../shared/exporters/types';

const dialect: ExporterOptionField = {
  id: 'dialect',
  type: 'enum',
  label: 'Dialect',
  default: 'postgres',
  choices: [{ value: 'postgres', label: 'PostgreSQL' }],
};
const typeorm = { dialect: 'postgres', singularize: true, includeImports: true, emitNullableExplicit: true };

describe('settingsDefaultFor', () => {
  it('uses the configured dialect when it is a registered choice', () => {
    expect(settingsDefaultFor('typeorm', dialect, typeorm)).toBe('postgres');
  });

  it('falls back to the field default for a dialect that is not registered', () => {
    expect(settingsDefaultFor('typeorm', dialect, { ...typeorm, dialect: 'mysql' })).toBe('postgres');
  });
});
