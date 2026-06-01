import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDbml } from '../../../extension/parser';
import type { QualifiedName, Schema } from '../../../shared/types';
import type { Bbox } from '../../render/spatialIndex';
import { SpatialIndex } from '../../render/spatialIndex';
import { orderEdges, chooseSides4, type OrderEdgeInput } from './astar';
import { GRID_MARGIN } from './constants';

/**
 * Perf budget for the on-demand A* edge router on the huge fixture (~5000 tables / ~1000 refs),
 * analogous to spec 07's dagre `<3000ms`. Validates the yield + per-edge node-cap mitigations and
 * the headline obstacle-avoidance invariant AT SCALE (not just on a toy fixture).
 */

function load(name: string): Schema {
  const src = readFileSync(resolve(process.cwd(), 'test/fixtures', name), 'utf8');
  const res = parseDbml(src);
  if (!res.schema) throw new Error(res.error.message);
  return res.schema;
}

const W = 240;
const hOf = (cols: number): number => 28 + cols * 20 + 8;

/**
 * Build a DENSE deterministic grid of fixed positions (NOT dagre — dagre spreads the huge fixture so
 * far apart no edge ever needs to detour, which makes the obstacle/cap assertions vacuous and the
 * budget trivial). A packed grid forces real obstacle avoidance: this is the worst case the <3s
 * budget must hold for. Tables are placed in id-order; tight gaps guarantee intervening obstacles.
 */
function buildInputs(schema: Schema): {
  edges: OrderEdgeInput[];
  bboxes: Map<QualifiedName, Bbox>;
  index: SpatialIndex;
} {
  const colCount = new Map<QualifiedName, number>();
  for (const t of schema.tables) colCount.set(t.name, t.columns.length);

  const GAP = 48; // tight: leaves a routable corridor but forces detours around neighbours
  const cols = Math.ceil(Math.sqrt(schema.tables.length));
  const rowH = hOf(8) + GAP; // uniform row pitch (deterministic)
  const positions = new Map<QualifiedName, { x: number; y: number }>();
  const ordered = [...schema.tables].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  ordered.forEach((t, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    positions.set(t.name, { x: c * (W + GAP), y: r * rowH });
  });

  const bboxes = new Map<QualifiedName, Bbox>();
  const index = new SpatialIndex();
  for (const t of schema.tables) {
    const p = positions.get(t.name);
    if (!p) continue;
    const b: Bbox = { x: p.x, y: p.y, w: W, h: hOf(colCount.get(t.name) ?? 0) };
    bboxes.set(t.name, b);
    index.insert(t.name, b);
  }

  // Synthesize stubs at the chosen-side midpoints (the perf test exercises the engine, not routeRefs).
  const edges: OrderEdgeInput[] = [];
  const refs = [...schema.refs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of refs) {
    const sb = bboxes.get(r.source.table);
    const tb = bboxes.get(r.target.table);
    if (!sb || !tb) continue;
    const { sourceSide, targetSide } = chooseSides4(sb, tb);
    const stubOf = (b: Bbox, side: ReturnType<typeof chooseSides4>['sourceSide']) => {
      switch (side) {
        case 'left': return { x: b.x - 24, y: b.y + b.h / 2 };
        case 'right': return { x: b.x + b.w + 24, y: b.y + b.h / 2 };
        case 'top': return { x: b.x + b.w / 2, y: b.y - 24 };
        case 'bottom': return { x: b.x + b.w / 2, y: b.y + b.h + 24 };
      }
    };
    edges.push({
      refId: r.id,
      sourceStub: stubOf(sb, sourceSide),
      targetStub: stubOf(tb, targetSide),
      sourceTable: sb,
      targetTable: tb,
      sourceTableName: r.source.table,
      targetTableName: r.target.table,
      sourceSide,
      targetSide,
    });
  }
  return { edges, bboxes, index };
}

function obstaclesFor(index: SpatialIndex) {
  return (win: Bbox, a: QualifiedName, b: QualifiedName): Bbox[] => {
    const out: Bbox[] = [];
    for (const name of index.query(win)) {
      if (name === a || name === b) continue;
      const bb = index.getBbox(name);
      if (bb) out.push(bb);
    }
    return out;
  };
}

function segIntersects(p: { x: number; y: number }, q: { x: number; y: number }, b: Bbox): boolean {
  const x0 = Math.min(p.x, q.x), x1 = Math.max(p.x, q.x);
  const y0 = Math.min(p.y, q.y), y1 = Math.max(p.y, q.y);
  return x0 < b.x + b.w && x1 > b.x && y0 < b.y + b.h && y1 > b.y;
}

describe('A* edge router — perf budget (huge.dbml)', () => {
  const schema = load('huge.dbml');
  const { edges, bboxes, index } = buildInputs(schema);

  it('routes ~1000 refs over ~5000 tables in under 3000ms (with yield + node cap)', async () => {
    expect(edges.length).toBeGreaterThan(500); // guard: the fixture really is large
    const t0 = performance.now();
    const routed = await orderEdges(edges, { obstaclesFor: obstaclesFor(index) });
    const dt = performance.now() - t0;
    expect(routed.length).toBe(edges.length);
    expect(dt).toBeLessThan(3000);
  });

  it('honors a low node cap (some edges fall back to []) and stays under budget', async () => {
    const t0 = performance.now();
    const routed = await orderEdges(edges, { obstaclesFor: obstaclesFor(index), maxExplored: 50 });
    const dt = performance.now() - t0;
    const fallbacks = routed.filter((r) => !r.ok);
    expect(fallbacks.length).toBeGreaterThan(0); // the cap bit somewhere
    for (const f of fallbacks) expect(f.waypoints).toEqual([]); // graceful degrade
    expect(dt).toBeLessThan(3000);
  });

  it('no routed (non-fallback) segment intersects an obstacle bbox — at scale', async () => {
    const routed = await orderEdges(edges, { obstaclesFor: obstaclesFor(index) });
    const byId = new Map(edges.map((e) => [e.refId, e]));
    let checked = 0;
    for (const r of routed) {
      if (!r.ok || r.waypoints.length === 0) continue;
      const ep = byId.get(r.refId)!;
      const corners = [ep.sourceStub, ...r.waypoints, ep.targetStub];
      const obstacles = obstaclesFor(index)(
        { x: Math.min(ep.sourceTable.x, ep.targetTable.x) - GRID_MARGIN, y: Math.min(ep.sourceTable.y, ep.targetTable.y) - GRID_MARGIN, w: 4000, h: 4000 },
        ep.sourceTableName,
        ep.targetTableName,
      );
      for (let i = 1; i < corners.length; i++) {
        for (const o of obstacles) {
          if (segIntersects(corners[i - 1]!, corners[i]!, o)) {
            throw new Error(`edge ${r.refId} segment ${i} intersects obstacle ${JSON.stringify(o)}`);
          }
        }
      }
      checked++;
      if (checked >= 200) break; // sample 200 detoured edges — enough to catch a systemic bug, keeps the test fast
    }
    expect(checked).toBeGreaterThan(0); // at least some edges detoured (the invariant is non-vacuous)
  });

  it('is deterministic at scale (two runs produce identical waypoints)', async () => {
    const a = await orderEdges(edges, { obstaclesFor: obstaclesFor(index) });
    const b = await orderEdges(edges, { obstaclesFor: obstaclesFor(index) });
    expect(a.map((r) => r.waypoints)).toEqual(b.map((r) => r.waypoints));
    expect(bboxes.size).toBeGreaterThan(0);
  });
});
