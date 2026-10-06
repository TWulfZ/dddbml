import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDbml } from '../../extension/parser';
import type { Dep, EdgeLayout, QualifiedName, Ref, Schema, Table } from '../../shared/types';
import { columnCenterY, estimateSize } from '../layout/autoLayout';
import { buildRowGeometry, fkColumnsByTable } from '../layout/tableRows';
import { store } from '../state/store';
import { smallPositionsDelta } from '../state/positionsDelta';
import { headerCenterY } from '../layout/autoLayout';
import { DepRouteCache } from './depRouter';
import { EdgeRouteCache } from './edgeRouter';
import { SceneCache, type SceneInputs } from './sceneCache';
import type { Bbox } from './spatialIndex';
import { visibleEdgeIds } from './useVisibleNames';

/**
 * Per-frame JS work of a table drag on the huge fixture (5000 tables / 1000 refs, 20 expanded
 * groups): store commit + scene (geometry, spatial index, edge boxes, world bbox) + routing + the two
 * culling queries — everything that runs before Preact diffs. Spec 07 budgets the whole drag frame
 * at 16.7 ms; this slice must leave most of it to Preact and paint (numbers in spec 04/07).
 */

function load(): Schema {
  const res = parseDbml(readFileSync(resolve(process.cwd(), 'test/fixtures/huge.dbml'), 'utf8'));
  if (!res.schema) throw new Error(res.error.message);
  return res.schema;
}

interface Stats { mean: number; p95: number }

function stats(samples: number[]): Stats {
  const s = samples.slice(10).sort((a, b) => a - b);
  return { mean: s.reduce((a, b) => a + b, 0) / s.length, p95: s[Math.floor(s.length * 0.95)]! };
}

describe('drag frame — per-frame JS budget (huge.dbml)', () => {
  const schema = load();
  const tablesByName = new Map<QualifiedName, Table>(schema.tables.map((t) => [t.name, t]));
  const rows = buildRowGeometry({ tables: schema.tables, showOnlyPkFk: false, fkColumnsByTable: fkColumnsByTable(schema.refs) });
  const edgeLayouts = new Map<string, EdgeLayout>();
  const groupState = {};
  const individuallyHidden = new Set<QualifiedName>();
  const cols = Math.ceil(Math.sqrt(schema.tables.length));
  const start = new Map<QualifiedName, { x: number; y: number }>();
  [...schema.tables]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .forEach((t, i) => start.set(t.name, { x: (i % cols) * 300, y: Math.floor(i / cols) * 260 }));
  // huge.dbml has no Dep blocks: add as many dep edges as it has refs, a few on the dragged table.
  const withDeps: Schema = { ...schema, deps: [syntheticDeps(schema, schema.refs.length)] };
  const inputsFor = (positions: ReadonlyMap<QualifiedName, { x: number; y: number }>, s: Schema = schema): SceneInputs => ({
    schema: s, positions, groupState, individuallyHidden, tablesByName, rows, edgeLayouts, density: 'cozy', showDeps: true,
  });
  const bboxOf = (n: QualifiedName): Bbox | undefined => {
    const p = store.getState().positions.get(n);
    if (!p) return undefined;
    const s = estimateSize(rows.count(n));
    return { x: p.x, y: p.y, w: s.width, h: s.height };
  };
  const columnY = (t: QualifiedName, c: string) => {
    const i = rows.indexOf(t, c);
    return i < 0 ? undefined : columnCenterY(i);
  };
  const layoutOf = (id: string) => edgeLayouts.get(id);
  const portY = (t: QualifiedName, c: readonly string[], b: Bbox) => b.y + ((c[0] ? columnY(t, c[0]) : undefined) ?? headerCenterY());
  // A table with refs at both ends of a group, so its container and port groups change every frame.
  const dragged = schema.refs[0]!.source.table;
  const selection = schema.tables.slice(2000, 2050).map((t) => t.name);
  const sortedNames = [...start.keys()];
  const withLoops: Schema = { ...schema, refs: [...schema.refs, ...syntheticLoops(sortedNames, cols, [dragged, ...selection])] };

  function run(names: readonly QualifiedName[], incremental: boolean, s: Schema = schema): Stats & { router: EdgeRouteCache } {
    store.setState({ positions: new Map(start) });
    const scenes = new SceneCache();
    const router = new EdgeRouteCache();
    const depRouter = new DepRouteCache();
    let scene = scenes.update(inputsFor(store.getState().positions, s));
    // As app.tsx wires it: every drag frame re-checks the automatic Cs against their neighbours.
    const obstacles = (box: Bbox) => scene.spatialIndex.query(box);
    router.routeAll(scene.derived.effectiveRefs, bboxOf, columnY, layoutOf, undefined, obstacles);
    depRouter.routeAll(scene.derived.effectiveDeps, bboxOf, portY, layoutOf);
    let rendered = store.getState().positions;
    const camera = { x: 0, y: 0, w: 1920, h: 1080 };
    const samples: number[] = [];
    for (let f = 1; f <= 160; f++) {
      const t0 = performance.now();
      const entries: Array<[QualifiedName, { x: number; y: number }]> = names.map((n) => {
        const p = start.get(n)!;
        return [n, { x: p.x + f * 7, y: p.y + f * 3 }];
      });
      store.getState().setPositionsBatch(entries);
      const positions = store.getState().positions;
      scene = (incremental ? scenes : new SceneCache()).update(inputsFor(positions, s));
      const moved = incremental ? smallPositionsDelta(rendered, positions) : null;
      const routes = moved
        ? router.routeMoved(moved, bboxOf, columnY, layoutOf)
        : router.routeAll(scene.derived.effectiveRefs, bboxOf, columnY, layoutOf, undefined, obstacles);
      const depRoutes = moved
        ? depRouter.routeMoved(moved, bboxOf, portY, layoutOf)
        : depRouter.routeAll(scene.derived.effectiveDeps, bboxOf, portY, layoutOf);
      rendered = positions;
      scene.spatialIndex.query(camera);
      visibleEdgeIds(scene.edgeBoxes, camera);
      samples.push(performance.now() - t0);
      expect(routes.length).toBeGreaterThan(0);
      expect(depRoutes.length).toBe(scene.derived.effectiveDeps.length);
    }
    return { ...stats(samples), router };
  }

  it('single-table drag frame stays a small slice of the 16.7 ms frame', () => {
    const full = run([dragged], false);
    const inc = run([dragged], true);
    console.log(`drag 1 table: full mean ${full.mean.toFixed(2)} ms p95 ${full.p95.toFixed(2)} | incremental mean ${inc.mean.toFixed(2)} ms p95 ${inc.p95.toFixed(2)}`);
    expect(inc.mean).toBeLessThan(full.mean / 2);
    expect(inc.mean).toBeLessThan(4);
  });

  it('50-table multi-drag frame stays a small slice of the 16.7 ms frame', () => {
    const full = run(selection, false);
    const inc = run(selection, true);
    console.log(`drag 50 tables: full mean ${full.mean.toFixed(2)} ms p95 ${full.p95.toFixed(2)} | incremental mean ${inc.mean.toFixed(2)} ms p95 ${inc.p95.toFixed(2)}`);
    expect(inc.mean).toBeLessThan(full.mean / 2);
    expect(inc.mean).toBeLessThan(4);
  });

  it('dep edges ride the same incremental path (as many deps as refs)', () => {
    const full = run([dragged], false, withDeps);
    const inc = run([dragged], true, withDeps);
    const fullMulti = run(selection, false, withDeps);
    const incMulti = run(selection, true, withDeps);
    console.log(`drag 1 table + ${withDeps.deps![0]!.edges.length} deps: full mean ${full.mean.toFixed(2)} ms p95 ${full.p95.toFixed(2)} | incremental mean ${inc.mean.toFixed(2)} ms p95 ${inc.p95.toFixed(2)}`);
    console.log(`drag 50 tables + deps: full mean ${fullMulti.mean.toFixed(2)} ms p95 ${fullMulti.p95.toFixed(2)} | incremental mean ${incMulti.mean.toFixed(2)} ms p95 ${incMulti.p95.toFixed(2)}`);
    expect(inc.mean).toBeLessThan(full.mean / 2);
    expect(inc.mean).toBeLessThan(4);
    expect(incMulti.mean).toBeLessThan(4);
  });

  it('a loop-heavy diagram (stacks beside facing Zs) keeps the incremental frame cheap', () => {
    const full = run([dragged], false, withLoops);
    const inc = run([dragged], true, withLoops);
    const fullMulti = run(selection, false, withLoops);
    const incMulti = run(selection, true, withLoops);
    const loops = withLoops.refs.length - schema.refs.length;
    console.log(`drag 1 table + ${loops} synthetic loops/Zs (${inc.router.claimCount} lane claims): full mean ${full.mean.toFixed(2)} ms p95 ${full.p95.toFixed(2)} | incremental mean ${inc.mean.toFixed(2)} ms p95 ${inc.p95.toFixed(2)}`);
    console.log(`drag 50 tables + loops/Zs: full mean ${fullMulti.mean.toFixed(2)} ms p95 ${fullMulti.p95.toFixed(2)} | incremental mean ${incMulti.mean.toFixed(2)} ms p95 ${incMulti.p95.toFixed(2)}`);
    // The scenario must exercise the lane claims, or it measures nothing new.
    expect(inc.router.claimCount).toBeGreaterThan(100);
    expect(inc.mean).toBeLessThan(full.mean / 2);
    expect(inc.mean).toBeLessThan(4);
    // Most of a 50-table frame is the per-stack neighbour query over ~1000 stacks and the full
    // re-nest, both predating lane claims (spec 07 "Regresiones conocidas": ~6 ms before claims).
    expect(incMulti.mean).toBeLessThan(fullMulti.mean / 4);
    expect(incMulti.mean).toBeLessThan(5);
  });
});

/**
 * Loop stacks on every 5th table of the grid (2 loops on every 10th, else 1), plus the dragged and
 * selected tables, each with a facing Z from its right neighbour to the table below it: the Z runs
 * through the column gap beside the stack, the case where loops may yield a lane (spec 05 §Self-loops).
 */
function syntheticLoops(names: readonly QualifiedName[], cols: number, extra: readonly QualifiedName[]): Ref[] {
  const out: Ref[] = [];
  const at = new Map(names.map((n, i) => [n, i]));
  const stacked = new Set<number>();
  names.forEach((_, i) => { if (i % 5 === 0) stacked.add(i); });
  for (const n of extra) stacked.add(at.get(n)!);
  const ref = (id: string, s: QualifiedName, sc: string, t: QualifiedName, tc: string): Ref =>
    ({ id, source: { table: s, columns: [sc], relation: '*' }, target: { table: t, columns: [tc], relation: '1' } });
  for (const i of stacked) {
    const t = names[i]!;
    out.push(ref(`loopA${i}`, t, 'name', t, 'id'));
    if (i % 10 === 0) out.push(ref(`loopB${i}`, t, 'status', t, 'id'));
    const right = names[i + 1];
    const below = names[i + cols];
    if (right && below && (i + 1) % cols !== 0) out.push(ref(`z${i}`, right, 'parent_id', below, 'id'));
  }
  return out;
}

/** Deterministic dep edges, half column-level; the first few start at the dragged table. */
function syntheticDeps(schema: Schema, count: number): Dep {
  const tables = schema.tables;
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor((seed / 2147483648) * n);
  };
  const dragged = schema.refs[0]!.source.table;
  const edges = Array.from({ length: count }, (_, i) => {
    const up = i < 5 ? tables.find((t) => t.name === dragged)! : tables[rand(tables.length)]!;
    const down = tables[rand(tables.length)]!;
    const cols = i % 2 === 1;
    return {
      id: `syn${i}`,
      upstream: { table: up.name, columns: cols ? [up.columns[0]!.name] : [] },
      downstream: { table: down.name, columns: cols ? [down.columns[0]!.name] : [] },
    };
  });
  return { name: null, edges };
}
