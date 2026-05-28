import { createStore } from 'zustand/vanilla';
import { useEffect, useReducer } from 'preact/hooks';
import type { AppSettings, EdgeLayout, GroupLayout, Layout, ParseError, QualifiedName, Schema, TableLayout, ViewportLayout, Waypoint } from '../../shared/types';
import { defaultSettings } from '../../shared/types';
import type { ExporterMeta } from '../../shared/exporters/types';
import type { EditCommand, MoveCommand, WaypointCommand } from './history';

export interface TooltipState {
  title: string;
  subtitle?: string;
  body: string;
  x: number;
  y: number;
}

export interface AppState {
  schema: Schema;
  parseError: ParseError | null;
  positions: Map<QualifiedName, { x: number; y: number }>;
  hiddenTables: Set<QualifiedName>;
  tableColors: Map<QualifiedName, string>;
  edgeLayouts: Map<string, EdgeLayout>;
  groups: Record<string, { collapsed: boolean; hidden: boolean; color?: string }>;
  viewport: ViewportLayout;
  theme: 'light' | 'dark';
  ready: boolean;
  selection: Set<QualifiedName>;
  tooltip: TooltipState | null;
  /** Ephemeral view flag: render only PK + FK columns in tables. Not persisted. */
  showOnlyPkFk: boolean;
  settings: AppSettings;
  exporters: ExporterMeta[];
  /** When true, the Export modal is open. */
  exportPromptOpen: boolean;
  /** When true, the Settings panel is open. */
  settingsPanelOpen: boolean;
  /** Undo stack. Tail = most recent. Capped at `historyCapacity`. Volatile. */
  past: EditCommand[];
  /** Redo stack. Tail = most recently undone. Cleared on any new push. */
  future: EditCommand[];
  /** Hard cap for `past`; oldest entries drop FIFO when exceeded. */
  historyCapacity: number;
}

export interface AppActions {
  setSchema(schema: Schema, parseError: ParseError | null): void;
  setLayout(layout: Layout): void;
  setTablePos(name: QualifiedName, x: number, y: number): void;
  setViewport(vp: Partial<ViewportLayout>): void;
  setTheme(kind: 'light' | 'dark'): void;
  setPositionsBatch(entries: Array<[QualifiedName, { x: number; y: number }]>): void;
  setGroup(name: string, patch: Partial<GroupLayout>): void;
  setTableHidden(name: QualifiedName, hidden: boolean): void;
  setTableColor(name: QualifiedName, color: string | null): void;
  setEdgeLayout(refId: string, layout: EdgeLayout | null): void;
  insertWaypoint(refId: string, index: number, w: Waypoint): void;
  moveWaypoint(refId: string, index: number, w: Waypoint): void;
  removeWaypoint(refId: string, index: number): void;
  clearWaypoints(refId: string): void;
  setSelection(names: Iterable<QualifiedName>): void;
  clearSelection(): void;
  setTooltip(t: TooltipState | null): void;
  toggleShowOnlyPkFk(): void;
  setSettings(s: AppSettings): void;
  setExporters(list: ExporterMeta[]): void;
  setExportPromptOpen(open: boolean): void;
  setSettingsPanelOpen(open: boolean): void;
  pushMoveCommand(cmd: MoveCommand): void;
  pushWaypointCommand(cmd: WaypointCommand): void;
  undo(): void;
  redo(): void;
  clearHistory(): void;
}

const initial: AppState = {
  schema: { tables: [], refs: [], groups: [] },
  parseError: null,
  positions: new Map(),
  hiddenTables: new Set(),
  tableColors: new Map(),
  edgeLayouts: new Map(),
  groups: {},
  viewport: { x: 0, y: 0, zoom: 1 },
  theme: 'light',
  ready: false,
  selection: new Set(),
  tooltip: null,
  showOnlyPkFk: false,
  settings: defaultSettings(),
  exporters: [],
  exportPromptOpen: false,
  settingsPanelOpen: false,
  past: [],
  future: [],
  historyCapacity: 200,
};

export const store = createStore<AppState & AppActions>((set, _get) => ({
  ...initial,
  setSchema(schema, parseError) {
    set((s) => {
      const oldNames = new Set(s.schema.tables.map((t) => t.name));
      const newNames = new Set(schema.tables.map((t) => t.name));
      const sameTableSet =
        oldNames.size === newNames.size && [...oldNames].every((n) => newNames.has(n));
      const patch: Partial<AppState> = { schema, parseError, ready: true };
      if (!sameTableSet) {
        patch.past = [];
        patch.future = [];
      }
      return patch;
    });
  },
  setLayout(layout) {
    const positions = new Map<QualifiedName, { x: number; y: number }>();
    const hiddenTables = new Set<QualifiedName>();
    const tableColors = new Map<QualifiedName, string>();
    const edgeLayouts = new Map<string, EdgeLayout>();
    for (const [name, pos] of Object.entries(layout.tables)) {
      positions.set(name, { x: pos.x, y: pos.y });
      if (pos.hidden) hiddenTables.add(name);
      if (pos.color) tableColors.set(name, pos.color);
    }
    for (const [id, eo] of Object.entries(layout.edges ?? {})) {
      const e: EdgeLayout = {};
      if (Array.isArray(eo.waypoints) && eo.waypoints.length > 0) {
        e.waypoints = eo.waypoints.map((w) => ({ x: Math.round(w.x), y: Math.round(w.y) }));
      } else if (eo.dx !== undefined || eo.dy !== undefined) {
        if (eo.dx !== undefined) e.dx = eo.dx;
        if (eo.dy !== undefined) e.dy = eo.dy;
      }
      if (e.waypoints || e.dx !== undefined || e.dy !== undefined) edgeLayouts.set(id, e);
    }
    set({
      positions,
      hiddenTables,
      tableColors,
      edgeLayouts,
      groups: { ...layout.groups },
      viewport: { ...layout.viewport },
      past: [],
      future: [],
    });
  },
  setTablePos(name, x, y) {
    set((s) => {
      const next = new Map(s.positions);
      next.set(name, { x: Math.round(x), y: Math.round(y) });
      return { positions: next };
    });
  },
  setPositionsBatch(entries) {
    set((s) => {
      const next = new Map(s.positions);
      for (const [name, pos] of entries) next.set(name, { x: Math.round(pos.x), y: Math.round(pos.y) });
      return { positions: next };
    });
  },
  setViewport(vp) {
    set((s) => ({ viewport: { ...s.viewport, ...vp } }));
  },
  setTheme(kind) {
    set({ theme: kind });
  },
  setGroup(name, patch) {
    set((s) => {
      const existing = s.groups[name] ?? {};
      const merged: GroupLayout = { ...existing, ...patch };
      if (merged.collapsed === false) delete merged.collapsed;
      if (merged.hidden === false) delete merged.hidden;
      if (merged.color === '') delete merged.color;
      return { groups: { ...s.groups, [name]: merged } };
    });
  },
  setTableHidden(name, hidden) {
    set((s) => {
      const next = new Set(s.hiddenTables);
      if (hidden) next.add(name); else next.delete(name);
      return { hiddenTables: next };
    });
  },
  setTableColor(name, color) {
    set((s) => {
      const next = new Map(s.tableColors);
      if (color) next.set(name, color); else next.delete(name);
      return { tableColors: next };
    });
  },
  setEdgeLayout(refId, layout) {
    set((s) => {
      const next = new Map(s.edgeLayouts);
      const hasWaypoints = layout?.waypoints && layout.waypoints.length > 0;
      const hasLegacy = layout && (layout.dx !== undefined || layout.dy !== undefined);
      if (layout && (hasWaypoints || hasLegacy)) next.set(refId, layout);
      else next.delete(refId);
      return { edgeLayouts: next };
    });
  },
  insertWaypoint(refId, index, w) {
    set((s) => {
      const next = new Map(s.edgeLayouts);
      const existing = next.get(refId);
      const wps = existing?.waypoints ? [...existing.waypoints] : [];
      const clamped = Math.max(0, Math.min(index, wps.length));
      wps.splice(clamped, 0, { x: Math.round(w.x), y: Math.round(w.y) });
      next.set(refId, { ...existing, waypoints: wps });
      return { edgeLayouts: next };
    });
  },
  moveWaypoint(refId, index, w) {
    set((s) => {
      const next = new Map(s.edgeLayouts);
      const existing = next.get(refId);
      if (!existing?.waypoints || index < 0 || index >= existing.waypoints.length) return s;
      const wps = [...existing.waypoints];
      wps[index] = { x: Math.round(w.x), y: Math.round(w.y) };
      next.set(refId, { ...existing, waypoints: wps });
      return { edgeLayouts: next };
    });
  },
  removeWaypoint(refId, index) {
    set((s) => {
      const next = new Map(s.edgeLayouts);
      const existing = next.get(refId);
      if (!existing?.waypoints || index < 0 || index >= existing.waypoints.length) return s;
      const wps = existing.waypoints.filter((_, i) => i !== index);
      if (wps.length === 0) {
        const rest: EdgeLayout = {};
        if (existing.dx !== undefined) rest.dx = existing.dx;
        if (existing.dy !== undefined) rest.dy = existing.dy;
        if (rest.dx !== undefined || rest.dy !== undefined) next.set(refId, rest);
        else next.delete(refId);
      } else {
        next.set(refId, { ...existing, waypoints: wps });
      }
      return { edgeLayouts: next };
    });
  },
  clearWaypoints(refId) {
    set((s) => {
      const next = new Map(s.edgeLayouts);
      const existing = next.get(refId);
      if (!existing) return s;
      const rest: EdgeLayout = {};
      if (existing.dx !== undefined) rest.dx = existing.dx;
      if (existing.dy !== undefined) rest.dy = existing.dy;
      if (rest.dx !== undefined || rest.dy !== undefined) next.set(refId, rest);
      else next.delete(refId);
      return { edgeLayouts: next };
    });
  },
  setSelection(names) {
    set({ selection: new Set(names) });
  },
  clearSelection() {
    set({ selection: new Set() });
  },
  setTooltip(t) {
    set({ tooltip: t });
  },
  toggleShowOnlyPkFk() {
    set((s) => ({ showOnlyPkFk: !s.showOnlyPkFk }));
  },
  setSettings(s) {
    set({ settings: s });
  },
  setExporters(list) {
    set({ exporters: list });
  },
  setExportPromptOpen(open) {
    set({ exportPromptOpen: open });
  },
  setSettingsPanelOpen(open) {
    set({ settingsPanelOpen: open });
  },
  pushMoveCommand(cmd) {
    set((s) => pushHistory(s, cmd));
  },
  pushWaypointCommand(cmd) {
    set((s) => pushHistory(s, cmd));
  },
  undo() {
    set((s) => {
      if (s.past.length === 0) return s;
      const cmd = s.past[s.past.length - 1]!;
      const patch = applyCommand(s, cmd, 'undo');
      return {
        ...patch,
        past: s.past.slice(0, -1),
        future: [...s.future, cmd],
      };
    });
  },
  redo() {
    set((s) => {
      if (s.future.length === 0) return s;
      const cmd = s.future[s.future.length - 1]!;
      const patch = applyCommand(s, cmd, 'redo');
      return {
        ...patch,
        future: s.future.slice(0, -1),
        past: [...s.past, cmd],
      };
    });
  },
  clearHistory() {
    set({ past: [], future: [] });
  },
}));

function pushHistory(s: AppState, cmd: EditCommand): Partial<AppState> {
  const next = [...s.past, cmd];
  const trimmed = next.length > s.historyCapacity ? next.slice(next.length - s.historyCapacity) : next;
  return { past: trimmed, future: [] };
}

function applyCommand(
  s: AppState,
  cmd: EditCommand,
  direction: 'undo' | 'redo',
): Partial<AppState> {
  if (cmd.kind === 'move') {
    const positions = new Map(s.positions);
    const entries = direction === 'undo' ? cmd.from : cmd.to;
    for (const [name, pos] of entries) positions.set(name, { x: pos.x, y: pos.y });
    return { positions };
  }
  const edgeLayouts = new Map(s.edgeLayouts);
  const existing = edgeLayouts.get(cmd.refId);
  const target = direction === 'undo' ? cmd.from : cmd.to;
  if (target.length === 0) {
    if (existing) {
      const rest: EdgeLayout = {};
      if (existing.dx !== undefined) rest.dx = existing.dx;
      if (existing.dy !== undefined) rest.dy = existing.dy;
      if (rest.dx !== undefined || rest.dy !== undefined) edgeLayouts.set(cmd.refId, rest);
      else edgeLayouts.delete(cmd.refId);
    }
  } else {
    edgeLayouts.set(cmd.refId, { ...existing, waypoints: target.map((w) => ({ x: w.x, y: w.y })) });
  }
  return { edgeLayouts };
}

export function useAppStore<T>(selector: (state: AppState & AppActions) => T): T {
  const [, forceUpdate] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    let last = selector(store.getState());
    const unsub = store.subscribe(() => {
      const next = selector(store.getState());
      if (!Object.is(last, next)) {
        last = next;
        forceUpdate();
      }
    });
    return unsub;
  }, []);
  return selector(store.getState());
}

export function toTableLayoutRecord(
  positions: Map<QualifiedName, { x: number; y: number }>,
  hiddenTables: Set<QualifiedName>,
  tableColors: Map<QualifiedName, string>,
): Record<QualifiedName, TableLayout> {
  const out: Record<QualifiedName, TableLayout> = {};
  for (const [name, pos] of positions) {
    const entry: TableLayout = { x: Math.round(pos.x), y: Math.round(pos.y) };
    if (hiddenTables.has(name)) entry.hidden = true;
    const c = tableColors.get(name);
    if (c) entry.color = c;
    out[name] = entry;
  }
  return out;
}
