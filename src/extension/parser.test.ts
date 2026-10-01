import { describe, expect, it } from 'vitest';
import { parseDbml } from './parser';

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
