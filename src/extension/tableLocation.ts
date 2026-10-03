import type { QualifiedName } from '../shared/types';
import { findField, findTable, parseModel, tableName } from './dbmlModel';
import { isName, isPunct, lex, nameOf, type LexToken } from './dbmlScan';

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

export interface TableDeclarationRange {
  table: QualifiedName;
  /** Offsets from the `Table` keyword through the body's closing `}` — the whole block is the Ctrl+click target. */
  start: number;
  end: number;
}

/**
 * Every top-level `Table` declaration. A lexer scan rather than a parse: links are asked for
 * on each edit pause, must work while the buffer is broken, and a full parse of a 5000-table file
 * would hold the shared worker queue for ~2 s.
 */
export function findTableDeclarationRanges(source: string): TableDeclarationRange[] {
  const tokens = lex(source).filter((t) => t.kind !== 'comment');
  const out: TableDeclarationRange[] = [];
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
    const qualified = isPunct(source, dot, '.') && isName(second);
    const nameEnd = qualified ? i + 3 : i + 1;
    const table = qualified ? qualify(nameOf(source, first), nameOf(source, second)) : qualify(null, nameOf(source, first));
    const close = bodyClose(source, tokens, bodyOpen(source, tokens, nameEnd + 1));
    if (close >= 0) {
      out.push({ table, start: t.start, end: tokens[close]!.end });
      i = close;
    } else {
      // Unterminated body: link the header only and let the depth count swallow what follows, so a
      // broken table never claims the declarations written after it.
      out.push({ table, start: t.start, end: tokens[nameEnd]!.end });
      i = nameEnd;
    }
  }
  return out;
}

/** Index of the `{` opening a body at token `j`, past an optional `as alias` and `[settings]`; -1 if the header has none. */
function bodyOpen(source: string, tokens: LexToken[], j: number): number {
  const alias = tokens[j];
  if (alias?.kind === 'ident' && source.slice(alias.start, alias.end).toLowerCase() === 'as' && isName(tokens[j + 1])) j += 2;
  if (isPunct(source, tokens[j], '[')) {
    while (j < tokens.length && !isPunct(source, tokens[j], ']')) j++;
    j++;
  }
  return isPunct(source, tokens[j], '{') ? j : -1;
}

/** Index of the `}` matching the `{` at `open`; -1 when `open` is -1 or the body never closes. */
function bodyClose(source: string, tokens: LexToken[], open: number): number {
  if (open < 0) return -1;
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    if (isPunct(source, tokens[k], '{')) depth++;
    else if (isPunct(source, tokens[k], '}') && --depth === 0) return k;
  }
  return -1;
}

function scanForTable(source: string, qualifiedName: string): number | null {
  const hit = findTableDeclarationRanges(source).find((r) => r.table === qualifiedName);
  return hit ? source.slice(0, hit.start).split('\n').length - 1 : null;
}

function qualify(schemaName: string | null, table: string): QualifiedName {
  return `${schemaName !== null && schemaName.length > 0 ? schemaName : 'public'}.${table}`;
}
