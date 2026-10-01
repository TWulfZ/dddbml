import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../vscode', () => ({ postToHost: vi.fn() }));
vi.mock('../persistence', () => ({ schedulePersist: vi.fn() }));

import { store } from '../state/store';
import { commitEdgeStyle, resetEdgeWaypoints } from './dragController';
import type { EdgeLayout } from '../../shared/types';

beforeEach(() => {
  store.setState({
    positions: new Map([['a', { x: 0, y: 0 }], ['b', { x: 500, y: 0 }]]),
    selection: new Set(),
    viewport: { x: 0, y: 0, zoom: 1 },
    edgeLayouts: new Map(),
    gitView: null,
    mergeConflicts: null,
    past: [],
    future: [],
  });
});

describe('edge edits', () => {
  const shaped: EdgeLayout = { waypoints: [{ x: 10, y: 10 }, { x: 10, y: 90 }], sourceSide: 'left', color: '#ff0000' };

  it('are ignored while the canvas is read-only', () => {
    store.setState({
      edgeLayouts: new Map([['k', shaped]]),
      gitView: { kind: 'diff', baseLabel: 'HEAD', headLabel: 'Working tree' },
    });
    resetEdgeWaypoints('k');
    commitEdgeStyle('k', {}, 'Edge color');
    expect(store.getState().edgeLayouts.get('k')).toEqual(shaped);
    expect(store.getState().past).toHaveLength(0);
  });

  it('a reset is one undo entry that restores waypoints and sides', () => {
    store.setState({ edgeLayouts: new Map([['k', shaped]]) });
    resetEdgeWaypoints('k');
    expect(store.getState().edgeLayouts.get('k')).toEqual({ color: '#ff0000' });
    expect(store.getState().past).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().edgeLayouts.get('k')).toEqual(shaped);
  });

  it('a reset of a legacy dx/dy offset can be undone', () => {
    store.setState({ edgeLayouts: new Map([['k', { dx: 40 }]]) });
    resetEdgeWaypoints('k');
    expect(store.getState().edgeLayouts.has('k')).toBe(false);
    store.getState().undo();
    expect(store.getState().edgeLayouts.get('k')).toEqual({ dx: 40 });
  });

  it('a reset of an edge with no shape adds no undo entry', () => {
    store.setState({ edgeLayouts: new Map([['k', { color: '#ff0000' }]]) });
    resetEdgeWaypoints('k');
    expect(store.getState().past).toHaveLength(0);
  });
});
