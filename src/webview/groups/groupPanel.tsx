import { useMemo, useState } from 'preact/hooks';
import type { TableGroup } from '../../shared/types';
import { store, useAppStore } from '../state/store';
import { schedulePersist } from '../drag/dragController';
import { ColorPopup, popupAnchorFor } from '../render/colorPopup';
import {
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconCollapseAll,
  IconExpandAll,
  IconEye,
  IconEyeClosed,
  IconSearch,
  IconSettings,
} from '../icons';

export function GroupPanel() {
  const groups = useAppStore((s) => s.schema.groups);
  const groupState = useAppStore((s) => s.groups);
  const hiddenTables = useAppStore((s) => s.hiddenTables);
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState('');

  if (groups.length === 0) return null;

  const lcQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!lcQuery) return groups;
    return groups.filter((g) => {
      if (g.name.toLowerCase().includes(lcQuery)) return true;
      return g.tables.some((t) => t.toLowerCase().includes(lcQuery));
    });
  }, [groups, lcQuery]);

  const anyVisible = groups.some((g) => !(groupState[g.name]?.hidden));
  const anyExpanded = groups.some((g) => !(groupState[g.name]?.collapsed));

  const toggleAllHidden = () => {
    const target = anyVisible;
    for (const g of groups) store.getState().setGroup(g.name, { hidden: target });
    if (!target) {
      for (const name of hiddenTables) store.getState().setTableHidden(name, false);
    }
    schedulePersist();
  };
  const toggleAllCollapsed = () => {
    const target = anyExpanded;
    for (const g of groups) store.getState().setGroup(g.name, { collapsed: target });
    schedulePersist();
  };

  if (!open) {
    return (
      <div class="ddd-group-panel is-closed">
        <button class="ddd-group-panel__handle" onClick={() => setOpen(true)} title="Open Diagram Views">
          <IconChevronRight size={12} />
          <span>Views</span>
        </button>
      </div>
    );
  }

  return (
    <div class="ddd-group-panel is-open">
      <div class="ddd-group-panel__head">
        <span class="ddd-group-panel__title">Diagram Views</span>
        <div class="ddd-group-panel__actions">
          <button class="ddd-icon-btn" onClick={toggleAllHidden} title={anyVisible ? 'Hide all' : 'Show all'}>
            {anyVisible ? <IconEye size={13} /> : <IconEyeClosed size={13} />}
          </button>
          <button class="ddd-icon-btn" onClick={toggleAllCollapsed} title={anyExpanded ? 'Collapse all groups' : 'Expand all groups'}>
            {anyExpanded ? <IconCollapseAll size={13} /> : <IconExpandAll size={13} />}
          </button>
          <button class="ddd-icon-btn" onClick={() => setOpen(false)} title="Close">
            <IconClose size={12} />
          </button>
        </div>
      </div>
      <label class="ddd-search">
        <span class="ddd-search__icon"><IconSearch size={12} /></span>
        <input
          class="ddd-search__input"
          type="text"
          placeholder="Search table or group"
          value={query}
          onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
        />
      </label>
      <ul class="ddd-group-list">
        {filtered.length === 0 ? (
          <li class="ddd-group-empty">No matches for "{query}"</li>
        ) : null}
        {filtered.map((g) => (
          <GroupRow
            key={g.name}
            group={g}
            state={groupState[g.name]}
            hiddenTables={hiddenTables}
            initialExpanded={lcQuery.length > 0}
            filter={lcQuery}
          />
        ))}
      </ul>
    </div>
  );
}

interface GroupRowProps {
  group: TableGroup;
  state: { collapsed?: boolean; hidden?: boolean; color?: string } | undefined;
  hiddenTables: Set<string>;
  initialExpanded: boolean;
  filter: string;
}

function GroupRow({ group, state, hiddenTables, initialExpanded, filter }: GroupRowProps) {
  const [userExpanded, setUserExpanded] = useState(initialExpanded);
  const [popup, setPopup] = useState<{ x: number; y: number } | null>(null);
  const hidden = state?.hidden ?? false;
  const collapsed = state?.collapsed ?? false;
  const color = state?.color ?? colorForGroup(group.name);
  // While a filter is active, always expand so matching tables are visible.
  const expanded = filter.length > 0 ? true : userExpanded;

  const toggleHidden = () => {
    store.getState().setGroup(group.name, { hidden: !hidden });
    schedulePersist();
  };
  const toggleCollapsed = () => {
    store.getState().setGroup(group.name, { collapsed: !collapsed });
    schedulePersist();
  };
  const applyColor = (c: string) => {
    store.getState().setGroup(group.name, { color: c });
    schedulePersist();
  };
  const resetColor = () => {
    store.getState().setGroup(group.name, { color: undefined });
    schedulePersist();
  };
  const onGearClick = (e: MouseEvent) => {
    e.stopPropagation();
    const rowEl = (e.currentTarget as HTMLElement).closest('.ddd-group-row') as HTMLElement | null;
    const anchorRect = rowEl?.getBoundingClientRect() ?? (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPopup(popupAnchorFor(anchorRect));
  };

  const memberTables = filter
    ? group.tables.filter((t) => t.toLowerCase().includes(filter))
    : group.tables;

  return (
    <>
      <li class="ddd-group-row">
        <button
          class="ddd-group-chevron"
          onClick={() => setUserExpanded(!userExpanded)}
          title={expanded ? 'Collapse list' : 'Expand table list'}
        >{expanded ? <IconChevronDown size={10} /> : <IconChevronRight size={10} />}</button>
        <span class="ddd-group-swatch" style={{ background: color }} title={color} />
        <span class="ddd-group-name" title={`${group.tables.length} tables`}>{group.name}</span>
        <span class="ddd-group-count">{group.tables.length}</span>
        <button
          class={`ddd-icon-btn ${hidden ? 'is-off' : ''}`}
          onClick={toggleHidden}
          title={hidden ? 'Show group' : 'Hide group'}
        >{hidden ? <IconEyeClosed size={12} /> : <IconEye size={12} />}</button>
        <button
          class={`ddd-icon-btn ${collapsed ? 'is-on' : ''}`}
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand group' : 'Collapse group'}
        >{collapsed ? <IconExpandAll size={12} /> : <IconCollapseAll size={12} />}</button>
        <button
          class="ddd-icon-btn"
          onClick={onGearClick}
          title="Configure"
        ><IconSettings size={12} /></button>
      </li>
      {popup ? (
        <ColorPopup
          current={color}
          x={popup.x}
          y={popup.y}
          onPick={applyColor}
          onReset={resetColor}
          onClose={() => setPopup(null)}
        />
      ) : null}
      {expanded ? (
        <li class="ddd-group-children">
          <ul class="ddd-table-list">
            {memberTables.map((name) => (
              <TableRow key={name} tableName={name} hidden={hiddenTables.has(name)} />
            ))}
          </ul>
        </li>
      ) : null}
    </>
  );
}

function TableRow({ tableName, hidden }: { tableName: string; hidden: boolean }) {
  const shortName = tableName.startsWith('public.') ? tableName.slice(7) : tableName;
  const toggle = () => {
    store.getState().setTableHidden(tableName, !hidden);
    schedulePersist();
  };
  return (
    <li class="ddd-table-row">
      <span class="ddd-table-row__name" title={tableName}>{shortName}</span>
      <button
        class={`ddd-icon-btn ${hidden ? 'is-off' : ''}`}
        onClick={toggle}
        title={hidden ? 'Show table' : 'Hide table'}
      >{hidden ? <IconEyeClosed size={11} /> : <IconEye size={11} />}</button>
    </li>
  );
}

export function colorForGroup(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 55%, 60%)`;
}
