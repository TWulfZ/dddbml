import type { EdgeLayout, EdgeSide, QualifiedName, Schema, Table } from '../../../shared/types';
import type { Bbox } from '../../render/spatialIndex';
import { SpatialIndex } from '../../render/spatialIndex';
import { chooseSides, routeRefs, type ColumnYResolver } from '../../render/edgeRouter';
import { columnCenterY, estimateSize } from '../autoLayout';
import { ASTAR_CELL, CLEARANCE, chooseSides4, orderEdges, type OrderEdgeInput, type RoutedEdge } from '../edgeOrder';
import { isSelfRef } from '../../render/edgeKey';
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
  /** SET pairs only (never null): waypoints + 4-side endpoints marked `auto`, color preserved. */
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

type SidePair = { sourceSide: EdgeSide; targetSide: EdgeSide };

/** Rigid stub (MIN_STUB = ASTAR_CELL) plus the clearance A* needs to turn off the stub end. */
const STUB_REACH = ASTAR_CELL + CLEARANCE;

/** The strip a stub on `side` and A*'s first turn off its end occupy, over the whole side. */
function stubBand(b: Bbox, side: EdgeSide): Bbox {
  switch (side) {
    case 'left': return { x: b.x - STUB_REACH, y: b.y, w: STUB_REACH, h: b.h };
    case 'right': return { x: b.x + b.w, y: b.y, w: STUB_REACH, h: b.h };
    case 'top': return { x: b.x, y: b.y - STUB_REACH, w: b.w, h: STUB_REACH };
    case 'bottom': return { x: b.x, y: b.y + b.h, w: b.w, h: STUB_REACH };
  }
}

const isVertical = (side: EdgeSide): boolean => side === 'top' || side === 'bottom';

/**
 * `chooseSides4`, unless a vertical stub would land in a third table: a stacked column sits
 * BASE_MIN_GAP (16) apart, less than one stub, so an edge skipping over a middle table has no clean
 * top/bottom route and A* could only reach that stub end through a table. It then goes round the
 * column from a horizontal side pair: the facing pair when the tables do not x-overlap, else a C on
 * the left first, because self-loops default to the right side (spec 05 §Self-loops).
 */
function provisionalSides(sb: Bbox, tb: Bbox, bandBlocked: (band: Bbox) => boolean): SidePair {
  const four = chooseSides4(sb, tb);
  const clear = (p: SidePair): boolean => !bandBlocked(stubBand(sb, p.sourceSide)) && !bandBlocked(stubBand(tb, p.targetSide));
  if (!isVertical(four.sourceSide) || clear(four)) return four;
  const facing = chooseSides(sb, tb);
  const candidates: SidePair[] = [
    ...(isVertical(facing.sourceSide) ? [] : [facing]),
    { sourceSide: 'left', targetSide: 'left' },
    { sourceSide: 'right', targetSide: 'right' },
  ];
  return candidates.find(clear) ?? four;
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

  // Refs to route, in deterministic ref.id order; skip manual-shaped edges when preserving, and
  // self-loops, whose geometry is fixed by the render router (spec 05 §Self-loops).
  const refs = schema.refs
    .filter((r) => !isSelfRef(r))
    .filter((r) => !(preserveManual && hasManualShape(existingLayouts.get(r.id))))
    .filter((r) => bboxes.has(r.source.table) && bboxes.has(r.target.table))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Provisional 4-side assignment feeds a routeRefs pass so the stubs A* routes between are the
  // spread ports that will persist. Layout resolver returns the provisional side for these refs.
  const provisionalSide = new Map<string, SidePair>();
  for (const r of refs) {
    const sb = bboxes.get(r.source.table)!;
    const tb = bboxes.get(r.target.table)!;
    const bandBlocked = (band: Bbox): boolean =>
      [...index.query(band)].some((name) => {
        if (name === r.source.table || name === r.target.table) return false;
        const o = index.getBbox(name);
        return !!o && o.x < band.x + band.w && o.x + o.w > band.x && o.y < band.y + band.h && o.y + o.h > band.y;
      });
    provisionalSide.set(r.id, provisionalSides(sb, tb, bandBlocked));
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

  // Map RoutedEdge[] → EdgeLayout SET pairs, preserving color. Sides persist only when they differ
  // from what the render path's chooseSides would pick. A fallback (ok:false) gets
  // the plain default route, so its provisional sides are dropped too. Every shape written here is
  // marked `auto`, so later "preserve manual" runs and endpoint moves treat it as A*'s (F20).
  const inputById = new Map(inputs.map((ep) => [ep.refId, ep]));
  const resets: Array<[string, EdgeLayout]> = [];
  for (const r of routed) {
    const existing = existingLayouts.get(r.refId);
    const next: EdgeLayout = {};
    if (existing?.color) next.color = existing.color;
    const ep = inputById.get(r.refId);
    if (r.ok && ep) {
      const auto = chooseSides(ep.sourceTable, ep.targetTable);
      if (auto.sourceSide !== r.sourceSide || auto.targetSide !== r.targetSide) {
        next.sourceSide = r.sourceSide;
        next.targetSide = r.targetSide;
      }
      if (r.waypoints.length > 0) next.waypoints = r.waypoints;
      if (next.waypoints || next.sourceSide) next.auto = true;
    }
    resets.push([r.refId, next]);
  }
  return { resets };
}
