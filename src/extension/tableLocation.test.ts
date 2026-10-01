import { describe, expect, it } from 'vitest';
import { findTableLine } from './tableLocation';

describe('findTableLine — unparseable buffer fallback', () => {
  const broken = `Table "auth"."users" {\n  id int\n}\n\nTable usuários [headercolor: #fff] {\n  id int\n\nTable orphan {\n`;

  it('still finds quoted, schema-qualified and non-ASCII declarations', () => {
    expect(findTableLine(broken, 'auth.users')).toBe(0);
    expect(findTableLine(broken, 'public.usuários')).toBe(4);
    expect(findTableLine(broken, 'public.missing')).toBeNull();
  });
});
