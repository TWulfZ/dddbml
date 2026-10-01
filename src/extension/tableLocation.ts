import { Parser } from '@dbml/core';

/**
 * 0-based line of the `Table` declaration for a qualified name ("schema.table"), or null.
 * Uses the parser's own token locations, so quoted, schema-qualified, aliased and non-ASCII names
 * resolve exactly like the diagram names them. A buffer that does not parse falls back to a
 * quote- and Unicode-aware scan of the declaration lines.
 */
export function findTableLine(source: string, qualifiedName: string): number | null {
  try {
    const db = Parser.parse(source, 'dbmlv2');
    for (const schema of db.schemas) {
      for (const table of schema.tables) {
        if (qualify(schema.name, table.name) === qualifiedName) return table.token.start.line - 1;
      }
    }
    return null;
  } catch {
    return scanForTable(source, qualifiedName);
  }
}

const IDENT = String.raw`(?:"[^"]*"|[\p{L}\p{N}_]+)`;
const DECL_RE = new RegExp(String.raw`^\s*Table\s+(${IDENT})(?:\s*\.\s*(${IDENT}))?`, 'iu');

function scanForTable(source: string, qualifiedName: string): number | null {
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = DECL_RE.exec(lines[i] ?? '');
    if (!m) continue;
    const qn = m[2] !== undefined ? qualify(m[1]!, m[2]) : qualify(null, m[1]!);
    if (qn === qualifiedName) return i;
  }
  return null;
}

function qualify(schemaName: string | null, tableName: string): string {
  const s = unquote(schemaName ?? '');
  return `${s.length > 0 ? s : 'public'}.${unquote(tableName)}`;
}

function unquote(s: string): string {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}
