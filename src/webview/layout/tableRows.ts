import type { Column, ColumnDiffEntry, QualifiedName, Table, TableDiffStatus } from '../../shared/types';

/** A column row tagged for the inline git-style unified diff. `context` = unchanged. */
export type DiffKind = 'context' | 'added' | 'removed' | 'changed-old' | 'changed-new';
export interface DiffRow { key: string; kind: DiffKind; col: Column; isFk: boolean }

/**
 * Build git-unified-diff rows for a table's columns: removed (`-`) then added (`+`), changed columns
 * as a `-`old / `+`new pair, interleaved in the base column order so it reads like an editor diff.
 * `base` undefined ⇒ a newly-added table (every column is `+`).
 */
export function buildDiffRows(current: Column[], base: Column[] | undefined, changed: Set<string>, fk?: Set<string>): DiffRow[] {
  const isFk = (n: string) => fk?.has(n) ?? false;
  if (!base) return current.map((c) => ({ key: `+${c.name}`, kind: 'added' as const, col: c, isFk: isFk(c.name) }));
  const baseByName = new Map(base.map((c) => [c.name, c]));
  const curByName = new Map(current.map((c) => [c.name, c]));
  const rows: DiffRow[] = [];
  let bi = 0;
  const flushRemovedBefore = (target: number) => {
    while (bi < target) {
      const bc = base[bi]!;
      if (!curByName.has(bc.name)) rows.push({ key: `-${bc.name}`, kind: 'removed', col: bc, isFk: false });
      bi++;
    }
  };
  for (const cc of current) {
    const bc = baseByName.get(cc.name);
    if (bc) {
      // Never rewind: a kept column that moved ahead of an already-flushed range would otherwise
      // make the final flush re-emit a removed column (duplicate `-` row and duplicate key).
      const idx = base.indexOf(bc);
      if (idx >= bi) {
        flushRemovedBefore(idx);
        bi = idx + 1;
      }
      if (changed.has(cc.name)) {
        rows.push({ key: `-${cc.name}`, kind: 'changed-old', col: bc, isFk: false });
        rows.push({ key: `+${cc.name}`, kind: 'changed-new', col: cc, isFk: isFk(cc.name) });
      } else {
        rows.push({ key: cc.name, kind: 'context', col: cc, isFk: isFk(cc.name) });
      }
    } else {
      rows.push({ key: `+${cc.name}`, kind: 'added', col: cc, isFk: isFk(cc.name) });
    }
  }
  flushRemovedBefore(base.length);
  return rows;
}

export interface RowOptions {
  showOnlyPkFk: boolean;
  fkColumns?: Set<string>;
  diffStatus?: TableDiffStatus;
  diffBase?: Table;
  columnDiff?: Map<string, ColumnDiffEntry>;
}

/**
 * The rows a table actually renders, in order: the inline diff for added/modified tables (which
 * bypasses the PK/FK filter), else the PK/FK-filtered or full column list. TableNode draws these and
 * every size/port computation must count the same rows, or edges and group boxes drift off the node.
 */
export function renderedRows(table: Table, o: RowOptions): DiffRow[] {
  if (o.diffStatus === 'added' || o.diffStatus === 'modified') {
    const changed = new Set<string>();
    if (o.columnDiff) for (const [n, e] of o.columnDiff) if (e.status === 'changed') changed.add(n);
    return buildDiffRows(table.columns, o.diffStatus === 'modified' ? o.diffBase?.columns : undefined, changed, o.fkColumns);
  }
  const fk = o.fkColumns;
  const cols = o.showOnlyPkFk ? table.columns.filter((c) => c.pk || (fk?.has(c.name) ?? false)) : table.columns;
  return cols.map((c) => ({ key: c.name, kind: 'context' as const, col: c, isFk: fk?.has(c.name) ?? false }));
}

/** Row index of a live column (its context/added/changed-new row), or -1 when it is not rendered. */
export function rowIndexOf(rows: readonly DiffRow[], column: string): number {
  return rows.findIndex((r) => r.col.name === column && r.kind !== 'removed' && r.kind !== 'changed-old');
}

/** Rendered row geometry per table; tables absent from `rows` render every column. */
export interface RowGeometry {
  count(name: QualifiedName): number;
  indexOf(name: QualifiedName, column: string): number;
}

export interface RowGeometryInput {
  tables: readonly Table[];
  showOnlyPkFk: boolean;
  fkColumnsByTable: Map<QualifiedName, Set<string>>;
  diffByTable?: Map<QualifiedName, TableDiffStatus> | null;
  diffBaseByTable?: Map<QualifiedName, Table> | null;
  columnDiffByTable?: Map<QualifiedName, Map<string, ColumnDiffEntry>> | null;
}

export function buildRowGeometry(input: RowGeometryInput): RowGeometry {
  const byName = new Map<QualifiedName, Table>();
  const rows = new Map<QualifiedName, DiffRow[]>();
  for (const t of input.tables) {
    byName.set(t.name, t);
    const diffStatus = input.diffByTable?.get(t.name);
    const isDiff = diffStatus === 'added' || diffStatus === 'modified';
    if (!input.showOnlyPkFk && !isDiff) continue;
    rows.set(t.name, renderedRows(t, {
      showOnlyPkFk: input.showOnlyPkFk,
      fkColumns: input.fkColumnsByTable.get(t.name),
      diffStatus,
      diffBase: input.diffBaseByTable?.get(t.name),
      columnDiff: input.columnDiffByTable?.get(t.name),
    }));
  }
  return {
    count: (name) => rows.get(name)?.length ?? byName.get(name)?.columns.length ?? 0,
    indexOf: (name, column) => {
      const r = rows.get(name);
      if (r) return rowIndexOf(r, column);
      return byName.get(name)?.columns.findIndex((c) => c.name === column) ?? -1;
    },
  };
}
