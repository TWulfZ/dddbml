/**
 * A minimal DBML lexer for locating text the parser's tokens do not cover (settings separators,
 * TableGroup member lines, declaration names). Comments and strings are recognised so a `}` or a
 * table name inside them is never mistaken for code. Pure, no `@dbml/core`.
 */

export type LexKind = 'ident' | 'quoted' | 'string' | 'comment' | 'punct';

export interface LexToken {
  kind: LexKind;
  start: number;
  end: number;
}

const IDENT_CHAR = /[\p{L}\p{N}_]/u;

/** Tokens of `src[from, to)`; whitespace is skipped. A string left open runs to `to`. */
export function lex(src: string, from = 0, to = src.length): LexToken[] {
  const out: LexToken[] = [];
  let i = from;
  while (i < to) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    const start = i;
    if (c === '/' && src[i + 1] === '/') {
      while (i < to && src[i] !== '\n' && src[i] !== '\r') i++;
      out.push({ kind: 'comment', start, end: i });
    } else if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close < 0 || close + 2 > to ? to : close + 2;
      out.push({ kind: 'comment', start, end: i });
    } else if (src.startsWith("'''", i)) {
      i = closeQuote(src, i + 3, to, "'''");
      out.push({ kind: 'string', start, end: i });
    } else if (c === "'" || c === '`' || c === '"') {
      i = closeQuote(src, i + 1, to, c);
      out.push({ kind: c === '"' ? 'quoted' : 'string', start, end: i });
    } else if (IDENT_CHAR.test(c)) {
      while (i < to && IDENT_CHAR.test(src[i]!)) i++;
      out.push({ kind: 'ident', start, end: i });
    } else {
      i++;
      out.push({ kind: 'punct', start, end: i });
    }
  }
  return out;
}

function closeQuote(src: string, i: number, to: number, quote: string): number {
  while (i < to) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src.startsWith(quote, i)) return i + quote.length;
    i++;
  }
  return to;
}

export function tokenText(src: string, t: LexToken): string {
  return src.slice(t.start, t.end);
}

export function isPunct(src: string, t: LexToken | undefined, ch: string): boolean {
  return t !== undefined && t.kind === 'punct' && src[t.start] === ch;
}

/** The identifier a name token spells: quotes stripped from `"…"`. */
export function nameOf(src: string, t: LexToken): string {
  const s = tokenText(src, t);
  return t.kind === 'quoted' ? s.slice(1, -1) : s;
}

export function isName(t: LexToken | undefined): t is LexToken {
  return t !== undefined && (t.kind === 'ident' || t.kind === 'quoted');
}

export function lineStart(src: string, offset: number): number {
  const nl = src.lastIndexOf('\n', offset - 1);
  return nl + 1;
}

/** Offset of the line break ending the line that holds `offset` (or the text length). */
export function lineEnd(src: string, offset: number): number {
  let i = offset;
  while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++;
  return i;
}

/** Start of the line after the one holding `offset`, past its `\n` or `\r\n` (or the text length). */
export function nextLineStart(src: string, offset: number): number {
  const end = lineEnd(src, offset);
  if (src[end] === '\r' && src[end + 1] === '\n') return end + 2;
  return end < src.length ? end + 1 : end;
}

export function isBlank(s: string): boolean {
  return s.trim().length === 0;
}

/** The text's dominant line break, so inserted lines match the file. */
export function eolOf(src: string): string {
  return src.includes('\r\n') ? '\r\n' : '\n';
}

export function indentOf(src: string, offset: number): string {
  const start = lineStart(src, offset);
  return /^[ \t]*/.exec(src.slice(start, offset))?.[0] ?? '';
}

/**
 * The range that removes `[start, end)`: the whole line(s) when nothing but whitespace or a trailing
 * comment shares them (so no blank husk is left), otherwise just the span and the spaces before it.
 * A removed block between two blank lines (or a file edge) also takes one of them, so deleting a
 * table does not leave a double gap.
 */
export function deletionRange(src: string, start: number, end: number): { start: number; end: number } {
  const ls = lineStart(src, start);
  const le = lineEnd(src, end);
  const before = src.slice(ls, start);
  const after = lex(src, end, le);
  if (!isBlank(before) || after.some((t) => t.kind !== 'comment')) {
    let s = start;
    while (s > ls && (src[s - 1] === ' ' || src[s - 1] === '\t')) s--;
    return { start: s, end };
  }
  let s = ls;
  let e = nextLineStart(src, end);
  const prevBlank = s === 0 || isBlank(src.slice(lineStart(src, s - 1), s));
  if (!prevBlank) return { start: s, end: e };
  if (e < src.length && isBlank(src.slice(e, lineEnd(src, e)))) {
    e = nextLineStart(src, e);
  } else if (e >= src.length && s > 0) {
    s = lineStart(src, s - 1);
  }
  return { start: s, end: e };
}
