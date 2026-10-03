import type { QualifiedName, Ref, Table, TableGroup } from '../../shared/types';
import type { NodeSize } from './autoLayout';
import { smartLayout } from './smartLayout/layout';

type Point = { x: number; y: number };

export interface PlaceMissingInput {
  tables: Table[];
  refs: Ref[];
  groups: TableGroup[];
  positions: Map<QualifiedName, Point>;
  sizeOf: (name: QualifiedName) => NodeSize;
  spacing?: number;
}

/** Positions for the tables that have none yet (spec 13, "Colocación automática de tablas nuevas"). */
export function placeMissingTables(input: PlaceMissingInput): Array<[QualifiedName, Point]> {
  const { tables, refs, groups, positions, sizeOf, spacing } = input;
  const missing = tables.filter((t) => !positions.has(t.name));
  if (missing.length === 0) return [];
  // Empty canvas: flat dagre left huge.dbml as one strip that even Fit could not frame. Otherwise
  // flat dagre would stack the new tables at its margin on top of the placed ones (audit F19);
  // 'new' mode places them by their group/FK neighbours, clear of others.
  const laidOut = smartLayout(
    positions.size === 0
      ? { tables, refs, groups, sizeOf, mode: 'all', spacing }
      : { tables, refs, groups, sizeOf, mode: 'new', existing: positions, spacing },
  );
  const entries: Array<[QualifiedName, Point]> = [];
  for (const t of missing) {
    const pos = laidOut.get(t.name);
    if (pos) entries.push([t.name, pos]);
  }
  return entries;
}
