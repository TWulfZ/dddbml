import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '../state/store';
import { estimateSize } from '../layout/autoLayout';
import { fitToContent, screenToWorld, worldToScreen, zoomToAtCenter } from './viewport';
import type { Table } from '../../shared/types';

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

describe('fitToContent', () => {
  const table = (name: string, groupName: string | null = null): Table => ({
    name, schemaName: 'public', tableName: name, columns: [], groupName,
  });

  it('frames only what is rendered: hidden group members are left out', () => {
    const s = store.getState();
    s.setSchema(
      { tables: [table('a'), table('b'), table('far', 'archive')], refs: [], groups: [{ name: 'archive', tables: ['far'] }] },
      null,
    );
    s.setPositionsBatch([['a', { x: 0, y: 0 }], ['b', { x: 400, y: 0 }], ['far', { x: 20000, y: 0 }]]);
    s.setGroup('archive', { hidden: true });

    fitToContent(viewportEl, 0);

    const visibleRight = 400 + estimateSize(0).width;
    expect(screenToWorld({ x: W / 2, y: H / 2 }).x).toBeCloseTo(visibleRight / 2);
    expect(worldToScreen({ x: visibleRight, y: 0 }).x).toBeCloseTo(W);
  });

  it('leaves the camera alone when every table is hidden', () => {
    const s = store.getState();
    s.setSchema({ tables: [table('a')], refs: [], groups: [] }, null);
    s.setPositionsBatch([['a', { x: 0, y: 0 }]]);
    s.setTableHidden('a', true);
    const before = store.getState().viewport;

    fitToContent(viewportEl, 0);

    expect(store.getState().viewport).toBe(before);
  });
});
