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
