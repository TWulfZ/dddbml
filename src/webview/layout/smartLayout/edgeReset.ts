import type { Dep, EdgeLayout, QualifiedName, Ref } from '../../../shared/types';
import { edgeKeyedDeps, edgeKeyedRefs, type KeyedDepEdge } from '../../render/edgeKey';

/** Every ref under the key its layout has while both endpoints render as themselves (no hide/collapse). */
export function rawLayoutRefs(refs: readonly Ref[]): Ref[] {
  return edgeKeyedRefs(refs, (t) => t).refs;
}

/** Dep counterpart of {@link rawLayoutRefs}: every dep under its unremapped `dep:` key. */
export function rawLayoutDeps(deps: readonly Dep[] | undefined): KeyedDepEdge[] {
  return edgeKeyedDeps(deps ?? [], (t) => t);
}

/** Whether an edge carries any shape: explicit waypoints, a port-side override, or a legacy dx/dy. */
export function hasShape(layout: EdgeLayout | undefined): boolean {
  if (!layout) return false;
  return (
    (layout.waypoints !== undefined && layout.waypoints.length > 0) ||
    layout.sourceSide !== undefined ||
    layout.targetSide !== undefined ||
    layout.dx !== undefined ||
    layout.dy !== undefined
  );
}

/**
 * Whether an edge carries a user-authored shape. The on-demand edge-ordering pass skips these when
 * `preserveManualEdges` is on; an A* shape (`auto`) is not the user's, so it stays re-orderable (F20).
 */
export function hasManualShape(layout: EdgeLayout | undefined): boolean {
  return hasShape(layout) && layout?.auto !== true;
}

/** Tables whose position changed (or are newly placed) between two position maps. */
export function movedNames(
  before: Map<QualifiedName, { x: number; y: number }>,
  after: Map<QualifiedName, { x: number; y: number }>,
): Set<QualifiedName> {
  const moved = new Set<QualifiedName>();
  for (const [name, pos] of after) {
    const b = before.get(name);
    if (!b || b.x !== pos.x || b.y !== pos.y) moved.add(name);
  }
  return moved;
}

/**
 * Edges whose BOTH endpoints moved have their shape (waypoints + legacy dx/dy) stranded —
 * waypoints are absolute world coords that don't follow tables (spec 05). Clear the shape,
 * preserving the user's color + port-side overrides. Edges with no shape are skipped, and
 * edges with only one endpoint moved keep their bend. A* shapes follow
 * {@link computeAutoShapeDrops} instead. Returns `[refId, nextLayout|null]` pairs (null = delete
 * the entry entirely).
 */
export function computeEdgeResets(
  refs: Ref[],
  moved: Set<QualifiedName>,
  edgeLayouts: Map<string, EdgeLayout>,
): Array<[string, EdgeLayout | null]> {
  const out: Array<[string, EdgeLayout | null]> = [];
  for (const r of refs) {
    const existing = edgeLayouts.get(r.id);
    if (!existing || existing.auto) continue;
    const stranded =
      (existing.waypoints !== undefined && existing.waypoints.length > 0) ||
      existing.dx !== undefined ||
      existing.dy !== undefined;
    if (!stranded) continue;
    if (!moved.has(r.source.table) || !moved.has(r.target.table)) continue;

    const next: EdgeLayout = {};
    if (existing.color) next.color = existing.color;
    if (existing.sourceSide) next.sourceSide = existing.sourceSide;
    if (existing.targetSide) next.targetSide = existing.targetSide;
    const hasData =
      next.color !== undefined || next.sourceSide !== undefined || next.targetSide !== undefined;
    out.push([r.id, hasData ? next : null]);
  }
  return out;
}

/**
 * A* shapes (`auto`) touching a moved table: sides and detours were chosen for the old relative
 * geometry, so one moved endpoint is enough to make them wrong (F20). The whole shape is dropped
 * (the edge falls back to default routing), color kept. Same `[refId, nextLayout|null]` pairs.
 */
export function computeAutoShapeDrops(
  refs: Ref[],
  moved: Set<QualifiedName>,
  edgeLayouts: Map<string, EdgeLayout>,
): Array<[string, EdgeLayout | null]> {
  const out: Array<[string, EdgeLayout | null]> = [];
  for (const r of refs) {
    const existing = edgeLayouts.get(r.id);
    if (!existing?.auto) continue;
    if (!moved.has(r.source.table) && !moved.has(r.target.table)) continue;
    out.push([r.id, existing.color ? { color: existing.color } : null]);
  }
  return out;
}

type Pos = { x: number; y: number };

/**
 * Edge changes at a table-drag commit (spec 05 "Arrastre de tablas"). A drag moves every dragged
 * table by the same delta (up to snapping), so an edge (ref, auto or not, or dep) with BOTH endpoints
 * dragged keeps its relative geometry: its absolute waypoints are translated by its source's delta,
 * sides and `auto` untouched. Edges with one endpoint dragged follow {@link computeAutoShapeDrops}
 * as before. `before`/`after` are the drag's MoveCommand from/to, so their keys are exactly the
 * dragged set. `refs`/`deps` must carry raw layout keys (a dragged table is always rendered as itself).
 */
export function computeDragEdgeChanges(
  refs: readonly Ref[],
  deps: readonly KeyedDepEdge[],
  before: Map<QualifiedName, Pos>,
  after: Map<QualifiedName, Pos>,
  edgeLayouts: Map<string, EdgeLayout>,
): Array<[string, EdgeLayout | null]> {
  const moved = movedNames(before, after);
  // Per table, not one pointer delta: snapping an off-grid origin shifts each table by a different
  // amount (possibly zero), and the edge then rides with its source end.
  const delta = (name: QualifiedName): Pos | null => {
    const b = before.get(name);
    const a = after.get(name);
    return a && b ? { x: a.x - b.x, y: a.y - b.y } : null;
  };
  const out: Array<[string, EdgeLayout | null]> = [];
  const translate = (id: string, from: QualifiedName): void => {
    const d = delta(from);
    const existing = edgeLayouts.get(id);
    if (!d || (d.x === 0 && d.y === 0) || !existing?.waypoints?.length) return;
    out.push([id, { ...existing, waypoints: existing.waypoints.map((w) => ({ x: w.x + d.x, y: w.y + d.y })) }]);
  };
  // Membership in the dragged set, not "moved": a snap that leaves one dragged end in place must not
  // turn an inside edge into a one-end edge whose A* shape is dropped.
  const dragged = (name: QualifiedName): boolean => before.has(name) && after.has(name);
  const oneEnd: Ref[] = [];
  for (const r of refs) {
    if (dragged(r.source.table) && dragged(r.target.table)) translate(r.id, r.source.table);
    else oneEnd.push(r);
  }
  for (const d of deps) {
    if (dragged(d.upstream.table) && dragged(d.downstream.table)) translate(d.id, d.upstream.table);
  }
  out.push(...computeAutoShapeDrops(oneEnd, moved, edgeLayouts));
  return out;
}

/**
 * Manual "reset relations" for a set of selected tables: every edge TOUCHING the selection
 * (source OR target selected) that carries a shape (user or A*) is reset to default routing —
 * waypoints + legacy dx/dy + port-side overrides cleared, color preserved (matches the
 * per-edge "Reset line"). Lets the user clean up a table's relations independently of an
 * auto-arrange. Returns `[refId, nextLayout|null]` pairs (null = delete the entry).
 */
export function computeSelectionEdgeResets(
  refs: Ref[],
  selection: Set<QualifiedName>,
  edgeLayouts: Map<string, EdgeLayout>,
): Array<[string, EdgeLayout | null]> {
  const out: Array<[string, EdgeLayout | null]> = [];
  for (const r of refs) {
    const existing = edgeLayouts.get(r.id);
    if (!hasShape(existing)) continue;
    if (!selection.has(r.source.table) && !selection.has(r.target.table)) continue;

    out.push([r.id, existing?.color ? { color: existing.color } : null]);
  }
  return out;
}

/**
 * Dep waypoints are FREE points the curve passes through (spec 18), not orthogonal trunks, so once
 * both endpoints move they float in empty space. Drop them (color kept), the dep twin of
 * {@link computeEdgeResets}; callers fold the pairs into the move's single undo step.
 */
export function computeDepStrandResets(
  deps: readonly KeyedDepEdge[],
  moved: Set<QualifiedName>,
  edgeLayouts: Map<string, EdgeLayout>,
): Array<[string, EdgeLayout | null]> {
  const out: Array<[string, EdgeLayout | null]> = [];
  for (const d of deps) {
    const existing = edgeLayouts.get(d.id);
    if (!existing?.waypoints?.length) continue;
    if (!moved.has(d.upstream.table) || !moved.has(d.downstream.table)) continue;
    out.push([d.id, existing.color ? { color: existing.color } : null]);
  }
  return out;
}

/** Dep twin of {@link computeSelectionEdgeResets}: "Reset relations" also straightens touching deps. */
export function computeSelectionDepResets(
  deps: readonly KeyedDepEdge[],
  selection: Set<QualifiedName>,
  edgeLayouts: Map<string, EdgeLayout>,
): Array<[string, EdgeLayout | null]> {
  const out: Array<[string, EdgeLayout | null]> = [];
  for (const d of deps) {
    const existing = edgeLayouts.get(d.id);
    if (!existing?.waypoints?.length) continue;
    if (!selection.has(d.upstream.table) && !selection.has(d.downstream.table)) continue;
    out.push([d.id, existing.color ? { color: existing.color } : null]);
  }
  return out;
}
