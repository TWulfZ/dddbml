import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../vscode', () => ({ postToHost: vi.fn() }));

import { store } from '../state/store';
import { diffNavIndex } from './gitBanner';

const emptyDiff = { tables: [], refs: [] };

beforeEach(() => store.getState().exitGitView());

describe('diff banner navigation', () => {
  it('first Next after opening the diff lands on change 1, not change 2', () => {
    store.getState().enterDiff('HEAD', 'working', emptyDiff);
    expect(diffNavIndex(store.getState().diffCursor, 3, 1)).toBe(0);
  });

  it('first Prev after opening the diff lands on the last change', () => {
    store.getState().enterDiff('HEAD', 'working', emptyDiff);
    expect(diffNavIndex(store.getState().diffCursor, 3, -1)).toBe(2);
  });

  it('wraps once a change is focused', () => {
    expect(diffNavIndex(2, 3, 1)).toBe(0);
    expect(diffNavIndex(0, 3, -1)).toBe(2);
  });
});
