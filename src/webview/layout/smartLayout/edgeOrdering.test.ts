import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '../../state/store';
import { runEdgeOrdering } from './runner';
import { computeEdgeOrdering } from './edgeOrdering';
import type { EdgeLayout, Layout, Ref, Schema, Table } from '../../../shared/types';

const mkTable = (name: string, cols = 3): Table => ({
  name,
  schemaName: 'public',
  tableName: name.replace('public.', ''),
  columns: Array.from({ length: cols }, (_, i) => ({ name: `c${i}`, type: 'int' })),
});

const mkRef = (id: string, src: string, tgt: string): Ref => ({
  id,
  source: { table: src, columns: ['c0'], relation: '*' },
  target: { table: tgt, columns: ['c0'], relation: '1' },
});

/** A schema where a→b must route around an intervening table `m` sitting on the straight corridor. */
function obstacleSchema(): { schema: Schema; positions: Array<[string, { x: number; y: number }]> } {
  const schema: Schema = {
    tables: [mkTable('public.a'), mkTable('public.b'), mkTable('public.m')],
    refs: [mkRef('a::c0|b::c0', 'public.a', 'public.b')],
    groups: [],
  };
  // a left, b far right, m squarely between them on the same row → forces a detour.
  const positions: Array<[string, { x: number; y: number }]> = [
    ['public.a', { x: 0, y: 0 }],
    ['public.b', { x: 800, y: 0 }],
    ['public.m', { x: 360, y: 0 }],
  ];
  return { schema, positions };
}

const blankLayout: Layout = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, tables: {}, groups: {} };

beforeEach(() => {
  store.getState().setLayout(blankLayout);
});

describe('runEdgeOrdering — edges-only arrange (spec 05 §9)', () => {
  it('pushes exactly ONE edges-only ArrangeCommand whose edges carry SET waypoints', async () => {
    const { schema, positions } = obstacleSchema();
    store.getState().setSchema(schema, null);
    store.getState().setPositionsBatch(positions);
    store.getState().clearHistory();
    const pastBefore = store.getState().past.length;

    await runEdgeOrdering({ preserveManual: true });

    expect(store.getState().past.length).toBe(pastBefore + 1);
    const cmd = store.getState().past[store.getState().past.length - 1]!;
    expect(cmd.kind).toBe('arrange');
    if (cmd.kind !== 'arrange') throw new Error('expected arrange');
    expect(cmd.from).toEqual([]); // edges-only: no position entries
    expect(cmd.to).toEqual([]);
    expect(cmd.edgesTo.length).toBeGreaterThan(0);
    const routed = cmd.edgesTo.find(([id]) => id === 'a::c0|b::c0')![1]!;
    expect(routed.waypoints && routed.waypoints.length).toBeGreaterThan(0); // it detoured
  });

  it('one undo restores the prior EdgeLayouts; redo re-applies the routed waypoints', async () => {
    const { schema, positions } = obstacleSchema();
    store.getState().setSchema(schema, null);
    store.getState().setPositionsBatch(positions);
    // Pre-existing color the routing must preserve and undo must restore.
    store.getState().applyEdgeLayouts([['a::c0|b::c0', { color: '#abc' }]]);
    store.getState().clearHistory();

    await runEdgeOrdering({ preserveManual: false });
    const after = store.getState().edgeLayouts.get('a::c0|b::c0')!;
    expect(after.color).toBe('#abc'); // color preserved
    expect(after.waypoints && after.waypoints.length).toBeGreaterThan(0);

    store.getState().undo();
    expect(store.getState().edgeLayouts.get('a::c0|b::c0')).toEqual({ color: '#abc' });

    store.getState().redo();
    expect(store.getState().edgeLayouts.get('a::c0|b::c0')!.waypoints!.length).toBeGreaterThan(0);
  });

  it('preserveManual:true leaves a hand-shaped edge untouched; false re-routes it', async () => {
    const { schema, positions } = obstacleSchema();
    const manual: EdgeLayout = { waypoints: [{ x: 111, y: 222 }] };

    // preserve = true → skipped
    {
      const ordered = await computeEdgeOrdering({
        schema,
        positions: new Map(positions),
        existingLayouts: new Map([['a::c0|b::c0', manual]]),
        preserveManual: true,
      });
      expect(ordered.resets.find(([id]) => id === 'a::c0|b::c0')).toBeUndefined();
    }
    // preserve = false → re-routed
    {
      const ordered = await computeEdgeOrdering({
        schema,
        positions: new Map(positions),
        existingLayouts: new Map([['a::c0|b::c0', manual]]),
        preserveManual: false,
      });
      const pair = ordered.resets.find(([id]) => id === 'a::c0|b::c0');
      expect(pair).toBeDefined();
      expect(pair![1].waypoints).not.toEqual(manual.waypoints);
    }
  });

  it('is a no-op (pushes no command) when there is nothing to order', async () => {
    store.getState().setSchema({ tables: [], refs: [], groups: [] }, null);
    store.getState().clearHistory();
    await runEdgeOrdering();
    expect(store.getState().past.length).toBe(0);
  });
});

describe('computeEdgeOrdering — determinism', () => {
  it('produces byte-identical results across two runs', async () => {
    const { schema, positions } = obstacleSchema();
    const a = await computeEdgeOrdering({ schema, positions: new Map(positions), existingLayouts: new Map(), preserveManual: false });
    const b = await computeEdgeOrdering({ schema, positions: new Map(positions), existingLayouts: new Map(), preserveManual: false });
    expect(JSON.stringify(a.resets)).toBe(JSON.stringify(b.resets));
  });
});
