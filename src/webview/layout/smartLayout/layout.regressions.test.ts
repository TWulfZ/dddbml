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

function sizeOfFor(schema: Schema): (n: QualifiedName) => NodeSize {
  const cols = new Map<string, number>();
  for (const t of schema.tables) cols.set(t.name, t.columns.length);
  return (n) => ({ width: 240, height: 28 + (cols.get(n) ?? 0) * 20 + 8 });
}

function layoutOf(schema: Schema): Map<QualifiedName, { x: number; y: number }> {
  return smartLayout({
    tables: schema.tables, refs: schema.refs, groups: schema.groups, sizeOf: sizeOfFor(schema), mode: 'all',
  });
}

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
