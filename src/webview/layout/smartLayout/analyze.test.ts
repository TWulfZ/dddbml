import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDbml } from '../../../extension/parser';
import { analyze, formatAnalysis } from './index';
import type { Schema } from '../../../shared/types';

function load(name: string): Schema {
  const src = readFileSync(resolve(process.cwd(), 'test/fixtures', name), 'utf8');
  const res = parseDbml(src);
  if (!res.schema) throw new Error(res.error.message);
  return res.schema;
}

describe('analyze — classification + clustering', () => {
  for (const fixture of ['small.dbml', 'huge.dbml']) {
    it(`assigns every table to exactly one cluster — ${fixture}`, () => {
      const schema = load(fixture);
      const { meta, clusters } = analyze(schema);

      for (const t of schema.tables) {
        expect(meta.get(t.name)?.role, `${t.name} has a role`).toBeDefined();
      }

      const seen = new Set<string>();
      for (const c of clusters) {
        for (const m of c.members) {
          expect(seen.has(m), `${m} appears in two clusters`).toBe(false);
          seen.add(m);
        }
      }
      expect(seen.size).toBe(schema.tables.length);
    });
  }

  it('formatAnalysis produces a readable roles + clusters dump', () => {
    const text = formatAnalysis(analyze(load('small.dbml')));
    expect(text).toContain('# Roles');
    expect(text).toContain('# Clusters');
  });
});
