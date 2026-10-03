import { describe, expect, it } from 'vitest';
import { findColumnLocation, findTableLine, findTableDeclarationRanges } from './tableLocation';

describe('findTableLine — unparseable buffer fallback', () => {
  const broken = `Table "auth"."users" {\n  id int\n}\n\nTable usuários [headercolor: #fff] {\n  id int\n\nTable orphan {\n`;

  it('still finds quoted, schema-qualified and non-ASCII declarations', () => {
    expect(findTableLine(broken, 'auth.users')).toBe(0);
    expect(findTableLine(broken, 'public.usuários')).toBe(4);
    expect(findTableLine(broken, 'public.missing')).toBeNull();
  });
});

describe('findColumnLocation', () => {
  const src = `Table "auth"."users" {\n  id int\n  "full name" varchar\n}\n\nTablePartial base {\n  created timestamp\n}\n\nTable a {\n  id int\n  ~base\n}\n`;

  it('points at the column name, quoted or injected from a TablePartial', () => {
    expect(findColumnLocation(src, 'auth.users', 'full name')).toEqual({ line: 2, character: 2 });
    expect(findColumnLocation(src, 'public.a', 'created')).toEqual({ line: 6, character: 2 });
    expect(findColumnLocation(src, 'public.a', 'missing')).toBeNull();
    expect(findColumnLocation('Table a {\n', 'public.a', 'id')).toBeNull();
  });
});

describe('findTableDeclarationRanges', () => {
  it('finds top-level declarations only, skipping comments, strings and a column named "table"', () => {
    const src = `// Table ghost {\nTable "auth"."users" as U {\n  table varchar [note: 'Table fake {']\n}\n/* Table hidden { */\ntable orgs {\n  id int\n}\n`;
    const ranges = findTableDeclarationRanges(src);
    expect(ranges.map((r) => [r.table, src.slice(r.start, r.end)])).toEqual([
      ['auth.users', `Table "auth"."users" as U {\n  table varchar [note: 'Table fake {']\n}`],
      ['public.orgs', 'table orgs {\n  id int\n}'],
    ]);
  });

  it('spans the whole block through settings, nested blocks and braces inside strings', () => {
    const src = `Table a [headercolor: #fff, note: '}'] {\n  id int\n  indexes {\n    id [pk]\n  }\n  Note: '{'\n}\nRef: a.id > a.id\n`;
    const [range] = findTableDeclarationRanges(src);
    expect(src.slice(range!.start, range!.end)).toBe(src.slice(0, src.indexOf('\nRef')));
  });

  it('falls back to the header when the body never closes, without claiming later tables', () => {
    const src = `Table a {\n  id int\n\nTable b {\n  id int\n}\nTable c\nEnum e {\n  x\n}\n`;
    expect(findTableDeclarationRanges(src).map((r) => [r.table, src.slice(r.start, r.end)])).toEqual([['public.a', 'Table a']]);
    const headerOnly = `Table c\nEnum e {\n  x\n}\n`;
    expect(findTableDeclarationRanges(headerOnly).map((r) => headerOnly.slice(r.start, r.end))).toEqual(['Table c']);
  });
});
