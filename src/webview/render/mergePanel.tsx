import { useState } from 'preact/hooks';
import type { GroupLayout, SerializableMergeConflict } from '../../shared/types';
import { store, useAppStore } from '../state/store';
import { postToHost } from '../vscode';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { Modal } from '../ui/Modal';
import { cn } from '../ui/cn';
import { MergeStepper } from './mergeStepper';

/** Git-style side labels — `ours`=current (HEAD), `theirs`=incoming. The store keys stay ours/theirs;
 *  only the user-facing words change so the model matches an editor merge conflict. */
export const SIDE_LABEL: Record<'ours' | 'theirs', string> = { ours: 'current', theirs: 'incoming' };

/**
 * Blocking conflict-resolution bar (spec 14 §Tier-3). Shown while `mergeConflicts != null`; the
 * diagram behind it is read-only (pan/zoom only). A progress spine (count pill + bar) + a segmented
 * toggle drive two views: **Review all** (table conflicts picked on-canvas via ghosts + group/edge
 * rows here) and **Step through** (one diff at a time, camera-focused — see `MergeStepper`). A single
 * shared footer holds bulk keep-all + `Apply`; the panel keeps a stable width so toggling views does
 * not jump. `Apply` opens a confirm dialog (the only place the conflict count is restated) and is the
 * sole step that writes the clean sidecar + `git add`.
 */
export function MergePanel() {
  const conflicts = useAppStore((s) => s.mergeConflicts);
  const decisions = useAppStore((s) => s.mergeDecisions);
  const applying = useAppStore((s) => s.mergeApplying);
  const view = useAppStore((s) => s.mergeView);
  const [confirm, setConfirm] = useState(false);

  if (!conflicts) return null;

  const total = conflicts.length;
  const resolved = conflicts.filter((c) => decisions[c.id] != null).length;
  const allResolved = resolved === total;
  const tableCount = conflicts.filter((c) => c.section === 'tables').length;
  const rows = conflicts.filter((c) => c.section !== 'tables');
  const pct = total ? Math.round((resolved / total) * 100) : 0;

  const doApply = () => {
    if (!allResolved || applying) return;
    setConfirm(false);
    store.getState().setMergeApplying(true);
    postToHost({ type: 'merge:resolve', payload: { decisions } });
  };

  return (
    <div class="ddd-merge-bar" role="dialog" aria-label="Resolve layout merge conflicts">
      <div class="ddd-merge-bar__head">
        <span class="ddd-merge-bar__title">Layout merge</span>
        <span class="ddd-merge-bar__count" aria-live="polite">{resolved}/{total} resolved</span>
      </div>

      <div class="ddd-merge-progress" role="presentation">
        <div class="ddd-merge-progress__fill" data-complete={allResolved || undefined} style={`--ddd-merge-pct:${pct}%`} />
      </div>

      <div class="ddd-merge-bar__tabs" role="tablist">
        <Button variant="action" size="sm" role="tab" aria-selected={view === 'all'} active={view === 'all'} onClick={() => store.getState().setMergeView('all')}>Review all</Button>
        <Button variant="action" size="sm" role="tab" aria-selected={view === 'step'} active={view === 'step'} onClick={() => store.getState().setMergeView('step')}>Step through</Button>
      </div>

      <div class="ddd-merge-bar__body">
        {view === 'step' ? (
          <MergeStepper />
        ) : (
          <>
            {tableCount > 0 ? (
              <p class="ddd-merge-bar__hint">
                Table positions — click a ghost on the canvas, or use <em>Step through</em>. Kept lights up; the other turns red = discarded.
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
      </div>

      <div class="ddd-merge-bar__footer">
        <Tooltip label="Keep all current">
          <Button variant="secondary" size="sm" class="ddd-merge-bulk" onClick={() => store.getState().setMergeDecisionsBulk('ours')}>
            <span class="ddd-merge-bulk__all">All</span>
            <span class="ddd-merge-bulk__sym">{'<<<'}</span>
          </Button>
        </Tooltip>
        <Tooltip label="Take all incoming">
          <Button variant="secondary" size="sm" class="ddd-merge-bulk" onClick={() => store.getState().setMergeDecisionsBulk('theirs')}>
            <span class="ddd-merge-bulk__all">All</span>
            <span class="ddd-merge-bulk__sym">{'>>>'}</span>
          </Button>
        </Tooltip>
        <Button class="ddd-merge-bar__apply" variant="primary" size="md" disabled={!allResolved || applying} onClick={() => setConfirm(true)}>
          {applying ? 'Applying…' : 'Apply'}
        </Button>
      </div>

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Apply layout merge"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="primary" onClick={doApply}>Apply {total}</Button>
          </>
        }
      >
        <p>
          Write the merged layout and stage it (git add) with your {total} resolution{total === 1 ? '' : 's'}.
          The discarded side stays recoverable through Git.
        </p>
      </Modal>
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
          <span class="ddd-merge-side__cap">{SIDE_LABEL.ours}</span>
        </Button>
        <Button variant="action" size="sm" active={decided === 'theirs'} class={sideClass(decided, 'theirs')} onClick={() => pick('theirs')}>
          {theirsColor ? <span class="ddd-merge-bar__swatch" style={{ background: theirsColor }} /> : null}
          <span class="ddd-merge-side__cap">{SIDE_LABEL.theirs}</span>
        </Button>
      </div>
    </div>
  );
}

/** Discarded side (a decision exists and it's not this one) → struck + danger cap. The chosen side's
 *  highlight is the Button's own `active` accent fill (no extra class), so the two never collide. */
export function sideClass(decided: 'ours' | 'theirs' | undefined, side: 'ours' | 'theirs', extra?: string): string {
  return cn('ddd-merge-side', decided && decided !== side && 'ddd-merge-side--cut', extra);
}

/** Best-effort color preview for a group conflict side (null = deleted / no color). */
function colorOf(v: SerializableMergeConflict['ours']): string | null {
  if (v && typeof v === 'object' && 'color' in v) return (v as GroupLayout).color ?? null;
  return null;
}
