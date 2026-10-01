import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '../state/store';
import { screenToWorld, zoomToAtCenter } from './viewport';

const W = 1000;
const H = 600;
const viewportEl = { getBoundingClientRect: () => ({ width: W, height: H }) } as unknown as HTMLElement;

beforeEach(() => {
  // Looking at world (5000, 3000) in the centre of the screen at 100%.
  store.getState().setViewport({ x: W / 2 - 5000, y: H / 2 - 3000, zoom: 1 });
});

describe('zoomToAtCenter (zoom % input)', () => {
  it('keeps the world point under the viewport centre fixed', () => {
    zoomToAtCenter(0.5, viewportEl);
    expect(store.getState().viewport.zoom).toBe(0.5);
    expect(screenToWorld({ x: W / 2, y: H / 2 })).toEqual({ x: 5000, y: 3000 });
  });

  it('clamps to the configured zoom range', () => {
    zoomToAtCenter(1000, viewportEl);
    expect(store.getState().viewport.zoom).toBe(store.getState().settings.zoomMax);
    expect(screenToWorld({ x: W / 2, y: H / 2 })).toEqual({ x: 5000, y: 3000 });
  });
});
