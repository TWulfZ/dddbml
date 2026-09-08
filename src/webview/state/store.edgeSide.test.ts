import { beforeEach, describe, expect, it } from 'vitest';
import { store } from './store';
import type { EdgeStyleCommand } from './history';
import type { Layout } from '../../shared/types';

const blankLayout: Layout = {
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  tables: {},
  groups: {},
};

beforeEach(() => {
  store.getState().setLayout(blankLayout);
});

describe('setEdgeSide — 4-side support (spec 05 §9 / E3)', () => {
  it('accepts top on the source endpoint', () => {
    store.getState().setEdgeSide('e1', 'source', 'top');
    expect(store.getState().edgeLayouts.get('e1')?.sourceSide).toBe('top');
  });

  it('accepts bottom on the target endpoint', () => {
    store.getState().setEdgeSide('e1', 'target', 'bottom');
    expect(store.getState().edgeLayouts.get('e1')?.targetSide).toBe('bottom');
  });

  it('clears a side when passed null', () => {
    store.getState().setEdgeSide('e1', 'source', 'top');
    store.getState().setEdgeSide('e1', 'source', null);
    expect(store.getState().edgeLayouts.get('e1')?.sourceSide).toBeUndefined();
  });
});

describe('EdgeStyleCommand — top/bottom round-trips through undo/redo', () => {
  it('restores a top source side on undo and reapplies on redo', () => {
    // Seed the edge with a top side, then record a command flipping it to a left side.
    store.getState().setEdgeSide('e1', 'source', 'top');
    const cmd: EdgeStyleCommand = {
      kind: 'edgeStyle',
      refId: 'e1',
      from: { sourceSide: 'top' },
      to: { sourceSide: 'left' },
      label: 'Flip edge port',
      timestamp: 1,
    };
    store.getState().pushEdgeStyleCommand(cmd);
    // pushEdgeStyleCommand records history only; apply the 'to' state to mirror a real edit.
    store.getState().setEdgeSide('e1', 'source', 'left');
    expect(store.getState().edgeLayouts.get('e1')?.sourceSide).toBe('left');

    store.getState().undo();
    expect(store.getState().edgeLayouts.get('e1')?.sourceSide).toBe('top');

    store.getState().redo();
    expect(store.getState().edgeLayouts.get('e1')?.sourceSide).toBe('left');
  });
});
