import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./vscode', () => ({ postToHost: vi.fn() }));

import { postToHost } from './vscode';
import { store } from './state/store';
import { handleHostMessage } from './hostMessages';
import { redoLatest, undoLatest } from './state/historyActions';
import { parseDbml } from '../extension/parser';
import type { Layout, Schema, WebviewToHost } from '../shared/types';

/** Webview half of spec 19: diagram `.dbml` edits in the undo history, and placed new tables. */

function schemaOf(src: string): Schema {
  const r = parseDbml(src);
  if (!r.schema) throw new Error(r.error.message);
  return r.schema;
}

const TWO = schemaOf('Table a { id int }\nTable b { id int }');
const THREE = schemaOf('Table a { id int }\nTable b { id int }\nTable c { id int }');
const LAYOUT: Layout = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, tables: { 'public.a': { x: 50, y: 0 }, 'public.b': { x: 400, y: 0 } }, groups: {}, edges: {} };

const posted = (): WebviewToHost[] => vi.mocked(postToHost).mock.calls.map(([m]) => m);
const postedTypes = (): string[] => posted().map((m) => m.type);

function moveA(to: number): void {
  store.getState().setTablePos('public.a', to, 0);
  store.getState().pushMoveCommand({ kind: 'move', label: 'Move a', timestamp: 0, from: [['public.a', { x: 50, y: 0 }]], to: [['public.a', { x: to, y: 0 }]] });
}

beforeEach(() => {
  store.getState().exitGitView();
  store.getState().endMerge();
  handleHostMessage({ type: 'schema:update', payload: { schema: TWO, parseError: null } });
  handleHostMessage({ type: 'layout:loaded', payload: LAYOUT });
  vi.mocked(postToHost).mockClear();
});

describe('SchemaEditCommand (spec 19 §Undo)', () => {
  it('is pushed on schema:applied; undo/redo ask the host instead of writing the layout', () => {
    handleHostMessage({ type: 'schema:applied', payload: { id: 'e1', label: 'Add reference' } });
    expect(store.getState().past.at(-1)).toMatchObject({ kind: 'schema', id: 'e1', label: 'Add reference' });

    const positions = store.getState().positions;
    undoLatest();
    expect(posted()).toEqual([{ type: 'schema:undo', payload: { id: 'e1' } }]);
    expect(store.getState().positions).toBe(positions);
    expect(store.getState().future).toHaveLength(1);

    redoLatest();
    expect(posted().at(-1)).toEqual({ type: 'schema:redo', payload: { id: 'e1' } });
    expect(store.getState().past).toHaveLength(1);
  });

  it('interleaves with layout commands in one stack', () => {
    moveA(100);
    handleHostMessage({ type: 'schema:applied', payload: { id: 'e1', label: 'Delete table' } });
    moveA(200);
    undoLatest();
    undoLatest();
    undoLatest();
    expect(postedTypes()).toEqual(['layout:persist', 'schema:undo', 'layout:persist']);
    expect(store.getState().positions.get('public.a')).toEqual({ x: 50, y: 0 });
  });

  it('a host refusal drops the command wherever it sits', () => {
    moveA(100);
    handleHostMessage({ type: 'schema:applied', payload: { id: 'e1', label: 'Add reference' } });
    undoLatest();
    handleHostMessage({ type: 'schema:discarded', payload: { id: 'e1' } });
    expect(store.getState().future).toHaveLength(0);
    expect(store.getState().past.map((c) => c.kind)).toEqual(['move']);

    handleHostMessage({ type: 'schema:applied', payload: { id: 'e2', label: 'Add reference' } });
    handleHostMessage({ type: 'schema:discarded', payload: { id: 'e2' } });
    expect(store.getState().past.map((c) => c.kind)).toEqual(['move']);
  });

  it('keeps the history when the table set changes because of its own edit', () => {
    moveA(100);
    handleHostMessage({ type: 'schema:applied', payload: { id: 'e1', label: 'New table c' } });
    handleHostMessage({ type: 'schema:update', payload: { schema: THREE, parseError: null } });
    expect(store.getState().past.map((c) => c.kind)).toEqual(['move', 'schema']);

    undoLatest();
    handleHostMessage({ type: 'schema:update', payload: { schema: TWO, parseError: null } });
    expect(store.getState().past.map((c) => c.kind)).toEqual(['move']);
    expect(store.getState().future.map((c) => c.kind)).toEqual(['schema']);
  });

  it('still clears it on a table-set change it did not cause (spec 11)', () => {
    handleHostMessage({ type: 'schema:applied', payload: { id: 'e1', label: 'Add reference' } });
    handleHostMessage({ type: 'schema:update', payload: { schema: TWO, parseError: null } });
    handleHostMessage({ type: 'schema:update', payload: { schema: THREE, parseError: null } });
    expect(store.getState().past).toHaveLength(0);
  });

  it('undo is a no-op while the canvas is read-only', () => {
    handleHostMessage({ type: 'schema:applied', payload: { id: 'e1', label: 'Add reference' } });
    store.getState().beginMerge([]);
    undoLatest();
    expect(posted()).toEqual([]);
  });
});

describe('layout:place (spec 19 §Crear tabla)', () => {
  it('holds a position for a table that is not in the schema yet, and persists it', () => {
    handleHostMessage({ type: 'layout:place', payload: { table: 'public.c', x: 320, y: 160 } });
    expect(store.getState().positions.get('public.c')).toEqual({ x: 320, y: 160 });
    const persist = posted().find((m) => m.type === 'layout:persist');
    expect(persist?.type === 'layout:persist' && persist.payload.tables?.['public.c']).toEqual({ x: 320, y: 160 });

    handleHostMessage({ type: 'schema:update', payload: { schema: THREE, parseError: null } });
    expect(store.getState().positions.get('public.c')).toEqual({ x: 320, y: 160 });
  });

  it('shows the table even if an orphan entry of that name was hidden', () => {
    store.getState().setTableHidden('public.c', true);
    handleHostMessage({ type: 'layout:place', payload: { table: 'public.c', x: 0, y: 0 } });
    expect(store.getState().hiddenTables.has('public.c')).toBe(false);
  });

  it('is ignored while the canvas is read-only', () => {
    store.getState().enterTimeTravel('abc', 'v0');
    handleHostMessage({ type: 'layout:place', payload: { table: 'public.c', x: 1, y: 1 } });
    expect(store.getState().positions.has('public.c')).toBe(false);
    expect(posted()).toEqual([]);
  });
});
