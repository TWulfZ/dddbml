import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../vscode', () => ({ postToHost: vi.fn() }));
import { store } from '../../state/store';
import { runEdgeOrdering } from './runner';
import { computeEdgeOrdering } from './edgeOrdering';
import type { EdgeLayout, Layout, Ref, Schema, Table } from '../../../shared/types';
import { LOOP_STEP, loopReach, routeRefs, type EdgeRoute } from '../../render/edgeRouter';
import type { Bbox } from '../../render/spatialIndex';
import { columnCenterY, estimateSize } from '../autoLayout';
import { isLegacyAutoShape } from '../edgeSides';

const mkTable = (name: string, cols = 3): Table => ({
  name,
  schemaName: 'public',
  tableName: name.replace('public.', ''),
  columns: Array.from({ length: cols }, (_, i) => ({ name: `c${i}`, type: 'int' })),
});

const bboxAt = (x: number, y: number): Bbox => {
  const size = estimateSize(3);
  return { x, y, w: size.width, h: size.height };
};

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

describe('computeEdgeOrdering — persisted sides (F20, spec 05 §9)', () => {
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

  it('a clear right C keeps the render default (no waypoints, no sides), so render nests it', async () => {
    const diagonal: Array<[string, { x: number; y: number }]> = [['public.a', { x: 0, y: 0 }], ['public.b', { x: 120, y: 300 }]];
    const { resets } = await order(diagonal);
    expect(resets.find(([id]) => id === ID)![1]).toEqual({});
  });

  it('a C whose right trunk crosses a third table keeps the render default, which flips it to a clear left', async () => {
    const schema: Schema = { ...pairSchema, tables: [...pairSchema.tables, mkTable('public.m')] };
    const h = estimateSize(3).height;
    // m pokes out right of the a/b column, between them: the right trunk at w + 24 runs through it.
    const positions = new Map<string, { x: number; y: number }>([
      ['public.a', { x: 0, y: 0 }],
      ['public.m', { x: 60, y: h + 80 }],
      ['public.b', { x: 0, y: 2 * h + 160 }],
    ]);
    const { resets } = await computeEdgeOrdering({ schema, positions, existingLayouts: new Map(), preserveManual: true });
    expect(resets.find(([id]) => id === ID)![1]).toEqual({});
  });

  it('a C blocked on both sides is routed by A*; its waypoints persist with both sides, so render keeps them', async () => {
    const schema: Schema = { ...pairSchema, tables: [...pairSchema.tables, mkTable('public.m'), mkTable('public.n')] };
    const { width: w, height: h } = estimateSize(3);
    // m pokes out right and n left of the a/b column, between them: both trunks run through one.
    const positions = new Map<string, { x: number; y: number }>([
      ['public.a', { x: 0, y: 0 }],
      ['public.m', { x: 60, y: h + 80 }],
      ['public.n', { x: -60, y: h + 80 }],
      ['public.b', { x: 0, y: 2 * h + 160 }],
    ]);
    const { resets } = await computeEdgeOrdering({ schema, positions, existingLayouts: new Map(), preserveManual: true });
    const layout = resets.find(([id]) => id === ID)![1];
    expect(layout.waypoints?.length).toBeGreaterThan(0);
    expect(layout.sourceSide).toBe('right');
    expect(layout.targetSide).toBe('right');
    expect(layout.auto).toBe(true);
    expect(isLegacyAutoShape(layout, bboxAt(0, 0), bboxAt(0, 2 * h + 160))).toBe(false);
    for (const wp of layout.waypoints!) expect(wp.x === w + 24 && wp.y > h + 80 && wp.y < 2 * h + 80).toBe(false);
  });

  it('waypoints never persist without their sides, so no new shape reads as a legacy side-less one', async () => {
    const schema: Schema = {
      tables: ['a', 'm', 'b'].map((n) => mkTable(`public.${n}`)),
      refs: [mkRef(ID, 'public.a', 'public.b')],
      groups: [],
    };
    const positions = new Map([['public.a', { x: 0, y: 0 }], ['public.m', { x: 0, y: 300 }], ['public.b', { x: 0, y: 600 }]]);
    const { resets } = await computeEdgeOrdering({ schema, positions, existingLayouts: new Map(), preserveManual: true });
    for (const [, layout] of resets) {
      if (layout.waypoints?.length) expect(layout.sourceSide && layout.targetSide).toBeTruthy();
    }
  });

  it('a third table blocking the right stub band persists a C on the left, marked auto', async () => {
    const schema: Schema = { ...pairSchema, tables: [...pairSchema.tables, mkTable('public.c')] };
    const w = estimateSize(3).width;
    const positions = new Map<string, { x: number; y: number }>([
      ['public.a', { x: 0, y: 0 }],
      ['public.b', { x: 0, y: 400 }],
      ['public.c', { x: w + 10, y: 0 }],
    ]);
    const { resets } = await computeEdgeOrdering({ schema, positions, existingLayouts: new Map(), preserveManual: true });
    const layout = resets.find(([id]) => id === ID)![1];
    expect(layout.sourceSide).toBe('left');
    expect(layout.targetSide).toBe('left');
    expect(layout.auto).toBe(true);
  });

  it('blocked stub bands never persist a C whose arm runs through the other table (side by side)', async () => {
    // isga's quotas → payment_applications: a tall table, a 32px gap, aligned rows and a third table
    // below b reaching into a's right stub band. Either C would run one arm through a or b.
    const big = estimateSize(8);
    const small = estimateSize(3);
    const schema: Schema = { tables: [mkTable('public.a', 8), mkTable('public.b'), mkTable('public.c')], refs: [mkRef(ID, 'public.a', 'public.b')], groups: [] };
    const positions = new Map<string, { x: number; y: number }>([
      ['public.a', { x: 0, y: 0 }],
      ['public.b', { x: big.width + 32, y: 0 }],
      ['public.c', { x: big.width + 32, y: small.height + 16 }],
    ]);
    expect(small.height + 16).toBeLessThan(big.height);
    const { resets } = await computeEdgeOrdering({ schema, positions, existingLayouts: new Map(), preserveManual: true });
    const layout = resets.find(([id]) => id === ID)![1];
    expect(layout.sourceSide === layout.targetSide && layout.sourceSide !== undefined).toBe(false);
    const sizeOf = (n: string) => (n === 'public.a' ? big : small);
    const bboxOf = (n: string): Bbox | undefined => {
      const p = positions.get(n);
      return p ? { x: p.x, y: p.y, w: sizeOf(n).width, h: sizeOf(n).height } : undefined;
    };
    const route = routeRefs(schema.refs, bboxOf, (_t, c) => columnCenterY(Number(c.slice(1))), () => layout)[0]!;
    const crosses = (sg: EdgeRoute['segments'][number], b: Bbox) =>
      Math.min(sg.x1, sg.x2) < b.x + b.w && Math.max(sg.x1, sg.x2) > b.x && Math.min(sg.y1, sg.y2) < b.y + b.h && Math.max(sg.y1, sg.y2) > b.y;
    for (const n of ['public.a', 'public.b']) expect(route.segments.some((sg) => crosses(sg, bboxOf(n)!)), n).toBe(false);
  });

  it('intersecting tables persist nothing: render decides their C or facing connector live', async () => {
    const w = estimateSize(3).width;
    for (const b of [{ x: 120, y: 40 }, { x: w, y: 20 }, { x: 40, y: 0 }]) {
      const { resets } = await order([['public.a', { x: 0, y: 0 }], ['public.b', b]]);
      expect(resets.find(([id]) => id === ID)![1]).toEqual({});
    }
  });

  it('a fallback (no route found) persists no provisional sides', async () => {
    // Stacked so far apart that the routing window exceeds MAX_GRID_CELLS ⇒ ok:false.
    const far: Array<[string, { x: number; y: number }]> = [['public.a', { x: 0, y: 0 }], ['public.b', { x: 9000, y: 30000 }]];
    const { resets } = await order(far);
    const layout = resets.find(([id]) => id === ID)![1];
    expect(layout).toEqual({});
  });
});

describe('computeEdgeOrdering — A* output is marked auto (F20)', () => {
  it('a detour is auto, so a second preserve-manual run still re-orders it', async () => {
    const ID = 'public.a(c0)->public.b(c0)';
    const { schema, positions: entries } = obstacleSchema();
    const positions = new Map(entries);
    const first = await computeEdgeOrdering({ schema, positions, existingLayouts: new Map(), preserveManual: true });
    const layout = first.resets.find(([id]) => id === ID)![1];
    // Even the render-default right/left persists, pinned to the detour it was routed for.
    expect(layout.waypoints?.length).toBeGreaterThan(0);
    expect(layout.sourceSide).toBe('right');
    expect(layout.targetSide).toBe('left');
    expect(layout.auto).toBe(true);

    const second = await computeEdgeOrdering({ schema, positions, existingLayouts: new Map(first.resets), preserveManual: true });
    expect(second.resets.some(([id]) => id === ID)).toBe(true);
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

  it('vertically stacked tables route a right-hand C with horizontal stubs, clear of every table', async () => {
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
    expect(route.segments[0]!.axis).toBe('h');
    expect(route.segments[route.segments.length - 1]!.axis).toBe('h');
    expect(route.source.x).toBe(bboxOf('public.a')!.x + bboxOf('public.a')!.w);
    expect(route.target.x).toBe(bboxOf('public.b')!.x + bboxOf('public.b')!.w);
    expect(hasBacktrack(route)).toBe(false);
    for (const name of ['public.a', 'public.m', 'public.b']) {
      const b = bboxOf(name)!;
      const inside = route.segments.some(
        (s) => Math.min(s.x1, s.x2) < b.x + b.w && Math.max(s.x1, s.x2) > b.x && Math.min(s.y1, s.y2) < b.y + b.h && Math.max(s.y1, s.y2) > b.y,
      );
      expect(inside).toBe(false);
    }
  });
});

describe('computeEdgeOrdering → routeRefs — stacked column with a table in between', () => {
  const ID = 'public.a(c0)->public.b(c0)';
  const strictlyInside = (p: { x: number; y: number }, b: Bbox): boolean =>
    p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h;
  const crossesInterior = (s: EdgeRoute['segments'][number], b: Bbox): boolean =>
    s.axis === 'h'
      ? s.y1 > b.y && s.y1 < b.y + b.h && Math.max(s.x1, s.x2) > b.x && Math.min(s.x1, s.x2) < b.x + b.w
      : s.x1 > b.x && s.x1 < b.x + b.w && Math.max(s.y1, s.y2) > b.y && Math.min(s.y1, s.y2) < b.y + b.h;
  /** Two consecutive collinear segments pointing opposite ways (the final-leg spike). */
  const backtracks = (r: EdgeRoute): boolean =>
    r.segments.some((s, i) => {
      const prev = r.segments[i - 1];
      if (!prev || prev.axis !== s.axis) return false;
      return s.axis === 'h'
        ? Math.sign(s.x2 - s.x1) * Math.sign(prev.x2 - prev.x1) < 0
        : Math.sign(s.y2 - s.y1) * Math.sign(prev.y2 - prev.y1) < 0;
    });

  // The selfloop.dbml first-open column: a (5 cols) / m / b stacked `gap` apart (16 = smart layout's
  // gap, narrower than a stub), plus m→a sharing a's bottom port group so the a↔b port sits off-centre.
  const cols: Record<string, number> = { 'public.a': 5, 'public.m': 3, 'public.b': 3 };
  const sizeOf = (n: string) => estimateSize(cols[n]!);
  const column = (gap: number): Map<string, { x: number; y: number }> => {
    const mY = sizeOf('public.a').height + gap;
    return new Map([
      ['public.a', { x: 0, y: 0 }],
      ['public.m', { x: 0, y: mY }],
      ['public.b', { x: 0, y: mY + sizeOf('public.m').height + gap }],
    ]);
  };

  for (const gap of [16, 80]) {
    for (const [label, src, tgt] of [['upward', 'public.b', 'public.a'], ['downward', 'public.a', 'public.b']] as const) {
      it(`${label}, gap ${gap}: no waypoint inside an endpoint, no spike, nothing through the middle table`, async () => {
        const schema: Schema = {
          tables: Object.entries(cols).map(([n, c]) => mkTable(n, c)),
          refs: [mkRef(ID, src, tgt), mkRef('public.m(c0)->public.a(c0)', 'public.m', 'public.a')],
          groups: [],
        };
        const posMap = column(gap);
        const { resets } = await computeEdgeOrdering({ schema, positions: posMap, existingLayouts: new Map(), preserveManual: false });
        const layouts = new Map(resets);
        const bboxOf = (n: string): Bbox | undefined => {
          const p = posMap.get(n);
          return p ? { x: p.x, y: p.y, w: sizeOf(n).width, h: sizeOf(n).height } : undefined;
        };
        const colY = (_t: string, col: string): number | undefined => columnCenterY(Number(col.slice(1)));
        const route = routeRefs(schema.refs, bboxOf, colY, (id) => layouts.get(id)).find((r) => r.id === ID)!;
        const layout = layouts.get(ID)!;

        for (const w of layout.waypoints ?? []) {
          expect(strictlyInside(w, bboxOf(src)!)).toBe(false);
          expect(strictlyInside(w, bboxOf(tgt)!)).toBe(false);
        }
        expect(backtracks(route)).toBe(false);
        for (const name of Object.keys(cols)) {
          expect(route.segments.some((s) => crossesInterior(s, bboxOf(name)!))).toBe(false);
        }
      });
    }
  }
});

describe('computeEdgeOrdering — self-loops (spec 05 §Self-loops)', () => {
  it('leaves loops out of A*: no waypoints, sides or auto marker for them', async () => {
    const { schema, positions } = obstacleSchema();
    const loop: Ref = {
      id: 'public.a::c1|public.a::c0',
      source: { table: 'public.a', columns: ['c1'], relation: '*' },
      target: { table: 'public.a', columns: ['c0'], relation: '1' },
    };
    const ordered = await computeEdgeOrdering({
      schema: { ...schema, refs: [...schema.refs, loop] },
      positions: new Map(positions),
      existingLayouts: new Map(),
      preserveManual: false,
    });
    expect(ordered.resets.find(([id]) => id === loop.id)).toBeUndefined();
    expect(ordered.resets.length).toBeGreaterThan(0);
  });
});

describe('computeEdgeOrdering → routeRefs — the selfloop.dbml column (spec 05 §9 "Carriles")', () => {
  // employees (manager/mentor loops) / projects / departments (parent loop), stacked 16 apart as the
  // first smart layout leaves them, plus the cross refs that become right-hand Cs.
  const cols: Record<string, number> = { 'public.employees': 5, 'public.projects': 3, 'public.departments': 3 };
  const sizeOf = (n: string) => estimateSize(cols[n]!);
  const loopRef = (table: string, col: string): Ref => ({
    id: `${table}::${col}|${table}::c0`,
    source: { table, columns: [col], relation: '*' },
    target: { table, columns: ['c0'], relation: '1' },
  });
  const refs: Ref[] = [
    loopRef('public.employees', 'c1'),
    loopRef('public.employees', 'c2'),
    { id: 'emp.dept', source: { table: 'public.employees', columns: ['c3'], relation: '*' }, target: { table: 'public.departments', columns: ['c0'], relation: '1' } },
    loopRef('public.departments', 'c1'),
    { id: 'proj.owner', source: { table: 'public.projects', columns: ['c1'], relation: '*' }, target: { table: 'public.employees', columns: ['c0'], relation: '1' } },
  ];
  const schema: Schema = { tables: Object.entries(cols).map(([n, c]) => mkTable(n, c)), refs, groups: [] };

  const renderAfterOrdering = async (extra: Array<[string, { x: number; y: number }, number]> = [], extraRefs: Ref[] = []) => {
    const all = { ...cols, ...Object.fromEntries(extra.map(([n, , c]) => [n, c])) };
    const size = (n: string) => estimateSize(all[n]!);
    let y = 0;
    const positions = new Map<string, { x: number; y: number }>();
    for (const n of ['public.employees', 'public.projects', 'public.departments']) {
      positions.set(n, { x: 0, y });
      y += sizeOf(n).height + 16;
    }
    for (const [n, p] of extra) positions.set(n, p);
    const s: Schema = { ...schema, tables: Object.entries(all).map(([n, c]) => mkTable(n, c)), refs: [...refs, ...extraRefs] };
    const { resets } = await computeEdgeOrdering({ schema: s, positions, existingLayouts: new Map(), preserveManual: false });
    const layouts = new Map(resets);
    const bboxOf = (n: string): Bbox | undefined => {
      const p = positions.get(n);
      return p ? { x: p.x, y: p.y, w: size(n).width, h: size(n).height } : undefined;
    };
    const colY = (_t: string, col: string): number | undefined => columnCenterY(Number(col.slice(1)));
    const routes = routeRefs(s.refs, bboxOf, colY, (id) => layouts.get(id), undefined, () => positions.keys());
    return { routes, layouts, bboxOf, names: [...positions.keys()], refs: s.refs };
  };

  const verticalRuns = (r: EdgeRoute) =>
    r.segments.filter((sg) => sg.axis === 'v' && !sg.rigid).map((sg) => ({ id: r.id, x: sg.x1, lo: Math.min(sg.y1, sg.y2), hi: Math.max(sg.y1, sg.y2) }));
  const overlaps = (p: { lo: number; hi: number }, q: { lo: number; hi: number }) => p.lo <= q.hi && q.lo <= p.hi;

  for (const [label, extra] of [
    ['as laid out', []],
    // A table right of the column blocks proj.owner's nested trunk, so A* routes it: without the loop
    // lanes it ran up employees' mentor-loop trunk (the bug seen after "Order edges").
    ['with a blocker beside projects', [['public.blocker', { x: 280, y: 104 }, 1]]],
  ] as const) {
    it(`${label}: no route runs along a loop trunk or shares another C's trunk`, async () => {
      const { routes } = await renderAfterOrdering(extra.map(([n, p, c]) => [n, { ...p }, c]));
      const loopRuns = routes.filter((r) => r.loop).flatMap(verticalRuns);
      const otherRuns = routes.filter((r) => !r.loop).flatMap(verticalRuns);
      expect(loopRuns.length).toBe(3);
      for (const run of otherRuns) {
        for (const l of loopRuns) if (overlaps(run, l)) expect(Math.abs(run.x - l.x), `${run.id} on ${l.id}`).toBeGreaterThanOrEqual(LOOP_STEP);
        for (const o of otherRuns) {
          if (o.id !== run.id && overlaps(run, o)) expect(Math.abs(run.x - o.x), `${run.id} on ${o.id}`).toBeGreaterThanOrEqual(LOOP_STEP);
        }
      }
    });
  }

  it('a C whose nested trunk would cross a third table is pinned to the clear stub column A* found', async () => {
    // a's two loops push the render-nested trunk to w + loopReach(3) = w + 72, inside m (from w + 64);
    // the plain stub column is clear, so A* answers "straight" and the adapter must pin it there.
    const sizes: Record<string, number> = { 'public.a': 6, 'public.b': 3, 'public.m': 2 };
    const w = estimateSize(6).width;
    const h = estimateSize(6).height;
    const r: Ref[] = [
      loopRef('public.a', 'c1'),
      loopRef('public.a', 'c2'),
      { id: 'a.b', source: { table: 'public.a', columns: ['c5'], relation: '*' }, target: { table: 'public.b', columns: ['c0'], relation: '1' } },
    ];
    // n, left of the column between a and b, blocks the mirrored C, so render cannot flip it either.
    const positions = new Map([
      ['public.a', { x: 0, y: 0 }],
      ['public.m', { x: w + 64, y: h + 60 }],
      ['public.n', { x: -estimateSize(2).width - 8, y: h + 60 }],
      ['public.b', { x: 0, y: h + 240 }],
    ]);
    const { resets } = await computeEdgeOrdering({
      schema: { tables: Object.entries({ ...sizes, 'public.n': 2 }).map(([n, c]) => mkTable(n, c)), refs: r, groups: [] },
      positions,
      existingLayouts: new Map(),
      preserveManual: false,
    });
    const layout = new Map(resets).get('a.b')!;
    expect(layout).toMatchObject({ sourceSide: 'right', targetSide: 'right', auto: true });
    expect(layout.waypoints!.length).toBeGreaterThan(0);
    for (const wp of layout.waypoints!) expect(wp.x).toBeLessThan(w + 64 - 16);
  });

  it('a neighbour column at the default 64 px gap: no persisted or drawn C segment crosses a third table', async () => {
    // The run-dddbml "nb" fixture: audit right of the column, fed by a departments→audit Z. On the
    // right the Cs' nested trunks (w + 72 and beyond) would run under audit; the left is clear.
    const w = estimateSize(5).width;
    const audit: Ref = { id: 'dept.audit', source: { table: 'public.departments', columns: ['c2'], relation: '*' }, target: { table: 'public.audit', columns: ['c0'], relation: '1' } };
    const { routes, layouts, bboxOf, names, refs: all } = await renderAfterOrdering([['public.audit', { x: w + 64, y: 0 }, 12]], [audit]);
    for (const id of ['emp.dept', 'proj.owner']) {
      expect(layouts.get(id)).toEqual({});
      const rt = routes.find((r) => r.id === id)!;
      const ref = all.find((r) => r.id === id)!;
      expect(rt.sourceStub.x).toBeLessThan(rt.source.x);
      for (const n of names) {
        if (n === ref.source.table || n === ref.target.table) continue;
        const o = bboxOf(n)!;
        for (const sg of rt.segments) {
          const hit = Math.min(sg.x1, sg.x2) < o.x + o.w && Math.max(sg.x1, sg.x2) > o.x && Math.min(sg.y1, sg.y2) < o.y + o.h && Math.max(sg.y1, sg.y2) > o.y;
          expect(hit, `${id} through ${n}`).toBe(false);
        }
      }
    }
  });

  it('the clear Cs stay waypoint-less and render outside every loop of their tables', async () => {
    const { routes, layouts } = await renderAfterOrdering();
    const w = estimateSize(5).width;
    for (const id of ['emp.dept', 'proj.owner']) {
      expect(layouts.get(id)).toEqual({});
      const trunk = verticalRuns(routes.find((r) => r.id === id)!);
      expect(trunk).toHaveLength(1);
      expect(trunk[0]!.x).toBeGreaterThanOrEqual(w + loopReach(3));
    }
  });
});

describe('computeEdgeOrdering — narrow-gap S (spec 05 §1, §9)', () => {
  const ID = 'public.a(c0)->public.b(c0)';
  const { width: w, height: h } = estimateSize(3);
  const rowOff = columnCenterY(0);
  const hasBacktrack = (r: EdgeRoute): boolean =>
    r.segments.some((s, i) => {
      const prev = r.segments[i - 1];
      if (!prev || prev.axis !== s.axis) return false;
      return s.axis === 'h'
        ? Math.sign(s.x2 - s.x1) * Math.sign(prev.x2 - prev.x1) < 0
        : Math.sign(s.y2 - s.y1) * Math.sign(prev.y2 - prev.y1) < 0;
    });
  const crosses = (s: EdgeRoute['segments'][number], b: Bbox) =>
    Math.min(s.x1, s.x2) < b.x + b.w && Math.max(s.x1, s.x2) > b.x && Math.min(s.y1, s.y2) < b.y + b.h && Math.max(s.y1, s.y2) > b.y;

  const run = async (names: string[], at: Record<string, { x: number; y: number }>) => {
    const schema: Schema = { tables: names.map((n) => mkTable(`public.${n}`)), refs: [mkRef(ID, 'public.a', 'public.b')], groups: [] };
    const positions = new Map(names.map((n) => [`public.${n}`, at[n]!] as [string, { x: number; y: number }]));
    const { resets } = await computeEdgeOrdering({ schema, positions, existingLayouts: new Map(), preserveManual: true });
    const layout = resets.find(([id]) => id === ID)![1];
    const bboxOf = (n: string): Bbox | undefined => {
      const p = positions.get(n);
      return p ? bboxAt(p.x, p.y) : undefined;
    };
    const route = routeRefs(schema.refs, bboxOf, () => rowOff, () => layout)[0]!;
    return { layout, route, bboxOf };
  };

  it('a clear S skips A* and persists nothing, so render draws the full-stub S', async () => {
    const { layout, route } = await run(['a', 'b'], { a: { x: 0, y: 0 }, b: { x: w + 10, y: h + 200 } });
    expect(layout).toEqual({});
    expect(route.sourceStub).toEqual({ x: w + 24, y: rowOff });
    expect(route.targetStub).toEqual({ x: w + 10 - 24, y: h + 200 + rowOff });
    expect(route.segments.filter((s) => !s.rigid).map((s) => s.axis)).toEqual(['v', 'h', 'v']);
  });

  it('an S through a third table is routed by A* between the full stubs, never inside a table or back over a stub', async () => {
    // m straddles both of the S's vertical runs between the port rows.
    const at = { a: { x: 0, y: 0 }, b: { x: w + 10, y: 2 * h + 240 }, m: { x: w - 80, y: h + 80 } };
    const { layout, route, bboxOf } = await run(['a', 'b', 'm'], at);
    expect(layout.waypoints?.length).toBeGreaterThan(0);
    expect(layout.sourceSide).toBe('right');
    expect(layout.targetSide).toBe('left');
    expect(layout.auto).toBe(true);
    expect(route.sourceStub).toEqual({ x: w + 24, y: rowOff });
    expect(route.targetStub).toEqual({ x: w + 10 - 24, y: 2 * h + 240 + rowOff });
    expect(hasBacktrack(route)).toBe(false);
    for (const n of ['public.a', 'public.b', 'public.m']) {
      expect(route.segments.some((s) => crosses(s, bboxOf(n)!)), n).toBe(false);
    }
  });

  it('packed side by side (gap 16, rows overlapping): no S hidden inside the tables after ordering', async () => {
    const { route, bboxOf } = await run(['a', 'b'], { a: { x: 0, y: 0 }, b: { x: w + 16, y: Math.round(h / 2) } });
    expect(route.sourceStub.x).toBeLessThan(w + 16);
    for (const n of ['public.a', 'public.b']) {
      expect(route.segments.some((s) => crosses(s, bboxOf(n)!)), n).toBe(false);
    }
  });

  it('packed one above the other: the S jogs in the 16px vertical gap and persists nothing', async () => {
    const { layout, route, bboxOf } = await run(['a', 'b'], { a: { x: 0, y: 0 }, b: { x: w + 16, y: h + 16 } });
    expect(layout).toEqual({});
    expect(route.sourceStub).toEqual({ x: w + 24, y: rowOff });
    expect(route.segments[2]!.y1).toBe(h + 8);
    for (const n of ['public.a', 'public.b']) {
      expect(route.segments.some((s) => crosses(s, bboxOf(n)!)), n).toBe(false);
    }
  });
});

describe('computeEdgeOrdering — intersecting tables (spec 05 §1)', () => {
  it('the left C render picks for an overlap persists nothing and stays the left C on render', async () => {
    const ID = 'public.a(c2)->public.b(c0)';
    const ref: Ref = { id: ID, source: { table: 'public.a', columns: ['c2'], relation: '*' }, target: { table: 'public.b', columns: ['c0'], relation: '1' } };
    const schema: Schema = { tables: [mkTable('public.a'), mkTable('public.b')], refs: [ref], groups: [] };
    const { height: h } = estimateSize(3);
    // b overlaps a's lower right: a's row runs through b (right C crosses it), b's row sits below a.
    const b = { x: 60, y: h - columnCenterY(0) + 5 };
    expect(b.y).toBeLessThan(columnCenterY(2));
    const positions = new Map([['public.a', { x: 0, y: 0 }], ['public.b', b]]);
    const { resets } = await computeEdgeOrdering({ schema, positions, existingLayouts: new Map(), preserveManual: true });
    const layout = resets.find(([id]) => id === ID)![1];
    expect(layout).toEqual({});
    const bboxOf = (n: string): Bbox | undefined => {
      const p = positions.get(n);
      return p ? bboxAt(p.x, p.y) : undefined;
    };
    const colY = (_t: string, c: string) => columnCenterY(Number(c.slice(1)));
    const route = routeRefs(schema.refs, bboxOf, colY, () => layout)[0]!;
    expect(route.source.x).toBe(0);
    expect(route.target.x).toBe(60);
    expect(route.sourceStub.x).toBe(-24);
  });
});
