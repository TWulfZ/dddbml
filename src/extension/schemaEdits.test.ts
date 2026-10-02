import { describe, expect, it } from 'vitest';
import { computeSchemaEdit, type SchemaEditIntent, type SchemaEditResult } from './schemaEdits';
import { parseDbml } from './parser';
import { applyEdits } from './textEdits';

const BASE = `// Billing — hand-written comments must survive
Table "auth"."users" as U {
  id int [pk] // primary
  "full name" varchar [not null, note: 'a, b]']
  org_id int [ref: > orgs.id, not null]
  indexes {
    (id, org_id) [unique]
  }
}

/* orgs table */
Table orgs {
  id int [pk]
  parent_id int [ref: > orgs.id]
  owner int
}

Ref owner_fk: orgs.owner > U.id [delete: cascade]

Table invoices {
  id int [pk]
  org int [ref: > orgs.id]
  amount int // money
  tags text[]
}

TableGroup billing {
  orgs // the org
  invoices
}
`;

type Ok = Extract<SchemaEditResult, { ok: true }>;

function run(source: string, intent: SchemaEditIntent): { result: Ok; after: string } {
  const result = computeSchemaEdit(source, intent);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  const after = applyEdits(source, result.edits);
  expect(parseDbml(after).error).toBeNull();
  expect(applyEdits(after, result.inverse)).toBe(source);
  return { result, after };
}

function refusal(source: string, intent: SchemaEditIntent): string {
  const result = computeSchemaEdit(source, intent);
  if (result.ok) throw new Error('expected a refusal');
  return result.reason;
}

const crlf = (s: string): string => s.replace(/\n/g, '\r\n');

describe('delete table', () => {
  const intent: SchemaEditIntent = { kind: 'delete', target: { kind: 'table', table: 'public.orgs' } };
  const expected = `// Billing — hand-written comments must survive
Table "auth"."users" as U {
  id int [pk] // primary
  "full name" varchar [not null, note: 'a, b]']
  org_id int [not null]
  indexes {
    (id, org_id) [unique]
  }
}

/* orgs table */

Table invoices {
  id int [pk]
  org int
  amount int // money
  tags text[]
}

TableGroup billing {
  invoices
}
`;

  it('removes the block, every inline / standalone ref to it and its group member line, nothing else', () => {
    const { result, after } = run(BASE, intent);
    expect(after).toBe(expected);
    expect(result.cascade).toEqual(expect.arrayContaining([
      'reference auth.users.org_id > orgs.id',
      'reference orgs.parent_id > orgs.id',
      'reference orgs.owner > auth.users.id',
      'reference invoices.org > orgs.id',
      'membership in TableGroup billing',
    ]));
    expect(result.label).toBe('Delete table orgs');
  });

  it('keeps CRLF line breaks byte-identical', () => {
    expect(run(crlf(BASE), intent).after).toBe(crlf(expected));
  });

  it('removes an aliased group member and a table written last in the file', () => {
    const single = `Table a as A {\n  id int\n}\n\nTableGroup g { A\n}\n\nTable b {\n  x int [ref: > A.id]\n  y int [note: 'a, b]', ref: - A.id]\n}\n`;
    expect(run(single, { kind: 'delete', target: { kind: 'table', table: 'public.a' } }).after)
      .toBe(`TableGroup g {\n}\n\nTable b {\n  x int\n  y int [note: 'a, b]']\n}\n`);
    expect(run(single, { kind: 'delete', target: { kind: 'table', table: 'public.b' } }).after)
      .toBe(`Table a as A {\n  id int\n}\n\nTableGroup g { A\n}\n`);
  });

  it('drops every ref setting of a column that pointed only at the deleted table', () => {
    const src = `Table t2 {\n  a int\n  b int\n}\n\nTable t1 {\n  y int [ref: > t2.a, pk, ref: > t2.b]\n  z int [ref: > t2.a, ref: > t2.b]\n}\n`;
    expect(run(src, { kind: 'delete', target: { kind: 'table', table: 'public.t2' } }).after)
      .toBe(`Table t1 {\n  y int [pk]\n  z int\n}\n`);
  });

  it('refuses when the table is still used by a Records block, leaving the file valid', () => {
    const src = `Table a {\n  id int\n}\n\nRecords a(id) {\n  1\n}\n`;
    expect(refusal(src, { kind: 'delete', target: { kind: 'table', table: 'public.a' } })).toMatch(/invalid/);
  });

  it('refuses a table that is not there and a buffer that does not parse', () => {
    expect(refusal(BASE, { kind: 'delete', target: { kind: 'table', table: 'public.nope' } })).toMatch(/not in the \.dbml/);
    expect(refusal('Table a {\n', { kind: 'delete', target: { kind: 'table', table: 'public.a' } })).toMatch(/does not parse/);
  });
});

describe('delete field', () => {
  it('removes a quoted column line only', () => {
    const { after } = run(BASE, { kind: 'delete', target: { kind: 'field', table: 'auth.users', column: 'full name' } });
    expect(after).toBe(BASE.replace(`  "full name" varchar [not null, note: 'a, b]']\n`, ''));
  });

  it('refuses a column in a composite index (spec 19 default)', () => {
    expect(refusal(BASE, { kind: 'delete', target: { kind: 'field', table: 'auth.users', column: 'org_id' } }))
      .toMatch(/composite index \(id, org_id\)/);
  });

  it('removes the refs that use it, including a self-ref, and keeps the other settings', () => {
    const { result, after } = run(BASE, { kind: 'delete', target: { kind: 'field', table: 'public.orgs', column: 'id' } });
    expect(after).toBe(BASE
      .replace('org_id int [ref: > orgs.id, not null]', 'org_id int [not null]')
      .replace('  id int [pk]\n  parent_id int [ref: > orgs.id]\n', '  parent_id int\n')
      .replace('org int [ref: > orgs.id]', 'org int'));
    expect(result.cascade).toHaveLength(3);
  });

  it('removes a standalone Ref statement that uses it', () => {
    const { after } = run(BASE, { kind: 'delete', target: { kind: 'field', table: 'public.orgs', column: 'owner' } });
    expect(after).toBe(BASE.replace('  owner int\n', '').replace('Ref owner_fk: orgs.owner > U.id [delete: cascade]\n\n', ''));
  });

  it('removes a single-column index on it', () => {
    const src = `Table a {\n  id int\n  code int\n  indexes {\n    code [unique] // fast\n    id\n  }\n}\n`;
    const { result, after } = run(src, { kind: 'delete', target: { kind: 'field', table: 'public.a', column: 'code' } });
    expect(after).toBe(`Table a {\n  id int\n  indexes {\n    id\n  }\n}\n`);
    expect(result.cascade).toEqual(['index on a(code)']);
  });

  it('refuses the last column and a column injected by a TablePartial', () => {
    expect(refusal('Table a {\n  id int\n}\n', { kind: 'delete', target: { kind: 'field', table: 'public.a', column: 'id' } })).toMatch(/only column/);
    const partial = `TablePartial base {\n  created timestamp\n}\n\nTable a {\n  id int\n  ~base\n}\n`;
    expect(refusal(partial, { kind: 'delete', target: { kind: 'field', table: 'public.a', column: 'created' } })).toMatch(/TablePartial/);
  });
});

describe('delete ref', () => {
  it('drops an inline setting and its separator, keeping the rest of the list', () => {
    const { after } = run(BASE, { kind: 'delete', target: { kind: 'ref', refId: 'auth.users(org_id)->public.orgs(id)' } });
    expect(after).toBe(BASE.replace('org_id int [ref: > orgs.id, not null]', 'org_id int [not null]'));
  });

  it('drops an emptied settings list with its brackets', () => {
    const { after } = run(BASE, { kind: 'delete', target: { kind: 'ref', refId: 'public.invoices(org)->public.orgs(id)' } });
    expect(after).toBe(BASE.replace('org int [ref: > orgs.id]', 'org int'));
  });

  it('drops the last setting of a multi-line list with its own comment, keeping the kept line comment', () => {
    const src = `Table a {\n  id int\n}\n\nTable b {\n  a_id int [\n    not null, // required\n    ref: > a.id // the fk\n  ]\n}\n`;
    expect(run(src, { kind: 'delete', target: { kind: 'ref', refId: 'public.a(id)->public.b(a_id)' } }).after)
      .toBe(`Table a {\n  id int\n}\n\nTable b {\n  a_id int [\n    not null // required\n  ]\n}\n`);
  });

  it('drops trailing settings of a one-line list without leaving a gap', () => {
    const src = `Table a {\n  id int\n}\n\nTable b {\n  a_id int [not null , note: 'x', ref: > a.id] // c\n}\n`;
    expect(run(src, { kind: 'delete', target: { kind: 'ref', refId: 'public.a(id)->public.b(a_id)' } }).after)
      .toBe(`Table a {\n  id int\n}\n\nTable b {\n  a_id int [not null , note: 'x'] // c\n}\n`);
  });

  it('removes a standalone Ref statement and one of the blank lines around it', () => {
    const { result, after } = run(BASE, { kind: 'delete', target: { kind: 'ref', refId: 'auth.users(id)->public.orgs(owner)' } });
    expect(after).toBe(BASE.replace('Ref owner_fk: orgs.owner > U.id [delete: cascade]\n\n', ''));
    expect(result.label).toBe('Delete reference orgs.owner > auth.users.id');
  });

  it('removes a long-form Ref block in a CRLF file', () => {
    const src = crlf(`Table a {\n  id int\n}\n\nTable b {\n  a_id int\n}\n\nRef fk {\n  b.a_id > a.id\n}\n`);
    expect(run(src, { kind: 'delete', target: { kind: 'ref', refId: 'public.a(id)->public.b(a_id)' } }).after)
      .toBe(crlf(`Table a {\n  id int\n}\n\nTable b {\n  a_id int\n}\n`));
  });

  it('refuses a ref that is gone', () => {
    expect(refusal(BASE, { kind: 'delete', target: { kind: 'ref', refId: 'public.x(a)->public.y(b)' } })).toMatch(/no longer/);
  });
});

describe('add ref', () => {
  it('creates a settings list after the type, before a trailing comment', () => {
    const { after, result } = run(BASE, { kind: 'addRef', from: { table: 'public.invoices', column: 'amount' }, to: { table: 'public.orgs', column: 'id' }, op: '>' });
    expect(after).toBe(BASE.replace('amount int // money', 'amount int [ref: > orgs.id] // money'));
    expect(result.label).toBe('Add reference invoices.amount > orgs.id');
  });

  it('appends to an existing list with schema-qualified, quoted target names', () => {
    const { after } = run(BASE, { kind: 'addRef', from: { table: 'public.invoices', column: 'id' }, to: { table: 'auth.users', column: 'full name' }, op: '-' });
    expect(after).toBe(BASE.replace('Table invoices {\n  id int [pk]', 'Table invoices {\n  id int [pk, ref: - auth.users."full name"]'));
  });

  it('treats brackets glued to the type as the type, not as settings', () => {
    const { after } = run(BASE, { kind: 'addRef', from: { table: 'public.invoices', column: 'tags' }, to: { table: 'public.orgs', column: 'id' }, op: '<>' });
    expect(after).toBe(BASE.replace('tags text[]', 'tags text[] [ref: <> orgs.id]'));
  });

  it('allows a self-reference', () => {
    const { after } = run(BASE, { kind: 'addRef', from: { table: 'public.orgs', column: 'owner' }, to: { table: 'public.orgs', column: 'id' }, op: '<' });
    expect(after).toBe(BASE.replace('  owner int\n', '  owner int [ref: < orgs.id]\n'));
  });

  it('refuses a duplicate and a missing column', () => {
    expect(refusal(BASE, { kind: 'addRef', from: { table: 'public.invoices', column: 'org' }, to: { table: 'public.orgs', column: 'id' }, op: '>' })).toMatch(/already exists/);
    expect(refusal(BASE, { kind: 'addRef', from: { table: 'public.invoices', column: 'nope' }, to: { table: 'public.orgs', column: 'id' }, op: '>' })).toMatch(/not in the \.dbml/);
  });
});

describe('add table', () => {
  it('appends a block at EOF and points the cursor line inside it', () => {
    const { result, after } = run(BASE, { kind: 'addTable', schema: null, table: 'payments' });
    expect(after).toBe(`${BASE}\nTable payments {\n  id int [pk]\n}\n`);
    expect(result.table).toBe('public.payments');
    const line = result.cursorLine!;
    const withLine = after.slice(0, line.offset) + line.text + after.slice(line.offset);
    expect(withLine.endsWith('Table payments {\n  id int [pk]\n  \n}\n')).toBe(true);
    expect(withLine.slice(line.offset + line.cursor)).toBe('\n}\n');
  });

  it('quotes names that need it and adds the member to a group with its indentation', () => {
    const src = crlf(`Table a {\n  id int\n}\n\nTableGroup "g 1" {\n    a\n}`);
    const { result, after } = run(src, { kind: 'addTable', schema: 'sales', table: 'order items', group: 'g 1' });
    expect(after).toBe(crlf(`Table a {\n  id int\n}\n\nTableGroup "g 1" {\n    a\n    sales."order items"\n}\n\nTable sales."order items" {\n  id int [pk]\n}\n`));
    expect(result.table).toBe('sales.order items');
    const line = result.cursorLine!;
    expect(after.slice(line.offset)).toBe('}\r\n');
  });

  it('opens a one-line group onto its own lines', () => {
    const { after } = run('Table a {\n  id int\n}\nTableGroup g { a }\n', { kind: 'addTable', schema: null, table: 'b', group: 'g' });
    expect(after).toBe('Table a {\n  id int\n}\nTableGroup g { a \n  b\n}\n\nTable b {\n  id int [pk]\n}\n');
  });

  it('refuses a duplicate name or an unknown group', () => {
    expect(refusal(BASE, { kind: 'addTable', schema: 'auth', table: 'users' })).toMatch(/already exists/);
    expect(refusal(BASE, { kind: 'addTable', schema: null, table: 'x', group: 'nope' })).toMatch(/TableGroup "nope"/);
  });

  it('works on an empty file', () => {
    expect(run('', { kind: 'addTable', schema: null, table: 'a' }).after).toBe('Table a {\n  id int [pk]\n}\n');
  });
});

describe('add field', () => {
  it('points an indented empty line before the closing brace, without editing the file', () => {
    const result = computeSchemaEdit(BASE, { kind: 'addField', table: 'public.orgs' });
    if (!result.ok) throw new Error(result.reason);
    expect(result.edits).toEqual([]);
    const line = result.cursorLine!;
    const withLine = BASE.slice(0, line.offset) + line.text + BASE.slice(line.offset);
    expect(withLine).toBe(BASE.replace('  owner int\n}', '  owner int\n  \n}'));
    expect(line.cursor).toBe(2);
  });

  it('splits a one-line table', () => {
    const src = 'Table t { id int }\n';
    const result = computeSchemaEdit(src, { kind: 'addField', table: 'public.t' });
    if (!result.ok) throw new Error(result.reason);
    const line = result.cursorLine!;
    expect(src.slice(0, line.offset) + line.text + src.slice(line.offset)).toBe('Table t { id int \n  \n}\n');
  });
});
