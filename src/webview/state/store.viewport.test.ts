import { beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from './store';

beforeEach(() => {
  store.getState().setViewport({ x: 0, y: 0, zoom: 1 });
});

describe('setViewport identity guard (spec 04 — no notify on an unchanged camera)', () => {
  it('keeps the same viewport object and does not notify subscribers when nothing changed', () => {
    const before = store.getState().viewport;
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    store.getState().setViewport({ x: 0, y: 0 });
    store.getState().setViewport({ zoom: 1 });
    unsub();
    expect(store.getState().viewport).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies exactly once per real change and merges partial updates', () => {
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    store.getState().setViewport({ x: 10 });
    unsub();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().viewport).toEqual({ x: 10, y: 0, zoom: 1 });
  });
});
