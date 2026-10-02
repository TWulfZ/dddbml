import { describe, it, expect } from 'vitest';
import { movedNames, computeAutoShapeDrops, computeDepStrandResets, computeDragEdgeChanges, computeEdgeResets, computeSelectionEdgeResets, hasManualShape } from './edgeReset';
import type { KeyedDepEdge } from '../../render/edgeKey';
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

describe('A* auto shapes (F20)', () => {
  const autoShape: EdgeLayout = { waypoints: [{ x: 1, y: 1 }], sourceSide: 'top', targetSide: 'bottom', auto: true };

  it('an auto shape is not manual, so preserve-manual runs re-order it', () => {
    expect(hasManualShape(autoShape)).toBe(false);
    const { auto: _auto, ...userShape } = autoShape;
    expect(hasManualShape(userShape)).toBe(true);
  });

  it('drops an auto shape (waypoints + sides) when either endpoint moved, keeping color', () => {
    const edges = new Map<string, EdgeLayout>([
      ['e1', { ...autoShape, color: '#abc' }],
      ['e2', { waypoints: [{ x: 3, y: 4 }], sourceSide: 'top' }], // manual: one moved endpoint keeps it
      ['e3', autoShape], // neither endpoint moved
      ['e4', autoShape],
    ]);
    const refs = [ref('e1', 'a', 'b'), ref('e2', 'a', 'z'), ref('e3', 'p', 'q'), ref('e4', 'z', 'a')];
    const map = new Map(computeAutoShapeDrops(refs, new Set(['a']), edges));
    expect(map.get('e1')).toEqual({ color: '#abc' });
    expect(map.get('e4')).toBeNull();
    expect(map.has('e2')).toBe(false);
    expect(map.has('e3')).toBe(false);
  });

  it('the stranded-manual reset leaves auto shapes to the auto drop', () => {
    const edges = new Map<string, EdgeLayout>([['e', autoShape]]);
    expect(computeEdgeResets([ref('e', 'a', 'b')], new Set(['a', 'b']), edges)).toEqual([]);
  });
});

describe('computeDepStrandResets', () => {
  const dep = (id: string, up: string, down: string): KeyedDepEdge => ({
    id, upstream: { table: up, columns: [] }, downstream: { table: down, columns: [] }, name: null, note: null,
  });

  it('drops free waypoints only when both endpoints moved, keeping the color', () => {
    const edges = new Map<string, EdgeLayout>([
      ['d1', { waypoints: [{ x: 1, y: 1 }], color: '#f00' }],
      ['d2', { waypoints: [{ x: 2, y: 2 }] }],
      ['d3', { color: '#0f0' }],
    ]);
    const resets = computeDepStrandResets([dep('d1', 'a', 'b'), dep('d2', 'a', 'z'), dep('d3', 'a', 'b')], new Set(['a', 'b']), edges);
    expect(resets).toEqual([['d1', { color: '#f00' }]]);
  });
});

describe('computeDragEdgeChanges (spec 05 "Arrastre de tablas")', () => {
  const dep = (id: string, up: string, down: string): KeyedDepEdge => ({
    id, upstream: { table: up, columns: [] }, downstream: { table: down, columns: [] }, name: null, note: null,
  });
  // The drag's MoveCommand from/to: exactly the dragged tables (`z` is not one).
  const before = new Map([['a', { x: 0, y: 0 }], ['b', { x: 500, y: 0 }]]);
  const after = new Map([['a', { x: 60, y: 20 }], ['b', { x: 560, y: 20 }]]);
  const wps = [{ x: 250, y: 40 }, { x: 250, y: 300 }];
  const moved = [{ x: 310, y: 60 }, { x: 310, y: 320 }];

  it('translates manual and auto ref waypoints when both endpoints moved, keeping sides, color and auto', () => {
    const edges = new Map<string, EdgeLayout>([
      ['m', { waypoints: wps, sourceSide: 'left', color: '#abc' }],
      ['au', { waypoints: wps, sourceSide: 'bottom', targetSide: 'top', auto: true }],
    ]);
    const out = new Map(computeDragEdgeChanges([ref('m', 'a', 'b'), ref('au', 'a', 'b')], [], before, after, edges));
    expect(out.get('m')).toEqual({ waypoints: moved, sourceSide: 'left', color: '#abc' });
    expect(out.get('au')).toEqual({ waypoints: moved, sourceSide: 'bottom', targetSide: 'top', auto: true });
  });

  it('translates a dep whose endpoints both moved', () => {
    const edges = new Map<string, EdgeLayout>([['d', { waypoints: wps, color: '#f00' }]]);
    const out = new Map(computeDragEdgeChanges([], [dep('d', 'a', 'b')], before, after, edges));
    expect(out.get('d')).toEqual({ waypoints: moved, color: '#f00' });
  });

  it('keeps an auto shape with no waypoints when both endpoints moved: its sides still fit', () => {
    const edges = new Map<string, EdgeLayout>([['au', { sourceSide: 'bottom', targetSide: 'top', auto: true }]]);
    expect(computeDragEdgeChanges([ref('au', 'a', 'b')], [], before, after, edges)).toEqual([]);
  });

  it('leaves single-endpoint edges as before: auto refs dropped, manual refs and deps kept', () => {
    const edges = new Map<string, EdgeLayout>([
      ['au', { waypoints: wps, auto: true, color: '#abc' }],
      ['m', { waypoints: wps }],
      ['d', { waypoints: wps }],
    ]);
    const out = computeDragEdgeChanges([ref('au', 'a', 'z'), ref('m', 'z', 'b')], [dep('d', 'z', 'a')], before, after, edges);
    expect(out).toEqual([['au', { color: '#abc' }]]);
  });

  it('translates by each edge\'s actual committed delta, not a shared pointer delta', () => {
    // Off-grid origins snap by different amounts; the edge rides with its source table.
    const snappedAfter = new Map([['a', { x: 60, y: 20 }], ['b', { x: 580, y: 20 }]]);
    const edges = new Map<string, EdgeLayout>([['e', { waypoints: [{ x: 10, y: 10 }] }], ['r', { waypoints: [{ x: 10, y: 10 }] }]]);
    const out = new Map(computeDragEdgeChanges([ref('e', 'a', 'b'), ref('r', 'b', 'a')], [], before, snappedAfter, edges));
    expect(out.get('e')).toEqual({ waypoints: [{ x: 70, y: 30 }] });
    expect(out.get('r')).toEqual({ waypoints: [{ x: 90, y: 30 }] });
  });

  it('an edge inside the dragged set rides with its source even when snap left one end in place', () => {
    const snappedAfter = new Map([['a', { x: 0, y: 0 }], ['b', { x: 520, y: 0 }]]);
    const offGridBefore = new Map([['a', { x: 0, y: 0 }], ['b', { x: 515, y: 0 }]]);
    const edges = new Map<string, EdgeLayout>([
      ['still', { waypoints: [{ x: 10, y: 10 }], auto: true }],
      ['rides', { waypoints: [{ x: 10, y: 10 }], auto: true }],
      ['dep', { waypoints: [{ x: 10, y: 10 }] }],
    ]);
    const out = computeDragEdgeChanges(
      [ref('still', 'a', 'b'), ref('rides', 'b', 'a')], [dep('dep', 'b', 'a')], offGridBefore, snappedAfter, edges,
    );
    expect(new Map(out)).toEqual(new Map([
      ['rides', { waypoints: [{ x: 15, y: 10 }], auto: true }],
      ['dep', { waypoints: [{ x: 15, y: 10 }] }],
    ]));
  });
});
