/**
 * Offset-based text edits shared by the parse worker (which computes them) and the host (which
 * applies them to a `TextDocument`). Pure and free of `@dbml/core`, so the host bundle can import it.
 */

/** Replaces `[start, end)` (UTF-16 offsets into the text it was computed against) with `newText`. */
export interface OffsetEdit {
  start: number;
  end: number;
  newText: string;
}

function sorted(edits: readonly OffsetEdit[]): OffsetEdit[] {
  return [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Edits must not overlap (touching is fine); they are all relative to `text`. */
export function applyEdits(text: string, edits: readonly OffsetEdit[]): string {
  let out = '';
  let at = 0;
  for (const e of sorted(edits)) {
    if (e.start < at) throw new Error('overlapping text edits');
    out += text.slice(at, e.start) + e.newText;
    at = e.end;
  }
  return out + text.slice(at);
}

/** The edits that turn `applyEdits(text, edits)` back into `text`, in that result's offsets. */
export function invertEdits(text: string, edits: readonly OffsetEdit[]): OffsetEdit[] {
  let delta = 0;
  return sorted(edits).map((e) => {
    const start = e.start + delta;
    delta += e.newText.length - (e.end - e.start);
    return { start, end: start + e.newText.length, newText: text.slice(e.start, e.end) };
  });
}

/** One edit spanning the region where `from` and `to` differ; empty when they are equal. */
export function diffEdit(from: string, to: string): OffsetEdit[] {
  if (from === to) return [];
  const max = Math.min(from.length, to.length);
  let p = 0;
  while (p < max && from.charCodeAt(p) === to.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && from.charCodeAt(from.length - 1 - s) === to.charCodeAt(to.length - 1 - s)) s++;
  return [{ start: p, end: from.length - s, newText: to.slice(p, to.length - s) }];
}

/**
 * Deletions only: sorts and unions overlapping or touching ranges, so independently computed
 * cascades (a block, a ref inside a settings list, a group member line) never overlap.
 */
export function mergeDeletions(ranges: ReadonlyArray<{ start: number; end: number }>): OffsetEdit[] {
  const out: OffsetEdit[] = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end, newText: '' });
  }
  return out;
}

/**
 * `edits` re-expressed for the text with `length` characters inserted at `at`: an edit whose range
 * holds `at` grows over the insertion (so an undo also removes it), later edits shift.
 */
export function growOverInsertion(edits: readonly OffsetEdit[], at: number, length: number): OffsetEdit[] {
  return edits.map((e) => {
    if (e.end < at) return e;
    if (e.start <= at) return { ...e, end: e.end + length };
    return { ...e, start: e.start + length, end: e.end + length };
  });
}
