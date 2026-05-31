import { describe, it, expect } from 'vitest';
import { store } from '../../state/store';
import { buildArrangeCommand, buildEdgesResetCommand } from '../../state/history';
import type { EdgeLayout } from '../../../shared/types';

describe('ArrangeCommand — composite undo/redo', () => {
  it('a single undo reverts positions AND edge waypoint resets', () => {
    const before = new Map([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }]]);
    store.getState().setPositionsBatch([...before]);
    store.getState().applyEdgeLayouts([['e1', { waypoints: [{ x: 5, y: 5 }], color: '#abc' }]]);
    store.getState().clearHistory();

    const edgesBefore = new Map(store.getState().edgeLayouts);
    const after = new Map([['a', { x: 0, y: 0 }], ['b', { x: 400, y: 200 }]]);
    const resets: Array<[string, EdgeLayout | null]> = [['e1', { color: '#abc' }]];

    store.getState().setPositionsBatch([...after]);
    store.getState().applyEdgeLayouts(resets);
    const cmd = buildArrangeCommand(before, store.getState().positions, edgesBefore, resets);
    expect(cmd).not.toBeNull();
    store.getState().pushArrangeCommand(cmd!);

    // applied
    expect(store.getState().positions.get('b')).toEqual({ x: 400, y: 200 });
    expect(store.getState().edgeLayouts.get('e1')).toEqual({ color: '#abc' });

    // one undo restores both position and the cleared waypoint
    store.getState().undo();
    expect(store.getState().positions.get('b')).toEqual({ x: 100, y: 0 });
    expect(store.getState().edgeLayouts.get('e1')).toEqual({ waypoints: [{ x: 5, y: 5 }], color: '#abc' });

    // redo re-applies both
    store.getState().redo();
    expect(store.getState().positions.get('b')).toEqual({ x: 400, y: 200 });
    expect(store.getState().edgeLayouts.get('e1')).toEqual({ color: '#abc' });
  });

  it('buildArrangeCommand returns null when nothing changed', () => {
    const same = new Map([['a', { x: 0, y: 0 }]]);
    expect(buildArrangeCommand(same, new Map(same), new Map(), [])).toBeNull();
  });

  it('reset-relations command undoes edge resets without touching positions', () => {
    store.getState().setPositionsBatch([['a', { x: 7, y: 7 }]]);
    store.getState().applyEdgeLayouts([['e1', { waypoints: [{ x: 9, y: 9 }], color: '#abc' }]]);
    store.getState().clearHistory();

    const edgesBefore = new Map(store.getState().edgeLayouts);
    const resets: Array<[string, EdgeLayout | null]> = [['e1', { color: '#abc' }]];
    store.getState().applyEdgeLayouts(resets);
    const cmd = buildEdgesResetCommand(edgesBefore, resets, 'Reset 1 relation');
    expect(cmd).not.toBeNull();
    expect(cmd!.from).toEqual([]); // edges-only — no position entries
    store.getState().pushArrangeCommand(cmd!);

    expect(store.getState().edgeLayouts.get('e1')).toEqual({ color: '#abc' });

    store.getState().undo();
    expect(store.getState().edgeLayouts.get('e1')).toEqual({ waypoints: [{ x: 9, y: 9 }], color: '#abc' });
    expect(store.getState().positions.get('a')).toEqual({ x: 7, y: 7 }); // untouched

    store.getState().redo();
    expect(store.getState().edgeLayouts.get('e1')).toEqual({ color: '#abc' });
  });
});
