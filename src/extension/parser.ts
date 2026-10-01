import { Parser } from '@dbml/core';
import type {
  Column,
  ColumnDefaultKind,
  ParseError,
  QualifiedName,
  Ref,
  RefEndpointRelation,
  Schema,
  Table,
  TableGroup,
} from '../shared/types';

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

interface ExportedSchema {
  name: string;
  tables: ExportedTable[];
  refs: ExportedRef[];
  tableGroups: ExportedTableGroup[];
}

interface ExportedDatabase {
  schemas: ExportedSchema[];
}

function unquote(s: string): string {
  if (!s) return s;
  const first = s.charAt(0);
  const last = s.charAt(s.length - 1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
    return s.slice(1, -1);
  }
  return s;
}

function qualify(schemaName: string | null | undefined, tableName: string): QualifiedName {
  const s = unquote((schemaName ?? '').trim());
  const t = unquote(tableName.trim());
  return `${s && s.length > 0 ? s : 'public'}.${t}`;
}

function mapExportedToSchema(db: ExportedDatabase): Schema {
  const tables: Table[] = [];
  const refs: Ref[] = [];
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
      tables.push({
        name: qn,
        schemaName,
        tableName: cleanName,
        columns: markIndexPk((t.fields ?? []).map(mapField), t.indexes),
        note: t.note || null,
        groupName: tableToGroup.get(qn) ?? null,
      });
    }

    for (const r of s.refs ?? []) {
      const mapped = mapRef(r, schemaName, resolveEndpoint);
      if (mapped) refs.push(mapped);
    }
  }

  tables.sort((a, b) => a.name.localeCompare(b.name));
  groups.sort((a, b) => a.name.localeCompare(b.name));

  return { tables, refs, groups };
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

function stableRefId(
  srcTable: string,
  srcCols: string[],
  tgtTable: string,
  tgtCols: string[],
): string {
  const a = `${srcTable}(${[...srcCols].sort().join(',')})`;
  const b = `${tgtTable}(${[...tgtCols].sort().join(',')})`;
  return a < b ? `${a}->${b}` : `${b}->${a}`;
}
