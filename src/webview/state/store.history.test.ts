import { beforeEach, describe, expect, it } from 'vitest';
import { store } from './store';
import type { MoveCommand } from './history';
import type { Layout, Schema, Table } from '../../shared/types';

const mkCmd = (entries: Array<[string, { x: number; y: number }, { x: number; y: number }]>): MoveCommand => ({
  kind: 'move',
  from: entries.map(([n, f]) => [n, f]),
  to: entries.map(([n, _f, t]) => [n, t]),
  label: entries.length === 1 ? `Move ${entries[0]![0]}` : `Move ${entries.length} tables`,
  timestamp: 1,
});

const mkTable = (name: string): Table => ({
  name,
  schemaName: name.includes('.') ? name.split('.')[0]! : 'public',
  tableName: name.includes('.') ? name.split('.')[1]! : name,
  columns: [],
});

const blankLayout: Layout = {
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  tables: {},
  groups: {},
};

beforeEach(() => {
  // Reset to a known clean state. setLayout already wipes history; positions are
  // explicitly seeded by tests that need them via store.setState.
  store.getState().setLayout(blankLayout);
});

describe('history slice', () => {
  it('pushMoveCommand appends to past and clears future', () => {
    const a = mkCmd([['a', { x: 0, y: 0 }, { x: 10, y: 10 }]]);
    const b = mkCmd([['b', { x: 0, y: 0 }, { x: 20, y: 20 }]]);
    store.getState().pushMoveCommand(a);
    store.getState().pushMoveCommand(b);
    expect(store.getState().past).toHaveLength(2);
    expect(store.getState().future).toHaveLength(0);
  });

  it('pushMoveCommand drops oldest beyond capacity (FIFO)', () => {
    store.setState({ historyCapacity: 3 });
    const cmds = ['a', 'b', 'c', 'd', 'e'].map((n, i) =>
      mkCmd([[n, { x: 0, y: 0 }, { x: i, y: i }]]),
    );
    for (const c of cmds) store.getState().pushMoveCommand(c);
    const past = store.getState().past;
    expect(past).toHaveLength(3);
    expect((past[0]! as MoveCommand).from[0]![0]).toBe('c');
    expect((past[2]! as MoveCommand).from[0]![0]).toBe('e');
  });

  it('undo applies `from` positions and moves cmd to future', () => {
    store.setState({ positions: new Map([['a', { x: 100, y: 100 }]]) });
    const cmd = mkCmd([['a', { x: 0, y: 0 }, { x: 100, y: 100 }]]);
    store.getState().pushMoveCommand(cmd);
    store.getState().undo();
    const s = store.getState();
    expect(s.positions.get('a')).toEqual({ x: 0, y: 0 });
    expect(s.past).toHaveLength(0);
    expect(s.future).toHaveLength(1);
  });

  it('redo applies `to` positions and moves cmd back to past', () => {
    store.setState({ positions: new Map([['a', { x: 100, y: 100 }]]) });
    const cmd = mkCmd([['a', { x: 0, y: 0 }, { x: 100, y: 100 }]]);
    store.getState().pushMoveCommand(cmd);
    store.getState().undo();
    store.getState().redo();
    const s = store.getState();
    expect(s.positions.get('a')).toEqual({ x: 100, y: 100 });
    expect(s.past).toHaveLength(1);
    expect(s.future).toHaveLength(0);
  });

  it('undo on empty past is a no-op', () => {
    expect(store.getState().past).toHaveLength(0);
    store.getState().undo();
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().future).toHaveLength(0);
  });

  it('redo on empty future is a no-op', () => {
    expect(store.getState().future).toHaveLength(0);
    store.getState().redo();
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().future).toHaveLength(0);
  });

  it('new push after undo clears future (no DAG)', () => {
    const a = mkCmd([['a', { x: 0, y: 0 }, { x: 10, y: 10 }]]);
    const b = mkCmd([['b', { x: 0, y: 0 }, { x: 20, y: 20 }]]);
    store.getState().pushMoveCommand(a);
    store.getState().undo();
    expect(store.getState().future).toHaveLength(1);
    store.getState().pushMoveCommand(b);
    expect(store.getState().future).toHaveLength(0);
    expect(store.getState().past).toHaveLength(1);
  });

  it('clearHistory empties both stacks', () => {
    const cmd = mkCmd([['a', { x: 0, y: 0 }, { x: 10, y: 10 }]]);
    store.getState().pushMoveCommand(cmd);
    store.getState().undo();
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().future).toHaveLength(1);
    store.getState().clearHistory();
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().future).toHaveLength(0);
  });

  it('setLayout resets both stacks', () => {
    const cmd = mkCmd([['a', { x: 0, y: 0 }, { x: 10, y: 10 }]]);
    store.getState().pushMoveCommand(cmd);
    store.getState().setLayout(blankLayout);
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().future).toHaveLength(0);
  });

  it('setSchema with a different table set resets stacks', () => {
    store.setState({ schema: { tables: [mkTable('a'), mkTable('b')], refs: [], groups: [] } });
    store.getState().pushMoveCommand(mkCmd([['a', { x: 0, y: 0 }, { x: 1, y: 1 }]]));
    expect(store.getState().past).toHaveLength(1);

    const newSchema: Schema = { tables: [mkTable('a'), mkTable('c')], refs: [], groups: [] };
    store.getState().setSchema(newSchema, null);
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().future).toHaveLength(0);
  });

  it('setSchema with the same table set preserves stacks', () => {
    store.setState({ schema: { tables: [mkTable('a'), mkTable('b')], refs: [], groups: [] } });
    store.getState().pushMoveCommand(mkCmd([['a', { x: 0, y: 0 }, { x: 1, y: 1 }]]));

    // Same table set, only column metadata changes (a + b still present).
    const samSchema: Schema = {
      tables: [
        { ...mkTable('a'), columns: [{ name: 'id', type: 'int' }] },
        mkTable('b'),
      ],
      refs: [],
      groups: [],
    };
    store.getState().setSchema(samSchema, null);
    expect(store.getState().past).toHaveLength(1);
  });
});
