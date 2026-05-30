import type { GroupLayout, SerializableMergeConflict } from '../../shared/types';
import { store, useAppStore } from '../state/store';
import { postToHost } from '../vscode';
import { Button } from '../ui/Button';

/**
 * Blocking conflict-resolution bar (spec 14 §Tier-3). Shown while `mergeConflicts != null`; the
 * diagram behind it is read-only (pan/zoom only). Table conflicts are picked on the canvas via
 * ghost tables; group/edge conflicts (no position) are picked as rows here. `Apply` is enabled
 * only once every conflict has a decision — then one post writes the clean sidecar + `git add`.
 */
export function MergePanel() {
  const conflicts = useAppStore((s) => s.mergeConflicts);
  const decisions = useAppStore((s) => s.mergeDecisions);
  const applying = useAppStore((s) => s.mergeApplying);

  if (!conflicts) return null;

  const total = conflicts.length;
  const resolved = conflicts.filter((c) => decisions[c.id] != null).length;
  const allResolved = resolved === total;
  const tableCount = conflicts.filter((c) => c.section === 'tables').length;
  const rows = conflicts.filter((c) => c.section !== 'tables');

  const apply = () => {
    if (!allResolved || applying) return;
    store.getState().setMergeApplying(true);
    postToHost({ type: 'merge:resolve', payload: { decisions } });
  };

  return (
    <div class="ddd-merge-bar" role="dialog" aria-label="Resolve layout merge conflicts">
      <div class="ddd-merge-bar__head">
        <span class="ddd-merge-bar__title">Layout merge — resolve {total} conflict{total === 1 ? '' : 's'}</span>
        <span class="ddd-merge-bar__count" aria-live="polite">{resolved}/{total} resolved</span>
      </div>

      {tableCount > 0 ? (
        <p class="ddd-merge-bar__hint">
          {tableCount} table position{tableCount === 1 ? '' : 's'} — click a ghost on the canvas (kept lights up; the other turns red = discarded).
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div class="ddd-merge-bar__rows">
          {rows.map((c) => (
            <ConflictRow key={c.id} conflict={c} decided={decisions[c.id]} />
          ))}
        </div>
      ) : null}

      <div class="ddd-merge-bar__actions">
        <div class="ddd-merge-bar__bulk">
          <Button variant="secondary" size="sm" onClick={() => store.getState().setMergeDecisionsBulk('ours')}>Keep all mine</Button>
          <Button variant="secondary" size="sm" onClick={() => store.getState().setMergeDecisionsBulk('theirs')}>Take all theirs</Button>
        </div>
        <Button variant="primary" size="md" disabled={!allResolved || applying} onClick={apply}>
          {applying ? 'Applying…' : `Apply (${total})`}
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
        <Button variant="action" size="sm" active={decided === 'ours'} onClick={() => pick('ours')}>
          {oursColor ? <span class="ddd-merge-bar__swatch" style={{ background: oursColor }} /> : null}mine
        </Button>
        <Button variant="action" size="sm" active={decided === 'theirs'} onClick={() => pick('theirs')}>
          {theirsColor ? <span class="ddd-merge-bar__swatch" style={{ background: theirsColor }} /> : null}theirs
        </Button>
      </div>
    </div>
  );
}

/** Best-effort color preview for a group conflict side (null = deleted / no color). */
function colorOf(v: SerializableMergeConflict['ours']): string | null {
  if (v && typeof v === 'object' && 'color' in v) return (v as GroupLayout).color ?? null;
  return null;
}
