import { describe, expect, it } from 'vitest';
import { store } from './store';
import { positionsMovedSince, smallPositionsDelta } from './positionsDelta';

const grid = (n: number) => new Map(Array.from({ length: n }, (_, i) => [`t${i}`, { x: i * 10, y: 0 }] as const));

describe('positions delta lineage', () => {
  it('unions the names of every commit between two renders', () => {
    store.setState({ positions: grid(20) });
    const rendered = store.getState().positions;
    store.getState().setPositionsBatch([['t1', { x: 5, y: 5 }]]);
    store.getState().setTablePos('t2', 7, 7);
    expect(positionsMovedSince(rendered, store.getState().positions)).toEqual(new Set(['t1', 't2']));
  });

  it('is unknown across a wholesale replacement (layout load, undo)', () => {
    store.setState({ positions: grid(20) });
    const rendered = store.getState().positions;
    store.getState().setPositionsBatch([['t1', { x: 5, y: 5 }]]);
    store.setState({ positions: new Map(store.getState().positions) });
    expect(positionsMovedSince(rendered, store.getState().positions)).toBeNull();
  });

  it('falls back to a rebuild once too many tables moved', () => {
    store.setState({ positions: grid(20) });
    const rendered = store.getState().positions;
    store.getState().setPositionsBatch(Array.from({ length: 6 }, (_, i) => [`t${i}`, { x: 1, y: 1 }] as [string, { x: number; y: number }]));
    expect(smallPositionsDelta(rendered, store.getState().positions)).toBeNull();
  });
});
