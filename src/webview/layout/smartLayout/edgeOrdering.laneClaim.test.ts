import { describe, expect, it, vi } from 'vitest';
import type { Ref, Schema, Table } from '../../../shared/types';
import { routeRefs, type EdgeRoute } from '../../render/edgeRouter';
import type { Bbox } from '../../render/spatialIndex';
import { columnCenterY, estimateSize } from '../autoLayout';
import * as edgeOrder from '../edgeOrder';
import { computeEdgeOrdering } from './edgeOrdering';

// Records what the adapter hands A* (edges and lanes), routing as usual.
const seenLanes: Bbox[][] = [];
const seenEdges: string[] = [];
vi.mock('../edgeOrder', async (importOriginal) => {
  const actual = await importOriginal<typeof edgeOrder>();
  return {
    ...actual,
    orderEdges: (inputs: Parameters<typeof actual.orderEdges>[0], opts: Parameters<typeof actual.orderEdges>[1]) => {
      seenLanes.push([...(opts.lanes ?? [])]);
      seenEdges.push(...inputs.map((e) => e.refId));
      return actual.orderEdges(inputs, opts);
    },
  };
});

const mkTable = (name: string, cols: number): Table => ({
  name,
  schemaName: 'public',
  tableName: name,
  columns: Array.from({ length: cols }, (_, i) => ({ name: `c${i}`, type: 'int' })),
});
const mkRef = (id: string, s: string, sc: string, t: string, tc: string): Ref =>
  ({ id, source: { table: s, columns: [sc], relation: '*' }, target: { table: t, columns: [tc], relation: '1' } });

// The spec 05 reference case: employees' two right loops, departments below, audit one 64 px column
// gap to the right, and a departments → audit Z through the gap beside the loops.
const cols: Record<string, number> = { emp: 5, dept: 3, audit: 3, blk: 2 };
const w = estimateSize(5).width;
const h = estimateSize(5).height;
const loops = [mkRef('emp-a', 'emp', 'c1', 'emp', 'c0'), mkRef('emp-b', 'emp', 'c2', 'emp', 'c0')];
const z = mkRef('dept-audit', 'dept', 'c2', 'audit', 'c0');

async function order(positions: Map<string, { x: number; y: number }>) {
  const schema: Schema = { tables: [...positions.keys()].map((n) => mkTable(n, cols[n]!)), refs: [...loops, z], groups: [] };
  seenLanes.length = 0;
  seenEdges.length = 0;
  const { resets } = await computeEdgeOrdering({ schema, positions, existingLayouts: new Map(), preserveManual: false });
  const layouts = new Map(resets);
  const bboxOf = (n: string): Bbox | undefined => {
    const p = positions.get(n);
    return p ? { x: p.x, y: p.y, w: estimateSize(cols[n]!).width, h: estimateSize(cols[n]!).height } : undefined;
  };
  const colY = (_t: string, c: string) => columnCenterY(Number(c.slice(1)));
  const routes = routeRefs(schema.refs, bboxOf, colY, (id) => layouts.get(id), undefined, () => positions.keys());
  return { layouts, routes, lanes: seenLanes.flat(), routed: [...seenEdges] };
}

const trunk = (r: EdgeRoute) => r.segments.filter((s) => s.axis === 'v' && !s.rigid).map((s) => s.x1);

describe('computeEdgeOrdering — a Z that made loops yield it a lane (spec 05 §9)', () => {
  it('persists nothing for the claimant, so render keeps the yielded lane', async () => {
    const positions = new Map([['emp', { x: 0, y: 0 }], ['dept', { x: 0, y: h + 16 }], ['audit', { x: w + 64, y: 0 }]]);
    const { layouts, routes, routed } = await order(positions);
    expect(routed).not.toContain(z.id);
    expect(layouts.get(z.id)).toEqual({});
    const drawn = routes.find((r) => r.id === z.id)!;
    expect(drawn.laneClaim).toBe(true);
    expect(loops.map((l) => trunk(routes.find((r) => r.id === l.id)!)[0])).toEqual([w + 32, w + 39]);
    expect(trunk(drawn)).toEqual([w + 47]);
  });

  it('a claimant through a third table goes to A*, which also keeps off where the loops return', async () => {
    // blk sits on the claimed trunk (w + 47) below audit, so the claimant crosses a third table.
    const positions = new Map([
      ['emp', { x: 0, y: 0 }], ['dept', { x: 0, y: h + 16 }], ['audit', { x: w + 64, y: 0 }], ['blk', { x: w + 40, y: h + 40 }],
    ]);
    const { layouts, lanes, routed } = await order(positions);
    expect(routed).toContain(z.id);
    expect(layouts.has(z.id)).toBe(true);
    const laneXs = new Set(lanes.map((l) => l.x));
    // Drawn (yielded) trunks and the neighbour-clamped ones they return to once the Z persists a shape.
    for (const x of [w + 32, w + 39, w + 44, w + 56]) expect(laneXs.has(x), `lane at ${x - w}`).toBe(true);
  });
});
