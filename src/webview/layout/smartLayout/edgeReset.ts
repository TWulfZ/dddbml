import type { EdgeLayout, QualifiedName, Ref } from '../../../shared/types';

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
 * edges with only one endpoint moved keep their bend. Returns `[refId, nextLayout|null]`
 * pairs (null = delete the entry entirely).
 */
export function computeEdgeResets(
  refs: Ref[],
  moved: Set<QualifiedName>,
  edgeLayouts: Map<string, EdgeLayout>,
): Array<[string, EdgeLayout | null]> {
  const out: Array<[string, EdgeLayout | null]> = [];
  for (const r of refs) {
    const existing = edgeLayouts.get(r.id);
    if (!existing) continue;
    const hasShape =
      (existing.waypoints !== undefined && existing.waypoints.length > 0) ||
      existing.dx !== undefined ||
      existing.dy !== undefined;
    if (!hasShape) continue;
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
 * Manual "reset relations" for a set of selected tables: every edge TOUCHING the selection
 * (source OR target selected) that carries a manual shape is reset to default routing —
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
    if (!existing) continue;
    const hasShape =
      (existing.waypoints !== undefined && existing.waypoints.length > 0) ||
      existing.dx !== undefined ||
      existing.dy !== undefined ||
      existing.sourceSide !== undefined ||
      existing.targetSide !== undefined;
    if (!hasShape) continue;
    if (!selection.has(r.source.table) && !selection.has(r.target.table)) continue;

    const next: EdgeLayout = {};
    if (existing.color) next.color = existing.color;
    out.push([r.id, next.color !== undefined ? next : null]);
  }
  return out;
}
