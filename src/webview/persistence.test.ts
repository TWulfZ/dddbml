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
