import { describe, expect, it } from 'vitest';
import type { Dep, EdgeLayout, GroupLayout, QualifiedName, Ref, Schema, Table } from '../../shared/types';
import { buildRowGeometry, fkColumnsByTable } from '../layout/tableRows';
import { store } from '../state/store';
import { SceneCache, type Scene, type SceneInputs } from './sceneCache';

// 30 tables: g0 expanded (t0-t9), g1 collapsed (t10-t14), g2 hidden (t15-t19), t20-t29 ungrouped
// with t25 individually hidden. Rows follow the PK/FK-only view, so sizes differ per table.
function fixture(): { schema: Schema; groupState: Record<string, GroupLayout>; hidden: Set<QualifiedName> } {
  const groupOf = (i: number) => (i < 10 ? 'g0' : i < 15 ? 'g1' : i < 20 ? 'g2' : null);
  const tables: Table[] = Array.from({ length: 30 }, (_, i) => ({
    name: `t${i}`,
    schemaName: 'public',
    tableName: `t${i}`,
    groupName: groupOf(i),
    columns: [
      { name: 'id', type: 'int', pk: true },
      ...Array.from({ length: (i % 4) + 1 }, (_, c) => ({ name: `fk${c}`, type: 'int' })),
      ...Array.from({ length: i % 3 }, (_, c) => ({ name: `note${c}`, type: 'text' })),
    ],
  }));
  let seed = 3;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor((seed / 2147483648) * n);
  };
  const refs: Ref[] = Array.from({ length: 40 }, (_, i) => {
    const s = rand(30);
    const t = rand(30);
    return {
      id: `r${i}`,
      source: { table: `t${s}`, columns: [`fk${i % 4 > s % 4 ? 0 : i % 4}`], relation: '*' },
      target: { table: `t${t}`, columns: ['id'], relation: '1' },
    };
  });
  const groups = ['g0', 'g1', 'g2'].map((g) => ({ name: g, tables: tables.filter((t) => t.groupName === g).map((t) => t.name) }));
  // Deps reach into the collapsed (t12) and hidden (t17) groups too, like refs.
  const deps: Dep[] = [{
    name: null,
    edges: Array.from({ length: 16 }, (_, i) => {
      const up = i === 0 ? 12 : i === 1 ? 17 : i === 2 ? 3 : rand(30);
      const down = i === 2 ? 27 : rand(30);
      return { id: `d${i}`, upstream: { table: `t${up}`, columns: [] }, downstream: { table: `t${down}`, columns: i % 2 ? ['id'] : [] } };
    }),
  }];
  return {
    schema: { tables, refs, groups, deps },
    groupState: { g1: { collapsed: true }, g2: { hidden: true } },
    hidden: new Set(['t25']),
  };
}

function indexDump(scene: Scene): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const names = [...scene.spatialIndex.query({ x: -20000, y: -20000, w: 40000, h: 40000 })].sort();
  for (const n of names) out[n] = scene.spatialIndex.getBbox(n);
  return out;
}

function expectSameScene(inc: Scene, full: Scene): void {
  expect(inc.derived.containers).toEqual(full.derived.containers);
  expect(inc.derived.exportContainers).toEqual(full.derived.exportContainers);
  expect(inc.derived.collapsedNodes).toEqual(full.derived.collapsedNodes);
  expect(inc.derived.effectiveRefs).toEqual(full.derived.effectiveRefs);
  expect(inc.derived.effectiveDeps).toEqual(full.derived.effectiveDeps);
  expect(inc.edgeBoxes).toEqual(full.edgeBoxes);
  expect(inc.worldBbox).toEqual(full.worldBbox);
  expect(indexDump(inc)).toEqual(indexDump(full));
}

describe('SceneCache — incremental drag frames', () => {
  const { schema, groupState, hidden } = fixture();
  const tablesByName = new Map(schema.tables.map((t) => [t.name, t]));
  const rows = buildRowGeometry({ tables: schema.tables, showOnlyPkFk: true, fkColumnsByTable: fkColumnsByTable(schema.refs) });
  const edgeLayouts = new Map<string, EdgeLayout>([['t3::fk1|t7::id', { waypoints: [{ x: -900, y: 40 }, { x: -900, y: 300 }] }]]);
  const firstDep = schema.deps![0]!.edges[2]!;
  const depWaypointKey = `dep:${firstDep.upstream.table}::|${firstDep.downstream.table}::`;
  edgeLayouts.set(depWaypointKey, { waypoints: [{ x: -1200, y: -700 }] });
  const inputsFor = (positions: ReadonlyMap<QualifiedName, { x: number; y: number }>, showDeps = true): SceneInputs => ({
    schema,
    positions,
    groupState,
    individuallyHidden: hidden,
    tablesByName,
    rows,
    edgeLayouts,
    density: 'cozy',
    showDeps,
  });
  const start = () => {
    const positions = new Map<QualifiedName, { x: number; y: number }>();
    schema.tables.forEach((t, i) => positions.set(t.name, { x: (i % 6) * 320, y: Math.floor(i / 6) * 260 }));
    store.setState({ positions });
    return positions;
  };
  const draggable = schema.tables.map((t) => t.name).filter((n) => {
    const i = Number(n.slice(1));
    return !(i >= 10 && i < 20) && n !== 't25';
  });

  it('moves entries of the same index and keeps the remapped refs, matching a full rebuild', () => {
    const cache = new SceneCache();
    const first = cache.update(inputsFor(start()));
    const version = first.spatialIndex.version;
    store.getState().setPositionsBatch([['t4', { x: 700, y: 900 }]]);
    const inc = cache.update(inputsFor(store.getState().positions));
    expect(inc.spatialIndex).toBe(first.spatialIndex);
    expect(inc.spatialIndex.version).not.toBe(version);
    expect(inc.derived.effectiveRefs).toBe(first.derived.effectiveRefs);
    expect(inc.derived.collapsedNodes).toBe(first.derived.collapsedNodes);
    expectSameScene(inc, new SceneCache().update(inputsFor(store.getState().positions)));
  });

  it('shrinks the world bbox when the outermost table is dragged inward', () => {
    const cache = new SceneCache();
    cache.update(inputsFor(start()));
    store.getState().setPositionsBatch([['t29', { x: 4000, y: 4000 }]]);
    const out = cache.update(inputsFor(store.getState().positions));
    store.getState().setPositionsBatch([['t29', { x: 300, y: 300 }]]);
    const back = cache.update(inputsFor(store.getState().positions));
    expect(back.worldBbox.w).toBeLessThan(out.worldBbox.w);
    expectSameScene(back, new SceneCache().update(inputsFor(store.getState().positions)));
  });

  it('matches a full rebuild over random drags, several commits per render and a collapsed-member move', () => {
    let seed = 11;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor((seed / 2147483648) * n);
    };
    const cache = new SceneCache();
    cache.update(inputsFor(start()));
    for (let step = 0; step < 150; step++) {
      const commits = 1 + rand(2);
      for (let c = 0; c < commits; c++) {
        const entries: Array<[QualifiedName, { x: number; y: number }]> = [];
        const k = 1 + rand(3);
        for (let j = 0; j < k; j++) {
          // Step 60 also drags a collapsed group's member: not a plain move, must fall back cleanly.
          const name = step === 60 && j === 0 ? 't12' : draggable[rand(draggable.length)]!;
          const p = store.getState().positions.get(name)!;
          entries.push([name, { x: p.x + rand(1400) - 700, y: p.y + rand(1000) - 500 }]);
        }
        store.getState().setPositionsBatch(entries);
      }
      const positions = store.getState().positions;
      expectSameScene(cache.update(inputsFor(positions)), new SceneCache().update(inputsFor(positions)));
    }
  });

  it('boxes shown deps (waypoints included) and moves their boxes with a dragged endpoint', () => {
    const cache = new SceneCache();
    const first = cache.update(inputsFor(start()));
    const depBox = first.edgeBoxes.find((b) => b.id === depWaypointKey);
    expect(depBox?.bbox.x).toBe(-1200);
    expect(first.worldBbox.x).toBeLessThanOrEqual(-1200);
    const moved = firstDep.downstream.table;
    const p = store.getState().positions.get(moved)!;
    store.getState().setPositionsBatch([[moved, { x: p.x + 40, y: p.y + 7000 }]]);
    const inc = cache.update(inputsFor(store.getState().positions));
    expect(inc.spatialIndex).toBe(first.spatialIndex);
    expect(inc.edgeBoxes.find((b) => b.id === depWaypointKey)!.bbox.h).toBeGreaterThan(depBox!.bbox.h);
    expectSameScene(inc, new SceneCache().update(inputsFor(store.getState().positions)));
  });

  it('gives hidden deps no culling box', () => {
    const scene = new SceneCache().update(inputsFor(start(), false));
    expect(scene.derived.effectiveDeps.length).toBeGreaterThan(0);
    expect(scene.edgeBoxes.some((b) => b.id.startsWith('dep:'))).toBe(false);
  });
});
