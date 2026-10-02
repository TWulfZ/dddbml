import { addDoubleQuoteIfNeeded } from '@dbml/core';
import type { ColumnRef, QualifiedName, RefOp, SchemaDeleteTarget } from '../shared/types';
import {
  contains, endpointColumns, endpointTable, findField, findTable, parseModel, refId, tableName,
  type Model, type ModelField, type ModelRef, type ModelTable, type ModelToken,
} from './dbmlModel';
import { deletionRange, eolOf, indentOf, isName, isPunct, lex, lineStart, nameOf, type LexToken } from './dbmlScan';
import { qualify, stableRefId, unquote } from './parser';
import { applyEdits, invertEdits, mergeDeletions, type OffsetEdit } from './textEdits';

/**
 * Spec 19: diagram intents → minimal text edits of the `.dbml`. Runs in the parse worker (it parses
 * with `@dbml/core`); the host only applies the result. Bytes outside the touched ranges are kept,
 * and every result is re-parsed before it is returned, so an edit never breaks the file.
 */

export type SchemaEditIntent =
  | { kind: 'addTable'; schema: string | null; table: string; group?: string }
  | { kind: 'addField'; table: QualifiedName }
  | { kind: 'addRef'; from: ColumnRef; to: ColumnRef; op: RefOp }
  | { kind: 'delete'; target: SchemaDeleteTarget };

/** An unsaved line the host inserts after the edit so the cursor lands ready to type. */
export interface CursorLine {
  /** Offset in the text the edits produce. */
  offset: number;
  text: string;
  /** Cursor position relative to `offset` once `text` is inserted. */
  cursor: number;
}

export type SchemaEditResult =
  | {
    ok: true;
    label: string;
    edits: OffsetEdit[];
    /** Edits that restore the source, in the offsets of the edited text. */
    inverse: OffsetEdit[];
    /** What a delete also removes, for the confirmation. */
    cascade: string[];
    /** The table an `addTable` creates. */
    table?: QualifiedName;
    cursorLine?: CursorLine;
  }
  | { ok: false; reason: string };

type Plan = Omit<Extract<SchemaEditResult, { ok: true }>, 'ok' | 'inverse'> & { verify?: (m: Model) => string | null };

export function computeSchemaEdit(source: string, intent: SchemaEditIntent): SchemaEditResult {
  const parsed = parseModel(source);
  if (!parsed.model) return fail(`the .dbml does not parse (${parsed.error}); fix it first`);
  const plan = planFor(source, parsed.model, intent);
  if (typeof plan === 'string') return fail(plan);
  const { verify, ...result } = plan;
  if (result.edits.length > 0) {
    const after = parseModel(applyEdits(source, result.edits));
    if (!after.model) return fail(`the change would leave the .dbml invalid (${after.error}); edit it in the editor instead`);
    const problem = verify?.(after.model);
    if (problem) return fail(problem);
  }
  return { ok: true, ...result, inverse: invertEdits(source, result.edits) };
}

function fail(reason: string): SchemaEditResult {
  return { ok: false, reason };
}

function planFor(src: string, model: Model, intent: SchemaEditIntent): Plan | string {
  switch (intent.kind) {
    case 'addTable': return planAddTable(src, model, intent.schema, intent.table, intent.group);
    case 'addField': return planAddField(src, model, intent.table);
    case 'addRef': return planAddRef(src, model, intent.from, intent.to, intent.op);
    case 'delete': {
      const t = intent.target;
      if (t.kind === 'table') return planDeleteTable(src, model, t.table);
      if (t.kind === 'field') return planDeleteField(src, model, t.table, t.column);
      return planDeleteRef(src, model, t.refId);
    }
  }
}

/* ----- add ----- */

function planAddTable(src: string, model: Model, schema: string | null, table: string, group: string | undefined): Plan | string {
  const name = qualify(schema, table);
  if (findTable(model, name)) return `a table named "${short(name)}" already exists`;
  const g = group === undefined ? undefined : model.groups.find((x) => unquote(x.name) === group);
  if (group !== undefined && !g) return `TableGroup "${group}" is not in the .dbml`;
  const eol = eolOf(src);
  const declared = schema === null ? quote(table) : `${quote(schema)}.${quote(table)}`;
  const lead = src.length === 0 ? '' : src.endsWith(eol + eol) || src === eol ? '' : src.endsWith(eol) ? eol : eol + eol;
  const head = `${lead}Table ${declared} {${eol}  id int [pk]${eol}`;
  const edits: OffsetEdit[] = [];
  if (g) edits.push(groupMemberInsert(src, g, schema === null || schema === 'public' ? quote(table) : declared));
  edits.push({ start: src.length, end: src.length, newText: `${head}}${eol}` });
  const shift = edits.length === 2 ? edits[0]!.newText.length : 0;
  return {
    label: `Add table ${short(name)}`,
    edits,
    cascade: [],
    table: name,
    cursorLine: { offset: src.length + shift + head.length, text: `  ${eol}`, cursor: 2 },
    verify: (m) => (findTable(m, name) ? null : `"${declared}" would not be read back as "${short(name)}"`),
  };
}

function groupMemberInsert(src: string, g: Model['groups'][number], member: string): OffsetEdit {
  const close = g.token.end.offset - 1;
  const memberToken = groupMembers(src, g)[0]?.tokens[0];
  const ownLine = memberToken !== undefined && /^[ \t]*$/.test(src.slice(lineStart(src, memberToken.start), memberToken.start));
  const indent = ownLine ? indentOf(src, memberToken.start) : '  ';
  const eol = eolOf(src);
  const ls = lineStart(src, close);
  if (/^[ \t]*$/.test(src.slice(ls, close))) return { start: ls, end: ls, newText: `${indent}${member}${eol}` };
  return { start: close, end: close, newText: `${eol}${indent}${member}${eol}` };
}

function planAddField(src: string, model: Model, table: QualifiedName): Plan | string {
  const t = findTable(model, table);
  if (!t) return `table "${short(table)}" is not in the .dbml`;
  const close = t.token.end.offset - 1;
  if (src[close] !== '}') return `could not find the end of table "${short(table)}"`;
  const own = t.fields.filter((f) => !f.injectedPartial);
  const last = own[own.length - 1];
  const indent = last ? indentOf(src, last.token.start.offset) || '  ' : '  ';
  const eol = eolOf(src);
  const ls = lineStart(src, close);
  const cursorLine: CursorLine = /^[ \t]*$/.test(src.slice(ls, close))
    ? { offset: ls, text: `${indent}${eol}`, cursor: indent.length }
    : { offset: close, text: `${eol}${indent}${eol}`, cursor: eol.length + indent.length };
  return { label: `Add field to ${short(table)}`, edits: [], cascade: [], cursorLine };
}

function planAddRef(src: string, model: Model, from: ColumnRef, to: ColumnRef, op: RefOp): Plan | string {
  const located = locateColumn(model, from);
  if (typeof located === 'string') return located;
  const target = locateColumn(model, to);
  if (typeof target === 'string') return target;
  const field = located.field;
  if (field.injectedPartial) return `${short(from.table)}.${from.column} comes from a TablePartial; add the reference in the editor`;
  const id = stableRefId(from.table, [from.column], to.table, [to.column]);
  if (model.refs.some((r) => refId(r) === id)) return `a reference between ${short(from.table)}.${from.column} and ${short(to.table)}.${to.column} already exists`;
  const setting = `ref: ${op} ${refTargetText(target.table, to.column)}`;
  const bracket = settingsBracket(src, field);
  const edit: OffsetEdit = !bracket
    ? { start: field.token.end.offset, end: field.token.end.offset, newText: ` [${setting}]` }
    : { start: bracket.close, end: bracket.close, newText: bracket.segments.length === 0 ? setting : `, ${setting}` };
  return {
    label: `Add reference ${short(from.table)}.${from.column} ${op} ${short(to.table)}.${to.column}`,
    edits: [edit],
    cascade: [],
    verify: (m) => (m.refs.some((r) => refId(r) === id) ? null : 'the new reference would not resolve to the chosen columns'),
  };
}

function locateColumn(model: Model, c: ColumnRef): { table: ModelTable; field: ModelField } | string {
  const table = findTable(model, c.table);
  if (!table) return `table "${short(c.table)}" is not in the .dbml`;
  const field = findField(table, c.column);
  if (!field) return `column "${short(c.table)}.${c.column}" is not in the .dbml`;
  return { table, field };
}

/** `public` is implied by unqualified endpoints (they resolve there in @dbml/core 10). */
function refTargetText(t: ModelTable, column: string): string {
  const schema = t.schema.name;
  const head = schema && schema !== 'public' ? `${quote(schema)}.` : '';
  return `${head}${quote(unquote(t.name))}.${quote(column)}`;
}

/* ----- delete ----- */

interface Removal {
  ranges: Array<{ start: number; end: number }>;
  /** Inline ref settings to drop, by owning field. */
  settings: Map<ModelField, Set<number>>;
  cascade: string[];
}

function planDeleteTable(src: string, model: Model, name: QualifiedName): Plan | string {
  const t = findTable(model, name);
  if (!t) return `table "${short(name)}" is not in the .dbml`;
  const removal: Removal = { ranges: [deletionRange(src, t.token.start.offset, t.token.end.offset)], settings: new Map(), cascade: [] };
  for (const r of model.refs) {
    if (!r.endpoints.some((e) => endpointTable(e) === name)) continue;
    const problem = removeRef(src, model, r, t.token, removal);
    if (problem) return problem;
  }
  for (const g of model.groups) {
    for (const m of groupMembers(src, g)) {
      if (!memberMatches(m.names, t)) continue;
      const first = m.tokens[0]!;
      const last = m.tokens[m.tokens.length - 1]!;
      removal.ranges.push(deletionRange(src, first.start, last.end));
      removal.cascade.push(`membership in TableGroup ${unquote(g.name)}`);
    }
  }
  return { label: `Delete table ${short(name)}`, edits: finish(src, removal), cascade: removal.cascade };
}

function planDeleteField(src: string, model: Model, table: QualifiedName, column: string): Plan | string {
  const located = locateColumn(model, { table, column });
  if (typeof located === 'string') return located;
  const { table: t, field } = located;
  const label = `${short(table)}.${column}`;
  if (field.injectedPartial) return `${label} comes from a TablePartial; remove it in the editor`;
  if (t.fields.length === 1) return `${label} is the only column of ${short(table)}; a table needs at least one`;
  const removal: Removal = { ranges: [deletionRange(src, field.token.start.offset, field.token.end.offset)], settings: new Map(), cascade: [] };
  for (const idx of t.indexes) {
    const cols = idx.columns.filter((c) => c.type === 'column').map((c) => unquote(c.value));
    if (!cols.includes(column)) continue;
    // Open question in spec 19 (default taken): a composite index is the user's to rewrite.
    if (idx.columns.length > 1) return `${label} is part of the composite index (${cols.join(', ')}); remove it from the index in the editor first`;
    removal.ranges.push(deletionRange(src, idx.token.start.offset, idx.token.end.offset));
    removal.cascade.push(`index on ${short(table)}(${column})`);
  }
  for (const r of model.refs) {
    if (!r.endpoints.some((e) => endpointTable(e) === table && endpointColumns(e).includes(column))) continue;
    const problem = removeRef(src, model, r, field.token, removal);
    if (problem) return problem;
  }
  return { label: `Delete field ${label}`, edits: finish(src, removal), cascade: removal.cascade };
}

function planDeleteRef(src: string, model: Model, id: string): Plan | string {
  const r = model.refs.find((x) => refId(x) === id);
  if (!r) return 'that reference is no longer in the .dbml';
  const removal: Removal = { ranges: [], settings: new Map(), cascade: [] };
  const problem = removeRef(src, model, r, null, removal);
  if (problem) return problem;
  return { label: `Delete reference ${describeRef(r)}`, edits: finish(src, removal), cascade: [] };
}

/**
 * Queues the removal of `r`; nothing to edit when it lies inside `within`, a range already being
 * deleted. Returns why it cannot be removed, if so.
 */
function removeRef(src: string, model: Model, r: ModelRef, within: ModelToken | null, out: Removal): string | null {
  out.cascade.push(`reference ${describeRef(r)}`);
  if (within && contains(within, r.token)) return null;
  const owner = model.tables.find((t) => contains(t.token, r.token));
  const field = owner?.fields.find((f) => contains(f.token, r.token));
  if (!field) {
    // An inline ref outside every table body sits in a TablePartial, shared by other tables.
    if (/[[,]\s*$/.test(src.slice(Math.max(0, r.token.start.offset - 200), r.token.start.offset))) {
      return `the reference ${describeRef(r)} is declared in a TablePartial; edit it in the editor`;
    }
    out.ranges.push(deletionRange(src, r.token.start.offset, r.token.end.offset));
    return null;
  }
  const bracket = settingsBracket(src, field);
  const idx = bracket?.segments.findIndex((s) => s.start <= r.token.start.offset && r.token.start.offset < s.end) ?? -1;
  if (idx < 0) return `could not find the reference ${describeRef(r)} in its column settings`;
  const set = out.settings.get(field) ?? new Set<number>();
  set.add(idx);
  out.settings.set(field, set);
  return null;
}

function finish(src: string, removal: Removal): OffsetEdit[] {
  for (const [field, drop] of removal.settings) {
    const bracket = settingsBracket(src, field);
    if (bracket) removal.ranges.push(...settingRemovals(src, bracket, drop));
  }
  return mergeDeletions(removal.ranges);
}

/** Many-to-one reads as `many > one` whichever way it was written. */
function describeRef(r: ModelRef): string {
  const [a, b] = r.endpoints;
  if (!a || !b) return r.name ?? 'reference';
  const end = (e: typeof a) => `${short(endpointTable(e))}.${endpointColumns(e).join(',')}`;
  const many = (e: typeof a) => e.relation === '*' || e.relation === 'many';
  if (many(a) && many(b)) return `${end(a)} <> ${end(b)}`;
  if (many(b)) return `${end(b)} > ${end(a)}`;
  return `${end(a)} ${many(a) ? '>' : '-'} ${end(b)}`;
}

/* ----- settings lists ----- */

interface Bracket {
  open: number;
  close: number;
  /** Top-level comma-separated settings, trimmed to their tokens. */
  segments: Array<{ start: number; end: number }>;
}

/**
 * The field's `[...]` settings list. A bracket glued to the type (`text[]`) is part of the type:
 * @dbml/core only accepts settings after whitespace.
 */
function settingsBracket(src: string, field: ModelField): Bracket | null {
  const tokens = lex(src, field.token.start.offset, field.token.end.offset).filter((t) => t.kind !== 'comment');
  let depth = 0;
  let open = -1;
  let last: { open: number; close: number } | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (isPunct(src, t, '[')) {
      if (depth === 0) open = i;
      depth++;
    } else if (isPunct(src, t, ']')) {
      depth--;
      if (depth === 0) last = { open, close: i };
    }
  }
  if (!last || last.close !== tokens.length - 1 || last.open === 0) return null;
  const openTok = tokens[last.open]!;
  if (tokens[last.open - 1]!.end === openTok.start) return null;
  const segments: Bracket['segments'] = [];
  let seg: LexToken[] = [];
  let nested = 0;
  const flush = (): void => {
    if (seg.length > 0) segments.push({ start: seg[0]!.start, end: seg[seg.length - 1]!.end });
    seg = [];
  };
  for (const t of tokens.slice(last.open + 1, last.close)) {
    if (isPunct(src, t, '(') || isPunct(src, t, '[')) nested++;
    else if (isPunct(src, t, ')') || isPunct(src, t, ']')) nested--;
    if (nested === 0 && isPunct(src, t, ',')) flush();
    else seg.push(t);
  }
  flush();
  return { open: openTok.start, close: tokens[last.close]!.start, segments };
}

/** Drops settings `drop` keeping the list's own separators; an emptied list goes with its brackets. */
function settingRemovals(src: string, b: Bracket, drop: Set<number>): Array<{ start: number; end: number }> {
  const n = b.segments.length;
  if ([...Array(n).keys()].every((i) => drop.has(i))) {
    let s = b.open;
    while (s > 0 && (src[s - 1] === ' ' || src[s - 1] === '\t')) s--;
    return [{ start: s, end: b.close + 1 }];
  }
  let keep = n - 1;
  while (drop.has(keep)) keep--;
  const out: Array<{ start: number; end: number }> = [];
  for (const i of drop) {
    if (i < keep) out.push({ start: b.segments[i]!.start, end: b.segments[i + 1]!.start });
  }
  if (keep < n - 1) {
    // Only the comma goes from the kept segment's line: whatever follows it (a `// comment`)
    // belongs to that line; the dropped tail goes with line semantics, its own comments included.
    const kept = b.segments[keep]!;
    const comma = lex(src, kept.end, b.segments[keep + 1]!.start).find((t) => isPunct(src, t, ','));
    if (comma) {
      let s = comma.start;
      while (s > kept.end && (src[s - 1] === ' ' || src[s - 1] === '\t')) s--;
      out.push({ start: s, end: comma.end });
    }
    out.push(deletionRange(src, b.segments[keep + 1]!.start, b.segments[n - 1]!.end));
  }
  return out;
}

/* ----- TableGroup members ----- */

interface GroupMember {
  tokens: LexToken[];
  /** `[table]` or `[schema, table]`, unquoted. */
  names: string[];
}

/** Member lines of a TableGroup body: a name or `schema.name` alone on its line (or next to a brace). */
function groupMembers(src: string, g: Model['groups'][number]): GroupMember[] {
  const tokens = lex(src, g.token.start.offset, g.token.end.offset).filter((t) => t.kind !== 'comment');
  const open = tokens.findIndex((t) => isPunct(src, t, '{'));
  if (open < 0) return [];
  const body = tokens.slice(open + 1, tokens.length - 1);
  const byLine = new Map<number, LexToken[]>();
  for (const t of body) {
    const ls = lineStart(src, t.start);
    byLine.set(ls, [...(byLine.get(ls) ?? []), t]);
  }
  const out: GroupMember[] = [];
  for (const line of byLine.values()) {
    const [a, dot, b] = line;
    if (line.length === 1 && isName(a)) out.push({ tokens: line, names: [nameOf(src, a)] });
    else if (line.length === 3 && isName(a) && isPunct(src, dot, '.') && isName(b)) out.push({ tokens: line, names: [nameOf(src, a), nameOf(src, b)] });
  }
  return out;
}

function memberMatches(names: string[], t: ModelTable): boolean {
  if (names.length === 2) return qualify(names[0], names[1]!) === tableName(t);
  const n = names[0]!;
  return qualify(null, n) === tableName(t) || (t.alias !== null && unquote(t.alias) === n);
}

/* ----- names ----- */

function quote(name: string): string {
  return addDoubleQuoteIfNeeded(name);
}

function short(name: QualifiedName): string {
  return name.startsWith('public.') ? name.slice('public.'.length) : name;
}
