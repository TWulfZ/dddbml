import type { EdgeLayout, EdgeSide, QualifiedName, Schema, Table } from '../../../shared/types';
import type { Bbox } from '../../render/spatialIndex';
import { SpatialIndex } from '../../render/spatialIndex';
import { routeRefs, type ColumnYResolver } from '../../render/edgeRouter';
import { columnCenterY, estimateSize } from '../autoLayout';
import { chooseSides4, orderEdges, type OrderEdgeInput, type RoutedEdge } from '../edgeOrder';
import { hasManualShape } from './edgeReset';

/**
 * Adapter between the store world and the PURE A* edge-ordering engine (`edgeOrder/`). Builds the
 * engine's geometric inputs from a position map, runs the batch, and maps `RoutedEdge[]` back onto
 * `EdgeLayout` SET pairs. Mutates NOTHING — the runner applies the result atomically (critic G2).
 *
 * Why the position map is passed in (not read from the store): during a table-arrange the store
 * still holds the OLD positions while A* must route against the NEW (computed) ones; and the live
 * SpatialIndex lives in `app.tsx`, unreachable here. So the adapter builds a throwaway index from
 * the given positions (critic G3) — correct geometry, one rebuild per command.
 */

export interface EdgeOrderingInput {
  schema: Schema;
  positions: Map<QualifiedName, { x: number; y: number }>;
  existingLayouts: Map<string, EdgeLayout>;
  preserveManual: boolean;
  signal?: AbortSignal;
  onProgress?: (pct: number) => void;
}

export interface EdgeOrderingResult {
  /** SET pairs only (never null): waypoints + 4-side endpoints, color preserved. */
  resets: Array<[string, EdgeLayout]>;
}

function sizeFnFor(schema: Schema): (n: QualifiedName) => { width: number; height: number } {
  const colCount = new Map<QualifiedName, number>();
  for (const t of schema.tables) colCount.set(t.name, t.columns.length);
  return (n) => estimateSize(colCount.get(n) ?? 0);
}

/** Resolve a column's port-row Y offset, mirroring what EdgeLayer passes to routeRefs (L/R only). */
function columnYResolverFor(schema: Schema): ColumnYResolver {
  const byName = new Map<QualifiedName, Table>();
  for (const t of schema.tables) byName.set(t.name, t);
  return (table, column) => {
    const t = byName.get(table);
    if (!t) return undefined;
    const idx = t.columns.findIndex((c) => c.name === column);
    if (idx < 0) return undefined;
    return columnCenterY(idx);
  };
}

/**
 * Compute the A* edge-ordering result for a fixed set of table positions. The engine routes between
 * the stubs of a `routeRefs` pass; per the resolved hybrid side model the adapter pre-assigns
 * provisional 4-side choices (so the spread stubs A* routes between are the ones that persist — no
 * first-render kink, critic G5). Edges with a manual shape are skipped when `preserveManual`.
 */
export async function computeEdgeOrdering(input: EdgeOrderingInput): Promise<EdgeOrderingResult> {
  const { schema, positions, existingLayouts, preserveManual, signal, onProgress } = input;
  const sizeOf = sizeFnFor(schema);

  const bboxes = new Map<QualifiedName, Bbox>();
  const index = new SpatialIndex();
  for (const t of schema.tables) {
    const p = positions.get(t.name);
    if (!p) continue;
    const s = sizeOf(t.name);
    const b: Bbox = { x: p.x, y: p.y, w: s.width, h: s.height };
    bboxes.set(t.name, b);
    index.insert(t.name, b);
  }
  const bboxOf = (name: QualifiedName): Bbox | undefined => bboxes.get(name);

  // Refs to route, in deterministic ref.id order; skip manual-shaped edges when preserving.
  const refs = schema.refs
    .filter((r) => !(preserveManual && hasManualShape(existingLayouts.get(r.id))))
    .filter((r) => bboxes.has(r.source.table) && bboxes.has(r.target.table))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Provisional 4-side assignment feeds a routeRefs pass so the stubs A* routes between are the
  // spread ports that will persist. Layout resolver returns the provisional side for these refs.
  const provisionalSide = new Map<string, { sourceSide: EdgeSide; targetSide: EdgeSide }>();
  for (const r of refs) {
    const sb = bboxes.get(r.source.table)!;
    const tb = bboxes.get(r.target.table)!;
    provisionalSide.set(r.id, chooseSides4(sb, tb));
  }
  const layoutResolver = (id: string): EdgeLayout | undefined => {
    const prov = provisionalSide.get(id);
    const existing = existingLayouts.get(id);
    if (!prov) return existing;
    // Provisional sides override; keep the user's color. No waypoints (A* computes them).
    return { color: existing?.color, sourceSide: prov.sourceSide, targetSide: prov.targetSide };
  };

  const routes = routeRefs(refs, bboxOf, columnYResolverFor(schema), layoutResolver);
  const routeById = new Map(routes.map((rt) => [rt.id, rt]));

  const inputs: OrderEdgeInput[] = [];
  for (const r of refs) {
    const rt = routeById.get(r.id);
    const sb = bboxes.get(r.source.table);
    const tb = bboxes.get(r.target.table);
    const prov = provisionalSide.get(r.id);
    if (!rt || !sb || !tb || !prov) continue;
    inputs.push({
      refId: r.id,
      sourceStub: rt.sourceStub,
      targetStub: rt.targetStub,
      sourceTable: sb,
      targetTable: tb,
      sourceTableName: r.source.table,
      targetTableName: r.target.table,
      sourceSide: prov.sourceSide,
      targetSide: prov.targetSide,
    });
  }

  const obstaclesFor = (win: Bbox, a: QualifiedName, b: QualifiedName): Bbox[] => {
    const out: Bbox[] = [];
    for (const name of index.query(win)) {
      if (name === a || name === b) continue;
      const bb = index.getBbox(name);
      if (bb) out.push(bb);
    }
    return out;
  };

  const routed: RoutedEdge[] = await orderEdges(inputs, { obstaclesFor, signal, onProgress });

  // Map RoutedEdge[] → EdgeLayout SET pairs. Persist the chosen sides always (the render path's
  // chooseSides never picks top/bottom, so the side is the source of truth); preserve color.
  const resets: Array<[string, EdgeLayout]> = [];
  for (const r of routed) {
    const existing = existingLayouts.get(r.refId);
    const next: EdgeLayout = {};
    if (existing?.color) next.color = existing.color;
    next.sourceSide = r.sourceSide;
    next.targetSide = r.targetSide;
    if (r.ok && r.waypoints.length > 0) next.waypoints = r.waypoints;
    resets.push([r.refId, next]);
  }
  return { resets };
}
