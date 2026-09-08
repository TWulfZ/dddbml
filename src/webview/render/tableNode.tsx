import { useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import type { Column, ColumnDiffEntry, Table, TableDiffStatus } from '../../shared/types';
import type { LodLevel } from './lod';
import { estimateSize } from '../layout/autoLayout';
import { startDrag } from '../drag/dragController';
import { countResettableSelectionEdges, resetSelectedEdges, runEdgeOrdering, runSmartLayout } from '../layout/smartLayout';
import { schedulePersist } from '../persistence';
import { postToHost } from '../vscode';
import { store, useAppStore } from '../state/store';
import { ColorPopup, popupAnchorFor } from './colorPopup';
import { ContextMenu, clampMenuAnchor } from './contextMenu';
import type { ContextMenuItem } from './contextMenu';
import { IconKey, IconNote, IconSettings } from '../icons';
import { withAlpha } from '../groups/bcPalette';

interface TableNodeProps {
  table: Table;
  x: number;
  y: number;
  lod: LodLevel;
  selected: boolean;
  color?: string;
  fkColumns?: Set<string>;
  /** Git diff overlay status for this table — border marker + inline unified-diff rows (spec 16). */
  diffStatus?: TableDiffStatus;
  /** True when "Blur background tables" is on and this table is NOT in the active diff/merge. */
  dimmed?: boolean;
  /** Previous (base) table — supplies old column defs for the inline diff of a modified table. */
  diffBase?: Table;
  /** Per-column diff entries (by name) for a modified table — tells which columns changed. */
  columnDiff?: Map<string, ColumnDiffEntry>;
}

/** A column row tagged for the inline git-style unified diff. `context` = unchanged. */
type DiffKind = 'context' | 'added' | 'removed' | 'changed-old' | 'changed-new';
interface DiffRow { key: string; kind: DiffKind; col: Column; isFk: boolean }

/**
 * Build git-unified-diff rows for a table's columns: removed (`-`) then added (`+`), changed columns
 * as a `-`old / `+`new pair, interleaved in the base column order so it reads like an editor diff.
 * `base` undefined ⇒ a newly-added table (every column is `+`).
 */
function buildDiffRows(current: Column[], base: Column[] | undefined, changed: Set<string>, fk?: Set<string>): DiffRow[] {
  const isFk = (n: string) => fk?.has(n) ?? false;
  if (!base) return current.map((c) => ({ key: `+${c.name}`, kind: 'added' as const, col: c, isFk: isFk(c.name) }));
  const baseByName = new Map(base.map((c) => [c.name, c]));
  const curByName = new Map(current.map((c) => [c.name, c]));
  const rows: DiffRow[] = [];
  let bi = 0;
  const flushRemovedBefore = (target: number) => {
    while (bi < target) {
      const bc = base[bi]!;
      if (!curByName.has(bc.name)) rows.push({ key: `-${bc.name}`, kind: 'removed', col: bc, isFk: false });
      bi++;
    }
  };
  for (const cc of current) {
    const bc = baseByName.get(cc.name);
    if (bc) {
      // Never rewind: a kept column that moved ahead of an already-flushed range would otherwise
      // make the final flush re-emit a removed column (duplicate `-` row and duplicate key).
      const idx = base.indexOf(bc);
      if (idx >= bi) {
        flushRemovedBefore(idx);
        bi = idx + 1;
      }
      if (changed.has(cc.name)) {
        rows.push({ key: `-${cc.name}`, kind: 'changed-old', col: bc, isFk: false });
        rows.push({ key: `+${cc.name}`, kind: 'changed-new', col: cc, isFk: isFk(cc.name) });
      } else {
        rows.push({ key: cc.name, kind: 'context', col: cc, isFk: isFk(cc.name) });
      }
    } else {
      rows.push({ key: `+${cc.name}`, kind: 'added', col: cc, isFk: isFk(cc.name) });
    }
  }
  flushRemovedBefore(base.length);
  return rows;
}

function TableNodeImpl({ table, x, y, lod, selected, color, fkColumns, diffStatus, dimmed, diffBase, columnDiff }: TableNodeProps) {
  const size = estimateSize(table.columns.length);
  const showOnlyPkFk = useAppStore((s) => s.showOnlyPkFk);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const onPointerDown = (e: PointerEvent) => {
    startDrag(e, table.name, e.currentTarget as HTMLElement);
  };
  const onDblClick = (e: Event) => {
    e.stopPropagation();
    postToHost({ type: 'command:reveal', payload: { tableName: table.name } });
  };
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu(clampMenuAnchor(e.clientX, e.clientY, 200, 100));
  };
  // Hovering a table reveals its (otherwise faded) connected edges.
  const onTableEnter = () => store.getState().setHoveredTable(table.name);
  const onTableLeave = () => {
    if (store.getState().hoveredTable === table.name) store.getState().setHoveredTable(null);
  };
  // In `rect` LOD the name isn't drawn, so hovering reveals it as a screen-space label
  // (reuses the single shared tooltip slot — only one label can ever show at a time).
  const onRectEnter = (e: Event) => {
    onTableEnter();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    store.getState().setTooltip({ title: table.name, body: table.note ?? '', x: r.left, y: r.top });
  };
  const onRectLeave = () => {
    onTableLeave();
    if (store.getState().tooltip) store.getState().setTooltip(null);
  };

  const ctxItems: ContextMenuItem[] = [
    { label: 'Export…', onClick: () => store.getState().setExportPromptOpen(true) },
    { label: '', onClick: () => {}, separator: true },
    { label: 'Copy table name', onClick: () => { void navigator.clipboard.writeText(table.tableName); } },
  ];

  // Selection actions, shown only when right-clicking a selected table. Read from the store at
  // menu-open time rather than subscribing: a `selection` subscription re-rendered EVERY mounted
  // table on each selection change (the `selected` prop already covers the visual state).
  const selection = ctxMenu ? store.getState().selection : null;
  if (selection && selection.size > 0 && selection.has(table.name)) {
    const resettable = countResettableSelectionEdges();
    ctxItems.push({ label: '', onClick: () => {}, separator: true });
    ctxItems.push({
      label: `Auto-arrange selected (${selection.size})`,
      onClick: () => { void runSmartLayout('selection'); },
    });
    ctxItems.push({
      label: 'Order edges only',
      onClick: () => { void runEdgeOrdering(); },
    });
    ctxItems.push({
      label: `Reset relations (${resettable})`,
      disabled: resettable === 0,
      onClick: () => resetSelectedEdges(),
    });
  }

  const ctxMenuEl = ctxMenu ? (
    <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxItems} onClose={() => setCtxMenu(null)} />
  ) : null;

  const selClass = selected ? ' is-selected' : '';
  // Diff marker (border) + background-dim. Column-level changes render inline as a unified diff.
  const diffClass = (diffStatus ? ` is-diff-${diffStatus}` : '') + (dimmed ? ' is-diff-dimmed' : '');

  const headerStyle: Record<string, string> = color
    ? { background: withAlpha(color, 0.22), borderTopColor: color }
    : {};

  if (lod === 'rect') {
    return (
      <>
        <div
          class={`ddd-table ddd-table--rect${selClass}${diffClass}`}
          data-id={table.name}
          onPointerDown={onPointerDown}
          onDblClick={onDblClick}
          onContextMenu={onContextMenu}
          onMouseEnter={onRectEnter}
          onMouseLeave={onRectLeave}
          style={{
            position: 'absolute',
            // 2D on purpose: a 3D transform would promote every node to its own GPU layer (spec 04 §Capas).
            transform: `translate(${x}px, ${y}px)`,
            width: `${size.width}px`,
            height: `${size.height}px`,
            background: color ?? 'var(--ddd-accent)',
          }}
        />
        {ctxMenuEl}
      </>
    );
  }

  const visibleCols = showOnlyPkFk
    ? table.columns.filter((c) => c.pk || (fkColumns && fkColumns.has(c.name)))
    : table.columns;

  // In diff mode show the full inline unified diff (bypasses the PK/FK-only filter).
  const isDiff = diffStatus === 'added' || diffStatus === 'modified';
  let diffRows: DiffRow[] | null = null;
  if (isDiff) {
    const changed = new Set<string>();
    if (columnDiff) for (const [n, e] of columnDiff) if (e.status === 'changed') changed.add(n);
    diffRows = buildDiffRows(table.columns, diffStatus === 'modified' ? diffBase?.columns : undefined, changed, fkColumns);
  }

  return (
    <>
      <div
        class={`ddd-table${selClass}${diffClass}`}
        data-id={table.name}
        onPointerDown={onPointerDown}
        onDblClick={onDblClick}
        onContextMenu={onContextMenu}
        onMouseEnter={onTableEnter}
        onMouseLeave={onTableLeave}
        style={{
          position: 'absolute',
          transform: `translate(${x}px, ${y}px)`,
          borderTopColor: color ?? undefined,
        }}
      >
        <TableHeader table={table} configurable headerStyle={headerStyle} />
        <ul class="ddd-table__cols">
          {diffRows
            ? diffRows.map((r) => <ColumnRow key={r.key} col={r.col} isFk={r.isFk} diffKind={r.kind} />)
            : visibleCols.map((c) => <ColumnRow key={c.name} col={c} isFk={fkColumns?.has(c.name) ?? false} />)}
        </ul>
      </div>
      {ctxMenuEl}
    </>
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

function ColumnRow({ col, isFk, diffKind }: { col: Column; isFk: boolean; diffKind?: DiffKind }) {
  const isAdd = diffKind === 'added' || diffKind === 'changed-new';
  const isDel = diffKind === 'removed' || diffKind === 'changed-old';
  const diffCls = isAdd ? ' is-diff-add' : isDel ? ' is-diff-del' : '';
  const sign = isAdd ? '+' : isDel ? '−' : '';
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
      class={`ddd-table__col${isFk ? ' is-fk' : ''}${diffCls}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {sign ? <span class="ddd-table__col-sign" aria-hidden="true">{sign}</span> : null}
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

// memo: App re-renders on many store slices; this only re-renders via its own subscriptions.
export const TableNode = memo(TableNodeImpl);
