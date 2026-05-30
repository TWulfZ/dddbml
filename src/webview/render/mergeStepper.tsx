import { useEffect } from 'preact/hooks';
import type { GroupLayout, SerializableMergeConflict, TableLayout } from '../../shared/types';
import { store, useAppStore } from '../state/store';
import { estimateSize } from '../layout/autoLayout';
import { focusDiff } from './viewport';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../ui/cn';
import { IconChevronRight } from '../icons';
import { sideClass } from './mergePanel';
import type { Bbox } from './spatialIndex';

/**
 * One-conflict-at-a-time resolver (spec 14 §Tier-3). Prev/Next walk the conflict list and fly the
 * camera to frame BOTH ghost positions of the current diff (table conflicts only). Hovering a
 * mine/theirs button cross-highlights its ghost via the shared `mergeHover` (no camera move — that's
 * deliberate, hover-to-move is disorienting). Picking auto-advances to the next unresolved conflict.
 */
export function MergeStepper() {
  const conflicts = useAppStore((s) => s.mergeConflicts);
  const decisions = useAppStore((s) => s.mergeDecisions);
  const cursor = useAppStore((s) => s.mergeCursor);
  const schema = useAppStore((s) => s.schema);
  const hoverState = useAppStore((s) => s.mergeHover);

  // Camera follows the cursor: frame the current diff whenever it lands on a TABLE conflict.
  useEffect(() => {
    if (!conflicts) return;
    const c = conflicts[cursor];
    if (!c || c.section !== 'tables') return;
    const table = schema.tables.find((t) => t.name === c.key);
    const size = estimateSize(table?.columns.length ?? 0);
    const a = bboxAt(c.ours, size);
    const b = bboxAt(c.theirs, size);
    if (a && b) focusDiff(a, b);
    else if (a) focusDiff(a, a);
    else if (b) focusDiff(b, b);
  }, [cursor, conflicts]);

  if (!conflicts || conflicts.length === 0) return null;
  const total = conflicts.length;
  const idx = Math.max(0, Math.min(total - 1, cursor));
  const c = conflicts[idx];
  if (!c) return null;

  const decided = decisions[c.id];
  const noun = c.section === 'tables' ? 'table' : c.section === 'groups' ? 'group' : 'edge';

  const pick = (side: 'ours' | 'theirs') => {
    store.getState().setMergeDecision(c.id, side);
    const next = nextUnresolved(conflicts, decisions, idx, c.id);
    if (next !== -1) store.getState().setMergeCursor(next);
  };
  const enter = (side: 'ours' | 'theirs') => store.getState().setMergeHover({ id: c.id, side });
  // Clear only if WE still own the hover — moving onto a ghost (which sets its own hover) must not be
  // wiped by this button's late pointerleave (mirrors the defensive clear in mergeGhosts.tsx).
  const leave = (side: 'ours' | 'theirs') => {
    const cur = store.getState().mergeHover;
    if (cur && cur.id === c.id && cur.side === side) store.getState().setMergeHover(null);
  };

  return (
    <div class="ddd-merge-step">
      <div class="ddd-merge-step__nav">
        <Tooltip label="Previous" placement="bottom">
          <Button variant="history" size="tool" disabled={idx <= 0} onClick={() => store.getState().mergeStep(-1)}>
            <IconChevronRight size={14} flipX />
          </Button>
        </Tooltip>
        <span class="ddd-merge-step__pos">{idx + 1} / {total}{decided ? ' ✓' : ''}</span>
        <Tooltip label="Next" placement="bottom">
          <Button variant="history" size="tool" disabled={idx >= total - 1} onClick={() => store.getState().mergeStep(1)}>
            <IconChevronRight size={14} />
          </Button>
        </Tooltip>
      </div>
      <div class="ddd-merge-dots" role="presentation">
        {conflicts.map((cf, i) => (
          <span key={cf.id} class={cn('ddd-merge-dot', i === idx && 'is-current', decisions[cf.id] != null && 'is-done')} />
        ))}
      </div>
      <div class="ddd-merge-step__label" title={`${noun} ${c.key}`}>
        <span class="ddd-merge-bar__row-noun">{noun}</span> {c.key}
      </div>
      <div class="ddd-merge-step__choices">
        <Button
          variant="action"
          size="sm"
          active={decided === 'ours'}
          class={sideClass(decided, 'ours', hoverState?.id === c.id && hoverState.side === 'ours' ? 'ddd-merge-cross' : undefined)}
          onPointerEnter={() => enter('ours')}
          onPointerLeave={() => leave('ours')}
          onClick={() => pick('ours')}
        >
          {colorOf(c.ours) ? <span class="ddd-merge-bar__swatch" style={{ background: colorOf(c.ours)! }} /> : null}
          <span class="ddd-merge-side__cap">mine</span>{posText(c.ours)}
          <span class="ddd-merge-side__mark" aria-hidden="true">✓</span>
        </Button>
        <Button
          variant="action"
          size="sm"
          active={decided === 'theirs'}
          class={sideClass(decided, 'theirs', hoverState?.id === c.id && hoverState.side === 'theirs' ? 'ddd-merge-cross' : undefined)}
          onPointerEnter={() => enter('theirs')}
          onPointerLeave={() => leave('theirs')}
          onClick={() => pick('theirs')}
        >
          {colorOf(c.theirs) ? <span class="ddd-merge-bar__swatch" style={{ background: colorOf(c.theirs)! }} /> : null}
          <span class="ddd-merge-side__cap">theirs</span>{posText(c.theirs)}
          <span class="ddd-merge-side__mark" aria-hidden="true">✓</span>
        </Button>
      </div>
    </div>
  );
}

function bboxAt(v: SerializableMergeConflict['ours'], size: { width: number; height: number }): Bbox | null {
  const t = v as TableLayout | null;
  if (!t || typeof t.x !== 'number') return null;
  return { x: t.x, y: t.y, w: size.width, h: size.height };
}

function posText(v: SerializableMergeConflict['ours']): string {
  const t = v as TableLayout | null;
  return t && typeof t.x === 'number' ? ` (${t.x}, ${t.y})` : '';
}

function colorOf(v: SerializableMergeConflict['ours']): string | null {
  if (v && typeof v === 'object' && 'color' in v) return (v as GroupLayout).color ?? null;
  return null;
}

/** Next conflict (after `fromIdx`, wrapping) with no decision yet; `justId` counts as resolved
 *  because the store decision set this render closure captured doesn't include the fresh pick. */
function nextUnresolved(
  conflicts: SerializableMergeConflict[],
  decisions: Record<string, 'ours' | 'theirs'>,
  fromIdx: number,
  justId: string,
): number {
  const resolved = (c: SerializableMergeConflict) => c.id === justId || decisions[c.id] != null;
  for (let i = fromIdx + 1; i < conflicts.length; i++) if (!resolved(conflicts[i]!)) return i;
  for (let i = 0; i < fromIdx; i++) if (!resolved(conflicts[i]!)) return i;
  return -1;
}
