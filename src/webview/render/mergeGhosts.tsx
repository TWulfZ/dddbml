import { useMemo } from 'preact/hooks';
import { memo } from 'preact/compat';
import type { QualifiedName, SerializableMergeConflict, Table, TableLayout } from '../../shared/types';
import { estimateSize } from '../layout/autoLayout';
import { store, useAppStore } from '../state/store';
import { IconKey } from '../icons';
import { densityMetrics } from '../layout/density';
import { bcColorFor, withAlpha } from '../groups/bcPalette';
import type { LodLevel } from './lod';
import { SpatialIndex } from './spatialIndex';
import { useVisibleNames, type ViewportRect } from './useVisibleNames';

type Side = 'ours' | 'theirs';
const SIDES = ['ours', 'theirs'] as const;
const ghostKey = (id: string, side: Side) => `${id}:${side}`;

interface MergeGhostsProps {
  tablesByName: Map<QualifiedName, Table>;
  viewportRect: ViewportRect;
  lod: LodLevel;
}

/**
 * On-canvas conflict picker for tables whose position BOTH sides changed (spec 14 §Tier-3). Each side
 * renders the FULL table (header + columns, like the diff view) at its candidate position, so you
 * judge the placement in context — not a bare outline. No mine/theirs labels on canvas: the bar
 * already says which is current vs incoming. Emphasis = hover/decision (keep = accent bloom, the
 * other dims + danger = discarded); click commits the pick (revertible until Apply). A side that
 * deletes the saved position has no table to draw, so it shows a compact chip instead.
 *
 * Ghosts follow the table culling/LOD contract (spec 04): their own spatial index (the shared one
 * only knows each table's provisional `ours` position) feeds `useVisibleNames`, and each Ghost
 * subscribes to its own emphasis, so a hover re-renders two cards instead of every ghost.
 */
function MergeGhostsImpl({ tablesByName, viewportRect, lod }: MergeGhostsProps) {
  const conflicts = useAppStore((s) => s.mergeConflicts);
  const density = useAppStore((s) => s.settings.ui.density);

  const tableConflicts = useMemo(() => (conflicts ?? []).filter((c) => c.section === 'tables'), [conflicts]);

  const index = useMemo(() => {
    const idx = new SpatialIndex();
    const nudge = densityMetrics(density).headerHeight;
    for (const c of tableConflicts) {
      const size = estimateSize(tablesByName.get(c.key)?.columns.length ?? 0);
      for (const side of SIDES) {
        const p = ghostPos(c, side, nudge);
        if (p) idx.insert(ghostKey(c.id, side), { x: p.x, y: p.y, w: size.width, h: size.height });
      }
    }
    return idx;
  }, [tableConflicts, tablesByName, density]);

  const visible = useVisibleNames(index, viewportRect, true);

  if (tableConflicts.length === 0) return null;

  return (
    <div class="ddd-merge-ghost-layer">
      {tableConflicts.map((c) =>
        SIDES.map((side) =>
          visible && !visible.has(ghostKey(c.id, side)) ? null : (
            <Ghost key={ghostKey(c.id, side)} conflict={c} side={side} table={tablesByName.get(c.key)} lod={lod} />
          ),
        ),
      )}
    </div>
  );
}

// memo: every prop is stable across pans (tablesByName is memoized on schema), so App's
// culling re-renders skip the whole ghost layer.
export const MergeGhosts = memo(MergeGhostsImpl);

/**
 * Where a side's ghost is drawn. Both sides at the same x/y (a color-only conflict) would stack the
 * cards and hide 'current', so 'incoming' is nudged down-right by `nudge` (one header height keeps the
 * current header exposed). Display-only: Apply still writes the original `theirs` value.
 */
export function ghostPos(c: SerializableMergeConflict, side: Side, nudge: number): { x: number; y: number } | null {
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

/** Hover wins; else the committed decision; else neutral. */
export function ghostEmphasis(
  hover: { id: string; side: Side } | null,
  decided: Side | undefined,
  id: string,
  side: Side,
): Emphasis {
  if (hover && hover.id === id) return hover.side === side ? 'keep' : 'discard';
  if (decided != null) return decided === side ? 'keep' : 'discard';
  return 'neutral';
}

function onGhostHover(id: string, side: Side, entering: boolean): void {
  if (entering) {
    store.getState().setMergeHover({ id, side });
    return;
  }
  const cur = store.getState().mergeHover;
  if (cur && cur.id === id && cur.side === side) store.getState().setMergeHover(null);
}

function GhostImpl({ conflict, side, table, lod }: { conflict: SerializableMergeConflict; side: Side; table: Table | undefined; lod: LodLevel }) {
  const id = conflict.id;
  const emphasis = useAppStore((s) => ghostEmphasis(s.mergeHover, s.mergeDecisions[id], id, side));
  const checkedSide = useAppStore((s) => s.mergeDecisions[id] === side);
  const nudge = densityMetrics(useAppStore((s) => s.settings.ui.density)).headerHeight;
  const groupName = table?.groupName;
  const groupColor = useAppStore((s) => (groupName ? s.groups[groupName]?.color : undefined));
  const thisVal = (side === 'ours' ? conflict.ours : conflict.theirs) as TableLayout | null;
  const pos = ghostPos(conflict, side, nudge); // a null side (delete) shows where the other side sits
  if (!pos) return null;
  const removed = thisVal === null;
  // Same tint path as TableNode, so each card shows the color that side would apply.
  const color = thisVal?.color ?? (groupName ? (groupColor ?? bcColorFor(groupName)) : undefined);

  const handlers = {
    onPointerEnter: () => onGhostHover(id, side, true),
    onPointerLeave: () => onGhostHover(id, side, false),
    onPointerDown: (e: PointerEvent) => { e.stopPropagation(); },
    onClick: (e: MouseEvent) => { e.stopPropagation(); store.getState().setMergeDecision(id, side); },
  };
  const checked = checkedSide ? <span class="ddd-merge-ghost__check" aria-hidden="true">✓</span> : null;
  const title = `${table?.name ?? conflict.key} (${thisVal?.x ?? pos.x}, ${thisVal?.y ?? pos.y})${thisVal?.color ? ` · ${thisVal.color}` : ''}`;

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
  if (lod === 'rect') {
    return (
      <div
        class={`ddd-table ddd-table--rect ddd-merge-ghost is-${emphasis}`}
        style={{
          position: 'absolute',
          transform: `translate(${pos.x}px, ${pos.y}px)`,
          width: `${size.width}px`,
          height: `${size.height}px`,
          background: color ?? 'var(--ddd-accent)',
        }}
        title={title}
        {...handlers}
      />
    );
  }

  return (
    <div
      class={`ddd-table ddd-merge-ghost is-${emphasis}`}
      style={{
        position: 'absolute',
        transform: `translate(${pos.x}px, ${pos.y}px)`,
        width: `${size.width}px`,
        borderTopColor: color,
      }}
      title={title}
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

const Ghost = memo(GhostImpl);
