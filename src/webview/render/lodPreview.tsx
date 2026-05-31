import type { Table } from '../../shared/types';
import type { LodLevel } from './lod';
import { TableNode } from './tableNode';
import { bcColorFor } from '../groups/bcPalette';

/**
 * LOD-mode preview shown inside the settings `HoverCard` (info icon next to the
 * "Level of Detail" thresholds). Renders the SAME `TableNode` the canvas uses, once
 * per LOD level, so the user sees exactly what `full` / `header` / `rect` look like
 * without zooming out to discover it.
 *
 * Interactivity is neutralized purely in CSS (`.ddd-lod-preview` sets
 * `pointer-events: none` and overrides `TableNode`'s inline absolute positioning) —
 * `TableNode` itself stays untouched (it is on the 5000-table hot path). See
 * specs/12-design-system.md.
 */

const DUMMY_TABLE: Table = {
  name: 'public.users',
  schemaName: 'public',
  tableName: 'users',
  columns: [
    { name: 'id', type: 'int', pk: true, increment: true },
    { name: 'name', type: 'varchar', notNull: true },
    { name: 'email', type: 'varchar', unique: true },
    { name: 'created_at', type: 'timestamp' },
  ],
};

const PREVIEW_COLOR = bcColorFor(DUMMY_TABLE.tableName);

const MODES: { lod: LodLevel; label: string; hint: string }[] = [
  { lod: 'full', label: 'Full', hint: 'All columns' },
  { lod: 'header', label: 'Medium', hint: 'Header only' },
  { lod: 'rect', label: 'Low', hint: 'Colored rect' },
];

export function LodPreview() {
  return (
    <div class="ddd-lod-preview">
      <div class="ddd-lod-preview__title">How a table renders at each zoom level</div>
      <div class="ddd-lod-preview__row">
        {MODES.map((m) => (
          <figure key={m.lod} class="ddd-lod-preview__cell">
            <div class="ddd-lod-preview__stage">
              <TableNode table={DUMMY_TABLE} x={0} y={0} lod={m.lod} selected={false} color={PREVIEW_COLOR} />
            </div>
            <figcaption class="ddd-lod-preview__caption">
              <span class="ddd-lod-preview__mode">{m.label}</span>
              <span class="ddd-lod-preview__hint">{m.hint}</span>
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
