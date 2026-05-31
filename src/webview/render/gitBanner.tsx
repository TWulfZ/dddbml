import { store, useAppStore } from '../state/store';
import { postToHost } from '../vscode';
import { Button } from '../ui/Button';
import { IconHistory, IconDiff, IconClose, IconChevronRight } from '../icons';
import { fitToBbox } from './viewport';
import type { DiffTarget } from './diffHitLayer';

/**
 * Canvas-level read-only bar (spec 16), shown while a git overlay is active (`gitView != null`).
 * Like the merge bar it floats over the diagram (not a modal); the canvas behind it is read-only.
 * Time-travel shows the commit label; diff shows base→current, prev/next camera nav over the
 * changes, and a "Blur background tables" toggle to focus the diff. English-only UI.
 */
export function GitBanner({ diffTargets = [] }: { diffTargets?: DiffTarget[] }) {
  const gitView = useAppStore((s) => s.gitView);
  const blur = useAppStore((s) => s.diffBlurBackground);
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
  const next = () => n && focus((cursor + 1) % n);
  const prev = () => n && focus((cursor - 1 + n) % n);

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
          <span class="ddd-git-bar__count" aria-live="polite">{Math.min(cursor + 1, n)} / {n}</span>
          <Button variant="history" size="tool" onClick={next} title="Next change" aria-label="Next change">
            <IconChevronRight size={14} />
          </Button>
        </span>
      ) : null}
      <label class="ddd-git-bar__check">
        <input
          type="checkbox"
          checked={blur}
          onChange={(e) => store.getState().setDiffBlurBackground((e.currentTarget as HTMLInputElement).checked)}
        />
        Blur background tables
      </label>
      <Button variant="secondary" size="sm" onClick={() => store.getState().exitGitView()}>
        <IconClose size={12} /> Exit
      </Button>
    </div>
  );
}
