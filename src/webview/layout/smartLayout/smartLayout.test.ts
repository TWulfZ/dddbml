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

/** Fixed cozy metrics — independent of the Zustand store, so tests are pure. */
function sizeOfFor(schema: Schema): (n: QualifiedName) => NodeSize {
  const cols = new Map<string, number>();
  for (const t of schema.tables) cols.set(t.name, t.columns.length);
  return (n) => {
    const c = cols.get(n) ?? 0;
    return { width: 240, height: 28 + c * 20 + 8 };
  };
}

function aabbOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function assertNoOverlap(
  positions: Map<QualifiedName, { x: number; y: number }>,
  sizeOf: (n: QualifiedName) => NodeSize,
): void {
  const entries = [...positions];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [na, pa] = entries[i]!;
      const [nb, pb] = entries[j]!;
      const sa = sizeOf(na);
      const sb = sizeOf(nb);
      const overlap = aabbOverlap(
        { x: pa.x, y: pa.y, w: sa.width, h: sa.height },
        { x: pb.x, y: pb.y, w: sb.width, h: sb.height },
      );
      expect(overlap, `${na} overlaps ${nb}`).toBe(false);
    }
  }
}

describe('smartLayout — geometry', () => {
  it('mode=all covers every table with no overlap', async () => {
    const schema = load('small.dbml');
    const sizeOf = sizeOfFor(schema);
    const pos = await smartLayout({
      tables: schema.tables, refs: schema.refs, groups: schema.groups, sizeOf, mode: 'all',
    });
    expect(pos.size).toBe(schema.tables.length);
    assertNoOverlap(pos, sizeOf);
  });

  it('is deterministic — two runs yield identical maps', async () => {
    const schema = load('small.dbml');
    const sizeOf = sizeOfFor(schema);
    const input = { tables: schema.tables, refs: schema.refs, groups: schema.groups, sizeOf, mode: 'all' as const };
    const a = await smartLayout(input);
    const b = await smartLayout(input);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('mode=new keeps seeded positions byte-exact and places only the missing', async () => {
    const schema = load('small.dbml');
    const sizeOf = sizeOfFor(schema);
    const seeded = schema.tables.slice(0, -5);
    const missing = schema.tables.slice(-5);
    const existing = new Map<QualifiedName, { x: number; y: number }>();
    seeded.forEach((t, i) => existing.set(t.name, { x: i * 500, y: 0 }));

    const pos = await smartLayout({
      tables: schema.tables, refs: schema.refs, groups: schema.groups, sizeOf, mode: 'new', existing,
    });
    for (const t of seeded) expect(pos.get(t.name)).toEqual(existing.get(t.name));
    for (const t of missing) expect(pos.has(t.name)).toBe(true);
  });

  it('mode=selection leaves every non-selected table exactly in place', async () => {
    const schema = load('small.dbml');
    const sizeOf = sizeOfFor(schema);
    const existing = new Map<QualifiedName, { x: number; y: number }>();
    schema.tables.forEach((t, i) => existing.set(t.name, { x: i * 500, y: (i % 4) * 400 }));
    const selection = new Set(schema.tables.slice(0, 4).map((t) => t.name));

    const pos = await smartLayout({
      tables: schema.tables, refs: schema.refs, groups: schema.groups, sizeOf, mode: 'selection', existing, selection,
    });
    for (const t of schema.tables) {
      if (!selection.has(t.name)) expect(pos.get(t.name)).toEqual(existing.get(t.name));
    }
  });
});
