import type { Column } from '../../shared/types';
import { useAppStore } from '../state/store';

const CARD_W = 380;
const GAP = 10;

type ColStatus = 'added' | 'removed' | 'changed' | 'same';

/**
 * Previous | Current comparison card (spec 16). Shown when a diff table is hovered (`diffHover`).
 * Frames the change as before/after rather than added/removed/modified: the left pane lists the
 * table's columns at the base revision, the right pane at the working tree. A column missing on one
 * side reads as removed/added by its absence; a column that differs is amber on both sides. Anchored
 * beside the hovered table, pointer-transparent (a peek, not interactive).
 */
export function DiffHoverCard() {
  const hover = useAppStore((s) => s.diffHover);
  const schema = useAppStore((s) => s.schema);
  const diffByTable = useAppStore((s) => s.diffByTable);
  const columnDiffByTable = useAppStore((s) => s.columnDiffByTable);
  const diffBaseByTable = useAppStore((s) => s.diffBaseByTable);
  const diffGhosts = useAppStore((s) => s.diffGhosts);

  if (!hover) return null;
  const { name, anchor } = hover;

  const live = schema.tables.find((t) => t.name === name);
  const ghost = diffGhosts?.find((g) => g.table.name === name);
  const previousCols: Column[] = diffBaseByTable?.get(name)?.columns ?? ghost?.table.columns ?? [];
  const currentCols: Column[] = live?.columns ?? [];
  if (previousCols.length === 0 && currentCols.length === 0) return null;

  const prevNames = new Set(previousCols.map((c) => c.name));
  const curNames = new Set(currentCols.map((c) => c.name));
  const changed = new Set<string>();
  const colDiff = columnDiffByTable?.get(name);
  if (colDiff) for (const [n, e] of colDiff) if (e.status === 'changed') changed.add(n);

  const prevStatus = (c: Column): ColStatus =>
    !curNames.has(c.name) ? 'removed' : changed.has(c.name) ? 'changed' : 'same';
  const curStatus = (c: Column): ColStatus =>
    !prevNames.has(c.name) ? 'added' : changed.has(c.name) ? 'changed' : 'same';

  // Anchor to the right of the table; flip left if it would overflow the viewport.
  const spaceRight = window.innerWidth - anchor.right;
  const left = spaceRight >= CARD_W + GAP ? anchor.right + GAP : Math.max(GAP, anchor.left - CARD_W - GAP);
  const top = Math.min(Math.max(GAP, anchor.top), Math.max(GAP, window.innerHeight - 320));

  return (
    <div class="ddd-diff-card" style={{ left: `${left}px`, top: `${top}px`, width: `${CARD_W}px` }} role="presentation">
      <div class="ddd-diff-card__title">{name}</div>
      <div class="ddd-diff-card__panes">
        <Pane heading="Previous" cols={previousCols} statusOf={prevStatus} emptyLabel="New table" />
        <Pane heading="Current" cols={currentCols} statusOf={curStatus} emptyLabel="Removed table" />
      </div>
    </div>
  );
}

function Pane({
  heading,
  cols,
  statusOf,
  emptyLabel,
}: {
  heading: string;
  cols: Column[];
  statusOf: (c: Column) => ColStatus;
  emptyLabel: string;
}) {
  return (
    <div class="ddd-diff-card__pane">
      <div class="ddd-diff-card__pane-head">{heading}</div>
      {cols.length === 0 ? (
        <p class="ddd-diff-card__empty">{emptyLabel}</p>
      ) : (
        <ul class="ddd-diff-card__cols">
          {cols.map((c) => {
            const st = statusOf(c);
            return (
              <li key={c.name} class={`ddd-diff-card__col${st === 'same' ? '' : ` is-diff-${st}`}`}>
                <span class="ddd-diff-card__col-name">{c.name}</span>
                <span class="ddd-diff-card__col-type">{c.type}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
