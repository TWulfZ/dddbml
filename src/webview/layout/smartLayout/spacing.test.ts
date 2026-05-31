import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDbml } from '../../../extension/parser';
import { smartLayout } from './layout';
import type { NodeSize } from '../autoLayout';
import type { QualifiedName, Schema } from '../../../shared/types';

function load(name: string): Schema {
  const src = readFileSync(resolve(process.cwd(), 'test/fixtures', name), 'utf8');
  const res = parseDbml(src);
  if (!res.schema) throw new Error(res.error.message);
  return res.schema;
}

function sizeOfFor(schema: Schema): (n: QualifiedName) => NodeSize {
  const cols = new Map<string, number>();
  for (const t of schema.tables) cols.set(t.name, t.columns.length);
  return (n) => ({ width: 240, height: 28 + (cols.get(n) ?? 0) * 20 + 8 });
}

function boundingArea(pos: Map<QualifiedName, { x: number; y: number }>, sizeOf: (n: QualifiedName) => NodeSize): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [n, p] of pos) {
    const s = sizeOf(n);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + s.width);
    maxY = Math.max(maxY, p.y + s.height);
  }
  return (maxX - minX) * (maxY - minY);
}

describe('smartLayout — spacing', () => {
  it('tighter spacing yields a smaller bounding box than looser spacing', () => {
    const schema = load('small.dbml');
    const sizeOf = sizeOfFor(schema);
    const base = { tables: schema.tables, refs: schema.refs, groups: schema.groups, sizeOf, mode: 'all' as const };

    const tight = smartLayout({ ...base, spacing: 0.5 });
    const loose = smartLayout({ ...base, spacing: 2 });

    expect(tight.size).toBe(schema.tables.length);
    expect(boundingArea(tight, sizeOf)).toBeLessThan(boundingArea(loose, sizeOf));
  });

  it('is deterministic per spacing value', () => {
    const schema = load('small.dbml');
    const sizeOf = sizeOfFor(schema);
    const input = { tables: schema.tables, refs: schema.refs, groups: schema.groups, sizeOf, mode: 'all' as const, spacing: 0.7 };
    expect([...smartLayout(input).entries()]).toEqual([...smartLayout(input).entries()]);
  });
});
