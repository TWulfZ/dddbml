import type { EdgeLayout, GroupLayout, Layout, TableLayout } from '../shared/types';

/**
 * Pure 3-way merge of the SHARED layout sections (tables, groups, edges) keyed by
 * their stable identity (qualified table name / group name / edge ref id). No git,
 * no vscode — so it is trivially unit-testable.
 *
 * Per key, with base = common ancestor, ours = local, theirs = incoming:
 *   - both sides equal            -> that value          (incl. both-added-equal, both-deleted)
 *   - only theirs changed         -> theirs              (covers theirs-added)
 *   - only ours changed           -> ours                (covers ours-added)
 *   - both changed differently    -> CONFLICT            (also add/add-different, edit/delete)
 *
 * Per-user view-state (viewport, hidden, collapsed) is NEVER merged here — it does
 * not live in the git file. `viewport` of the result is carried from `ours`.
 */

export type ConflictSection = 'tables' | 'groups' | 'edges';

export interface MergeConflict {
  section: ConflictSection;
  key: string;
  /** Value on the common-ancestor side (undefined = absent in base). */
  base?: unknown;
  /** Local value (undefined = deleted locally). */
  ours?: unknown;
  /** Incoming value (undefined = deleted by them). */
  theirs?: unknown;
}

export interface MergeResult {
  /** Auto-resolved layout; conflicted keys are provisionally left as OURS. */
  merged: Layout;
  conflicts: MergeConflict[];
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

function mergeSection<T>(
  section: ConflictSection,
  base: Record<string, T>,
  ours: Record<string, T>,
  theirs: Record<string, T>,
  out: Record<string, T>,
  conflicts: MergeConflict[],
): void {
  const keys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
  for (const k of keys) {
    const b = base[k];
    const o = ours[k];
    const t = theirs[k];
    if (deepEqual(o, t)) {
      if (o !== undefined) out[k] = o; // both sides agree (incl. both-deleted -> stays absent)
    } else if (deepEqual(b, o)) {
      if (t !== undefined) out[k] = t; // only theirs changed
    } else if (deepEqual(b, t)) {
      if (o !== undefined) out[k] = o; // only ours changed
    } else {
      conflicts.push({ section, key: k, base: b, ours: o, theirs: t });
      if (o !== undefined) out[k] = o; // provisional: ours-biased so a cancelled resolution is valid
    }
  }
}

export function mergeThreeWay(base: Layout, ours: Layout, theirs: Layout): MergeResult {
  const conflicts: MergeConflict[] = [];
  const tables: Record<string, TableLayout> = {};
  const groups: Record<string, GroupLayout> = {};
  const edges: Record<string, EdgeLayout> = {};

  mergeSection('tables', base.tables, ours.tables, theirs.tables, tables, conflicts);
  mergeSection('groups', base.groups, ours.groups, theirs.groups, groups, conflicts);
  mergeSection('edges', base.edges ?? {}, ours.edges ?? {}, theirs.edges ?? {}, edges, conflicts);

  const merged: Layout = { version: 1, viewport: ours.viewport, tables, groups, edges };
  return { merged, conflicts };
}
