import { useState } from 'preact/hooks';
import type { Column, Table } from '../../shared/types';
import type { LodLevel } from './lod';
import { estimateSize } from '../layout/autoLayout';
import { startDrag, schedulePersist } from '../drag/dragController';
import { postToHost } from '../vscode';
import { store, useAppStore } from '../state/store';
import { ColorPopup, popupAnchorFor } from './colorPopup';
import { IconKey, IconNote, IconSettings } from '../icons';

interface TableNodeProps {
  table: Table;
  x: number;
  y: number;
  lod: LodLevel;
  selected: boolean;
  color?: string;
  fkColumns?: Set<string>;
}

export function TableNode({ table, x, y, lod, selected, color, fkColumns }: TableNodeProps) {
  const size = estimateSize(table.columns.length);
  const showOnlyPkFk = useAppStore((s) => s.showOnlyPkFk);
  const onPointerDown = (e: PointerEvent) => {
    startDrag(e, table.name, e.currentTarget as HTMLElement);
  };
  const onDblClick = (e: Event) => {
    e.stopPropagation();
    postToHost({ type: 'command:reveal', payload: { tableName: table.name } });
  };

  const selClass = selected ? ' is-selected' : '';
  const headerStyle = color
    ? { background: tint(color, 0.22), borderTopColor: color }
    : {};

  if (lod === 'rect') {
    return (
      <div
        class={`ddd-table ddd-table--rect${selClass}`}
        data-id={table.name}
        onPointerDown={onPointerDown}
        onDblClick={onDblClick}
        title={table.note ? `${table.name}\n\n${table.note}` : table.name}
        style={{
          position: 'absolute',
          transform: `translate3d(${x}px, ${y}px, 0)`,
          width: `${size.width}px`,
          height: `${size.height}px`,
          background: color ?? 'var(--ddd-accent)',
        }}
      />
    );
  }

  if (lod === 'header') {
    return (
      <div
        class={`ddd-table ddd-table--header-only${selClass}`}
        data-id={table.name}
        onPointerDown={onPointerDown}
        onDblClick={onDblClick}
        style={{
          position: 'absolute',
          transform: `translate3d(${x}px, ${y}px, 0)`,
          borderTopColor: color ?? undefined,
        }}
      >
        <TableHeader table={table} headerStyle={headerStyle} />
      </div>
    );
  }

  const visibleCols = showOnlyPkFk
    ? table.columns.filter((c) => c.pk || (fkColumns && fkColumns.has(c.name)))
    : table.columns;

  return (
    <div
      class={`ddd-table${selClass}`}
      data-id={table.name}
      onPointerDown={onPointerDown}
      onDblClick={onDblClick}
      style={{
        position: 'absolute',
        transform: `translate3d(${x}px, ${y}px, 0)`,
        borderTopColor: color ?? undefined,
      }}
    >
      <TableHeader table={table} configurable headerStyle={headerStyle} />
      <ul class="ddd-table__cols">
        {visibleCols.map((c) => (
          <ColumnRow key={c.name} col={c} isFk={fkColumns?.has(c.name) ?? false} />
        ))}
      </ul>
    </div>
  );
}

function TableHeader({ table, configurable, headerStyle }: { table: Table; configurable?: boolean; headerStyle?: Record<string, string> }) {
  const [popup, setPopup] = useState<{ x: number; y: number } | null>(null);
  const existing = store.getState().tableColors.get(table.name);

  const applyColor = (c: string) => {
    store.getState().setTableColor(table.name, c);
    schedulePersist();
  };
  const resetColor = () => {
    store.getState().setTableColor(table.name, null);
    schedulePersist();
  };

  const onGearClick = (e: MouseEvent) => {
    e.stopPropagation();
    // Anchor popup to the outer table bounding box so it opens right-beside the table, not the tiny gear.
    const tableEl = (e.currentTarget as HTMLElement).closest('.ddd-table') as HTMLElement | null;
    const anchorRect = tableEl?.getBoundingClientRect() ?? (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPopup(popupAnchorFor(anchorRect));
  };

  const onGearPointerDown = (e: PointerEvent) => {
    // Prevent drag / marquee from starting when user clicks gear.
    e.stopPropagation();
  };

  const onHeadPointerDown = (e: PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.ddd-table__gear') || target.closest('.ddd-table__note-icon') || target.closest('.ddd-color-popup')) {
      e.stopPropagation();
    }
  };

  return (
    <div class="ddd-table__header" style={headerStyle} onPointerDown={onHeadPointerDown}>
      <span class="ddd-table__title">
        {table.schemaName !== 'public' ? <span class="ddd-table__schema">{table.schemaName}.</span> : null}
        <span class="ddd-table__name">{table.tableName}</span>
        {table.note ? <TableNoteIcon note={table.note} name={table.name} /> : null}
      </span>
      {configurable ? (
        <button
          class="ddd-table__gear"
          onClick={onGearClick}
          onPointerDown={onGearPointerDown}
          title="Configure"
        ><IconSettings size={12} /></button>
      ) : null}
      {popup ? (
        <ColorPopup
          current={existing ?? 'var(--ddd-accent)'}
          x={popup.x}
          y={popup.y}
          onPick={applyColor}
          onReset={resetColor}
          onClose={() => setPopup(null)}
        />
      ) : null}
    </div>
  );
}

function ColumnRow({ col, isFk }: { col: Column; isFk: boolean }) {
  const onEnter = (e: Event) => {
    if (!col.note) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    store.getState().setTooltip({
      title: col.name,
      subtitle: col.type,
      body: col.note,
      x: rect.right + 10,
      y: rect.top,
    });
  };
  const onLeave = () => {
    if (store.getState().tooltip) store.getState().setTooltip(null);
  };
  return (
    <li
      class={`ddd-table__col${isFk ? ' is-fk' : ''}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <span class="ddd-table__col-left">
        <span class={`ddd-table__col-name${col.pk ? ' is-pk' : ''}`}>{col.name}</span>
        {col.pk ? <IconKey size={10} /> : null}
        {col.note ? <IconNote size={10} /> : null}
      </span>
      <span class="ddd-table__col-right">
        <span class="ddd-table__col-type">{col.type}</span>
        {col.notNull ? <span class="ddd-table__badge" title="not null">NN</span> : null}
        {col.unique ? <span class="ddd-table__badge" title="unique">U</span> : null}
      </span>
    </li>
  );
}

function TableNoteIcon({ note, name }: { note: string; name: string }) {
  const onEnter = (e: Event) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    store.getState().setTooltip({
      title: name,
      body: note,
      x: rect.right + 10,
      y: rect.top,
    });
  };
  const onLeave = () => {
    if (store.getState().tooltip) store.getState().setTooltip(null);
  };
  return (
    <span class="ddd-table__note-icon" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <IconNote size={11} />
    </span>
  );
}

/** Mix a hex/hsl color with dark background to produce a subtle tint. Returns rgba. */
function tint(color: string, alpha: number): string {
  if (color.startsWith('hsl(')) return color.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`);
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const n = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex.padEnd(6, '0');
    const r = parseInt(n.slice(0, 2), 16);
    const g = parseInt(n.slice(2, 4), 16);
    const b = parseInt(n.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}
