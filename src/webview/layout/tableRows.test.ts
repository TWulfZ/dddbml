import { describe, expect, it } from 'vitest';
import type { ColumnDiffEntry, Table } from '../../shared/types';
import { buildRowGeometry } from './tableRows';

const posts: Table = {
  name: 'public.posts',
  schemaName: 'public',
  tableName: 'posts',
  columns: [
    { name: 'id', type: 'int', pk: true },
    { name: 'title', type: 'text' },
    { name: 'body', type: 'text' },
    { name: 'created_at', type: 'timestamp' },
    { name: 'updated_at', type: 'timestamp' },
    { name: 'user_id', type: 'int' },
  ],
};
const fk = new Map([['public.posts', new Set(['user_id'])]]);

describe('buildRowGeometry — rows a table actually renders', () => {
  it('PK/FK-only view: the FK port sits on its filtered row and the box shrinks to 2 rows', () => {
    const g = buildRowGeometry({ tables: [posts], showOnlyPkFk: true, fkColumnsByTable: fk });
    expect(g.count('public.posts')).toBe(2);
    expect(g.indexOf('public.posts', 'user_id')).toBe(1);
    expect(g.indexOf('public.posts', 'title')).toBe(-1);
  });

  it('unfiltered view keeps the full column list', () => {
    const g = buildRowGeometry({ tables: [posts], showOnlyPkFk: false, fkColumnsByTable: fk });
    expect(g.count('public.posts')).toBe(6);
    expect(g.indexOf('public.posts', 'user_id')).toBe(5);
  });

  it('a modified diff table counts its removed/old rows and ports the live (+new) row', () => {
    const base: Table = { ...posts, columns: [posts.columns[0]!, { name: 'legacy', type: 'int' }, ...posts.columns.slice(1)] };
    const columnDiff = new Map<string, ColumnDiffEntry>([['user_id', { name: 'user_id', status: 'changed', type: null }]]);
    const g = buildRowGeometry({
      tables: [posts],
      showOnlyPkFk: true,
      fkColumnsByTable: fk,
      diffByTable: new Map([['public.posts', 'modified']]),
      diffBaseByTable: new Map([['public.posts', base]]),
      columnDiffByTable: new Map([['public.posts', columnDiff]]),
    });
    // id, -legacy, title, body, created_at, updated_at, -user_id(old), +user_id(new)
    expect(g.count('public.posts')).toBe(8);
    expect(g.indexOf('public.posts', 'user_id')).toBe(7);
  });
});
