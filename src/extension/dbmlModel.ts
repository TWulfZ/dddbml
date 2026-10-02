import { Parser } from '@dbml/core';
import type { QualifiedName } from '../shared/types';
import { qualify, stableRefId, unquote } from './parser';

/** Parse-worker only: imports `@dbml/core` (spec 18). The subset of its model that edits read. */

interface Loc { offset: number; line: number; column: number }
export interface ModelToken { start: Loc; end: Loc }

export interface ModelField {
  name: string;
  token: ModelToken;
  table: ModelTable;
  injectedPartial?: unknown;
}

export interface ModelIndex {
  columns: Array<{ type: string; value: string }>;
  token: ModelToken;
}

export interface ModelTable {
  name: string;
  alias: string | null;
  token: ModelToken;
  fields: ModelField[];
  indexes: ModelIndex[];
  schema: { name: string };
}

export interface ModelEndpoint {
  schemaName: string | null;
  tableName: string;
  fieldNames: string[];
  fields?: ModelField[];
  relation: string;
  token: ModelToken;
}

export interface ModelRef {
  name: string | null;
  token: ModelToken;
  endpoints: ModelEndpoint[];
}

export interface ModelGroup {
  name: string;
  token: ModelToken;
  tables: ModelTable[];
}

interface ModelSchema {
  name: string;
  tables: ModelTable[];
  refs: ModelRef[];
  tableGroups: ModelGroup[];
}

export interface Model {
  tables: ModelTable[];
  refs: ModelRef[];
  groups: ModelGroup[];
}

export function parseModel(source: string): { model: Model; error: null } | { model: null; error: string } {
  let schemas: ModelSchema[];
  try {
    schemas = (Parser.parse(source, 'dbmlv2') as unknown as { schemas: ModelSchema[] }).schemas;
  } catch (err) {
    return { model: null, error: parseErrorMessage(err) };
  }
  const refs = new Set<ModelRef>();
  const model: Model = { tables: [], refs: [], groups: [] };
  for (const s of schemas) {
    model.tables.push(...s.tables);
    for (const r of s.refs) refs.add(r);
    model.groups.push(...s.tableGroups);
  }
  model.refs = [...refs];
  return { model, error: null };
}

function parseErrorMessage(err: unknown): string {
  const diags = (err as { diags?: Array<{ message?: unknown; location?: { start?: { line?: unknown } } }> } | null)?.diags;
  const first = Array.isArray(diags) ? diags[0] : undefined;
  if (first && typeof first.message === 'string') {
    const line = first.location?.start?.line;
    return typeof line === 'number' ? `${first.message} (line ${line})` : first.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export function tableName(t: ModelTable): QualifiedName {
  return qualify(t.schema.name, unquote(t.name));
}

export function findTable(model: Model, name: QualifiedName): ModelTable | undefined {
  return model.tables.find((t) => tableName(t) === name);
}

export function findField(table: ModelTable, column: string): ModelField | undefined {
  return table.fields.find((f) => unquote(f.name) === column);
}

/** Unqualified endpoints resolve to `public` in @dbml/core 10, whatever schema the ref sits in. */
export function endpointTable(e: ModelEndpoint): QualifiedName {
  const field = e.fields?.[0];
  return field ? tableName(field.table) : qualify(e.schemaName, e.tableName);
}

export function endpointColumns(e: ModelEndpoint): string[] {
  return e.fieldNames.map(unquote);
}

/** Same id the diagram gives the ref (`parser.ts` mapRef), so the webview can name it. */
export function refId(r: ModelRef): string | null {
  const [a, b] = r.endpoints;
  if (!a || !b) return null;
  return stableRefId(endpointTable(a), endpointColumns(a), endpointTable(b), endpointColumns(b));
}

export function contains(outer: ModelToken, inner: ModelToken): boolean {
  return outer.start.offset <= inner.start.offset && inner.end.offset <= outer.end.offset;
}
