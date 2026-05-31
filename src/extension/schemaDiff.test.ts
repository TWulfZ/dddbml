import { describe, expect, it } from 'vitest';
import { diffSchemas } from './schemaDiff';
import type { Column, Schema, Table } from '../shared/types';

function col(name: string, type = 'int', extra: Partial<Column> = {}): Column {
  return { name, type, ...extra };
}
function table(name: string, columns: Column[], extra: Partial<Table> = {}): Table {
  return { name, schemaName: 'public', tableName: name.replace(/^public\./, ''), columns, ...extra };
}
function schema(tables: Table[], refs: Schema['refs'] = []): Schema {
  return { tables, refs, groups: [] };
}

const users = table('public.users', [col('id', 'int', { pk: true }), col('email')]);
const orders = table('public.orders', [col('id', 'int', { pk: true }), col('user_id')]);
const ref = {
  id: 'public.orders.user_id->public.users.id',
  source: { table: 'public.orders', columns: ['user_id'], relation: '*' as const },
  target: { table: 'public.users', columns: ['id'], relation: '1' as const },
};

describe('diffSchemas', () => {
  it('identical schemas produce no diff', () => {
    const d = diffSchemas(schema([users, orders], [ref]), schema([users, orders], [ref]));
    expect(d.tables).toHaveLength(0);
    expect(d.refs).toHaveLength(0);
  });

  it('detects an added table (border-only, carries no base)', () => {
    const d = diffSchemas(schema([users]), schema([users, orders]));
    expect(d.tables).toEqual([
      expect.objectContaining({ table: 'public.orders', status: 'added', columns: [], base: null }),
    ]);
  });

  it('detects a removed table and carries its base for the ghost', () => {
    const d = diffSchemas(schema([users, orders]), schema([users]));
    const removed = d.tables.find((t) => t.table === 'public.orders');
    expect(removed?.status).toBe('removed');
    expect(removed?.base?.name).toBe('public.orders');
    expect(removed?.pos).toBeNull(); // position is filled by the host, not the pure diff
  });

  it('detects column add / remove / change on a modified table', () => {
    const before = table('public.users', [col('id', 'int', { pk: true }), col('email'), col('age', 'int')]);
    const after = table('public.users', [
      col('id', 'int', { pk: true }),
      col('email', 'varchar'), // changed type
      col('name'),             // added
      // age removed
    ]);
    const d = diffSchemas(schema([before]), schema([after]));
    expect(d.tables).toHaveLength(1);
    const t = d.tables[0]!;
    expect(t.status).toBe('modified');
    const byName = new Map(t.columns.map((c) => [c.name, c]));
    expect(byName.get('email')?.status).toBe('changed');
    expect(byName.get('name')?.status).toBe('added');
    expect(byName.get('age')?.status).toBe('removed');
    expect(byName.get('age')?.type).toBe('int'); // base type retained for the ghost row
    expect(byName.get('id')).toBeUndefined();     // unchanged column omitted
    expect(t.base?.name).toBe('public.users');    // Previous table carried for the hover card
  });

  it('detects added and removed refs', () => {
    const added = diffSchemas(schema([users, orders]), schema([users, orders], [ref]));
    expect(added.refs).toEqual([expect.objectContaining({ id: ref.id, status: 'added' })]);

    const removed = diffSchemas(schema([users, orders], [ref]), schema([users, orders]));
    expect(removed.refs).toEqual([expect.objectContaining({ id: ref.id, status: 'removed' })]);
  });

  it('flags a pk/notNull-only change as modified even when the type is unchanged', () => {
    const before = table('public.t', [col('id', 'int')]);
    const after = table('public.t', [col('id', 'int', { pk: true, notNull: true })]);
    const d = diffSchemas(schema([before]), schema([after]));
    expect(d.tables[0]?.columns[0]).toMatchObject({ name: 'id', status: 'changed' });
  });
});
