import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { TableGroup } from '../../shared/types';
import { store, useAppStore } from '../state/store';
import { schedulePersist } from '../persistence';
import { ColorPopup } from '../render/colorPopup';
import { Button } from '../ui/Button';
import { Search } from '../ui/Search';
import { Tooltip } from '../ui/Tooltip';
import { bcColorFor } from './bcPalette';
import {
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconCollapseAll,
  IconExpandAll,
  IconEye,
  IconEyeClosed,
  IconFilter,
  IconSettings,
} from '../icons';

export function GroupPanel() {
  const groups = useAppStore((s) => s.schema.groups);
  const groupState = useAppStore((s) => s.groups);
  const hiddenTables = useAppStore((s) => s.hiddenTables);
  const open = useAppStore((s) => s.viewsPanelOpen);
  const focusNonce = useAppStore((s) => s.viewsSearchFocusNonce);
  const showOnlyPkFk = useAppStore((s) => s.showOnlyPkFk);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const setOpen = (v: boolean) => store.getState().setViewsPanelOpen(v);

  // The toolbar's search button opens this panel and bumps the nonce; focus the input when it fires.
  useEffect(() => {
    if (focusNonce > 0) searchRef.current?.focus();
  }, [focusNonce]);

  const lcQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!lcQuery) return groups;
    return groups.filter((g) => {
      if (g.name.toLowerCase().includes(lcQuery)) return true;
      return g.tables.some((t) => t.toLowerCase().includes(lcQuery));
    });
  }, [groups, lcQuery]);

  const hasGroups = groups.length > 0;
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
          {hasGroups ? (
            <>
              <Tooltip label={anyVisible ? 'Hide all' : 'Show all'}>
                <Button variant="subtle" size="tool" onClick={toggleAllHidden}>
                  {anyVisible ? <IconEye size={13} /> : <IconEyeClosed size={13} />}
                </Button>
              </Tooltip>
              <Tooltip label={anyExpanded ? 'Collapse all groups' : 'Expand all groups'}>
                <Button variant="subtle" size="tool" onClick={toggleAllCollapsed}>
                  {anyExpanded ? <IconCollapseAll size={13} /> : <IconExpandAll size={13} />}
                </Button>
              </Tooltip>
            </>
          ) : null}
          <Tooltip label="Close">
            <Button variant="subtle" size="tool" onClick={() => setOpen(false)}>
              <IconClose size={12} />
            </Button>
          </Tooltip>
        </div>
      </div>
      <div class="ddd-group-panel__views">
        <span class="ddd-group-panel__section">View options</span>
        <Button
          variant="action"
          size="sm"
          active={showOnlyPkFk}
          onClick={() => store.getState().toggleShowOnlyPkFk()}
          title="Show only primary-key and foreign-key columns"
        >
          <IconFilter size={12} />
          <span>PK/FK columns only</span>
        </Button>
      </div>
      <Search value={query} onInput={setQuery} placeholder="Search table or group" inputRef={searchRef} />
      <ul class="ddd-group-list">
        {!hasGroups ? (
          <li class="ddd-group-empty">No groups defined</li>
        ) : filtered.length === 0 ? (
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
    const panelEl = (e.currentTarget as HTMLElement).closest('.ddd-group-panel') as HTMLElement | null;
    const gearEl = e.currentTarget as HTMLElement;
    const panel = (panelEl ?? gearEl).getBoundingClientRect();
    const gear = gearEl.getBoundingClientRect();
    const popupW = 240, popupH = 220;
    const x = Math.max(8, panel.left - popupW - 4);
    const y = Math.min(Math.max(8, gear.top), window.innerHeight - popupH - 8);
    setPopup({ x, y });
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
        <Button
          variant="subtle"
          size="icon"
          off={hidden}
          onClick={toggleHidden}
          title={hidden ? 'Show group' : 'Hide group'}
        >{hidden ? <IconEyeClosed size={12} /> : <IconEye size={12} />}</Button>
        <Button
          variant="subtle"
          size="icon"
          active={collapsed}
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand group' : 'Collapse group'}
        >{collapsed ? <IconExpandAll size={12} /> : <IconCollapseAll size={12} />}</Button>
        <Button
          variant="subtle"
          size="icon"
          onClick={onGearClick}
          title="Configure"
        ><IconSettings size={12} /></Button>
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
      <Button
        variant="subtle"
        size="icon"
        off={hidden}
        onClick={toggle}
        title={hidden ? 'Show table' : 'Hide table'}
      >{hidden ? <IconEyeClosed size={11} /> : <IconEye size={11} />}</Button>
    </li>
  );
}

/**
 * Deterministic group color from the Bounded-Context palette.
 * Source of truth: specs/12-design-system.md.
 */
export function colorForGroup(name: string): string {
  return bcColorFor(name);
}
