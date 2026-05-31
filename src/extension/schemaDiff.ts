import type { Column, Schema, SchemaDiff, ColumnDiffEntry, TableDiff, RefDiff } from '../shared/types';

/**
 * Pure structural diff between two parsed schemas (spec 16). No git, no vscode, no layout — the
 * caller parses both revisions (`parseDbml`) and enriches removed tables with their base position.
 * Output is deterministic (sorted) so it is trivially testable and produces stable payloads.
 *
 * Tables are matched by qualified name, columns by name, refs by their stable `id`. Only CHANGED
 * entities appear in the result; unchanged tables/refs are omitted to keep the payload small.
 */
export function diffSchemas(base: Schema, head: Schema): SchemaDiff {
  const baseTables = new Map(base.tables.map((t) => [t.name, t]));
  const headTables = new Map(head.tables.map((t) => [t.name, t]));

  const tables: TableDiff[] = [];
  for (const [name, h] of headTables) {
    const b = baseTables.get(name);
    if (!b) {
      tables.push({ table: name, status: 'added', columns: [], base: null, pos: null });
    } else {
      const columns = diffColumns(b.columns, h.columns);
      const tableChanged = columns.length > 0 ||
        (b.note ?? null) !== (h.note ?? null) ||
        (b.groupName ?? null) !== (h.groupName ?? null);
      // Carry the base (Previous) table so the webview's Previous|Current hover card can render it.
      if (tableChanged) tables.push({ table: name, status: 'modified', columns, base: b, pos: null });
    }
  }
  for (const [name, b] of baseTables) {
    if (!headTables.has(name)) {
      tables.push({ table: name, status: 'removed', columns: [], base: b, pos: null });
    }
  }
  tables.sort((a, z) => a.table.localeCompare(z.table));

  const baseRefs = new Set(base.refs.map((r) => r.id));
  const headRefs = new Map(head.refs.map((r) => [r.id, r]));
  const refs: RefDiff[] = [];
  for (const r of head.refs) {
    if (!baseRefs.has(r.id)) refs.push({ id: r.id, status: 'added', source: r.source.table, target: r.target.table });
  }
  for (const r of base.refs) {
    if (!headRefs.has(r.id)) refs.push({ id: r.id, status: 'removed', source: r.source.table, target: r.target.table });
  }
  refs.sort((a, z) => a.id.localeCompare(z.id));

  return { tables, refs };
}

function diffColumns(base: Column[], head: Column[]): ColumnDiffEntry[] {
  const baseByName = new Map(base.map((c) => [c.name, c]));
  const headByName = new Map(head.map((c) => [c.name, c]));
  const out: ColumnDiffEntry[] = [];
  for (const h of head) {
    const b = baseByName.get(h.name);
    if (!b) out.push({ name: h.name, status: 'added', type: null });
    else if (columnChanged(b, h)) out.push({ name: h.name, status: 'changed', type: null });
  }
  for (const b of base) {
    if (!headByName.has(b.name)) out.push({ name: b.name, status: 'removed', type: b.type });
  }
  out.sort((a, z) => a.name.localeCompare(z.name));
  return out;
}

function columnChanged(a: Column, b: Column): boolean {
  return a.type !== b.type ||
    !!a.pk !== !!b.pk ||
    !!a.notNull !== !!b.notNull ||
    !!a.unique !== !!b.unique ||
    !!a.increment !== !!b.increment ||
    (a.default ?? null) !== (b.default ?? null) ||
    (a.note ?? null) !== (b.note ?? null);
}
