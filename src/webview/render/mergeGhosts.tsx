import { useState } from 'preact/hooks';
import type { QualifiedName, SerializableMergeConflict, Table, TableLayout } from '../../shared/types';
import { estimateSize } from '../layout/autoLayout';
import { store, useAppStore } from '../state/store';

/**
 * On-canvas ghost-table conflict picker (spec 14 §Tier-3). For every table whose position was
 * changed by BOTH sides, draws two ghosts — mine @ours, theirs @theirs — in world coords inside
 * `.ddd-world`, so they pan/zoom with the diagram. Hover previews (kept = accent bloom, the other
 * dims + danger tint = "discarded"); click commits the pick (revertible until Apply). Non-table
 * conflicts (group color / edge route) are resolved as rows in the conflict bar, not here.
 */
export function MergeGhosts({ tablesByName }: { tablesByName: Map<QualifiedName, Table> }) {
  const conflicts = useAppStore((s) => s.mergeConflicts);
  const decisions = useAppStore((s) => s.mergeDecisions);
  const [hover, setHover] = useState<{ id: string; side: 'ours' | 'theirs' } | null>(null);

  if (!conflicts) return null;
  const tableConflicts = conflicts.filter((c) => c.section === 'tables');
  if (tableConflicts.length === 0) return null;

  return (
    <div class="ddd-merge-ghost-layer">
      {tableConflicts.map((c) => {
        const table = tablesByName.get(c.key);
        return (['ours', 'theirs'] as const).map((side) => (
          <Ghost
            key={`${c.id}:${side}`}
            conflict={c}
            side={side}
            table={table}
            decided={decisions[c.id]}
            hovered={hover?.id === c.id ? hover.side : null}
            onHover={(h) => setHover(h ? { id: c.id, side } : (cur) => (cur?.id === c.id && cur.side === side ? null : cur))}
            onPick={() => store.getState().setMergeDecision(c.id, side)}
          />
        ));
      })}
    </div>
  );
}

function Ghost({
  conflict,
  side,
  table,
  decided,
  hovered,
  onHover,
  onPick,
}: {
  conflict: SerializableMergeConflict;
  side: 'ours' | 'theirs';
  table: Table | undefined;
  decided: 'ours' | 'theirs' | undefined;
  hovered: 'ours' | 'theirs' | null;
  onHover: (entering: boolean) => void;
  onPick: () => void;
}) {
  const mine = side === 'ours';
  const thisVal = (mine ? conflict.ours : conflict.theirs) as TableLayout | null;
  const otherVal = (mine ? conflict.theirs : conflict.ours) as TableLayout | null;
  const pos = thisVal ?? otherVal; // a null side (edit/delete) shows where the other side sits
  if (!pos) return null;
  const removed = thisVal === null; // this side deletes the saved position

  // Emphasis: hover wins; else the committed decision; else both neutral.
  const emphasis: 'keep' | 'discard' | 'neutral' =
    hovered != null ? (hovered === side ? 'keep' : 'discard')
    : decided != null ? (decided === side ? 'keep' : 'discard')
    : 'neutral';

  const size = estimateSize(table?.columns.length ?? 0);
  const cls = `ddd-merge-ghost ${mine ? 'is-mine' : 'is-theirs'} is-${emphasis}${removed ? ' is-removed' : ''}`;
  const name = table ? table.tableName : conflict.key;

  return (
    <div
      class={cls}
      style={{ position: 'absolute', transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`, width: `${size.width}px` }}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onPointerDown={(e) => { e.stopPropagation(); }}
      onClick={(e) => { e.stopPropagation(); onPick(); }}
      title={removed ? `${name}: this side removes the saved position` : `${name} — ${mine ? 'mine' : 'theirs'} (${pos.x}, ${pos.y})`}
    >
      <div class="ddd-merge-ghost__tag">
        <span class="ddd-merge-ghost__who">{mine ? 'mine' : 'theirs'}</span>
        {decided === side ? <span class="ddd-merge-ghost__check">✓</span> : null}
      </div>
      <div class="ddd-merge-ghost__name">{removed ? '✕ no position' : name}</div>
      {removed ? null : <div class="ddd-merge-ghost__pos">{pos.x}, {pos.y}</div>}
    </div>
  );
}
