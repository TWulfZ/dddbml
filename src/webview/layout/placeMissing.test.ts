import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDbml } from '../../extension/parser';
import { estimateSize } from './autoLayout';
import { placeMissingTables } from './placeMissing';
import type { QualifiedName, Schema } from '../../shared/types';

type Point = { x: number; y: number };
interface Rect { x: number; y: number; w: number; h: number }

function fixture(name: string): Schema {
  const res = parseDbml(readFileSync(resolve(process.cwd(), 'test/fixtures', name), 'utf8'));
  if (!res.schema) throw new Error(res.error.message);
  return res.schema;
}

function sizeOfFor(schema: Schema) {
  const cols = new Map(schema.tables.map((t) => [t.name, t.columns.length]));
  return (n: QualifiedName) => estimateSize(cols.get(n) ?? 0);
}

function place(schema: Schema, positions = new Map<QualifiedName, Point>()) {
  return placeMissingTables({ tables: schema.tables, refs: schema.refs, groups: schema.groups, positions, sizeOf: sizeOfFor(schema) });
}

function rectOf(schema: Schema, pos: Map<QualifiedName, Point>, n: QualifiedName): Rect {
  const p = pos.get(n)!;
  const s = sizeOfFor(schema)(n);
  return { x: p.x, y: p.y, w: s.width, h: s.height };
}

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function bounds(rects: Rect[]): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

describe('placeMissingTables — first open without a sidecar (spec 13)', () => {
  it('lays huge.dbml out as a compact block, not a horizontal strip', () => {
    const schema = fixture('huge.dbml');
    const pos = new Map(place(schema));
    expect(pos.size).toBe(schema.tables.length);
    const box = bounds(schema.tables.map((t) => rectOf(schema, pos, t.name)));
    expect(box.w / box.h).toBeLessThan(4);
    expect(box.h / box.w).toBeLessThan(4);
  }, 60_000);

  it('keeps each TableGroup together: no foreign table inside a group box', () => {
    const schema = fixture('isga.generated.dbml');
    expect(schema.groups.length).toBeGreaterThan(1);
    const pos = new Map(place(schema));
    for (const g of schema.groups) {
      const members = new Set(g.tables);
      const box = bounds(g.tables.map((n) => rectOf(schema, pos, n)));
      for (const t of schema.tables) {
        if (members.has(t.name)) continue;
        expect(intersects(rectOf(schema, pos, t.name), box), `${t.name} inside group ${g.name}`).toBe(false);
      }
    }
  });

  it('is a no-op once every table has a position, so the re-run effect places nothing twice', () => {
    const schema = fixture('small.dbml');
    const first = new Map(place(schema));
    expect(first.size).toBe(schema.tables.length);
    expect(place(schema, first)).toEqual([]);
  });

  it('places only the missing tables, clear of the ones already on the canvas', () => {
    const schema = fixture('small.dbml');
    const full = new Map(place(schema));
    const missing = schema.tables.slice(0, 3).map((t) => t.name);
    const existing = new Map(full);
    for (const n of missing) existing.delete(n);
    const added = place(schema, existing);
    expect(added.map(([n]) => n).sort()).toEqual([...missing].sort());
    const merged = new Map([...existing, ...added]);
    for (const [n] of added) {
      for (const [m] of existing) expect(intersects(rectOf(schema, merged, n), rectOf(schema, merged, m)), `${n} over ${m}`).toBe(false);
    }
  });
});
