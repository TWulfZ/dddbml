import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../vscode', () => ({ postToHost: vi.fn() }));
vi.mock('../persistence', () => ({ schedulePersist: vi.fn() }));

import { store } from '../state/store';
import { zoomAt } from '../render/viewport';
import { commitEdgeStyle, deleteDepWaypoint, flipLoopSide, resetEdgeWaypoints, startDepWaypointInsert, startDepWaypointMove, startDrag, startEndpointDrag } from './dragController';
import type { EdgeLayout, Ref } from '../../shared/types';
import { depKey, edgeKey } from '../render/edgeKey';

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

const baseSettings = store.getState().settings;

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
    settings: baseSettings,
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

  it('a lock that lands after a committed frame puts the tables back on release, with no history', () => {
    const node = fakeNode();
    store.setState({ selection: new Set(['a', 'b']) });
    startDrag(ptr(100, 100), 'a', node);
    move(150, 130);
    runFrame();
    expect(store.getState().positions.get('a')).toEqual({ x: 50, y: 30 });
    store.setState({ gitView: { kind: 'diff', baseLabel: 'HEAD', headLabel: 'Working tree' } });
    up(150, 130);
    expect(store.getState().positions.get('a')).toEqual({ x: 0, y: 0 });
    expect(store.getState().positions.get('b')).toEqual({ x: 500, y: 0 });
    expect(node.style.transform).toBe('translate(0px, 0px)');
    expect(store.getState().past).toHaveLength(0);
  });

  it('a lock that swapped in its own layout (time travel) keeps that layout on release', () => {
    startDrag(ptr(100, 100), 'a', fakeNode());
    move(150, 130);
    runFrame();
    store.getState().enterTimeTravel('abc', 'abc');
    store.getState().setLayout({
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      tables: { a: { x: 70, y: 80 }, b: { x: 500, y: 0 } },
      groups: {},
    });
    up(150, 130);
    expect(store.getState().positions.get('a')).toEqual({ x: 70, y: 80 });
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

  it('a multi-select drag translates the waypoints of edges inside the selection, in one undo step', () => {
    store.setState({ selection: new Set(['a', 'b']) });
    startDrag(ptr(100, 100), 'a', fakeNode());
    move(160, 130);
    up(160, 130);
    const edges = store.getState().edgeLayouts;
    expect(edges.get(ab)).toEqual({ ...autoShape, waypoints: [{ x: 310, y: 70 }], color: '#ff0000' });
    expect(edges.get(ac)).toEqual(manual);
    expect(edges.has(bc)).toBe(false);
    expect(store.getState().past).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().positions.get('a')).toEqual({ x: 0, y: 0 });
    expect(store.getState().positions.get('b')).toEqual({ x: 500, y: 0 });
    expect(store.getState().edgeLayouts.get(ab)).toEqual({ ...autoShape, color: '#ff0000' });
    expect(store.getState().edgeLayouts.get(bc)).toEqual(autoShape);
    store.getState().redo();
    expect(store.getState().edgeLayouts.get(ab)).toEqual({ ...autoShape, waypoints: [{ x: 310, y: 70 }], color: '#ff0000' });
    expect(store.getState().edgeLayouts.has(bc)).toBe(false);
  });

  it('a multi-select drag translates a manual ref inside the selection', () => {
    store.setState({ selection: new Set(['a', 'c']) });
    startDrag(ptr(100, 100), 'a', fakeNode());
    move(160, 130);
    up(160, 130);
    expect(store.getState().edgeLayouts.get(ac)).toEqual({ waypoints: [{ x: 310, y: 330 }] });
  });

  it('with snap on, waypoints move by the snapped delta the tables committed', () => {
    const settings = store.getState().settings;
    store.setState({ selection: new Set(['a', 'c']), settings: { ...settings, ui: { ...settings.ui, snapToGrid: true, gridSize: 20 } } });
    startDrag(ptr(100, 100), 'a', fakeNode());
    move(157, 128);
    up(157, 128);
    expect(store.getState().positions.get('a')).toEqual({ x: 60, y: 20 });
    expect(store.getState().edgeLayouts.get(ac)).toEqual({ waypoints: [{ x: 310, y: 320 }] });
  });

  it('with snap on, an A* shape inside the selection survives a drag that snaps one end back in place', () => {
    const settings = store.getState().settings;
    store.setState({
      selection: new Set(['a', 'b']),
      positions: new Map([['a', { x: 0, y: 0 }], ['b', { x: 515, y: 0 }], ['c', { x: 500, y: 500 }]]),
      settings: { ...settings, ui: { ...settings.ui, snapToGrid: true, gridSize: 20 } },
    });
    startDrag(ptr(100, 100), 'a', fakeNode());
    move(108, 100);
    up(108, 100);
    expect(store.getState().positions.get('a')).toEqual({ x: 0, y: 0 });
    expect(store.getState().positions.get('b')).toEqual({ x: 520, y: 0 });
    expect(store.getState().edgeLayouts.get(ab)).toEqual({ ...autoShape, color: '#ff0000' });
    expect(store.getState().edgeLayouts.has(bc)).toBe(false);
  });

  it('"Reset line" still resets an auto shape', () => {
    resetEdgeWaypoints(bc);
    expect(store.getState().edgeLayouts.has(bc)).toBe(false);
    expect(store.getState().past).toHaveLength(1);
  });
});

describe('dep waypoint edits (spec 18)', () => {
  const dk = depKey('a', [], 'b', []);
  const shape: EdgeLayout = { waypoints: [{ x: 250, y: 100 }, { x: 300, y: 200 }], color: '#3b82f6' };

  beforeEach(() => {
    store.setState({
      schema: { tables: [], refs: [], groups: [], deps: [{ name: null, edges: [{ id: 'd', upstream: { table: 'a', columns: [] }, downstream: { table: 'b', columns: [] } }] }] },
      edgeLayouts: new Map([[dk, shape]]),
    });
  });

  it('are ignored while the canvas is read-only', () => {
    store.setState({ gitView: { kind: 'diff', baseLabel: 'HEAD', headLabel: 'Working tree' } });
    startDepWaypointMove(dk, 0, ptr(300, 120), fakeNode());
    expect(listeners.size).toBe(0);
    startDepWaypointInsert(dk, 1, { x: 270, y: 150 }, ptr(320, 170), fakeNode());
    expect(listeners.size).toBe(0);
    deleteDepWaypoint(dk, 0);
    expect(store.getState().edgeLayouts.get(dk)).toEqual(shape);
    expect(store.getState().past).toHaveLength(0);
  });

  it('never carry the A* marker, even over a sidecar that smuggled one in', () => {
    // Bypasses writeLayout on purpose: a hand-edited sidecar is the only way a dep key could hold it.
    store.setState({ edgeLayouts: new Map([[dk, { ...shape, auto: true }]]) });
    startDepWaypointMove(dk, 0, ptr(300, 120), fakeNode());
    move(300, 120);
    up(300, 120);
    expect(store.getState().edgeLayouts.get(dk)).toEqual(shape);
    startDepWaypointMove(dk, 0, ptr(300, 120), fakeNode());
    move(340, 160);
    up(340, 160);
    expect(store.getState().edgeLayouts.get(dk)?.auto).toBeUndefined();
    store.getState().undo();
    expect(store.getState().edgeLayouts.get(dk)).toEqual(shape);
  });

  it('a table drag over both endpoints carries the dep waypoints along', () => {
    store.setState({ selection: new Set(['a', 'b']) });
    startDrag(ptr(100, 100), 'a', fakeNode());
    move(400, 300);
    up(400, 300);
    expect(store.getState().positions.get('b')).toEqual({ x: 800, y: 200 });
    expect(store.getState().edgeLayouts.get(dk)).toEqual({ ...shape, waypoints: [{ x: 550, y: 300 }, { x: 600, y: 400 }] });
  });

  it('a table drag over one endpoint keeps the dep waypoints', () => {
    startDrag(ptr(100, 100), 'a', fakeNode());
    move(400, 300);
    up(400, 300);
    expect(store.getState().edgeLayouts.get(dk)).toEqual(shape);
    expect(store.getState().past[0]?.kind).toBe('move');
  });
});

describe('self-loop side flip (spec 05 §Self-loops)', () => {
  const loop = edgeKey('a', ['parent_id'], 'a', ['id']);

  it('the toolbar flip moves both ends to the other side, one undo step', () => {
    flipLoopSide(loop);
    expect(store.getState().edgeLayouts.get(loop)).toEqual({ sourceSide: 'left', targetSide: 'left' });
    // Right is the default side: flipping back drops the override instead of persisting it.
    flipLoopSide(loop);
    expect(store.getState().edgeLayouts.has(loop)).toBe(false);
    expect(store.getState().past).toHaveLength(2);
    store.getState().undo();
    expect(store.getState().edgeLayouts.get(loop)).toEqual({ sourceSide: 'left', targetSide: 'left' });
  });

  it('dragging either loop endpoint across the table flips both ends', () => {
    startEndpointDrag(loop, 'target', 100, ptr(150, 0), fakeNode(), (x) => x, true);
    move(50, 0);
    up(50, 0);
    expect(store.getState().edgeLayouts.get(loop)).toEqual({ sourceSide: 'left', targetSide: 'left' });
    expect(store.getState().past).toHaveLength(1);
  });

  it('is gated by the read-only canvas', () => {
    store.setState({ gitView: { kind: 'diff', baseLabel: 'HEAD', headLabel: 'Working tree' } });
    flipLoopSide(loop);
    expect(store.getState().edgeLayouts.has(loop)).toBe(false);
  });
});
