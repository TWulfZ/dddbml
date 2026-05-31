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
    expect(store.getState().past).toHaveLength(1);
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
