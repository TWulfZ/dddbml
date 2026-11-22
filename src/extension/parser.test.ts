import { describe, expect, it } from 'vitest';
import { parseDbml, RECORDS_ROW_CAP } from './parser';

function parse(src: string) {
  const r = parseDbml(src);
  if (!r.schema) throw new Error(r.error.message);
  return r.schema;
}

describe('parseDbml — TableGroup membership', () => {
  it('assigns groupName to schema-qualified tables whose schema is exported before public', () => {
    const s = parse(`
      Table core.users { id int [pk] }
      Table billing.invoice { id int [pk]
        user_id int [ref: > core.users.id] }
      TableGroup Core { core.users }
      TableGroup Billing { billing.invoice }
    `);
    const groupOf = Object.fromEntries(s.tables.map((t) => [t.name, t.groupName]));
    expect(groupOf).toEqual({ 'billing.invoice': 'Billing', 'core.users': 'Core' });
  });

  it('assigns groupName when a qualified table precedes a public table in the same group', () => {
    const s = parse(`
      Table core.users { id int [pk] }
      Table accounts { id int [pk] }
      TableGroup Mixed { core.users
        accounts }
    `);
    const groupOf = Object.fromEntries(s.tables.map((t) => [t.name, t.groupName]));
    expect(groupOf).toEqual({ 'core.users': 'Mixed', 'public.accounts': 'Mixed' });
  });
});

describe('parseDbml — refs written against a table alias', () => {
  const endpoints = (src: string) =>
    parse(src).refs.map((r) => [r.source.table, r.target.table].sort().join(' '));

  it('resolves a standalone ref through the alias', () => {
    expect(endpoints(`
      Table users as U { id int [pk] }
      Table posts { id int [pk]
        user_id int }
      Ref: posts.user_id > U.id
    `)).toEqual(['public.posts public.users']);
  });

  it('resolves an inline ref through the alias', () => {
    expect(endpoints(`
      Table users as U { id int [pk] }
      Table posts { id int [pk]
        user_id int [ref: > U.id] }
    `)).toEqual(['public.posts public.users']);
  });

  it("resolves an alias to its own schema, not the ref's", () => {
    const s = parse(`
      Table core.users as U { id int [pk] }
      Table posts { id int [pk]
        user_id int }
      Ref: posts.user_id > U.id
    `);
    expect(s.refs.map((r) => r.target.table)).toEqual(['core.users']);
    expect(s.refs[0]!.id).toBe('core.users(id)->public.posts(user_id)');
  });
});

describe('parseDbml — index-level primary keys', () => {
  it('marks every member of a composite pk index as pk', () => {
    const s = parse(`
      Table enrollments {
        student_id int
        course_id int
        grade int
        indexes { (student_id, course_id) [pk] }
      }
    `);
    const pkCols = s.tables[0]!.columns.filter((c) => c.pk).map((c) => c.name);
    expect(pkCols).toEqual(['student_id', 'course_id']);
  });
});

describe('parseDbml — locale-independent order (audit F88)', () => {
  it('sorts tables and groups by code unit, so every teammate feeds layout the same order', () => {
    const s = parse(`
      Table alpha { id int [pk] }
      Table Zeta { id int [pk] }
      TableGroup beta { alpha }
      TableGroup Omega { Zeta }
    `);
    // localeCompare puts lowercase "alpha" before "Zeta" under every ICU locale; code-unit order does not.
    expect(s.tables.map((t) => t.name)).toEqual(['public.Zeta', 'public.alpha']);
    expect(s.groups.map((g) => g.name)).toEqual(['Omega', 'beta']);
  });
});

describe('parseDbml — records (issue #3)', () => {
  it('parses both records syntaxes from the issue and keeps typed cell values', () => {
    const s = parse(`
      Table users {
        id int [pk]
        name varchar
        records {
          1, 'a'
          2, null
        }
      }
      Table plans { id int
        price decimal }
      records plans (id, price) {
        1, 9.5
      }
    `);
    expect(s.records).toEqual([
      { table: 'public.plans', columns: ['id', 'price'], rows: [[{ v: 1, t: 'integer' }, { v: 9.5, t: 'real' }]], totalRows: 1 },
      {
        table: 'public.users',
        columns: ['id', 'name'],
        rows: [[{ v: 1, t: 'integer' }, { v: 'a', t: 'string' }], [{ v: 2, t: 'integer' }, { v: null, t: 'null' }]],
        totalRows: 2,
      },
    ]);
  });

  it('caps the rows sent to the webview but reports the real total', () => {
    const body = Array.from({ length: RECORDS_ROW_CAP + 5 }, (_, i) => `  ${i}`).join('\n');
    const s = parse(`Table t { id int }\nrecords t (id) {\n${body}\n}`);
    expect(s.records![0]!.rows).toHaveLength(RECORDS_ROW_CAP);
    expect(s.records![0]!.totalRows).toBe(RECORDS_ROW_CAP + 5);
  });

  it('omits records entirely when the schema has none', () => {
    expect(parse('Table t { id int }').records).toBeUndefined();
  });
});

describe('parseDbml — Dep (issue #3)', () => {
  it('parses the issue syntax as a directional column-level dependency, outside refs', () => {
    const s = parse(`
      Table table1 { col int }
      Table table2 { col int }
      Dep: table1.col -> table2.col
    `);
    expect(s.refs).toEqual([]);
    expect(s.deps).toEqual([
      {
        name: null,
        note: null,
        edges: [
          {
            id: 'public.table1(col)->public.table2(col)',
            upstream: { table: 'public.table1', columns: ['col'] },
            downstream: { table: 'public.table2', columns: ['col'] },
          },
        ],
      },
    ]);
  });

  it('keeps table-level edges, block color/note, and resolves schemas and aliases', () => {
    const s = parse(`
      Table raw.stripe as S { id int }
      Table stg_orders { id int }
      Dep lineage [color: #3b82f6, note: 'paid orders'] {
        S -> stg_orders
      }
    `);
    expect(s.deps).toEqual([
      {
        name: 'lineage',
        color: '#3b82f6',
        note: 'paid orders',
        edges: [
          {
            id: 'raw.stripe()->public.stg_orders()',
            upstream: { table: 'raw.stripe', columns: [] },
            downstream: { table: 'public.stg_orders', columns: [] },
          },
        ],
      },
    ]);
  });
});

describe('parseDbml — headercolor', () => {
  it('exposes headercolor only on tables that declare it', () => {
    const s = parse('Table a [headercolor: #3498DB] { id int }\nTable b { id int }');
    expect(s.tables.map((t) => t.headerColor)).toEqual(['#3498DB', undefined]);
  });
});


describe('DBML documentation conformance — references', () => {
  const operators = [
    ['>', '*', '1'], ['<', '1', '*'], ['-', '1', '1'], ['<>', '*', '*'],
  ] as const;
  for (const [op, left, right] of operators) {
    for (const optionalLeft of [false, true]) for (const optionalRight of [false, true]) {
      const operator = `${optionalLeft ? '?' : ''}${op}${optionalRight ? '?' : ''}`;
      for (const form of ['short', 'long', 'inline']) {
        it(`${form} ${operator} preserves both endpoint cardinalities`, () => {
          const inline = form === 'inline' ? `[ref: ${operator} b.id]` : '';
          const relation = `a.id ${operator} b.id`;
          const src = `Table a { id int ${inline} }\nTable b { id int }\n` +
            (form === 'short' ? `Ref link: ${relation}` : form === 'long' ? `Ref link { ${relation} }` : '');
          const s = parse(src);
          expect(s.refs).toHaveLength(1);
          const ref = s.refs[0]!;
          const a = [ref.source, ref.target].find((e) => e.table === 'public.a')!;
          const b = [ref.source, ref.target].find((e) => e.table === 'public.b')!;
          expect([a.relation, b.relation]).toEqual([left, right]);
          expect([a.optional ?? false, b.optional ?? false]).toEqual([optionalLeft, optionalRight]);
        });
      }
    }
  }

  it.each(['cascade', 'restrict', 'set null', 'set default', 'no action'])(
    'preserves referential action %s, name, color, and composite column order', (action) => {
      const s = parse(`
        Table core.parent as P { id int
          country varchar }
        Table child { parent_id int
          country varchar }
        Ref composite: child.(parent_id, country) > P.(id, country) [delete: ${action}, update: ${action}, color: #ff0000]
      `);
      expect(s.refs[0]).toMatchObject({
        name: 'composite', color: '#ff0000', onDelete: action, onUpdate: action,
        source: { table: 'public.child', columns: ['parent_id', 'country'], relation: '*' },
        target: { table: 'core.parent', columns: ['id', 'country'], relation: '1' },
      });
    },
  );

  it('keeps repeated inline refs, self refs, and quoted identifiers', () => {
    const s = parse(`
      Table "user accounts" { "user id" int [pk, ref: < posts.author, ref: < posts.reviewer]
        manager int [ref: > "user accounts"."user id"] }
      Table posts { author int
        reviewer int }
    `);
    expect(s.refs).toHaveLength(3);
    expect(s.refs.flatMap((r) => [r.source.table, r.target.table])).not.toContain('public.user');
    expect(s.refs.some((r) => r.source.table === r.target.table)).toBe(true);
  });
});

describe('DBML documentation conformance — table syntax', () => {
  it('renders resolved partials, quoted types, enums, checks, indexes, defaults and notes', () => {
    const s = parse(`
      Project sample { database_type: 'PostgreSQL' }
      Enum core.status as Status { active
        "not active" }
      TablePartial base { id int [pk, increment]
        created_at timestamp [default: \`now()\`] }
      Table core.users [note: 'Users', headercolor: #123456] {
        ~base
        "full name" varchar(255) [not null, unique, note: 'Display name']
        balance "double precision" [default: 1.5, check: \`balance >= 0\`]
        enabled boolean [default: false]
        status Status
        checks { \`id > 0\` [name: 'positive_id'] }
        indexes { ("full name" [desc]) [name: 'names'] }
        records (id, "full name") [example] { 1, 'Alice' }
      }
    `);
    expect(s.tables[0]).toMatchObject({name: 'core.users', note: 'Users', headerColor: '#123456'});
    expect(s.tables[0]!.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({name: 'id', pk: true, increment: true}),
      expect.objectContaining({name: 'full name', type: 'varchar(255)', notNull: true, unique: true, note: 'Display name'}),
      expect.objectContaining({name: 'balance', type: 'double precision', default: '1.5'}),
      expect.objectContaining({name: 'enabled', default: 'false'}),
    ]));
    expect(s.records?.[0]?.rows).toHaveLength(1);
  });
});

describe('diagram annotations', () => {
  it('reads project info, group appearance, and the exact categories in a named view', () => {
    const schema = parse(`
Project demo {
  database_type: 'PostgreSQL'
  Note: 'Overview'
}
Table core.user { id int [pk] }
Table orders { user_id int }
TableGroup app [color: #abc, note: 'Core tables'] { core.user }
Note caption { 'An annotation' }
DiagramView focused {
  Tables { orders }
  Notes { caption }
  TableGroups { app }
  Schemas { core }
}
DiagramView table_only { Tables { * } }
DiagramView all_notes { Notes { * } }
DiagramView empty {}
Ref: orders.user_id > core.user.id [inactive]
    `);
    expect(schema.project).toMatchObject({ name: 'demo', databaseType: 'PostgreSQL', note: 'Overview' });
    expect(schema.groups).toEqual([{ name: 'app', tables: ['core.user'], color: '#abc', note: 'Core tables' }]);
    expect(schema.refs[0]?.inactive).toBe(true);
    expect(schema.diagramViews).toEqual([
      { name: 'focused', tables: ['public.orders'], notes: ['caption'], groups: ['app'], schemas: ['core'] },
      { name: 'table_only', tables: '*', notes: [], groups: [], schemas: [] },
      { name: 'all_notes', tables: [], notes: '*', groups: [], schemas: [] },
      { name: 'empty', tables: [], notes: [], groups: [], schemas: [] },
    ]);
  });
});

it('reads ordered title-block fields, title font size, and image filenames from Project', () => {
  const schema = parse(`Project "Sales database" {
    database_type: 'Postgres 18.0'
    created: "31.12.2026"
    document_type: 'ERD schema'
    author: 'O\\'Connor'
    font_size: '42'
    logo: 'company logo.svg'
    image: 'mark.png'
    Note: 'Schema overview'
  }`);
  expect(schema.project).toEqual({
    name: 'Sales database', databaseType: 'Postgres 18.0', fontSize: 42, note: 'Schema overview',
    fields: [
      { key: 'database_type', value: 'Postgres 18.0' },
      { key: 'created', value: '31.12.2026' },
      { key: 'document_type', value: 'ERD schema' },
      { key: 'author', value: "O'Connor" },
    ],
    images: [{ key: 'logo', filename: 'company logo.svg' }, { key: 'image', filename: 'mark.png' }],
  });
});
