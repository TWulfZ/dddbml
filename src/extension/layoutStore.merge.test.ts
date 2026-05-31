import { describe, expect, it } from 'vitest';
import { mergeLayout, serializeLayout } from './layoutStore';
import type { EdgeLayout, Layout } from '../shared/types';

const baseLayout = (overrides?: Partial<Layout>): Layout => ({
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  tables: {},
  groups: {},
  edges: {},
  ...overrides,
});

describe('layoutStore — mergeLayout (layout:persist partial merge)', () => {
  it('preserves edges sent in the payload (waypoints + color + sides)', () => {
    const current = baseLayout();
    const edge: EdgeLayout = {
      waypoints: [{ x: 320, y: 180 }, { x: 320, y: 420 }],
      color: '#D0E8FF',
      sourceSide: 'left',
      targetSide: 'right',
    };
    const merged = mergeLayout(current, { edges: { 'ref-1': edge } });
    expect(merged.edges).toEqual({ 'ref-1': edge });
  });

  it('falls back to current edges when the payload omits them (does not wipe to {})', () => {
    const current = baseLayout({
      edges: { 'ref-1': { waypoints: [{ x: 10, y: 20 }], color: '#FFD4E4' } },
    });
    // Payload carries only table positions — the classic partial persist after a table drag.
    const merged = mergeLayout(current, { tables: { 'public.users': { x: 5, y: 5 } } });
    expect(merged.edges).toEqual(current.edges);
  });

  it('payload wins over current per key; omitted keys keep current', () => {
    const current = baseLayout({
      viewport: { x: -1, y: -1, zoom: 0.5 },
      tables: { 'public.a': { x: 1, y: 1 } },
      groups: { billing: { collapsed: true } },
      edges: { e: { color: '#111111' } },
    });
    const merged = mergeLayout(current, {
      tables: { 'public.b': { x: 2, y: 2 } },
      viewport: { x: 9, y: 9, zoom: 2 },
    });
    expect(merged.viewport).toEqual({ x: 9, y: 9, zoom: 2 }); // payload wins
    expect(merged.tables).toEqual({ 'public.b': { x: 2, y: 2 } }); // payload wins (replace, not deep-merge)
    expect(merged.groups).toEqual(current.groups); // omitted -> kept
    expect(merged.edges).toEqual(current.edges); // omitted -> kept
    expect(merged.version).toBe(1);
  });

  it('tolerates a current layout with no edges key', () => {
    const current: Layout = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, tables: {}, groups: {} };
    const merged = mergeLayout(current, {});
    expect(merged.edges).toEqual({});
  });

  it('regression: a recolored, segment-dragged edge survives serialization (not "edges": {})', () => {
    const current = baseLayout();
    const payload: Partial<Layout> = {
      edges: { 'ref-1': { waypoints: [{ x: 320, y: 180 }], color: '#D0E8FF', sourceSide: 'left' } },
    };
    const text = serializeLayout(mergeLayout(current, payload));
    expect(text).not.toContain('"edges": {}');
    expect(text).toContain('"ref-1": {');
    expect(text).toContain('"color": "#D0E8FF"');
    expect(text).toContain('"sourceSide": "left"');
    expect(text).toContain('{ "x": 320, "y": 180 }');
  });
});
