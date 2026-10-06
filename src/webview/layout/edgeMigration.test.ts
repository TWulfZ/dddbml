import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../vscode', () => ({ postToHost: vi.fn() }));

import { postToHost } from '../vscode';
import { store } from '../state/store';
import { EDGE_ROUTING_VERSION, type EdgeLayout, type Layout, type Ref } from '../../shared/types';
import { edgeKey } from '../render/edgeKey';
import { keepLegacyEdges, showEdgeMigrationNotice, updateLegacyEdges } from './edgeMigration';
import { schedulePersist } from '../persistence';

const posted = vi.mocked(postToHost);
const persists = () => posted.mock.calls.map(([m]) => m).filter((m) => m.type === 'layout:persist');

const ref = (id: string, source: string, sc: string, target: string, tc: string): Ref => ({
  id,
  source: { table: source, columns: [sc], relation: '*' },
  target: { table: target, columns: [tc], relation: '1' },
});

const AB = edgeKey('public.a', ['b_id'], 'public.b', ['id']);
const AC = edgeKey('public.a', ['c_id'], 'public.c', ['id']);
const LOOP = edgeKey('public.a', ['parent_id'], 'public.a', ['id']);
const DEP = 'dep:' + edgeKey('public.a', ['x'], 'public.c', ['y']);

const legacyEdges: Record<string, EdgeLayout> = {
  [AB]: { waypoints: [{ x: 300, y: 40 }, { x: 300, y: 340 }], sourceSide: 'bottom', targetSide: 'top', color: '#abc' },
  [AC]: { dx: 40 },
  [LOOP]: { sourceSide: 'left', targetSide: 'left' },
  [DEP]: { waypoints: [{ x: 5, y: 6 }] },
};

const layout = (overrides: Partial<Layout> = {}): Layout => ({
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  tables: { 'public.a': { x: 0, y: 0 }, 'public.b': { x: 600, y: 300 }, 'public.c': { x: 600, y: 0 } },
  groups: {},
  edges: structuredClone(legacyEdges),
  ...overrides,
});

beforeEach(() => {
  posted.mockClear();
  store.getState().exitGitView();
  store.getState().endMerge();
  store.setState({
    schema: {
      tables: [],
      groups: [],
      refs: [
        ref('r1', 'public.a', 'b_id', 'public.b', 'id'),
        ref('r2', 'public.a', 'c_id', 'public.c', 'id'),
        ref('r3', 'public.a', 'parent_id', 'public.a', 'id'),
      ],
    },
  });
  store.getState().setLayout(layout());
});

describe('migration notice detection (spec 05 §Migración)', () => {
  it('is due for an unmarked layout with FK shapes', () => {
    expect(store.getState().edgeMigrationPending).toBe(true);
    expect(showEdgeMigrationNotice(store.getState())).toBe(true);
  });

  it('is not due once the layout is marked', () => {
    store.getState().setLayout(layout({ edgeRouting: EDGE_ROUTING_VERSION }));
    expect(showEdgeMigrationNotice(store.getState())).toBe(false);
  });

  it('is not due when only colors or dep curves are saved', () => {
    store.getState().setLayout(layout({ edges: { [AB]: { color: '#abc' }, [DEP]: { waypoints: [{ x: 1, y: 2 }] } } }));
    expect(showEdgeMigrationNotice(store.getState())).toBe(false);
  });

  it('is not due when the only FK shapes are self-loop flips (the update would change nothing)', () => {
    store.getState().setLayout(layout({ edges: { [LOOP]: { sourceSide: 'left', targetSide: 'left' } } }));
    expect(showEdgeMigrationNotice(store.getState())).toBe(false);
  });

  it('is hidden on a read-only canvas (time travel, diff, merge)', () => {
    store.getState().enterTimeTravel('abc', 'abc');
    expect(showEdgeMigrationNotice(store.getState())).toBe(false);
    store.getState().exitGitView();
    store.getState().enterDiff('HEAD', 'working', { tables: [], refs: [] });
    expect(showEdgeMigrationNotice(store.getState())).toBe(false);
    store.getState().exitGitView();
    store.getState().beginMerge([]);
    expect(showEdgeMigrationNotice(store.getState())).toBe(false);
  });
});

describe('"Update relations"', () => {
  it('drops every FK shape (colors kept), leaves loops and deps, stamps the marker and persists once', () => {
    updateLegacyEdges();
    const s = store.getState();
    expect(s.edgeLayouts.get(AB)).toEqual({ color: '#abc' });
    expect(s.edgeLayouts.has(AC)).toBe(false);
    expect(s.edgeLayouts.get(LOOP)).toEqual(legacyEdges[LOOP]);
    expect(s.edgeLayouts.get(DEP)).toEqual(legacyEdges[DEP]);
    expect(s.edgeRouting).toBe(EDGE_ROUTING_VERSION);
    expect(showEdgeMigrationNotice(s)).toBe(false);
    expect(persists()).toHaveLength(1);
    expect(persists()[0]).toMatchObject({ payload: { edgeRouting: EDGE_ROUTING_VERSION, edges: { [AB]: { color: '#abc' } } } });
  });

  it('is ONE undo step that restores every shape; the answer itself stays recorded', () => {
    updateLegacyEdges();
    expect(store.getState().past).toHaveLength(1);
    store.getState().undo();
    const s = store.getState();
    for (const [k, v] of Object.entries(legacyEdges)) expect(s.edgeLayouts.get(k)).toEqual(v);
    expect(s.edgeRouting).toBe(EDGE_ROUTING_VERSION);
    expect(showEdgeMigrationNotice(s)).toBe(false);
    store.getState().redo();
    expect(store.getState().edgeLayouts.get(AB)).toEqual({ color: '#abc' });
  });
});

describe('"Keep"', () => {
  it('leaves every shape and the history alone, stamps the marker and persists once', () => {
    keepLegacyEdges();
    const s = store.getState();
    for (const [k, v] of Object.entries(legacyEdges)) expect(s.edgeLayouts.get(k)).toEqual(v);
    expect(s.past).toHaveLength(0);
    expect(showEdgeMigrationNotice(s)).toBe(false);
    expect(persists()).toHaveLength(1);
    expect(persists()[0]).toMatchObject({ payload: { edgeRouting: EDGE_ROUTING_VERSION } });
  });

  it('keeps riding later persists, so no ordinary write drops the answer', () => {
    keepLegacyEdges();
    updateLegacyEdges(); // already answered: no-op
    expect(persists()).toHaveLength(1);
    expect(store.getState().edgeLayouts.get(AB)).toEqual(legacyEdges[AB]);
    store.getState().setTablePos('public.a', 10, 10);
    schedulePersist();
    expect(persists().at(-1)).toMatchObject({ payload: { edgeRouting: EDGE_ROUTING_VERSION } });
  });
});

describe('read-only gate', () => {
  it('neither action edits, stamps nor writes while the canvas is read-only', () => {
    for (const enter of [
      () => store.getState().enterTimeTravel('abc', 'abc'),
      () => store.getState().enterDiff('HEAD', 'working', { tables: [], refs: [] }),
      () => store.getState().beginMerge([]),
    ]) {
      enter();
      updateLegacyEdges();
      keepLegacyEdges();
      const s = store.getState();
      expect(s.edgeRouting).toBeUndefined();
      expect(s.edgeMigrationPending).toBe(true);
      expect(s.edgeLayouts.get(AB)).toEqual(legacyEdges[AB]);
      store.getState().exitGitView();
      store.getState().endMerge();
    }
    expect(persists()).toHaveLength(0);
  });
});
