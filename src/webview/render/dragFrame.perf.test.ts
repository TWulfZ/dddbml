import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDbml } from '../../extension/parser';
import type { EdgeLayout, QualifiedName, Schema, Table } from '../../shared/types';
import { columnCenterY, estimateSize } from '../layout/autoLayout';
import { buildRowGeometry, fkColumnsByTable } from '../layout/tableRows';
import { store } from '../state/store';
import { smallPositionsDelta } from '../state/positionsDelta';
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
  const inputsFor = (positions: ReadonlyMap<QualifiedName, { x: number; y: number }>): SceneInputs => ({
    schema, positions, groupState, individuallyHidden, tablesByName, rows, edgeLayouts, density: 'cozy', showDeps: true,
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
  // A table with refs at both ends of a group, so its container and port groups change every frame.
  const dragged = schema.refs[0]!.source.table;
  const selection = schema.tables.slice(2000, 2050).map((t) => t.name);

  function run(names: readonly QualifiedName[], incremental: boolean): Stats {
    store.setState({ positions: new Map(start) });
    const scenes = new SceneCache();
    const router = new EdgeRouteCache();
    let scene = scenes.update(inputsFor(store.getState().positions));
    router.routeAll(scene.derived.effectiveRefs, bboxOf, columnY, layoutOf);
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
      scene = (incremental ? scenes : new SceneCache()).update(inputsFor(positions));
      const moved = incremental ? smallPositionsDelta(rendered, positions) : null;
      const routes = moved
        ? router.routeMoved(moved, bboxOf, columnY, layoutOf)
        : router.routeAll(scene.derived.effectiveRefs, bboxOf, columnY, layoutOf);
      rendered = positions;
      scene.spatialIndex.query(camera);
      visibleEdgeIds(scene.edgeBoxes, camera);
      samples.push(performance.now() - t0);
      expect(routes.length).toBeGreaterThan(0);
    }
    return stats(samples);
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
});
