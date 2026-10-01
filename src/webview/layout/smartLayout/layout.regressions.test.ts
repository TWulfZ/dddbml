import { describe, it, expect } from 'vitest';
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
