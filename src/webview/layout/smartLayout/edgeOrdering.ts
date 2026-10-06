import type { EdgeLayout, QualifiedName, Schema, Table } from '../../../shared/types';
import type { Bbox } from '../../render/spatialIndex';
import { SpatialIndex } from '../../render/spatialIndex';
import { chooseSides, routeRefs, type ColumnYResolver, type EdgeRoute } from '../../render/edgeRouter';
import { columnCenterY, estimateSize } from '../autoLayout';
import { ASTAR_CELL, CLEARANCE, chooseSides4, orderEdges, type OrderEdgeInput, type RoutedEdge } from '../edgeOrder';
import { isSelfRef } from '../../render/edgeKey';
import { hasManualShape } from './edgeReset';
import { boxesIntersect, cClearsEndpoints, narrowGapSJog, type HorizontalSide, type HorizontalSidePair, type PortRows } from '../edgeSides';

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
  /** SET pairs only (never null): waypoints + left/right endpoints marked `auto`, color preserved. */
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

type SidePair = HorizontalSidePair;

/** Rigid stub (MIN_STUB = ASTAR_CELL) plus the clearance A* needs to turn off the stub end. */
const STUB_REACH = ASTAR_CELL + CLEARANCE;

/** The strip a stub on `side` and A*'s first turn off its end occupy, over the whole side. */
function stubBand(b: Bbox, side: HorizontalSide): Bbox {
  return side === 'left'
    ? { x: b.x - STUB_REACH, y: b.y, w: STUB_REACH, h: b.h }
    : { x: b.x + b.w, y: b.y, w: STUB_REACH, h: b.h };
}

/**
 * `chooseSides4` (the render path's zone rule), unless a stub band lands in a third table: packed
 * tables sit BASE_MIN_GAP (16) apart, less than one stub, so A* could only reach that stub end
 * through a table. It then tries a C round the right of both tables, then round the left, each only
 * if its arms and trunk keep out of both tables: side by side, one arm of either C runs through the
 * other table, which hides the edge (seen on isga's quotas pair). Every candidate is left/right, so no
 * top/bottom port is ever persisted (spec 05 §9). Intersecting tables keep the zone pair, whose C or
 * facing connector render picks live (§1).
 */
function provisionalSides(sb: Bbox, tb: Bbox, rows: PortRows, bandBlocked: (band: Bbox) => boolean): SidePair {
  const auto = chooseSides4(sb, tb);
  if (boxesIntersect(sb, tb)) return auto;
  const clear = (p: SidePair): boolean => !bandBlocked(stubBand(sb, p.sourceSide)) && !bandBlocked(stubBand(tb, p.targetSide));
  if (clear(auto)) return auto;
  const sides: HorizontalSide[] = ['right', 'left'];
  const c = sides.find((side) => cClearsEndpoints(sb, tb, side, rows) && clear({ sourceSide: side, targetSide: side }));
  return c ? { sourceSide: c, targetSide: c } : auto;
}

/**
 * A* reports a clear straight run between a C's stubs as no waypoints, but this C only went to A*
 * because its nested render default crosses a third table: left waypoint-less, render would nest it
 * back there. Pin the column A* found instead (never inside a stub, so no spur), dropping corners that
 * coincide with a stub end as `routeOneEdge` does; aligned stubs keep one corner at the midpoint.
 */
function pinStraightC(ep: OrderEdgeInput, r: RoutedEdge): RoutedEdge {
  const start = r.pathWorld[0];
  if (!r.ok || r.waypoints.length > 0 || ep.sourceSide !== ep.targetSide || !start) return r;
  const a = { x: Math.round(ep.sourceStub.x), y: Math.round(ep.sourceStub.y) };
  const b = { x: Math.round(ep.targetStub.x), y: Math.round(ep.targetStub.y) };
  const x = ep.sourceSide === 'right' ? Math.max(start.x, a.x, b.x) : Math.min(start.x, a.x, b.x);
  const corners = [{ x, y: a.y }, { x, y: b.y }].filter((p) => !(p.x === a.x && p.y === a.y) && !(p.x === b.x && p.y === b.y));
  return { ...r, waypoints: corners.length > 0 ? corners : [{ x, y: Math.round((a.y + b.y) / 2) }] };
}

/**
 * Compute the A* edge-ordering result for a fixed set of table positions. The engine routes between
 * the stubs of a `routeRefs` pass; the adapter pre-assigns provisional left/right sides (so the
 * spread stubs A* routes between are the ones that persist — no first-render kink, critic G5). Edges
 * with a manual shape are skipped when `preserveManual`.
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

  // Provisional side assignment feeds a routeRefs pass so the stubs A* routes between are the
  // spread ports that will persist. Layout resolver returns the provisional side for these refs.
  const provisionalSide = new Map<string, SidePair>();
  const colY = columnYResolverFor(schema);
  const rowOf = (b: Bbox, table: QualifiedName, column: string | undefined): number =>
    b.y + ((column === undefined ? undefined : colY(table, column)) ?? b.h / 2);
  for (const r of refs) {
    const sb = bboxes.get(r.source.table)!;
    const tb = bboxes.get(r.target.table)!;
    const bandBlocked = (band: Bbox): boolean =>
      [...index.query(band)].some((name) => {
        if (name === r.source.table || name === r.target.table) return false;
        const o = index.getBbox(name);
        return !!o && o.x < band.x + band.w && o.x + o.w > band.x && o.y < band.y + band.h && o.y + o.h > band.y;
      });
    const rows = { source: rowOf(sb, r.source.table, r.source.columns[0]), target: rowOf(tb, r.target.table, r.target.columns[0]) };
    provisionalSide.set(r.id, provisionalSides(sb, tb, rows, bandBlocked));
  }
  const zonePair = new Map<string, SidePair>();
  for (const r of refs) zonePair.set(r.id, chooseSides4(bboxes.get(r.source.table)!, bboxes.get(r.target.table)!));
  const layoutResolver = (id: string): EdgeLayout | undefined => {
    const prov = provisionalSide.get(id);
    const existing = existingLayouts.get(id);
    if (!prov) return existing;
    // Keep the user's color, drop the old shape (A* computes it). The zone pair stays unset so render
    // may still flip a C whose side a neighbour blocks, exactly as it will once nothing is persisted.
    const zone = zonePair.get(id)!;
    if (zone.sourceSide === prov.sourceSide && zone.targetSide === prov.targetSide) return { color: existing?.color };
    return { color: existing?.color, sourceSide: prov.sourceSide, targetSide: prov.targetSide };
  };

  // Every drawable ref, loops and preserved manual edges included: they share port groups with the
  // routed ones and the render path nests C trunks against them, so this is the geometry render draws.
  const drawable = schema.refs.filter((r) => bboxes.has(r.source.table) && bboxes.has(r.target.table));
  const routes = routeRefs(drawable, bboxOf, colY, layoutResolver, undefined, (box) => index.query(box));
  const routeById = new Map(routes.map((rt) => [rt.id, rt]));
  const sidesOf = (rt: EdgeRoute): SidePair => ({
    sourceSide: rt.sourceStub.x < rt.source.x ? 'left' : 'right',
    targetSide: rt.targetStub.x < rt.target.x ? 'left' : 'right',
  });

  // A C whose render-default route clears every third table stays waypoint-less: the render path then
  // nests it outside loops and other Cs at LOOP_STEP (12) spacing, finer than A*'s 24-unit grid can
  // express, and keeps re-nesting it as tables move. Only a blocked C goes through A*.
  const throughThirdTable = (rt: EdgeRoute, a: QualifiedName, b: QualifiedName): boolean =>
    rt.segments.some((sg) => {
      const x0 = Math.min(sg.x1, sg.x2);
      const x1 = Math.max(sg.x1, sg.x2);
      const y0 = Math.min(sg.y1, sg.y2);
      const y1 = Math.max(sg.y1, sg.y2);
      return [...index.query({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })].some((name) => {
        if (name === a || name === b) return false;
        const o = index.getBbox(name);
        return !!o && x0 < o.x + o.w && x1 > o.x && y0 < o.y + o.h && y1 > o.y;
      });
    });
  // A clear narrow-gap S stays render-owned the same way: its full-stub jog is exactly the default A*
  // would only approximate on its grid, and a live S follows the tables. Intersecting tables drawn as
  // the facing connector keep it too: any detour A* finds around them still starts and ends under the
  // other table, and persisting it would read as a loop of one of them (spec 05 §1). Their C, when one
  // clears both tables, is an ordinary C.
  const keepDefault = new Set<string>();
  for (const r of refs) {
    const rt = routeById.get(r.id);
    if (!rt) continue;
    const sides = sidesOf(rt);
    const sameSide = sides.sourceSide === sides.targetSide;
    const sb = bboxes.get(r.source.table)!;
    const tb = bboxes.get(r.target.table)!;
    const narrowS = narrowGapSJog(rt.source, rt.target, sides.sourceSide, sides.targetSide, sb, tb) !== undefined;
    // A Z that made a stack yield it a lane stays render-owned too: persisting any shape would end its
    // claim and widen the stack back over the lane A* just routed through.
    const clear = (sameSide || narrowS || rt.laneClaim === true) && !throughThirdTable(rt, r.source.table, r.target.table);
    const facingOverlap = !sameSide && boxesIntersect(sb, tb);
    if (clear || facingOverlap) keepDefault.add(r.id);
  }

  // Trunks A* must never run along: loops, the Cs kept above and preserved manual Cs.
  const lanes: Bbox[] = [];
  for (const rt of routes) {
    const sameSide = Math.sign(rt.sourceStub.x - rt.source.x) === Math.sign(rt.targetStub.x - rt.target.x);
    const routedByAStar = provisionalSide.has(rt.id) && !keepDefault.has(rt.id);
    if (!(rt.loop || sameSide) || routedByAStar) continue;
    for (const sg of rt.segments) {
      if (sg.rigid || sg.axis !== 'v' || sg.y1 === sg.y2) continue;
      lanes.push({ x: sg.x1, y: Math.min(sg.y1, sg.y2), w: 0, h: Math.abs(sg.y2 - sg.y1) });
      // A loop pulled in for a claiming Z returns there once that Z persists A*'s waypoints.
      if (rt.unyieldedTrunkX !== undefined) lanes.push({ x: rt.unyieldedTrunkX, y: Math.min(sg.y1, sg.y2), w: 0, h: Math.abs(sg.y2 - sg.y1) });
    }
  }

  const inputs: OrderEdgeInput[] = [];
  for (const r of refs) {
    if (keepDefault.has(r.id)) continue;
    const rt = routeById.get(r.id);
    const sb = bboxes.get(r.source.table);
    const tb = bboxes.get(r.target.table);
    if (!rt || !sb || !tb || !provisionalSide.has(r.id)) continue;
    // The drawn sides, which differ from the provisional ones when render flipped an automatic C.
    const sides = sidesOf(rt);
    inputs.push({
      refId: r.id,
      sourceStub: rt.sourceStub,
      targetStub: rt.targetStub,
      sourceTable: sb,
      targetTable: tb,
      sourceTableName: r.source.table,
      targetTableName: r.target.table,
      sourceSide: sides.sourceSide,
      targetSide: sides.targetSide,
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

  const routedById = new Map(
    (await orderEdges(inputs, { obstaclesFor, lanes, signal, onProgress })).map((r) => [r.refId, r]),
  );
  const inputById = new Map(inputs.map((ep) => [ep.refId, ep]));
  const routed: RoutedEdge[] = [];
  for (const r of refs) {
    const prov = provisionalSide.get(r.id);
    const done = routedById.get(r.id);
    const ep = inputById.get(r.id);
    if (done && ep) routed.push(pinStraightC(ep, done));
    else if (prov && keepDefault.has(r.id)) {
      routed.push({ refId: r.id, sourceSide: prov.sourceSide, targetSide: prov.targetSide, waypoints: [], pathWorld: [], ok: true });
    }
  }

  // Map RoutedEdge[] → EdgeLayout SET pairs, preserving color. Waypoints always persist with both
  // sides they were routed for, so render never pairs them with other ports and a side-less auto
  // detour stays recognisable as a pre-2026-10-03 legacy shape (`isLegacyEdgeShape`); without
  // waypoints, sides persist only when they differ from chooseSides. A fallback (ok:false) gets the
  // plain default route, so its provisional sides are dropped too. Every shape written here is
  // marked `auto`, so later "preserve manual" runs and endpoint moves treat it as A*'s (F20).
  const resets: Array<[string, EdgeLayout]> = [];
  const refById = new Map(refs.map((r) => [r.id, r]));
  for (const r of routed) {
    const existing = existingLayouts.get(r.refId);
    const next: EdgeLayout = {};
    if (existing?.color) next.color = existing.color;
    const ref = refById.get(r.refId);
    const sb = ref && bboxes.get(ref.source.table);
    const tb = ref && bboxes.get(ref.target.table);
    if (r.ok && sb && tb) {
      const auto = chooseSides(sb, tb);
      if (r.waypoints.length > 0 || auto.sourceSide !== r.sourceSide || auto.targetSide !== r.targetSide) {
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
