import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./vscode', () => ({ postToHost: vi.fn() }));

import { postToHost } from './vscode';
import { store } from './state/store';
import { schedulePersist } from './persistence';

const posted = vi.mocked(postToHost);
const persists = () => posted.mock.calls.filter(([m]) => m.type === 'layout:persist');

beforeEach(() => {
  vi.useFakeTimers();
  posted.mockClear();
  store.getState().exitGitView();
  store.getState().endMerge();
});
afterEach(() => vi.useRealTimers());

describe('discrete edits reach the host at once (F22)', () => {
  it('posts layout:persist synchronously, so closing or hiding the panel right after cannot drop it', () => {
    schedulePersist();
    expect(persists()).toHaveLength(1);
  });
});

describe('webview persist gate (spec 16, two-layer gate)', () => {
  it('posts nothing while a past revision is on screen (F27)', () => {
    store.getState().enterTimeTravel('abc', 'abc');
    schedulePersist();
    vi.advanceTimersByTime(1000);
    expect(persists()).toHaveLength(0);
  });

  it('posts nothing while the provisional merge is on screen (F27)', () => {
    store.getState().beginMerge([]);
    schedulePersist();
    vi.advanceTimersByTime(1000);
    expect(persists()).toHaveLength(0);
  });
});

describe('camera persistence (F26)', () => {
  const viewportPosts = () => posted.mock.calls.filter(([m]) => m.type === 'viewport:persist');

  it('posts the camera once a pan/zoom burst settles, and never inside layout:persist', () => {
    for (let i = 1; i <= 5; i++) store.getState().setViewport({ x: i * 10 });
    expect(viewportPosts()).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(viewportPosts().map(([m]) => m)).toEqual([{ type: 'viewport:persist', payload: { x: 50, y: 0, zoom: 1 } }]);
    schedulePersist();
    const [persist] = persists().at(-1)!;
    expect(persist.type === 'layout:persist' && 'viewport' in persist.payload).toBe(false);
  });

  it('still saves the camera while the canvas is read-only (it is personal state)', () => {
    store.getState().enterTimeTravel('abc', 'abc');
    store.getState().setViewport({ zoom: 2 });
    vi.advanceTimersByTime(1000);
    expect(viewportPosts()).toHaveLength(1);
  });
});

describe('locally hidden table with no sidecar entry (F66)', () => {
  it('renders hidden and is persisted as hidden once auto-layout places it', () => {
    store.getState().setLayout({ version: 1, viewport: { x: 0, y: 0, zoom: 1 }, tables: {}, groups: {}, edges: {}, hiddenUnplaced: ['public.t'] });
    expect(store.getState().hiddenTables.has('public.t')).toBe(true);
    schedulePersist();
    expect(persists().at(-1)![0]).toMatchObject({ payload: { hiddenUnplaced: ['public.t'] } });
    store.getState().setPositionsBatch([['public.t', { x: 10, y: 20 }]]);
    schedulePersist();
    expect(persists().at(-1)![0]).toMatchObject({ payload: { tables: { 'public.t': { x: 10, y: 20, hidden: true } }, hiddenUnplaced: [] } });
  });
});

describe('A* auto marker (F20)', () => {
  it('rides the persist payload with its shape, so a reopened diagram still re-orders the edge', () => {
    store.setState({ edgeLayouts: new Map([['k', { waypoints: [{ x: 1, y: 2 }], sourceSide: 'top', auto: true }]]) });
    schedulePersist();
    const [persist] = persists().at(-1)!;
    expect(persist.type === 'layout:persist' && persist.payload.edges?.['k']).toEqual({ waypoints: [{ x: 1, y: 2 }], sourceSide: 'top', auto: true });
  });
});

describe('pre-0.4 layouts load silently (spec 05 §11: no migration prompt)', () => {
  it('an unmarked layout keeps every saved shape, raises no pending state and is not written on load', () => {
    const K = 'public.a::b_id|public.b::id';
    const shape = { waypoints: [{ x: 568, y: 40 }, { x: 568, y: 337 }], sourceSide: 'right' as const, color: '#abc' };
    store.getState().setLayout({ version: 1, viewport: { x: 0, y: 0, zoom: 1 }, tables: {}, groups: {}, edges: { [K]: shape } });
    const s = store.getState() as unknown as Record<string, unknown>;
    expect(store.getState().edgeLayouts.get(K)).toEqual(shape);
    expect('edgeMigrationPending' in s).toBe(false);
    expect('edgeRouting' in s).toBe(false);
    expect(persists()).toHaveLength(0);
    // The marker is the host's to keep: a persist never carries it, so it cannot drop or rewrite it.
    schedulePersist();
    expect(persists()[0]![0]).toMatchObject({ payload: { edges: { [K]: shape } } });
    expect('edgeRouting' in (persists()[0]![0] as { payload: object }).payload).toBe(false);
  });
});
