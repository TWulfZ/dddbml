import type { QualifiedName } from '../shared/types';
import { findField, findTable, parseModel, tableName } from './dbmlModel';
import { isName, isPunct, lex, nameOf } from './dbmlScan';

/**
 * 0-based line of the `Table` declaration for a qualified name ("schema.table"), or null.
 * Uses the parser's own token locations, so quoted, schema-qualified, aliased and non-ASCII names
 * resolve exactly like the diagram names them. A buffer that does not parse falls back to a
 * quote- and Unicode-aware scan of the declaration lines.
 */
export function findTableLine(source: string, qualifiedName: string): number | null {
  const { model } = parseModel(source);
  if (!model) return scanForTable(source, qualifiedName);
  const table = model.tables.find((t) => tableName(t) === qualifiedName);
  return table ? table.token.start.line - 1 : null;
}

/** 0-based position of a column's declaration (its name), or null when it is not in the source. */
export function findColumnLocation(source: string, table: QualifiedName, column: string): { line: number; character: number } | null {
  const { model } = parseModel(source);
  const t = model ? findTable(model, table) : undefined;
  const field = t ? findField(t, column) : undefined;
  // A TablePartial column's token points into the partial, which is still where it is written.
  return field ? { line: field.token.start.line - 1, character: field.token.start.column - 1 } : null;
}

export interface TableNameRange {
  table: QualifiedName;
  /** Offsets of the declared name (`schema.table` included), for a document link. */
  start: number;
  end: number;
}

/**
 * Every top-level `Table` declaration's name. A lexer scan rather than a parse: links are asked for
 * on each edit pause, must work while the buffer is broken, and a full parse of a 5000-table file
 * would hold the shared worker queue for ~2 s.
 */
export function findTableNameRanges(source: string): TableNameRange[] {
  const tokens = lex(source).filter((t) => t.kind !== 'comment');
  const out: TableNameRange[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (isPunct(source, t, '{')) depth++;
    else if (isPunct(source, t, '}')) depth = Math.max(0, depth - 1);
    if (depth !== 0 || t.kind !== 'ident' || source.slice(t.start, t.end).toLowerCase() !== 'table') continue;
    const first = tokens[i + 1];
    if (!isName(first)) continue;
    const dot = tokens[i + 2];
    const second = tokens[i + 3];
    if (isPunct(source, dot, '.') && isName(second)) {
      out.push({ table: qualify(nameOf(source, first), nameOf(source, second)), start: first.start, end: second.end });
      i += 3;
    } else {
      out.push({ table: qualify(null, nameOf(source, first)), start: first.start, end: first.end });
      i += 1;
    }
  }
  return out;
}

function scanForTable(source: string, qualifiedName: string): number | null {
  const hit = findTableNameRanges(source).find((r) => r.table === qualifiedName);
  return hit ? source.slice(0, hit.start).split('\n').length - 1 : null;
}

function qualify(schemaName: string | null, table: string): QualifiedName {
  return `${schemaName !== null && schemaName.length > 0 ? schemaName : 'public'}.${table}`;
}
