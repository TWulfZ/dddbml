import { beforeEach, describe, expect, it } from 'vitest';
import { store, isCanvasReadOnly } from './store';
import type { MoveCommand } from './history';
import type { SchemaDiff, SerializableMergeConflict } from '../../shared/types';

beforeEach(() => {
  store.getState().exitGitView();
  store.getState().endMerge();
  store.getState().clearHistory();
});

const conflicts: SerializableMergeConflict[] = [
  { id: 'tables::a', section: 'tables', key: 'a', ours: { x: 1, y: 1 }, theirs: { x: 2, y: 2 } },
];

describe('git view slice (spec 16)', () => {
  it('isCanvasReadOnly is false in the normal state', () => {
    expect(isCanvasReadOnly(store.getState())).toBe(false);
  });

  it('enterTimeTravel sets the overlay, drops selection, and makes the canvas read-only', () => {
    store.getState().setSelection(['public.x']);
    store.getState().enterTimeTravel('abc123', 'abc123 · v1');
    const s = store.getState();
    expect(s.gitView).toEqual({ kind: 'timeTravel', rev: 'abc123', label: 'abc123 · v1' });
    expect(s.selection.size).toBe(0);
    expect(isCanvasReadOnly(s)).toBe(true);
  });

  it('undo/redo are no-ops while a git overlay is active', () => {
    store.getState().setTablePos('public.t', 5, 5);
    const move: MoveCommand = {
      kind: 'move',
      from: [['public.t', { x: 0, y: 0 }]],
      to: [['public.t', { x: 5, y: 5 }]],
      label: 'Move table',
      timestamp: 0,
    };
    store.getState().pushMoveCommand(move);
    store.getState().enterTimeTravel('abc', 'abc');
    store.getState().undo();
    expect(store.getState().positions.get('public.t')).toEqual({ x: 5, y: 5 });
    store.getState().exitGitView();
    expect(store.getState().past).toEqual([move]);
  });

  it('enterDiff builds the per-table / column / ref maps and ghosts', () => {
    const diff: SchemaDiff = {
      tables: [
        { table: 'public.new', status: 'added', columns: [], base: null, pos: null },
        {
          table: 'public.mod',
          status: 'modified',
          columns: [{ name: 'email', status: 'changed', type: null }],
          base: { name: 'public.mod', schemaName: 'public', tableName: 'mod', columns: [{ name: 'email', type: 'int' }] },
          pos: null,
        },
        {
          table: 'public.gone',
          status: 'removed',
          columns: [],
          base: { name: 'public.gone', schemaName: 'public', tableName: 'gone', columns: [{ name: 'id', type: 'int' }] },
          pos: { x: 10, y: 20 },
        },
      ],
      refs: [
        { id: 'r1', status: 'added', source: 'public.mod', target: 'public.new' },
        { id: 'r2', status: 'removed', source: 'public.gone', target: 'public.mod' },
      ],
    };
    store.getState().enterDiff('HEAD', 'working', diff);
    const s = store.getState();
    expect(s.gitView).toEqual({ kind: 'diff', baseLabel: 'HEAD', headLabel: 'working' });
    expect(s.diffByTable?.get('public.new')).toBe('added');
    expect(s.diffByTable?.get('public.mod')).toBe('modified');
    expect(s.diffByTable?.has('public.gone')).toBe(false); // removed → ghost, not a live node
    expect(s.columnDiffByTable?.get('public.mod')?.get('email')?.status).toBe('changed');
    expect(s.diffBaseByTable?.get('public.mod')?.tableName).toBe('mod'); // Previous table for the card
    expect(s.diffGhosts).toHaveLength(1);
    expect(s.diffGhosts?.[0]?.pos).toEqual({ x: 10, y: 20 });
    expect(s.refDiff?.get('r1')).toBe('added');
    expect(s.diffRemovedRefs).toHaveLength(1);
    expect(isCanvasReadOnly(s)).toBe(true);
  });

  describe('removed table with no position in the base sidecar', () => {
    const gone = (name: string) => ({
      table: name,
      status: 'removed' as const,
      columns: [],
      base: { name, schemaName: 'public', tableName: name.split('.')[1]!, columns: [{ name: 'id', type: 'int' }] },
      pos: null,
    });

    it('falls back to the webview position the table had before it was deleted', () => {
      store.getState().setTablePos('public.audit', 300, 400);
      store.getState().enterDiff('HEAD', 'working', { tables: [gone('public.audit')], refs: [] });
      expect(store.getState().diffGhosts?.map((g) => g.pos)).toEqual([{ x: 300, y: 400 }]);
    });

    it('still gets a ghost next to its referenced live table when no position is known', () => {
      store.getState().setPositionsBatch([['public.users', { x: 100, y: 50 }]]);
      store.getState().enterDiff('HEAD', 'working', {
        tables: [gone('public.never_placed')],
        refs: [{ id: 'r', status: 'removed', source: 'public.never_placed', target: 'public.users' }],
      });
      const g = store.getState().diffGhosts?.[0];
      expect(g?.table.name).toBe('public.never_placed');
      expect(g!.pos.x).toBeGreaterThan(100);
      expect(g!.pos.y).toBe(50);
    });

    it('still gets a ghost when it has neither a position nor refs', () => {
      store.getState().enterDiff('HEAD', 'working', { tables: [gone('public.orphan_a'), gone('public.orphan_b')], refs: [] });
      const ghosts = store.getState().diffGhosts ?? [];
      expect(ghosts.map((g) => g.table.name)).toEqual(['public.orphan_a', 'public.orphan_b']);
      expect(ghosts[0]!.pos).not.toEqual(ghosts[1]!.pos);
    });
  });

  it('exitGitView clears every diff map', () => {
    store.getState().enterDiff('HEAD', 'working', { tables: [], refs: [] });
    store.getState().exitGitView();
    const s = store.getState();
    expect(s.gitView).toBeNull();
    expect(s.diffByTable).toBeNull();
    expect(s.refDiff).toBeNull();
    expect(s.diffGhosts).toBeNull();
  });

  it('beginMerge wins over a git overlay (clears gitView)', () => {
    store.getState().enterTimeTravel('abc', 'abc');
    store.getState().beginMerge(conflicts);
    expect(store.getState().gitView).toBeNull();
    expect(store.getState().mergeConflicts).toHaveLength(1);
  });
});

describe('read-only gate on the git overlays', () => {
  it('entering time travel from an active diff drops the diff maps (F63)', () => {
    store.getState().enterDiff('HEAD', 'working', {
      tables: [{ table: 'public.a', status: 'added', columns: [], base: null, pos: null }],
      refs: [{ id: 'r1', status: 'added', source: 'public.a', target: 'public.b' }],
    });
    store.getState().enterTimeTravel('abc', 'abc');
    const s = store.getState();
    expect(s.gitView?.kind).toBe('timeTravel');
    expect([s.diffByTable, s.columnDiffByTable, s.diffBaseByTable, s.diffGhosts, s.refDiff, s.diffRemovedRefs]).toEqual([null, null, null, null, null, null]);
  });

  it('Diagram Views and colour edits are refused while read-only', () => {
    store.getState().enterTimeTravel('abc', 'abc');
    const before = store.getState();
    store.getState().setGroup('G', { collapsed: true, hidden: true, color: '#123456' });
    store.getState().setTableHidden('public.a', true);
    store.getState().setTableColor('public.a', '#123456');
    store.getState().setEdgeColor('public.a.id>public.b.id', '#123456');
    const after = store.getState();
    expect(after.groups).toBe(before.groups);
    expect(after.hiddenTables).toBe(before.hiddenTables);
    expect(after.tableColors).toBe(before.tableColors);
    expect(after.edgeLayouts).toBe(before.edgeLayouts);
  });
});
