import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./vscode', () => ({ postToHost: vi.fn() }));

import { postToHost } from './vscode';
import { store } from './state/store';
import { flushPendingPersist, schedulePersist } from './persistence';

const posted = vi.mocked(postToHost);

beforeEach(() => {
  vi.useFakeTimers();
  posted.mockClear();
  store.getState().exitGitView();
  store.getState().endMerge();
});
afterEach(() => vi.useRealTimers());

describe('webview persist gate (spec 16, two-layer gate)', () => {
  it('a persist scheduled before time travel never posts the past revision (F27)', () => {
    schedulePersist();
    store.getState().enterTimeTravel('abc', 'abc');
    vi.advanceTimersByTime(1000);
    expect(posted).not.toHaveBeenCalled();
  });

  it('a persist scheduled before merge:begin never posts the provisional merge (F27)', () => {
    schedulePersist();
    store.getState().beginMerge([]);
    vi.advanceTimersByTime(1000);
    expect(posted).not.toHaveBeenCalled();
  });

  it('flushPendingPersist posts the pending edit at once, and only once', () => {
    schedulePersist();
    flushPendingPersist();
    expect(posted).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(posted).toHaveBeenCalledTimes(1);
  });
});
