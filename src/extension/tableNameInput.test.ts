import { describe, expect, it } from 'vitest';
import { parseTableNameInput } from './tableNameInput';

const existing = new Set(['public.users', 'auth.users']);

describe('parseTableNameInput', () => {
  it('reads a bare name into public and a dotted one as schema.table', () => {
    expect(parseTableNameInput(' orders ', existing)).toEqual({ schema: null, table: 'orders', qualified: 'public.orders' });
    expect(parseTableNameInput('sales.order items', existing)).toEqual({ schema: 'sales', table: 'order items', qualified: 'sales.order items' });
    expect(parseTableNameInput('"v1.2"."a.b"', existing)).toEqual({ schema: 'v1.2', table: 'a.b', qualified: 'v1.2.a.b' });
  });

  it('rejects duplicates, including an explicit public schema', () => {
    expect(parseTableNameInput('users', existing)).toMatch(/already exists/);
    expect(parseTableNameInput('public.users', existing)).toMatch(/already exists/);
    expect(parseTableNameInput('auth.users', existing)).toMatch(/already exists/);
  });

  it('rejects empty parts, extra dots, stray quotes and control characters', () => {
    for (const bad of ['', '  ', 'a.b.c', '.a', 'a.', 'a"b', 'a\tb']) {
      expect(typeof parseTableNameInput(bad, existing)).toBe('string');
    }
  });
});
