import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../vscode', () => ({ postToHost: vi.fn() }));
vi.mock('../persistence', () => ({ schedulePersist: vi.fn() }));

import { store } from '../state/store';
import { zoomAt } from '../render/viewport';
import { commitEdgeStyle, resetEdgeWaypoints, startDrag, startEndpointDrag } from './dragController';
import type { EdgeLayout, Ref } from '../../shared/types';
import { edgeKey } from '../render/edgeKey';

// Minimal DOM stand-ins: the controller only needs window listeners, a body classList and a node
// that can capture the pointer and find its viewport.
const listeners = new Map<string, (ev: PointerEvent) => void>();
vi.stubGlobal('window', {
  addEventListener: (type: string, fn: (ev: PointerEvent) => void) => listeners.set(type, fn),
  removeEventListener: (type: string) => listeners.delete(type),
});
vi.stubGlobal('document', { body: { classList: { add: () => undefined, remove: () => undefined } } });

const VIEWPORT_RECT = { left: 50, top: 20 };

function fakeNode(): HTMLElement {
  return {
    style: {},
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    closest: () => ({ getBoundingClientRect: () => VIEWPORT_RECT }),
  } as unknown as HTMLElement;
}

function ptr(clientX: number, clientY: number): PointerEvent {
  return {
    clientX,
    clientY,
    button: 0,
    pointerId: 1,
    shiftKey: false,
    stopPropagation: () => undefined,
    preventDefault: () => undefined,
  } as unknown as PointerEvent;
}

const move = (x: number, y: number) => listeners.get('pointermove')!(ptr(x, y));
const up = (x: number, y: number) => listeners.get('pointerup')!(ptr(x, y));

beforeEach(() => {
  listeners.clear();
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

describe('startDrag', () => {
  it('a sub-threshold jitter click moves nothing', () => {
    store.setState({ viewport: { x: 0, y: 0, zoom: 0.3 }, selection: new Set(['a', 'b']) });
    startDrag(ptr(100, 100), 'a', fakeNode());
    move(103, 100);
    up(103, 100);
    expect(store.getState().positions.get('a')).toEqual({ x: 0, y: 0 });
    expect(store.getState().positions.get('b')).toEqual({ x: 500, y: 0 });
  });

  it('a drag that returns near its start is still an undoable drag', () => {
    startDrag(ptr(100, 100), 'a', fakeNode());
    move(150, 100);
    move(102, 100);
    up(102, 100);
    expect(store.getState().positions.get('a')).toEqual({ x: 2, y: 0 });
    expect(store.getState().past).toHaveLength(1);
  });

  it('zooming mid-drag keeps the grabbed point under the cursor', () => {
    startDrag(ptr(100, 100), 'a', fakeNode());
    move(200, 100);
    expect(store.getState().positions.get('a')).toEqual({ x: 100, y: 0 });
    zoomAt({ x: 200 - VIEWPORT_RECT.left, y: 100 - VIEWPORT_RECT.top }, 2);
    expect(store.getState().positions.get('a')).toEqual({ x: 100, y: 0 });
    move(200, 100);
    expect(store.getState().positions.get('a')).toEqual({ x: 100, y: 0 });
    up(200, 100);
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

describe('table drag over A* auto edges (F20)', () => {
  const mkRef = (s: string, t: string): Ref => ({
    id: `${s}->${t}`,
    source: { table: s, columns: ['id'], relation: '*' },
    target: { table: t, columns: ['id'], relation: '1' },
  });
  const ab = edgeKey('a', ['id'], 'b', ['id']);
  const ac = edgeKey('a', ['id'], 'c', ['id']);
  const bc = edgeKey('b', ['id'], 'c', ['id']);
  const autoShape: EdgeLayout = { waypoints: [{ x: 250, y: 40 }], sourceSide: 'bottom', targetSide: 'top', auto: true };
  const manual: EdgeLayout = { waypoints: [{ x: 250, y: 300 }] };

  beforeEach(() => {
    store.setState({
      schema: { tables: [], refs: [mkRef('a', 'b'), mkRef('a', 'c'), mkRef('b', 'c')], groups: [] },
      positions: new Map([['a', { x: 0, y: 0 }], ['b', { x: 500, y: 0 }], ['c', { x: 500, y: 500 }]]),
      edgeLayouts: new Map([[ab, { ...autoShape, color: '#ff0000' }], [ac, manual], [bc, autoShape]]),
    });
  });

  it('dropping a dragged table discards the auto shapes it touches, keeping color and user shapes', () => {
    startDrag(ptr(100, 100), 'a', fakeNode());
    move(160, 100);
    up(160, 100);
    const edges = store.getState().edgeLayouts;
    expect(edges.get(ab)).toEqual({ color: '#ff0000' });
    expect(edges.get(ac)).toEqual(manual);
    expect(edges.get(bc)).toEqual(autoShape);
  });

  it('one undo restores the table and the auto shape it discarded', () => {
    startDrag(ptr(100, 100), 'a', fakeNode());
    move(160, 100);
    up(160, 100);
    expect(store.getState().past).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().positions.get('a')).toEqual({ x: 0, y: 0 });
    expect(store.getState().edgeLayouts.get(ab)).toEqual({ ...autoShape, color: '#ff0000' });
    store.getState().redo();
    expect(store.getState().edgeLayouts.get(ab)).toEqual({ color: '#ff0000' });
  });

  it('a port flip dragged back to where it started leaves the shape automatic and history empty', () => {
    const rightAuto: EdgeLayout = { ...autoShape, sourceSide: 'right' };
    store.setState({ edgeLayouts: new Map([[bc, rightAuto]]) });
    startEndpointDrag(bc, 'source', 600, ptr(650, 0), fakeNode(), (x) => x);
    move(550, 0);
    expect(store.getState().edgeLayouts.get(bc)?.auto).toBeUndefined();
    move(650, 0);
    up(650, 0);
    expect(store.getState().edgeLayouts.get(bc)).toEqual(rightAuto);
    expect(store.getState().past).toHaveLength(0);
  });

  it('"Reset line" still resets an auto shape', () => {
    resetEdgeWaypoints(bc);
    expect(store.getState().edgeLayouts.has(bc)).toBe(false);
    expect(store.getState().past).toHaveLength(1);
  });
});
