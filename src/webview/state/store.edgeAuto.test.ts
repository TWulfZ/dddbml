import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../vscode', () => ({ postToHost: vi.fn() }));
vi.mock('../persistence', () => ({ schedulePersist: vi.fn() }));

import { store } from './store';
import { buildWaypointCommand } from './history';
import { commitEdgeStyle, readEdgeStyle } from '../drag/dragController';
import type { EdgeLayout, Layout } from '../../shared/types';

const K = 'public.a::c0|public.b::c0';
const autoShape: EdgeLayout = { waypoints: [{ x: 10, y: 10 }, { x: 10, y: 90 }], sourceSide: 'right', color: '#abc', auto: true };

const seed = (layout: EdgeLayout) => store.setState({ edgeLayouts: new Map([[K, layout]]), past: [], future: [] });

beforeEach(() => {
  store.setState({ gitView: null, mergeConflicts: null, edgeLayouts: new Map(), past: [], future: [] });
});

describe('auto marker (F20) — load', () => {
  it('setLayout keeps the marker of a loaded A* shape', () => {
    const layout: Layout = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, tables: {}, groups: {}, edges: { [K]: autoShape } };
    store.getState().setLayout(layout);
    expect(store.getState().edgeLayouts.get(K)).toEqual(autoShape);
  });

  it('setLayout drops the marker from a dep: key (spec 18)', () => {
    const D = 'dep:public.a::|public.b::';
    const layout: Layout = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, tables: {}, groups: {}, edges: { [D]: autoShape } };
    store.getState().setLayout(layout);
    expect(store.getState().edgeLayouts.get(D)?.auto).toBeUndefined();
    expect(store.getState().edgeLayouts.get(D)?.waypoints).toEqual(autoShape.waypoints);
  });
});

describe('auto marker (F20) — user edits clear it, color does not', () => {
  it('a waypoint edit makes the shape the user\'s', () => {
    seed(autoShape);
    store.getState().setEdgeWaypoints(K, [{ x: 20, y: 10 }, { x: 20, y: 90 }]);
    expect(store.getState().edgeLayouts.get(K)?.auto).toBeUndefined();
  });

  it('a side flip makes the shape the user\'s', () => {
    seed(autoShape);
    store.getState().setEdgeSide(K, 'source', 'left');
    expect(store.getState().edgeLayouts.get(K)?.auto).toBeUndefined();
  });

  it('a color change keeps the shape automatic', () => {
    seed(autoShape);
    store.getState().setEdgeColor(K, '#123456');
    expect(store.getState().edgeLayouts.get(K)?.auto).toBe(true);
  });
});

describe('auto marker (F20) — undo/redo replays', () => {
  it('undoing a waypoint edit restores the A* shape as auto; redo makes it the user\'s again', () => {
    seed(autoShape);
    const to = [{ x: 20, y: 10 }, { x: 20, y: 90 }];
    store.getState().setEdgeWaypoints(K, to);
    const cmd = buildWaypointCommand(K, autoShape.waypoints!, to, 'move', true)!;
    store.getState().pushWaypointCommand(cmd);

    store.getState().undo();
    expect(store.getState().edgeLayouts.get(K)).toEqual(autoShape);
    store.getState().redo();
    expect(store.getState().edgeLayouts.get(K)?.auto).toBeUndefined();
  });

  it('undoing a side flip restores the marker; redo clears it', () => {
    seed(autoShape);
    const before = readEdgeStyle(K);
    store.getState().setEdgeSide(K, 'source', 'left');
    commitEdgeStyle(K, before, 'Flip edge port');

    store.getState().undo();
    expect(store.getState().edgeLayouts.get(K)).toEqual(autoShape);
    store.getState().redo();
    expect(store.getState().edgeLayouts.get(K)).toEqual({ ...autoShape, sourceSide: 'left', auto: undefined });
  });

  it('undoing a color change on an auto edge keeps it auto', () => {
    seed(autoShape);
    const before = readEdgeStyle(K);
    store.getState().setEdgeColor(K, '#123456');
    commitEdgeStyle(K, before, 'Edge color');
    store.getState().undo();
    expect(store.getState().edgeLayouts.get(K)).toEqual(autoShape);
    store.getState().redo();
    expect(store.getState().edgeLayouts.get(K)).toEqual({ ...autoShape, color: '#123456' });
  });
});

describe('legacy A* top/bottom shapes (spec 05 §9) — edits start from what is drawn', () => {
  const legacy: EdgeLayout = { waypoints: [{ x: 10, y: 10 }, { x: 10, y: 90 }], sourceSide: 'bottom', targetSide: 'top', color: '#abc', auto: true };

  it('a waypoint edit replaces the ignored shape whole, keeping only its color', () => {
    seed(legacy);
    const to = [{ x: 20, y: 10 }, { x: 20, y: 90 }];
    store.getState().setEdgeWaypoints(K, to);
    expect(store.getState().edgeLayouts.get(K)).toEqual({ color: '#abc', waypoints: to });
  });

  it('a side flip replaces the ignored shape whole, keeping only its color', () => {
    seed(legacy);
    store.getState().setEdgeSide(K, 'source', 'left');
    expect(store.getState().edgeLayouts.get(K)).toEqual({ color: '#abc', sourceSide: 'left' });
  });

  it('re-applying the drawn (empty) waypoints leaves the stored shape untouched', () => {
    seed(legacy);
    store.getState().setEdgeWaypoints(K, []);
    expect(store.getState().edgeLayouts.get(K)).toEqual(legacy);
  });
});
