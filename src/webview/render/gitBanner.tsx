import { store, useAppStore } from '../state/store';
import { postToHost } from '../vscode';
import { Button } from '../ui/Button';
import { IconHistory, IconDiff, IconClose, IconChevronRight } from '../icons';
import { fitToBbox } from './viewport';
import type { QualifiedName, Table, TableDiffStatus } from '../../shared/types';
import type { DiffGhost } from '../state/store';
import { estimateSize } from '../layout/autoLayout';
import { liveViewBox, type DiffViewFilters } from './diffGhosts';

/** A change location (table or removed-ghost bbox) the banner's prev/next nav flies the camera to. */
export interface DiffTarget {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function buildDiffTargets(
  diffByTable: Map<QualifiedName, TableDiffStatus> | null,
  diffGhosts: DiffGhost[] | null,
  positions: Map<QualifiedName, { x: number; y: number }>,
  tablesByName: Map<QualifiedName, Table>,
  filters: DiffViewFilters,
): DiffTarget[] {
  const targets: DiffTarget[] = [];
  const seen = new Set<string>();
  if (diffByTable) {
    for (const [name] of diffByTable) {
      const v = liveViewBox(name, positions, tablesByName, filters);
      if (!v || seen.has(v.node)) continue;
      seen.add(v.node);
      targets.push({ name, ...v.box });
    }
  }
  if (diffGhosts) {
    for (const g of diffGhosts) {
      const s = estimateSize(g.table.columns.length);
      targets.push({ name: g.table.name, x: g.pos.x, y: g.pos.y, w: s.width, h: s.height });
    }
  }
  return targets.sort((a, b) => a.name.localeCompare(b.name));
}

/** Next/prev change index. A cursor outside [0, n) means "nothing focused yet" (fresh diff, or the
 *  target list shrank), so Next starts at the first change and Prev at the last. */
export function diffNavIndex(cursor: number, n: number, dir: 1 | -1): number {
  if (cursor < 0 || cursor >= n) return dir === 1 ? 0 : n - 1;
  return (cursor + dir + n) % n;
}

/**
 * Canvas-level read-only bar (spec 16), shown while a git overlay is active (`gitView != null`).
 * Like the merge bar it floats over the diagram (not a modal); the canvas behind it is read-only.
 * Time-travel shows the commit label; diff shows base→current, prev/next camera nav over the
 * changes, and a "Blur background tables" toggle to focus the diff. English-only UI.
 */
export function GitBanner({ diffTargets = [] }: { diffTargets?: DiffTarget[] }) {
  const gitView = useAppStore((s) => s.gitView);
  const blur = useAppStore((s) => s.focusDimming);
  const cursor = useAppStore((s) => s.diffCursor);
  if (!gitView) return null;

  if (gitView.kind === 'timeTravel') {
    return (
      <div class="ddd-git-bar" role="status" aria-label="Viewing an earlier revision (read-only)">
        <IconHistory size={14} />
        <span class="ddd-git-bar__label">
          Viewing <strong>{gitView.label}</strong> · read-only
        </span>
        <Button variant="secondary" size="sm" onClick={() => postToHost({ type: 'git:timeTravel:exit' })}>
          <IconClose size={12} /> Exit
        </Button>
      </div>
    );
  }

  const focus = (i: number) => {
    const t = diffTargets[i];
    if (!t) return;
    store.getState().setDiffCursor(i);
    fitToBbox({ x: t.x, y: t.y, w: t.w, h: t.h });
  };
  const n = diffTargets.length;
  const next = () => n && focus(diffNavIndex(cursor, n, 1));
  const prev = () => n && focus(diffNavIndex(cursor, n, -1));

  return (
    <div class="ddd-git-bar" role="status" aria-label="Diff view (read-only)">
      <IconDiff size={14} />
      <span class="ddd-git-bar__label">
        Diff <strong>{gitView.baseLabel}</strong> → <strong>{gitView.headLabel}</strong>
      </span>
      {n > 0 ? (
        <span class="ddd-git-bar__nav">
          <Button variant="history" size="tool" onClick={prev} title="Previous change" aria-label="Previous change">
            <IconChevronRight flipX size={14} />
          </Button>
          <span class="ddd-git-bar__count" aria-live="polite">{cursor >= 0 && cursor < n ? cursor + 1 : '–'} / {n}</span>
          <Button variant="history" size="tool" onClick={next} title="Next change" aria-label="Next change">
            <IconChevronRight size={14} />
          </Button>
        </span>
      ) : null}
      <label class="ddd-git-bar__check">
        <input
          type="checkbox"
          checked={blur}
          onChange={(e) => store.getState().setFocusDimming((e.currentTarget as HTMLInputElement).checked)}
        />
        Blur background tables
      </label>
      <Button variant="secondary" size="sm" onClick={() => postToHost({ type: 'git:diff:exit' })}>
        <IconClose size={12} /> Exit
      </Button>
    </div>
  );
}
