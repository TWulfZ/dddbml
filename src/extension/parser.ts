import { Parser } from '@dbml/core';
import { cmpCodeUnit } from '../shared/compare';
import type {
  Column,
  ColumnDefaultKind,
  Dep,
  DepEndpoint,
  ParseError,
  QualifiedName,
  Ref,
  RecordValue,
  RefEndpointRelation,
  Schema,
  Table,
  TableGroup,
  TableRecords,
} from '../shared/types';

/** Records preview only needs a sample; whole seed files would bloat every schema:update. */
export const RECORDS_ROW_CAP = 200;

/**
 * Wrapper over @dbml/core Parser.
 * Input: DBML source string.
 * Output: internal Schema (plain-data, postMessage-safe) or ParseError.
 */
export function parseDbml(source: string): { schema: Schema; error: null } | { schema: null; error: ParseError } {
  try {
    const db = Parser.parse(source, 'dbmlv2');
    const exported = db.export() as unknown as ExportedDatabase;
    return { schema: mapExportedToSchema(exported), error: null };
  } catch (err) {
    return { schema: null, error: toParseError(err) };
  }
}

function toParseError(err: unknown): ParseError {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const message = typeof e.message === 'string' ? e.message : String(err);
    const diags = (e.diags ?? e.diagnostics) as unknown;
    if (Array.isArray(diags) && diags.length > 0) {
      const first = diags[0] as Record<string, unknown>;
      const loc = first.location as Record<string, unknown> | undefined;
      const start = loc?.start as Record<string, unknown> | undefined;
      return {
        message: typeof first.message === 'string' ? first.message : message,
        line: typeof start?.line === 'number' ? start.line : undefined,
        column: typeof start?.column === 'number' ? start.column : undefined,
      };
    }
    return { message };
  }
  return { message: String(err) };
}

/* ----- AST mapping ----- */

interface ExportedField {
  name: string;
  type: unknown;
  unique: boolean;
  pk: boolean;
  not_null: boolean;
  note: string;
  dbdefault: unknown;
  increment: boolean;
}

interface ExportedTable {
  fields: ExportedField[];
  name: string;
  alias: string | null;
  note: string;
  headerColor: string | null;
  indexes?: Array<{ pk?: boolean; columns: Array<{ type: string; value: string }> }>;
}

interface ExportedRef {
  endpoints: Array<{
    schemaName: string | null;
    tableName: string;
    fieldNames: string[];
    relation: unknown;
  }>;
  name: string | null;
  onDelete: unknown;
  onUpdate: unknown;
}

interface ExportedTableGroup {
  name: string;
  tables: Array<{ schemaName: string | null; tableName: string }>;
}

interface ExportedDepEndpoint {
  schemaName: string | null;
  tableName: string;
  fieldNames: string[];
}

interface ExportedDep {
  name: string | null;
  color?: string | null;
  note: string | null;
  edges: Array<{ upstream: ExportedDepEndpoint; downstream: ExportedDepEndpoint }>;
}

interface ExportedSchema {
  name: string;
  tables: ExportedTable[];
  refs: ExportedRef[];
  tableGroups: ExportedTableGroup[];
  deps?: ExportedDep[];
}

interface ExportedRecords {
  schemaName: string | null;
  tableName: string;
  columns: string[];
  values: Array<Array<{ value: unknown; type: string }>>;
}

interface ExportedDatabase {
  schemas: ExportedSchema[];
  records?: ExportedRecords[];
}

export function unquote(s: string): string {
  if (!s) return s;
  const first = s.charAt(0);
  const last = s.charAt(s.length - 1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
    return s.slice(1, -1);
  }
  return s;
}

export function qualify(schemaName: string | null | undefined, tableName: string): QualifiedName {
  const s = unquote((schemaName ?? '').trim());
  const t = unquote(tableName.trim());
  return `${s && s.length > 0 ? s : 'public'}.${t}`;
}

function mapExportedToSchema(db: ExportedDatabase): Schema {
  const tables: Table[] = [];
  const refs: Ref[] = [];
  const deps: Dep[] = [];
  const groups: TableGroup[] = [];
  const tableToGroup = new Map<QualifiedName, string>();

  // @dbml/core exports TableGroups under `public` (after qualified schemas), so membership
  // must be fully known before any table is mapped.
  for (const s of db.schemas) {
    const schemaName = s.name && s.name.length > 0 ? s.name : 'public';
    for (const g of s.tableGroups ?? []) {
      const groupName = unquote(g.name);
      const members: QualifiedName[] = [];
      for (const t of g.tables ?? []) {
        const q = qualify(t.schemaName ?? schemaName, t.tableName);
        members.push(q);
        tableToGroup.set(q, groupName);
      }
      members.sort();
      groups.push({ name: groupName, tables: members });
    }
  }

  // Aliases are global in DBML, so a ref in one schema may name an aliased table mapped later.
  const realTables = new Set<QualifiedName>();
  const aliasToTable = new Map<string, QualifiedName>();
  for (const s of db.schemas) {
    const schemaName = s.name && s.name.length > 0 ? s.name : 'public';
    for (const t of s.tables ?? []) {
      const qn = qualify(schemaName, unquote(t.name));
      realTables.add(qn);
      if (t.alias) aliasToTable.set(unquote(t.alias), qn);
    }
  }
  const resolveEndpoint = (schemaName: string | null, tableName: string, defaultSchemaName: string): QualifiedName => {
    const qn = qualify(schemaName ?? defaultSchemaName, tableName);
    if (schemaName != null || realTables.has(qn)) return qn;
    return aliasToTable.get(unquote(tableName.trim())) ?? qn;
  };

  for (const s of db.schemas) {
    const schemaName = s.name && s.name.length > 0 ? s.name : 'public';

    for (const t of s.tables ?? []) {
      const cleanName = unquote(t.name);
      const qn = qualify(schemaName, cleanName);
      const table: Table = {
        name: qn,
        schemaName,
        tableName: cleanName,
        columns: markIndexPk((t.fields ?? []).map(mapField), t.indexes),
        note: t.note || null,
        groupName: tableToGroup.get(qn) ?? null,
      };
      if (t.headerColor) table.headerColor = t.headerColor;
      tables.push(table);
    }

    for (const r of s.refs ?? []) {
      const mapped = mapRef(r, schemaName, resolveEndpoint);
      if (mapped) refs.push(mapped);
    }

    for (const d of s.deps ?? []) {
      const mapped = mapDep(d, schemaName, resolveEndpoint);
      if (mapped) deps.push(mapped);
    }
  }

  tables.sort((a, b) => cmpCodeUnit(a.name, b.name));
  groups.sort((a, b) => cmpCodeUnit(a.name, b.name));

  const schema: Schema = { tables, refs, groups };
  const records = mapRecords(db.records ?? [], resolveEndpoint);
  if (records.length > 0) schema.records = records;
  if (deps.length > 0) schema.deps = deps;
  return schema;
}

function mapRecords(blocks: ExportedRecords[], resolveTable: EndpointResolver): TableRecords[] {
  // A table may get several `records` blocks (inline + top-level); the preview shows them as one grid
  // only when their column lists match, otherwise each block stays separate.
  const out: TableRecords[] = [];
  for (const b of blocks) {
    const table = resolveTable(b.schemaName, b.tableName, 'public');
    const columns = b.columns.map(unquote);
    const rows = b.values.map((row) => row.map(toRecordValue));
    const prev = out.find((r) => r.table === table && r.columns.join('\0') === columns.join('\0'));
    if (prev) {
      prev.totalRows += rows.length;
      prev.rows.push(...rows.slice(0, Math.max(0, RECORDS_ROW_CAP - prev.rows.length)));
    } else {
      out.push({ table, columns, rows: rows.slice(0, RECORDS_ROW_CAP), totalRows: rows.length });
    }
  }
  return out.sort((a, b) => cmpCodeUnit(a.table, b.table));
}

function toRecordValue(cell: { value: unknown; type: string }): RecordValue {
  const v = cell.value;
  if (v === null || v === undefined) return { v: null, t: 'null' };
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return { v, t: cell.type };
  return { v: String(v), t: cell.type };
}

function mapDep(d: ExportedDep, defaultSchemaName: string, resolveTable: EndpointResolver): Dep | null {
  const edges = (d.edges ?? []).map((e) => {
    const upstream: DepEndpoint = {
      table: resolveTable(e.upstream.schemaName, e.upstream.tableName, defaultSchemaName),
      columns: (e.upstream.fieldNames ?? []).map(unquote),
    };
    const downstream: DepEndpoint = {
      table: resolveTable(e.downstream.schemaName, e.downstream.tableName, defaultSchemaName),
      columns: (e.downstream.fieldNames ?? []).map(unquote),
    };
    const id = `${upstream.table}(${upstream.columns.join(',')})->${downstream.table}(${downstream.columns.join(',')})`;
    return { id, upstream, downstream };
  });
  if (edges.length === 0) return null;
  const dep: Dep = { name: d.name ? unquote(d.name) : null, note: d.note || null, edges };
  if (d.color) dep.color = d.color;
  return dep;
}

function mapField(f: ExportedField): Column {
  const col: Column = {
    name: unquote(f.name),
    type: typeName(f.type),
    pk: f.pk || undefined,
    notNull: f.not_null || undefined,
    unique: f.unique || undefined,
    increment: f.increment || undefined,
    default: f.dbdefault != null ? String((f.dbdefault as { value?: unknown })?.value ?? f.dbdefault) : null,
    note: f.note || null,
  };
  const kind = defaultKindOf(f.dbdefault);
  if (kind) col.defaultKind = kind;
  return col;
}

/** `indexes { (a, b) [pk] }` is how DBML spells a composite primary key; @dbml/core leaves the fields' `pk` false. */
function markIndexPk(columns: Column[], indexes: ExportedTable['indexes']): Column[] {
  for (const idx of indexes ?? []) {
    if (idx.pk !== true) continue;
    for (const member of idx.columns) {
      if (member.type !== 'column') continue;
      const col = columns.find((c) => c.name === unquote(member.value));
      if (col) col.pk = true;
    }
  }
  return columns;
}

function defaultKindOf(dbdefault: unknown): ColumnDefaultKind | undefined {
  if (!dbdefault || typeof dbdefault !== 'object') return undefined;
  const { type, value } = dbdefault as { type?: unknown; value?: unknown };
  // @dbml/core reports a bare `null` default as a boolean whose value is the text 'null'.
  if (type === 'boolean' && value === 'null') return 'null';
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'expression') return type;
  return undefined;
}

function typeName(t: unknown): string {
  if (typeof t === 'string') return t;
  if (t && typeof t === 'object') {
    const o = t as Record<string, unknown>;
    if (typeof o.type_name === 'string') return o.type_name;
    if (typeof o.name === 'string') return o.name;
  }
  return 'unknown';
}

type EndpointResolver = (schemaName: string | null, tableName: string, defaultSchemaName: string) => QualifiedName;

function mapRef(r: ExportedRef, defaultSchemaName: string, resolveTable: EndpointResolver): Ref | null {
  if (!r.endpoints || r.endpoints.length !== 2) return null;
  const [a, b] = r.endpoints;
  if (!a || !b) return null;
  const source = {
    table: resolveTable(a.schemaName, a.tableName, defaultSchemaName),
    columns: a.fieldNames.map(unquote),
    relation: normalizeRelation(a.relation),
  };
  const target = {
    table: resolveTable(b.schemaName, b.tableName, defaultSchemaName),
    columns: b.fieldNames.map(unquote),
    relation: normalizeRelation(b.relation),
  };
  const id = stableRefId(source.table, source.columns, target.table, target.columns);
  const ref: Ref = { id, source, target, name: r.name || null };
  if (typeof r.onDelete === 'string') ref.onDelete = r.onDelete;
  if (typeof r.onUpdate === 'string') ref.onUpdate = r.onUpdate;
  return ref;
}

function normalizeRelation(rel: unknown): RefEndpointRelation {
  if (rel === '*' || rel === 'many' || rel === '>') return '*';
  return '1';
}

export function stableRefId(
  srcTable: string,
  srcCols: string[],
  tgtTable: string,
  tgtCols: string[],
): string {
  const a = `${srcTable}(${[...srcCols].sort().join(',')})`;
  const b = `${tgtTable}(${[...tgtCols].sort().join(',')})`;
  return a < b ? `${a}->${b}` : `${b}->${a}`;
}
