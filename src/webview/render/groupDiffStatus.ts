import type { QualifiedName, TableDiffStatus, TableGroup } from '../../shared/types';
import type { DiffGhost } from '../state/store';

/**
 * Diff border of each group's collapsed node (spec 16): the shared status of its changed members,
 * `modified` when they disagree. Removed tables have no live member, so they count through their
 * diff ghost's base group. Individually hidden members are skipped, matching the diff navigation.
 */
export function groupDiffStatuses(
  groups: readonly TableGroup[],
  diffByTable: ReadonlyMap<QualifiedName, TableDiffStatus> | null,
  ghosts: readonly DiffGhost[] | null,
  individuallyHidden: ReadonlySet<QualifiedName>,
): Map<string, TableDiffStatus> {
  const out = new Map<string, TableDiffStatus>();
  const add = (group: string, status: TableDiffStatus): void => {
    const prev = out.get(group);
    out.set(group, prev === undefined || prev === status ? status : 'modified');
  };
  if (diffByTable) {
    for (const g of groups) {
      for (const t of g.tables) {
        const status = diffByTable.get(t);
        if (status && !individuallyHidden.has(t)) add(g.name, status);
      }
    }
  }
  for (const gh of ghosts ?? []) {
    if (gh.table.groupName) add(gh.table.groupName, 'removed');
  }
  return out;
}
