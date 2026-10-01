import { beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from './store';
import type { Layout } from '../../shared/types';

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

describe('host layout pushes keep the live camera (F26)', () => {
  const layout = (x: number): Layout => ({ version: 1, viewport: { x, y: 0, zoom: 1 }, tables: {}, groups: {}, edges: {} });

  it('adopts the saved camera on the first layout only; later pushes (watcher, merge, overlay exit) keep it', () => {
    store.getState().setLayout(layout(100));
    expect(store.getState().viewport.x).toBe(100);
    store.getState().setViewport({ x: 42 });
    store.getState().setLayout(layout(100));
    expect(store.getState().viewport.x).toBe(42);
  });
});
