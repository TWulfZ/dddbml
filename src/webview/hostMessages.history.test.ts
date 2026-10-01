import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./vscode', () => ({ postToHost: vi.fn() }));

import { store } from './state/store';
import { handleHostMessage } from './hostMessages';
import { parseDbml } from '../extension/parser';
import type { Layout, Schema } from '../shared/types';

/** Undo/redo across the git overlays (spec 11 lifecycle rows, decision 2026-10-01; F76). */

function schemaOf(src: string): Schema {
  const r = parseDbml(src);
  if (!r.schema) throw new Error(r.error.message);
  return r.schema;
}

const WORKING = schemaOf('Table a { id int }\nTable b { id int }');
const PAST = schemaOf('Table old_only { id int }');
const layout = (tables: Layout['tables']): Layout => ({ version: 1, viewport: { x: 0, y: 0, zoom: 1 }, tables, groups: {}, edges: {} });
const WORKING_LAYOUT = layout({ 'public.a': { x: 50, y: 0 }, 'public.b': { x: 400, y: 0 } });

function workingWithOneMove(): void {
  store.getState().exitGitView();
  store.getState().endMerge();
  handleHostMessage({ type: 'schema:update', payload: { schema: WORKING, parseError: null } });
  handleHostMessage({ type: 'layout:loaded', payload: WORKING_LAYOUT });
  store.getState().pushMoveCommand({ kind: 'move', label: 'Move a', timestamp: 0, from: [['public.a', { x: 0, y: 0 }]], to: [['public.a', { x: 50, y: 0 }]] });
}

function peekPastRevision(): void {
  handleHostMessage({ type: 'git:timeTravel:enter', payload: { rev: 'abc', label: 'v0', schema: PAST, layout: layout({ 'public.old_only': { x: 5, y: 5 } }) } });
}

/** The host's exit sequence: working schema → working layout → exit (spec 16). */
function exitTo(schema: Schema, layoutMsg: 'layout:loaded' | 'layout:external-change' = 'layout:loaded'): void {
  handleHostMessage({ type: 'schema:update', payload: { schema, parseError: null } });
  handleHostMessage({ type: layoutMsg, payload: WORKING_LAYOUT });
  handleHostMessage({ type: 'git:timeTravel:exit' });
}

describe('undo history across time travel and diff (F76)', () => {
  beforeEach(workingWithOneMove);

  it('survives a time-travel peek, and undo is a no-op while it lasts', () => {
    peekPastRevision();
    store.getState().undo();
    expect(store.getState().positions.get('public.a')).toBeUndefined();
    exitTo(WORKING);
    expect(store.getState().past).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().positions.get('public.a')).toEqual({ x: 0, y: 0 });
  });

  it('survives a diff overlay', () => {
    handleHostMessage({ type: 'git:diff:enter', payload: { baseLabel: 'HEAD', headLabel: 'working', diff: { tables: [], refs: [] } } });
    handleHostMessage({ type: 'git:diff:exit' });
    expect(store.getState().past).toHaveLength(1);
  });

  it('is dropped when the working table set changed during the peek', () => {
    peekPastRevision();
    exitTo(schemaOf('Table a { id int }\nTable b { id int }\nTable c { id int }'));
    expect(store.getState().past).toHaveLength(0);
  });

  it('is dropped when the working layout changed on disk during the peek', () => {
    peekPastRevision();
    exitTo(WORKING, 'layout:external-change');
    expect(store.getState().past).toHaveLength(0);
  });
});
