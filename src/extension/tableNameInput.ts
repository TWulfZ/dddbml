import type { QualifiedName } from '../shared/types';

export interface TableNameInput {
  schema: string | null;
  table: string;
  qualified: QualifiedName;
}

const PART = String.raw`(?:"([^"]+)"|([^".]+))`;
const NAME_RE = new RegExp(String.raw`^(?:${PART}\.)?${PART}$`, 'u');

/**
 * Reads "table" or "schema.table" as typed in the New-table prompt. Parts are free text (spaces and
 * non-ASCII are quoted when written, spec 19); a part with a dot must be wrapped in "…". Returns the
 * message to show when the input is not a usable, new name.
 */
export function parseTableNameInput(input: string, existing: ReadonlySet<QualifiedName>): TableNameInput | string {
  const text = input.trim();
  if (text.length === 0) return 'Enter a table name.';
  if (/[\p{Cc}]/u.test(text)) return 'A table name cannot contain line breaks or tabs.';
  const m = NAME_RE.exec(text);
  if (!m) return 'Use "table" or "schema.table"; wrap a part that contains a dot in double quotes.';
  const schemaPart = (m[1] ?? m[2])?.trim();
  const table = (m[3] ?? m[4] ?? '').trim();
  if (table.length === 0 || schemaPart === '') return 'Schema and table names cannot be empty.';
  const schema = schemaPart ?? null;
  const qualified = `${schema ?? 'public'}.${table}`;
  if (existing.has(qualified)) return `A table named "${qualified}" already exists.`;
  return { schema, table, qualified };
}
