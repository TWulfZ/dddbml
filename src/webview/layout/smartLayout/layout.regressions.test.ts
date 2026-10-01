import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDbml } from '../../../extension/parser';
import { smartLayout } from './layout';
import type { NodeSize } from '../autoLayout';
import type { QualifiedName, Schema } from '../../../shared/types';

function parse(src: string): Schema {
  const res = parseDbml(src);
  if (!res.schema) throw new Error(res.error.message);
  return res.schema;
}

const sizeOfCache = new WeakMap<Schema, (n: QualifiedName) => NodeSize>();
function sizeOfFor(schema: Schema): (n: QualifiedName) => NodeSize {
  const cached = sizeOfCache.get(schema);
  if (cached) return cached;
  const cols = new Map<string, number>();
  for (const t of schema.tables) cols.set(t.name, t.columns.length);
  const fn = (n: QualifiedName): NodeSize => ({ width: 240, height: 28 + (cols.get(n) ?? 0) * 20 + 8 });
  sizeOfCache.set(schema, fn);
  return fn;
}

function layoutOf(schema: Schema, spacing?: number): Map<QualifiedName, { x: number; y: number }> {
  return smartLayout({
    tables: schema.tables, refs: schema.refs, groups: schema.groups, sizeOf: sizeOfFor(schema), mode: 'all', spacing,
  });
}

function fixture(name: string): Schema {
  return parse(readFileSync(resolve(process.cwd(), 'test/fixtures', name), 'utf8'));
}

interface Rect { x: number; y: number; w: number; h: number }

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function tableRect(schema: Schema, pos: Map<QualifiedName, { x: number; y: number }>, n: QualifiedName): Rect {
  const p = pos.get(n)!;
  const s = sizeOfFor(schema)(n);
  return { x: p.x, y: p.y, w: s.width, h: s.height };
}

function extent(schema: Schema, pos: Map<QualifiedName, { x: number; y: number }>): { w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of pos.keys()) {
    const r = tableRect(schema, pos, n);
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { w: maxX - minX, h: maxY - minY };
}

/** Group container rects exactly as app.tsx derives them (24px padding, 20px header). */
function containers(schema: Schema, pos: Map<QualifiedName, { x: number; y: number }>): Array<Rect & { name: string }> {
  const out: Array<Rect & { name: string }> = [];
  for (const g of schema.groups) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const t of g.tables) {
      if (!pos.has(t)) continue;
      const r = tableRect(schema, pos, t);
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    }
    if (!Number.isFinite(minX)) continue;
    out.push({ name: g.name, x: minX - 24, y: minY - 44, w: maxX - minX + 48, h: maxY - minY + 68 });
  }
  return out;
}

/** Container overlaps plus tables of one group intruding into another group's container. */
function groupViolations(schema: Schema, pos: Map<QualifiedName, { x: number; y: number }>): string[] {
  const boxes = containers(schema, pos);
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (intersects(boxes[i]!, boxes[j]!)) out.push(`${boxes[i]!.name} overlaps ${boxes[j]!.name}`);
    }
  }
  for (const t of schema.tables) {
    if (!t.groupName) continue;
    const r = tableRect(schema, pos, t.name);
    for (const b of boxes) {
      if (b.name !== t.groupName && intersects(r, b)) out.push(`${t.name} inside ${b.name}`);
    }
  }
  return out;
}

describe('smartLayout — disconnected parts pack near-square (audit F17)', () => {
  const aspectOk = ({ w, h }: { w: number; h: number }) => w / h >= 1 / 4 && w / h <= 4;

  it('60 tables with no refs', () => {
    const src = Array.from({ length: 60 }, (_, i) => `Table t${i} { id int [pk]\n  name text }`).join('\n');
    const schema = parse(src);
    expect(aspectOk(extent(schema, layoutOf(schema)))).toBe(true);
  });

  it('small.dbml', () => {
    const schema = fixture('small.dbml');
    expect(aspectOk(extent(schema, layoutOf(schema)))).toBe(true);
  });

  it('huge.dbml, with group containers still disjoint', () => {
    const schema = fixture('huge.dbml');
    const pos = layoutOf(schema);
    expect(aspectOk(extent(schema, pos))).toBe(true);
    expect(groupViolations(schema, pos)).toEqual([]);
  });
});

describe('smartLayout — group containers stay disjoint (audit F18)', () => {
  for (const spacing of [0.4, 1, 2.5]) {
    it(`isga.generated.dbml at spacing ${spacing}`, () => {
      const schema = fixture('isga.generated.dbml');
      expect(groupViolations(schema, layoutOf(schema, spacing))).toEqual([]);
    });
  }
});

describe('smartLayout — cluster ids with spaces (audit F54)', () => {
  const dbml = (a: string, b: string) => `
    Table orders { id int [pk] }
    Table order_lines { id int [pk]
      order_id int [ref: > orders.id] }
    Table invoices { id int [pk]
      order_id int [ref: > orders.id] }
    Table payments { id int [pk]
      invoice_id int [ref: > invoices.id] }
    TableGroup ${a} {
      orders
      order_lines
    }
    TableGroup ${b} {
      invoices
      payments
    }
  `;

  it('ranks groups whose names contain spaces exactly like space-free names', () => {
    const spaced = layoutOf(parse(dbml('"Sales Context"', '"Billing Area"')));
    const plain = layoutOf(parse(dbml('Sales_Context', 'Billing_Area')));
    expect([...spaced].sort()).toEqual([...plain].sort());
  });
});

describe('smartLayout — locale-independent determinism (audit F88)', () => {
  const codeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  // Mixed case: ICU locale collation interleaves cases, code-unit order puts uppercase first.
  const sats = ['alpha', 'Beta', 'gamma', 'Delta', 'epsilon', 'Zeta'];
  const src = [
    'Table hub { id int [pk] }',
    ...sats.map((n) => `Table ${n} { id int [pk]\n  hub_id int [ref: > hub.id] }`),
  ].join('\n');

  it('orders the radial ring by code unit, not by locale collation', () => {
    const schema = parse(src);
    const sizeOf = sizeOfFor(schema);
    const pos = layoutOf(schema);
    const center = (n: string) => {
      const p = pos.get(`public.${n}`)!;
      const s = sizeOf(`public.${n}`);
      return { x: p.x + s.width / 2, y: p.y + s.height / 2 };
    };
    const hub = center('hub');
    // The ring starts at 12 o'clock and runs clockwise in screen coordinates; the half-step slack
    // absorbs the column-align nudge applied after radial placement.
    const halfStep = Math.PI / sats.length;
    const angle = (n: string) => {
      const c = center(n);
      const a = Math.atan2(c.y - hub.y, c.x - hub.x) + Math.PI / 2;
      return a < -halfStep ? a + 2 * Math.PI : a;
    };
    const ring = [...sats].sort((a, b) => angle(a) - angle(b));
    expect(ring).toEqual([...sats].sort(codeUnit));
  });

  it('does not depend on the order the host sorted tables and groups in', () => {
    const schema = parse(readFileSync(resolve(process.cwd(), 'test/fixtures/small.dbml'), 'utf8'));
    const reversed: Schema = { ...schema, tables: [...schema.tables].reverse(), groups: [...schema.groups].reverse() };
    expect([...layoutOf(reversed)].sort()).toEqual([...layoutOf(schema)].sort());
  });
});

describe('smartLayout — selection re-arrange stays in its own group (audit F53)', () => {
  it('isga.generated.dbml: every cross-group-only table', () => {
    const schema = fixture('isga.generated.dbml');
    const base = layoutOf(schema);
    expect(groupViolations(schema, base)).toEqual([]);

    const groupOf = new Map(schema.tables.map((t) => [t.name, t.groupName]));
    const neighbours = new Map<QualifiedName, QualifiedName[]>();
    for (const r of schema.refs) {
      neighbours.set(r.source.table, [...(neighbours.get(r.source.table) ?? []), r.target.table]);
      neighbours.set(r.target.table, [...(neighbours.get(r.target.table) ?? []), r.source.table]);
    }
    const crossOnly = schema.tables.filter((t) => {
      const ns = neighbours.get(t.name) ?? [];
      return t.groupName !== null && ns.length > 0 && ns.every((n) => groupOf.get(n) && groupOf.get(n) !== t.groupName);
    });
    expect(crossOnly.length).toBeGreaterThan(0);

    const area = (pos: Map<QualifiedName, { x: number; y: number }>, group: string) => {
      const c = containers(schema, pos).find((b) => b.name === group)!;
      return c.w * c.h;
    };
    const failures: string[] = [];
    for (const t of crossOnly) {
      const pos = smartLayout({
        tables: schema.tables, refs: schema.refs, groups: schema.groups, sizeOf: sizeOfFor(schema),
        mode: 'selection', existing: base, selection: new Set([t.name]),
      });
      for (const v of groupViolations(schema, pos)) failures.push(`${t.name}: ${v}`);
      const growth = area(pos, t.groupName!) / area(base, t.groupName!);
      if (growth > 2) failures.push(`${t.name}: own group area x${growth.toFixed(1)}`);
    }
    expect(failures).toEqual([]);
  });
});
