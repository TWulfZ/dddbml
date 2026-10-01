import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../vscode', () => ({ postToHost: vi.fn() }));
vi.mock('../persistence', () => ({ schedulePersist: vi.fn() }));

import { store } from '../state/store';
import { zoomAt } from '../render/viewport';
import { commitEdgeStyle, resetEdgeWaypoints, startDrag } from './dragController';
import type { EdgeLayout } from '../../shared/types';

// Minimal DOM stand-ins: the controller only needs window listeners, a body classList and a node
// that can capture the pointer and find its viewport.
const listeners = new Map<string, (ev: PointerEvent) => void>();
vi.stubGlobal('window', {
  addEventListener: (type: string, fn: (ev: PointerEvent) => void) => listeners.set(type, fn),
  removeEventListener: (type: string) => listeners.delete(type),
});
vi.stubGlobal('document', { body: { classList: { add: () => undefined, remove: () => undefined } } });

// Manual animation frames: the drag commits from rAF, so tests decide when a frame runs.
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  frames.set(nextFrame, cb);
  return nextFrame++;
});
vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
function runFrame(): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const cb of pending) cb(0);
}

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
  frames.clear();
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
    runFrame();
    expect(store.getState().positions.get('a')).toEqual({ x: 100, y: 0 });
    zoomAt({ x: 200 - VIEWPORT_RECT.left, y: 100 - VIEWPORT_RECT.top }, 2);
    runFrame();
    expect(store.getState().positions.get('a')).toEqual({ x: 100, y: 0 });
    move(200, 100);
    runFrame();
    expect(store.getState().positions.get('a')).toEqual({ x: 100, y: 0 });
    up(200, 100);
  });

  it('commits at most once per animation frame, with the latest pointer', () => {
    const node = fakeNode();
    startDrag(ptr(100, 100), 'a', node);
    let commits = 0;
    const unsub = store.subscribe((s, prev) => {
      if (s.positions !== prev.positions) commits++;
    });
    move(120, 100);
    move(140, 110);
    move(160, 120);
    expect(commits).toBe(0);
    runFrame();
    unsub();
    expect(commits).toBe(1);
    expect(store.getState().positions.get('a')).toEqual({ x: 60, y: 20 });
    expect(node.style.transform).toBe('translate(60px, 20px)');
    up(160, 120);
  });

  it('a frame that lands after the canvas turned read-only writes nothing', () => {
    startDrag(ptr(100, 100), 'a', fakeNode());
    move(150, 130);
    store.setState({ gitView: { kind: 'diff', baseLabel: 'HEAD', headLabel: 'Working tree' } });
    runFrame();
    up(150, 130);
    expect(store.getState().positions.get('a')).toEqual({ x: 0, y: 0 });
    expect(store.getState().past).toHaveLength(0);
  });

  it('a release before the pending frame still lands on the last pointer position', () => {
    startDrag(ptr(100, 100), 'a', fakeNode());
    move(150, 130);
    up(150, 130);
    expect(store.getState().positions.get('a')).toEqual({ x: 50, y: 30 });
    expect(store.getState().past).toHaveLength(1);
    expect(frames.size).toBe(0);
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
