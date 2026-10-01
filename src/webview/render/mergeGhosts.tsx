import type { QualifiedName, SerializableMergeConflict, Table, TableLayout } from '../../shared/types';
import { estimateSize } from '../layout/autoLayout';
import { store, useAppStore } from '../state/store';
import { IconKey } from '../icons';
import { densityMetrics } from '../layout/density';
import { bcColorFor, withAlpha } from '../groups/bcPalette';

/**
 * On-canvas conflict picker for tables whose position BOTH sides changed (spec 14 §Tier-3). Each side
 * renders the FULL table (header + columns, like the diff view) at its candidate position, so you
 * judge the placement in context — not a bare outline. No mine/theirs labels on canvas: the bar
 * already says which is current vs incoming. Emphasis = hover/decision (keep = accent bloom, the
 * other dims + danger = discarded); click commits the pick (revertible until Apply). A side that
 * deletes the saved position has no table to draw, so it shows a compact chip instead.
 */
export function MergeGhosts({ tablesByName }: { tablesByName: Map<QualifiedName, Table> }) {
  const conflicts = useAppStore((s) => s.mergeConflicts);
  const decisions = useAppStore((s) => s.mergeDecisions);
  // Hover is shared via the store so the stepper's current/incoming buttons cross-highlight these.
  const hover = useAppStore((s) => s.mergeHover);

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
            onHover={(entering) => {
              if (entering) store.getState().setMergeHover({ id: c.id, side });
              else {
                const cur = store.getState().mergeHover;
                if (cur && cur.id === c.id && cur.side === side) store.getState().setMergeHover(null);
              }
            }}
            onPick={() => store.getState().setMergeDecision(c.id, side)}
          />
        ));
      })}
    </div>
  );
}

/**
 * Where a side's ghost is drawn. Both sides at the same x/y (a color-only conflict) would stack the
 * cards and hide 'current', so 'incoming' is nudged down-right by `nudge` (one header height keeps the
 * current header exposed). Display-only: Apply still writes the original `theirs` value.
 */
export function ghostPos(c: SerializableMergeConflict, side: 'ours' | 'theirs', nudge: number): { x: number; y: number } | null {
  const ours = c.ours as TableLayout | null;
  const theirs = c.theirs as TableLayout | null;
  const pos = side === 'ours' ? (ours ?? theirs) : (theirs ?? ours);
  if (!pos) return null;
  if (side === 'theirs' && ours && theirs && ours.x === theirs.x && ours.y === theirs.y) {
    return { x: pos.x + nudge, y: pos.y + nudge };
  }
  return { x: pos.x, y: pos.y };
}

type Emphasis = 'keep' | 'discard' | 'neutral';

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
  const nudge = densityMetrics(useAppStore((s) => s.settings.ui.density)).headerHeight;
  const groupName = table?.groupName;
  const groupColor = useAppStore((s) => (groupName ? s.groups[groupName]?.color : undefined));
  const thisVal = (side === 'ours' ? conflict.ours : conflict.theirs) as TableLayout | null;
  const pos = ghostPos(conflict, side, nudge); // a null side (delete) shows where the other side sits
  if (!pos) return null;
  const removed = thisVal === null;
  // Same tint path as TableNode, so each card shows the color that side would apply.
  const color = thisVal?.color ?? (groupName ? (groupColor ?? bcColorFor(groupName)) : undefined);

  // Emphasis: hover wins; else the committed decision; else both neutral.
  const emphasis: Emphasis =
    hovered != null ? (hovered === side ? 'keep' : 'discard')
    : decided != null ? (decided === side ? 'keep' : 'discard')
    : 'neutral';

  const handlers = {
    onPointerEnter: () => onHover(true),
    onPointerLeave: () => onHover(false),
    onPointerDown: (e: PointerEvent) => { e.stopPropagation(); },
    onClick: (e: MouseEvent) => { e.stopPropagation(); onPick(); },
  };
  const checked = decided === side ? <span class="ddd-merge-ghost__check" aria-hidden="true">✓</span> : null;

  // Delete-side (or unknown table): a compact chip, not a full duplicate of the other position.
  if (removed || !table) {
    return (
      <div
        class={`ddd-merge-ghost ddd-merge-ghost--chip is-${emphasis}${removed ? ' is-removed' : ''}`}
        style={{ position: 'absolute', transform: `translate(${pos.x}px, ${pos.y}px)` }}
        title={`${table?.tableName ?? conflict.key}: this side removes the saved position`}
        {...handlers}
      >
        {removed ? '✕ removes position' : (table?.tableName ?? conflict.key)}
        {checked}
      </div>
    );
  }

  const size = estimateSize(table.columns.length);
  return (
    <div
      class={`ddd-table ddd-merge-ghost is-${emphasis}`}
      style={{
        position: 'absolute',
        transform: `translate(${pos.x}px, ${pos.y}px)`,
        width: `${size.width}px`,
        borderTopColor: color,
      }}
      title={`${table.name} (${thisVal?.x ?? pos.x}, ${thisVal?.y ?? pos.y})${thisVal?.color ? ` · ${thisVal.color}` : ''}`}
      {...handlers}
    >
      {checked}
      <div class="ddd-table__header" style={color ? { background: withAlpha(color, 0.22), borderTopColor: color } : undefined}>
        <span class="ddd-table__title">
          {table.schemaName !== 'public' ? <span class="ddd-table__schema">{table.schemaName}.</span> : null}
          <span class="ddd-table__name">{table.tableName}</span>
        </span>
      </div>
      <ul class="ddd-table__cols">
        {table.columns.map((col) => (
          <li key={col.name} class="ddd-table__col">
            <span class="ddd-table__col-left">
              <span class={`ddd-table__col-name${col.pk ? ' is-pk' : ''}`}>{col.name}</span>
              {col.pk ? <IconKey size={10} /> : null}
            </span>
            <span class="ddd-table__col-right">
              <span class="ddd-table__col-type">{col.type}</span>
              {col.notNull ? <span class="ddd-table__badge" title="not null">NN</span> : null}
              {col.unique ? <span class="ddd-table__badge" title="unique">U</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
