import type * as vscode from 'vscode';
import type { Layout, SerializableMergeConflict } from '../shared/types';
import { emptyLayout, parseLayout, sidecarUri } from './layoutStore';
import { getRepoRoot, getUnmergedStages, showStage, toRepoRelative } from './gitStages';
import { mergeThreeWay, type ConflictSection, type MergeConflict } from './mergeThreeWay';

/**
 * Result of inspecting a git-conflicted sidecar: the provisional auto-merge (ours-biased
 * on the genuine conflicts) plus the conflicts that still need a human decision. NOTHING is
 * written here — the file keeps its conflict markers until the user resolves in the webview,
 * so closing the panel mid-merge re-triggers the resolver on reopen (instead of the old
 * QuickPick, which wrote a marker-free file on cancel and destroyed its own trigger).
 */
export interface SidecarConflict {
  merged: Layout;
  conflicts: MergeConflict[];
  repoRoot: string;
  relpath: string;
}

/**
 * Reads the three clean versions from git's merge index (stages 1/2/3) and runs the pure
 * per-key 3-way merge — WITHOUT a merge driver or any user git config. Throws if the file is
 * not inside a git repo / unmerged state, so the caller can keep the last good in-memory
 * layout instead of wiping it. Does not write or stage anything (see {@link applyDecisions}).
 */
export async function detectSidecarConflict(dbmlUri: vscode.Uri): Promise<SidecarConflict> {
  const sidecar = sidecarUri(dbmlUri);
  const repoRoot = await getRepoRoot(sidecar.fsPath);
  if (!repoRoot) throw new Error('dddbml: layout conflict but no git repository found');
  const relpath = toRepoRelative(repoRoot, sidecar.fsPath);

  const stages = await getUnmergedStages(repoRoot, relpath);
  if (stages.size === 0) throw new Error('dddbml: layout file is not in a git-unmerged state');

  const base = stages.has(1) ? parseLayout((await showStage(repoRoot, 1, relpath)) ?? '') : emptyLayout();
  const ours = stages.has(2) ? parseLayout((await showStage(repoRoot, 2, relpath)) ?? '') : emptyLayout();
  const theirs = stages.has(3) ? parseLayout((await showStage(repoRoot, 3, relpath)) ?? '') : emptyLayout();

  const { merged, conflicts } = mergeThreeWay(base, ours, theirs);
  return { merged, conflicts, repoRoot, relpath };
}

/** Stable conflict id used to key the webview's decision map. */
export function conflictId(section: ConflictSection, key: string): string {
  return `${section}::${key}`;
}

/**
 * Project the host-side conflicts into the postMessage-safe display shape. Absent/deleted
 * sides become `null` (NOT `undefined` — VS Code's postMessage drops undefined keys).
 */
export function toSerializableConflicts(conflicts: MergeConflict[]): SerializableMergeConflict[] {
  return conflicts.map((c) => ({
    id: conflictId(c.section, c.key),
    section: c.section,
    key: c.key,
    ours: (c.ours ?? null) as SerializableMergeConflict['ours'],
    theirs: (c.theirs ?? null) as SerializableMergeConflict['theirs'],
  }));
}

/**
 * Pure: apply the user's per-conflict decisions onto a clone of the provisional merge.
 * A missing decision falls back to `ours` (matches the provisional bias), so a partial map
 * still yields a valid layout. No IO — the caller writes + `git add`s the result.
 */
export function applyDecisions(
  merged: Layout,
  conflicts: MergeConflict[],
  decisions: Record<string, 'ours' | 'theirs'>,
): Layout {
  const layout = cloneLayout(merged);
  for (const c of conflicts) {
    const side = decisions[conflictId(c.section, c.key)] ?? 'ours';
    applySide(layout, c, side);
  }
  return layout;
}

export function countKeys(l: Layout): number {
  return Object.keys(l.tables).length + Object.keys(l.groups).length + Object.keys(l.edges ?? {}).length;
}

function cloneLayout(l: Layout): Layout {
  return {
    version: 1,
    viewport: l.viewport,
    tables: { ...l.tables },
    groups: { ...l.groups },
    edges: { ...(l.edges ?? {}) },
  };
}

function sectionRecord(layout: Layout, section: ConflictSection): Record<string, unknown> {
  if (section === 'tables') return layout.tables as Record<string, unknown>;
  if (section === 'groups') return layout.groups as Record<string, unknown>;
  if (!layout.edges) layout.edges = {};
  return layout.edges as Record<string, unknown>;
}

function applySide(layout: Layout, c: MergeConflict, side: 'ours' | 'theirs'): void {
  const rec = sectionRecord(layout, c.section);
  const val = side === 'ours' ? c.ours : c.theirs;
  if (val === undefined) delete rec[c.key];
  else rec[c.key] = val;
}
