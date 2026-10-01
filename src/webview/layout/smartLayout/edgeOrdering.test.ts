import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../vscode', () => ({ postToHost: vi.fn() }));
import { store } from '../../state/store';
import { runEdgeOrdering } from './runner';
import { computeEdgeOrdering } from './edgeOrdering';
import type { EdgeLayout, Layout, Ref, Schema, Table } from '../../../shared/types';
import { routeRefs, type EdgeRoute } from '../../render/edgeRouter';
import type { Bbox } from '../../render/spatialIndex';
import { columnCenterY, estimateSize } from '../autoLayout';

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
    refs: [mkRef('public.a(c0)->public.b(c0)', 'public.a', 'public.b')],
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

/** The edge layer's key for the a→b ref (render/edgeKey), which runner results must land on. */
const EDGE_KEY = 'public.a::c0|public.b::c0';

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
    const routed = cmd.edgesTo.find(([id]) => id === EDGE_KEY)![1]!;
    expect(routed.waypoints && routed.waypoints.length).toBeGreaterThan(0); // it detoured
  });

  it('one undo restores the prior EdgeLayouts; redo re-applies the routed waypoints', async () => {
    const { schema, positions } = obstacleSchema();
    store.getState().setSchema(schema, null);
    store.getState().setPositionsBatch(positions);
    // Pre-existing color the routing must preserve and undo must restore.
    store.getState().applyEdgeLayouts([[EDGE_KEY, { color: '#abc' }]]);
    store.getState().clearHistory();

    await runEdgeOrdering({ preserveManual: false });
    const after = store.getState().edgeLayouts.get(EDGE_KEY)!;
    expect(after.color).toBe('#abc'); // color preserved
    expect(after.waypoints && after.waypoints.length).toBeGreaterThan(0);

    store.getState().undo();
    expect(store.getState().edgeLayouts.get(EDGE_KEY)).toEqual({ color: '#abc' });

    store.getState().redo();
    expect(store.getState().edgeLayouts.get(EDGE_KEY)!.waypoints!.length).toBeGreaterThan(0);
  });

  it('preserveManual:true leaves a hand-shaped edge untouched; false re-routes it', async () => {
    const { schema, positions } = obstacleSchema();
    const manual: EdgeLayout = { waypoints: [{ x: 111, y: 222 }] };

    // preserve = true → skipped
    {
      const ordered = await computeEdgeOrdering({
        schema,
        positions: new Map(positions),
        existingLayouts: new Map([['public.a(c0)->public.b(c0)', manual]]),
        preserveManual: true,
      });
      expect(ordered.resets.find(([id]) => id === 'public.a(c0)->public.b(c0)')).toBeUndefined();
    }
    // preserve = false → re-routed
    {
      const ordered = await computeEdgeOrdering({
        schema,
        positions: new Map(positions),
        existingLayouts: new Map([['public.a(c0)->public.b(c0)', manual]]),
        preserveManual: false,
      });
      const pair = ordered.resets.find(([id]) => id === 'public.a(c0)->public.b(c0)');
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

describe('computeEdgeOrdering — sides persist only when they carry information (F20)', () => {
  const ID = 'public.a(c0)->public.b(c0)';
  const pairSchema: Schema = {
    tables: [mkTable('public.a'), mkTable('public.b')],
    refs: [mkRef(ID, 'public.a', 'public.b')],
    groups: [],
  };
  const order = (positions: Array<[string, { x: number; y: number }]>, existing = new Map<string, EdgeLayout>()) =>
    computeEdgeOrdering({ schema: pairSchema, positions: new Map(positions), existingLayouts: existing, preserveManual: true });

  it('render-default left/right sides are not persisted, so the edge stays re-orderable', async () => {
    const side: Array<[string, { x: number; y: number }]> = [['public.a', { x: 0, y: 0 }], ['public.b', { x: 600, y: 0 }]];
    const first = await order(side);
    const layout = first.resets.find(([id]) => id === ID)![1];
    expect(layout.sourceSide).toBeUndefined();
    expect(layout.targetSide).toBeUndefined();
    const second = await order(side, new Map(first.resets));
    expect(second.resets.some(([id]) => id === ID)).toBe(true);
  });

  it('a fallback (no route found) persists no provisional sides', async () => {
    // Stacked so far apart that the routing window exceeds MAX_GRID_CELLS ⇒ ok:false.
    const far: Array<[string, { x: number; y: number }]> = [['public.a', { x: 0, y: 0 }], ['public.b', { x: 9000, y: 30000 }]];
    const { resets } = await order(far);
    const layout = resets.find(([id]) => id === ID)![1];
    expect(layout).toEqual({});
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

describe('computeEdgeOrdering → routeRefs (rendered A* routes)', () => {
  /** Two consecutive segments on one axis pointing opposite ways: a spur or a stub doubling back. */
  const hasBacktrack = (r: EdgeRoute): boolean =>
    r.segments.some((s, i) => {
      const prev = r.segments[i - 1];
      if (!prev || prev.axis !== s.axis) return false;
      return s.axis === 'h'
        ? Math.sign(s.x2 - s.x1) * Math.sign(prev.x2 - prev.x1) < 0
        : Math.sign(s.y2 - s.y1) * Math.sign(prev.y2 - prev.y1) < 0;
    });

  const render = async (
    schema: Schema,
    positions: Array<[string, { x: number; y: number }]>,
  ): Promise<{ route: EdgeRoute; bboxOf: (n: string) => Bbox | undefined }> => {
    const posMap = new Map(positions);
    const { resets } = await computeEdgeOrdering({ schema, positions: posMap, existingLayouts: new Map(), preserveManual: false });
    const layouts = new Map(resets);
    const byName = new Map(schema.tables.map((t) => [t.name, t]));
    const bboxOf = (n: string): Bbox | undefined => {
      const p = posMap.get(n);
      const t = byName.get(n);
      if (!p || !t) return undefined;
      const s = estimateSize(t.columns.length);
      return { x: p.x, y: p.y, w: s.width, h: s.height };
    };
    const colY = (table: string, col: string): number | undefined => {
      const idx = byName.get(table)?.columns.findIndex((c) => c.name === col) ?? -1;
      return idx < 0 ? undefined : columnCenterY(idx);
    };
    const route = routeRefs(schema.refs, bboxOf, colY, (id) => layouts.get(id))[0]!;
    return { route, bboxOf };
  };

  it('a detour around a table never doubles back on its rigid stubs', async () => {
    const { schema, positions } = obstacleSchema();
    const { route } = await render(schema, positions);
    expect(route.waypoints.length).toBeGreaterThan(0);
    expect(hasBacktrack(route)).toBe(false);
  });

  it('vertically stacked tables route top/bottom with vertical stubs clear of both borders', async () => {
    const schema: Schema = {
      tables: [mkTable('public.a'), mkTable('public.b'), mkTable('public.m')],
      refs: [mkRef('public.a(c0)->public.b(c0)', 'public.a', 'public.b')],
      groups: [],
    };
    const positions: Array<[string, { x: number; y: number }]> = [
      ['public.a', { x: 0, y: 0 }],
      ['public.m', { x: 0, y: 300 }],
      ['public.b', { x: 0, y: 600 }],
    ];
    const { route, bboxOf } = await render(schema, positions);
    expect(route.segments[0]!.axis).toBe('v');
    expect(route.segments[route.segments.length - 1]!.axis).toBe('v');
    expect(hasBacktrack(route)).toBe(false);
    for (const name of ['public.a', 'public.b']) {
      const b = bboxOf(name)!;
      const alongBorder = route.segments.some(
        (s) => s.axis === 'h' && (s.y1 === b.y || s.y1 === b.y + b.h) && Math.max(s.x1, s.x2) > b.x && Math.min(s.x1, s.x2) < b.x + b.w,
      );
      expect(alongBorder).toBe(false);
    }
  });
});
