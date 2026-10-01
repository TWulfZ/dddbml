import { beforeEach, describe, expect, it } from 'vitest';
import { store } from './store';
import type { Schema, Table } from '../../shared/types';

const mkTable = (name: string): Table => ({ name, schemaName: 'public', tableName: name, columns: [] });

const schema: Schema = {
  tables: ['a', 'b', 'c'].map(mkTable),
  refs: [],
  groups: [{ name: 'billing', tables: ['b', 'c'] }],
};

beforeEach(() => {
  store.getState().setSchema(schema, null);
  store.setState({ groups: {}, hiddenTables: new Set(), selection: new Set(['a', 'b', 'c']) });
});

// Hidden / collapsed tables are not rendered, so a stale selection would let a multi-drag move
// them and feed them to every selection-scoped action.
describe('selection pruning', () => {
  it('collapsing a group drops its members from the selection', () => {
    store.getState().setGroup('billing', { collapsed: true });
    expect([...store.getState().selection]).toEqual(['a']);
  });

  it('hiding a group drops its members from the selection', () => {
    store.getState().setGroup('billing', { hidden: true });
    expect([...store.getState().selection]).toEqual(['a']);
  });

  it('a colour change keeps the same selection Set', () => {
    const before = store.getState().selection;
    store.getState().setGroup('billing', { color: '#ff0000' });
    expect(store.getState().selection).toBe(before);
  });

  it('hiding a table drops it from the selection', () => {
    store.getState().setTableHidden('a', true);
    expect([...store.getState().selection]).toEqual(['b', 'c']);
  });

  it('a schema without a selected table drops it from the selection', () => {
    store.getState().setSchema({ ...schema, tables: ['a', 'b'].map(mkTable) }, null);
    expect([...store.getState().selection]).toEqual(['a', 'b']);
  });
});
