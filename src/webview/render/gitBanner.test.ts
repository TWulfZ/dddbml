import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../vscode', () => ({ postToHost: vi.fn() }));

import type { Table, TableDiffStatus } from '../../shared/types';
import { store } from '../state/store';
import { buildDiffTargets, diffNavIndex } from './gitBanner';

const table = (name: string, groupName?: string): Table => ({
  name,
  schemaName: 'public',
  tableName: name.split('.')[1]!,
  columns: [{ name: 'id', type: 'int' }],
  ...(groupName ? { groupName } : {}),
});

describe('diff change targets respect view filters', () => {
  const tables = [table('public.a', 'G'), table('public.b', 'G'), table('public.c'), table('public.h')];
  const tablesByName = new Map(tables.map((t) => [t.name, t]));
  const positions = new Map([
    ['public.a', { x: 0, y: 0 }],
    ['public.b', { x: 400, y: 0 }],
    ['public.c', { x: 0, y: 800 }],
    ['public.h', { x: 5000, y: 4000 }],
  ]);
  const filters = {
    hiddenTables: new Set(['public.h']),
    collapsedTables: new Set(['public.a', 'public.b']),
    collapsedNodes: [{ name: 'G', x: 1500, y: 100, w: 200, h: 80 }],
  };
  const changed = new Map<string, TableDiffStatus>([
    ['public.a', 'modified'],
    ['public.b', 'modified'],
    ['public.c', 'modified'],
    ['public.h', 'modified'],
  ]);

  it('skips hidden tables and lands collapsed ones on their group node, once per group', () => {
    const targets = buildDiffTargets(changed, null, positions, tablesByName, filters);
    expect(targets.map((t) => ({ x: t.x, y: t.y }))).toEqual([
      { x: 1500, y: 100 },
      { x: 0, y: 800 },
    ]);
  });
});

const emptyDiff = { tables: [], refs: [] };

beforeEach(() => store.getState().exitGitView());

describe('diff banner navigation', () => {
  it('first Next after opening the diff lands on change 1, not change 2', () => {
    store.getState().enterDiff('HEAD', 'working', emptyDiff);
    expect(diffNavIndex(store.getState().diffCursor, 3, 1)).toBe(0);
  });

  it('first Prev after opening the diff lands on the last change', () => {
    store.getState().enterDiff('HEAD', 'working', emptyDiff);
    expect(diffNavIndex(store.getState().diffCursor, 3, -1)).toBe(2);
  });

  it('wraps once a change is focused', () => {
    expect(diffNavIndex(2, 3, 1)).toBe(0);
    expect(diffNavIndex(0, 3, -1)).toBe(2);
  });
});
