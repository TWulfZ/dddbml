import type { GroupLayout, SerializableMergeConflict } from '../../shared/types';
import { store, useAppStore } from '../state/store';
import { postToHost } from '../vscode';
import { Button } from '../ui/Button';
import { cn } from '../ui/cn';
import { MergeStepper } from './mergeStepper';

/**
 * Blocking conflict-resolution bar (spec 14 §Tier-3). Shown while `mergeConflicts != null`; the
 * diagram behind it is read-only (pan/zoom only). A progress spine (bar + count pill) + a segmented
 * toggle drive two views: **Review all** (table conflicts picked on-canvas via ghosts + group/edge
 * rows here) and **Step through** (one diff at a time, camera-focused — see `MergeStepper`). A single
 * shared footer (bulk keep-all + `Apply`) renders in both views; `Apply` is enabled only once every
 * conflict has a decision — then one post writes the clean sidecar + `git add`.
 */
export function MergePanel() {
  const conflicts = useAppStore((s) => s.mergeConflicts);
  const decisions = useAppStore((s) => s.mergeDecisions);
  const applying = useAppStore((s) => s.mergeApplying);
  const view = useAppStore((s) => s.mergeView);

  if (!conflicts) return null;

  const total = conflicts.length;
  const resolved = conflicts.filter((c) => decisions[c.id] != null).length;
  const allResolved = resolved === total;
  const tableCount = conflicts.filter((c) => c.section === 'tables').length;
  const rows = conflicts.filter((c) => c.section !== 'tables');
  const pct = total ? Math.round((resolved / total) * 100) : 0;

  const apply = () => {
    if (!allResolved || applying) return;
    store.getState().setMergeApplying(true);
    postToHost({ type: 'merge:resolve', payload: { decisions } });
  };

  return (
    <div class="ddd-merge-bar" role="dialog" aria-label="Resolve layout merge conflicts">
      <div class="ddd-merge-bar__head">
        <span class="ddd-merge-bar__title">Layout merge — {total} conflict{total === 1 ? '' : 's'}</span>
        <span class="ddd-merge-bar__count" aria-live="polite">{resolved}/{total} resolved</span>
      </div>

      <div class="ddd-merge-progress" role="presentation">
        <div class="ddd-merge-progress__fill" data-complete={allResolved || undefined} style={`--ddd-merge-pct:${pct}%`} />
      </div>

      <div class="ddd-merge-bar__tabs" role="tablist">
        <Button variant="action" size="sm" role="tab" aria-selected={view === 'all'} active={view === 'all'} onClick={() => store.getState().setMergeView('all')}>Review all</Button>
        <Button variant="action" size="sm" role="tab" aria-selected={view === 'step'} active={view === 'step'} onClick={() => store.getState().setMergeView('step')}>Step through</Button>
      </div>

      {view === 'step' ? (
        <MergeStepper />
      ) : (
        <>
          {tableCount > 0 ? (
            <p class="ddd-merge-bar__hint">
              {tableCount} table position{tableCount === 1 ? '' : 's'} — click a ghost on the canvas, or use <em>Step through</em> to walk them. Kept lights up; the other turns red = discarded.
            </p>
          ) : null}
          {rows.length > 0 ? (
            <div class="ddd-merge-bar__rows">
              {rows.map((c) => (
                <ConflictRow key={c.id} conflict={c} decided={decisions[c.id]} />
              ))}
            </div>
          ) : null}
        </>
      )}

      <div class="ddd-merge-bar__footer">
        <Button variant="secondary" size="sm" onClick={() => store.getState().setMergeDecisionsBulk('ours')}>Keep all mine</Button>
        <Button variant="secondary" size="sm" onClick={() => store.getState().setMergeDecisionsBulk('theirs')}>Take all theirs</Button>
        <Button class="ddd-merge-bar__apply" variant="primary" size="md" disabled={!allResolved || applying} onClick={apply}>
          {applying ? 'Applying…' : allResolved ? `Apply (${total})` : `Apply (${resolved}/${total})`}
        </Button>
      </div>
    </div>
  );
}

function ConflictRow({ conflict, decided }: { conflict: SerializableMergeConflict; decided: 'ours' | 'theirs' | undefined }) {
  const noun = conflict.section === 'groups' ? 'group' : 'edge';
  const pick = (side: 'ours' | 'theirs') => store.getState().setMergeDecision(conflict.id, side);
  const oursColor = colorOf(conflict.ours);
  const theirsColor = colorOf(conflict.theirs);
  return (
    <div class="ddd-merge-bar__row">
      <span class="ddd-merge-bar__row-label" title={`${noun} ${conflict.key}`}>
        <span class="ddd-merge-bar__row-noun">{noun}</span> {conflict.key}
      </span>
      <div class="ddd-merge-bar__row-choices">
        <Button variant="action" size="sm" active={decided === 'ours'} class={sideClass(decided, 'ours')} onClick={() => pick('ours')}>
          {oursColor ? <span class="ddd-merge-bar__swatch" style={{ background: oursColor }} /> : null}
          <span class="ddd-merge-side__cap">mine</span>
          <span class="ddd-merge-side__mark" aria-hidden="true">✓</span>
        </Button>
        <Button variant="action" size="sm" active={decided === 'theirs'} class={sideClass(decided, 'theirs')} onClick={() => pick('theirs')}>
          {theirsColor ? <span class="ddd-merge-bar__swatch" style={{ background: theirsColor }} /> : null}
          <span class="ddd-merge-side__cap">theirs</span>
          <span class="ddd-merge-side__mark" aria-hidden="true">✓</span>
        </Button>
      </div>
    </div>
  );
}

/** kept = chosen side (Button's accent fill owns the highlight; we add a tick); cut = the other side
 *  once a decision exists (struck + danger CAP); undecided = neutral (no class). */
export function sideClass(decided: 'ours' | 'theirs' | undefined, side: 'ours' | 'theirs', extra?: string): string {
  return cn(
    'ddd-merge-side',
    decided === side && 'ddd-merge-side--kept',
    decided && decided !== side && 'ddd-merge-side--cut',
    extra,
  );
}

/** Best-effort color preview for a group conflict side (null = deleted / no color). */
function colorOf(v: SerializableMergeConflict['ours']): string | null {
  if (v && typeof v === 'object' && 'color' in v) return (v as GroupLayout).color ?? null;
  return null;
}
