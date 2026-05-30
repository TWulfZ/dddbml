import { describe, it, expect } from 'vitest';
import { movedNames, computeEdgeResets, computeSelectionEdgeResets } from './edgeReset';
import type { EdgeLayout, Ref } from '../../../shared/types';

const ref = (id: string, s: string, t: string): Ref => ({
  id,
  source: { table: s, columns: ['x'], relation: '*' },
  target: { table: t, columns: ['y'], relation: '1' },
});

describe('edge waypoint reset on bulk move', () => {
  it('movedNames flags changed and newly-placed tables', () => {
    const before = new Map([['a', { x: 0, y: 0 }], ['b', { x: 10, y: 10 }]]);
    const after = new Map([['a', { x: 0, y: 0 }], ['b', { x: 99, y: 10 }], ['c', { x: 5, y: 5 }]]);
    const m = movedNames(before, after);
    expect(m.has('a')).toBe(false);
    expect(m.has('b')).toBe(true);
    expect(m.has('c')).toBe(true);
  });

  it('clears shape only when both endpoints moved, preserving color + sides', () => {
    const edges = new Map<string, EdgeLayout>([
      ['e1', { waypoints: [{ x: 1, y: 2 }], color: '#abc', sourceSide: 'left' }],
      ['e2', { waypoints: [{ x: 3, y: 4 }] }],
      ['e3', { color: '#fff' }], // no shape → skipped entirely
    ]);
    const refs = [ref('e1', 'a', 'b'), ref('e2', 'a', 'z'), ref('e3', 'a', 'b')];
    const moved = new Set(['a', 'b']); // z did NOT move

    const map = new Map(computeEdgeResets(refs, moved, edges));
    expect(map.get('e1')).toEqual({ color: '#abc', sourceSide: 'left' });
    expect(map.has('e2')).toBe(false); // only one endpoint moved → bend preserved
    expect(map.has('e3')).toBe(false); // no shape to reset
  });

  it('returns null when the reset would leave no data', () => {
    const edges = new Map<string, EdgeLayout>([['e', { waypoints: [{ x: 1, y: 1 }] }]]);
    const resets = computeEdgeResets([ref('e', 'a', 'b')], new Set(['a', 'b']), edges);
    expect(resets).toEqual([['e', null]]);
  });
});

describe('reset relations of selected tables', () => {
  it('resets every edge TOUCHING the selection (source OR target), keeping color only', () => {
    const edges = new Map<string, EdgeLayout>([
      ['e1', { waypoints: [{ x: 1, y: 1 }], color: '#abc', sourceSide: 'left' }],
      ['e2', { sourceSide: 'right' }], // only a side override — still resettable
      ['e3', { waypoints: [{ x: 2, y: 2 }] }], // not touching selection
      ['e4', { color: '#fff' }], // no shape → skipped
    ]);
    const refs = [
      ref('e1', 'sel', 'other'), // touches selection via source
      ref('e2', 'x', 'sel'), // touches via target
      ref('e3', 'p', 'q'), // no selected endpoint
      ref('e4', 'sel', 'z'),
    ];
    const selection = new Set(['sel']);

    const map = new Map(computeSelectionEdgeResets(refs, selection, edges));
    expect(map.get('e1')).toEqual({ color: '#abc' }); // waypoints + side dropped, color kept
    expect(map.get('e2')).toBeNull(); // side dropped, no color → delete
    expect(map.has('e3')).toBe(false); // not touching selection
    expect(map.has('e4')).toBe(false); // no shape
  });
});
