import { createStore } from 'zustand/vanilla';
import { useEffect, useReducer } from 'preact/hooks';
import type { AppSettings, ColumnDiffEntry, EdgeLayout, GitCommitMeta, GitStashEntry, GitStatusSummary, GroupLayout, Layout, ParseError, QualifiedName, RefDiff, RefDiffStatus, Schema, SchemaDiff, SerializableMergeConflict, Table, TableDiffStatus, TableLayout, ViewportLayout, Waypoint } from '../../shared/types';
import { defaultSettings } from '../../shared/types';
import type { ExporterMeta } from '../../shared/exporters/types';
import type { ArrangeCommand, EditCommand, EdgeStyleCommand, MoveCommand, WaypointCommand } from './history';

export interface TooltipState {
  title: string;
  subtitle?: string;
  body: string;
  x: number;
  y: number;
}

/**
 * Non-editing canvas overlays driven by git (spec 16). Mutually exclusive with each other and with
 * merge mode. Both make the canvas read-only via {@link isCanvasReadOnly}.
 *   - `timeTravel`: showing a past commit's schema/layout (read via `git show`, never the work tree).
 *   - `diff`: overlaying an added/removed/modified diff between two revisions.
 */
export type GitView =
  | { kind: 'timeTravel'; rev: string; label: string }
  | { kind: 'diff'; baseLabel: string; headLabel: string };

/** A table removed vs the diff base — rendered as a ghost at its base position (no live node exists). */
export interface DiffGhost {
  table: Table;
  pos: { x: number; y: number };
}

export interface AppState {
  schema: Schema;
  parseError: ParseError | null;
  positions: Map<QualifiedName, { x: number; y: number }>;
  hiddenTables: Set<QualifiedName>;
  tableColors: Map<QualifiedName, string>;
  edgeLayouts: Map<string, EdgeLayout>;
  /** Currently selected edge (ref id) — drives the floating edge toolbar. Null = none. */
  selectedEdgeId: string | null;
  groups: Record<string, GroupLayout>;
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
  /** When true, the top-left application menu popover is open (spec 15). */
  appMenuOpen: boolean;
  /** When true, the Diagram Views panel is expanded (was local to GroupPanel; lifted so the
   *  toolbar's search button can open it). */
  viewsPanelOpen: boolean;
  /** Bumped to request the Diagram Views search input take focus (toolbar search action). */
  viewsSearchFocusNonce: number;
  /** Undo stack. Tail = most recent. Capped at `historyCapacity`. Volatile. */
  past: EditCommand[];
  /** Redo stack. Tail = most recently undone. Cleared on any new push. */
  future: EditCommand[];
  /** Hard cap for `past`; oldest entries drop FIFO when exceeded. */
  historyCapacity: number;
  /** Active layout-merge conflicts (spec 14). Non-null ⇒ the diagram is in blocking
   *  conflict-resolution mode: pan/zoom only, no select/drag/edit/persist until resolved. */
  mergeConflicts: SerializableMergeConflict[] | null;
  /** Per-conflict decisions keyed by `SerializableMergeConflict.id`. Revertible until Apply. */
  mergeDecisions: Record<string, 'ours' | 'theirs'>;
  /** True after Apply is posted to the host, while awaiting `merge:done`. */
  mergeApplying: boolean;
  /** Conflict-resolver view: review-all list vs the focused one-at-a-time stepper. */
  mergeView: 'all' | 'step';
  /** Stepper index into `mergeConflicts`. */
  mergeCursor: number;
  /** Shared hover (ghost ↔ stepper button cross-highlight), keyed by conflict id + side. */
  mergeHover: { id: string; side: 'ours' | 'theirs' } | null;
  /** Live git status of the diagram files (spec 16). Null until the host first reports. */
  gitStatus: GitStatusSummary | null;
  /** When true, the Git panel modal is open. */
  gitPanelOpen: boolean;
  /** True while a git write op (commit/stash/restore) is in flight — disables the action buttons. */
  gitBusy: boolean;
  /** Repo-global stash entries, newest first (spec 16). */
  gitStashes: GitStashEntry[];
  /** Commits touching the diagram files (History pane), newest first. */
  gitCommits: GitCommitMeta[];
  /** Active git canvas overlay (time-travel / diff), or null. Drives the read-only gate. */
  gitView: GitView | null;
  /** Diff overlay (null unless `gitView.kind === 'diff'`). Per-table status for live (added/modified)
   *  tables; removed tables live in `diffGhosts`. */
  diffByTable: Map<QualifiedName, TableDiffStatus> | null;
  /** Per-table column diffs for modified tables (keyed by table → column name → entry). */
  columnDiffByTable: Map<QualifiedName, Map<string, ColumnDiffEntry>> | null;
  /** Removed tables to render as ghosts at their base positions. */
  diffGhosts: DiffGhost[] | null;
  /** Ref (FK) diff keyed by stable ref id. Added refs tint live edges; removed refs draw as ghosts. */
  refDiff: Map<string, RefDiffStatus> | null;
  /** Removed refs (endpoints) for the ghost connector overlay. */
  diffRemovedRefs: RefDiff[] | null;
  /** Previous (base) full table for changed tables — feeds the inline unified-diff rows. */
  diffBaseByTable: Map<QualifiedName, Table> | null;
  /** When true (default), tables NOT in the active diff / merge are dimmed + blurred to focus the
   *  changes/conflicts. Shared by the diff overlay and the merge resolver (spec 14/16). */
  focusDimming: boolean;
  /** Index into the change list for the banner's prev/next camera navigation. */
  diffCursor: number;
  /** Table currently hovered on the canvas — reveals its (otherwise faded) connected edges. */
  hoveredTable: QualifiedName | null;
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
  setEdgeWaypoints(refId: string, waypoints: Waypoint[]): void;
  applyEdgeLayouts(entries: Array<[string, EdgeLayout | null]>): void;
  setEdgeColor(refId: string, color: string | null): void;
  setEdgeSide(refId: string, end: 'source' | 'target', side: 'left' | 'right' | null): void;
  resetEdgeShape(refId: string): void;
  setSelectedEdge(refId: string | null): void;
  setSelection(names: Iterable<QualifiedName>): void;
  clearSelection(): void;
  setTooltip(t: TooltipState | null): void;
  toggleShowOnlyPkFk(): void;
  setSettings(s: AppSettings): void;
  setExporters(list: ExporterMeta[]): void;
  setExportPromptOpen(open: boolean): void;
  setSettingsPanelOpen(open: boolean): void;
  setAppMenuOpen(open: boolean): void;
  setViewsPanelOpen(open: boolean): void;
  openViewsAndFocusSearch(): void;
  pushMoveCommand(cmd: MoveCommand): void;
  pushWaypointCommand(cmd: WaypointCommand): void;
  pushEdgeStyleCommand(cmd: EdgeStyleCommand): void;
  pushArrangeCommand(cmd: ArrangeCommand): void;
  undo(): void;
  redo(): void;
  clearHistory(): void;
  beginMerge(conflicts: SerializableMergeConflict[]): void;
  setMergeDecision(id: string, side: 'ours' | 'theirs'): void;
  setMergeDecisionsBulk(side: 'ours' | 'theirs'): void;
  setMergeApplying(applying: boolean): void;
  setMergeView(view: 'all' | 'step'): void;
  setMergeCursor(index: number): void;
  mergeStep(delta: number): void;
  setMergeHover(hover: { id: string; side: 'ours' | 'theirs' } | null): void;
  endMerge(): void;
  setGitStatus(status: GitStatusSummary): void;
  setGitPanelOpen(open: boolean): void;
  setGitBusy(busy: boolean): void;
  setGitStashes(stashes: GitStashEntry[]): void;
  setGitCommits(commits: GitCommitMeta[]): void;
  enterTimeTravel(rev: string, label: string): void;
  enterDiff(baseLabel: string, headLabel: string, diff: SchemaDiff): void;
  exitGitView(): void;
  setFocusDimming(on: boolean): void;
  setDiffCursor(index: number): void;
  setHoveredTable(name: QualifiedName | null): void;
}

const initial: AppState = {
  schema: { tables: [], refs: [], groups: [] },
  parseError: null,
  positions: new Map(),
  hiddenTables: new Set(),
  tableColors: new Map(),
  edgeLayouts: new Map(),
  selectedEdgeId: null,
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
  appMenuOpen: false,
  viewsPanelOpen: true,
  viewsSearchFocusNonce: 0,
  past: [],
  future: [],
  historyCapacity: 200,
  mergeConflicts: null,
  mergeDecisions: {},
  mergeApplying: false,
  mergeView: 'all',
  mergeCursor: 0,
  mergeHover: null,
  gitStatus: null,
  gitPanelOpen: false,
  gitBusy: false,
  gitStashes: [],
  gitCommits: [],
  gitView: null,
  diffByTable: null,
  columnDiffByTable: null,
  diffGhosts: null,
  refDiff: null,
  diffRemovedRefs: null,
  diffBaseByTable: null,
  focusDimming: true,
  diffCursor: 0,
  hoveredTable: null,
};

/** The canvas is read-only (pan/zoom only) during a merge OR any git overlay (time-travel / diff).
 *  Single predicate so every edit gate honors all three without scattering `||` checks (spec 14/16). */
export function isCanvasReadOnly(s: AppState): boolean {
  return s.mergeConflicts !== null || s.gitView !== null;
}

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
      if (eo.color) e.color = eo.color;
      if (eo.sourceSide === 'left' || eo.sourceSide === 'right') e.sourceSide = eo.sourceSide;
      if (eo.targetSide === 'left' || eo.targetSide === 'right') e.targetSide = eo.targetSide;
      if (e.waypoints || e.color || e.sourceSide || e.targetSide || e.dx !== undefined || e.dy !== undefined) {
        edgeLayouts.set(id, e);
      }
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
  setEdgeWaypoints(refId, waypoints) {
    set((s) => {
      const next = new Map(s.edgeLayouts);
      const merged: EdgeLayout = { ...(next.get(refId) ?? {}) };
      const wps = waypoints.map((w) => ({ x: Math.round(w.x), y: Math.round(w.y) }));
      if (wps.length > 0) merged.waypoints = wps; else delete merged.waypoints;
      writeLayout(next, refId, merged);
      return { edgeLayouts: next };
    });
  },
  applyEdgeLayouts(entries) {
    set((s) => {
      const next = new Map(s.edgeLayouts);
      for (const [refId, layout] of entries) {
        if (layout) writeLayout(next, refId, { ...layout });
        else next.delete(refId);
      }
      return { edgeLayouts: next };
    });
  },
  setEdgeColor(refId, color) {
    set((s) => {
      const next = new Map(s.edgeLayouts);
      const merged: EdgeLayout = { ...(next.get(refId) ?? {}) };
      if (color) merged.color = color; else delete merged.color;
      writeLayout(next, refId, merged);
      return { edgeLayouts: next };
    });
  },
  setEdgeSide(refId, end, side) {
    set((s) => {
      const next = new Map(s.edgeLayouts);
      const merged: EdgeLayout = { ...(next.get(refId) ?? {}) };
      if (end === 'source') {
        if (side) merged.sourceSide = side; else delete merged.sourceSide;
      } else {
        if (side) merged.targetSide = side; else delete merged.targetSide;
      }
      writeLayout(next, refId, merged);
      return { edgeLayouts: next };
    });
  },
  resetEdgeShape(refId) {
    set((s) => {
      const existing = s.edgeLayouts.get(refId);
      if (!existing) return s;
      const next = new Map(s.edgeLayouts);
      // Reset shape only (waypoints + side overrides + legacy); keep the user's color.
      const merged: EdgeLayout = {};
      if (existing.color) merged.color = existing.color;
      writeLayout(next, refId, merged);
      return { edgeLayouts: next };
    });
  },
  setSelectedEdge(refId) {
    set({ selectedEdgeId: refId });
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
  setAppMenuOpen(open) {
    set({ appMenuOpen: open });
  },
  setViewsPanelOpen(open) {
    set({ viewsPanelOpen: open });
  },
  openViewsAndFocusSearch() {
    set((s) => ({ viewsPanelOpen: true, viewsSearchFocusNonce: s.viewsSearchFocusNonce + 1 }));
  },
  pushMoveCommand(cmd) {
    set((s) => pushHistory(s, cmd));
  },
  pushWaypointCommand(cmd) {
    set((s) => pushHistory(s, cmd));
  },
  pushEdgeStyleCommand(cmd) {
    set((s) => pushHistory(s, cmd));
  },
  pushArrangeCommand(cmd) {
    set((s) => pushHistory(s, cmd));
  },
  undo() {
    set((s) => {
      if (isCanvasReadOnly(s)) return s; // read-only during conflict resolution / git overlay (spec 14/16)
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
      if (isCanvasReadOnly(s)) return s; // read-only during conflict resolution / git overlay (spec 14/16)
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
  beginMerge(conflicts) {
    // Enter blocking conflict mode; drop any stale selection so nothing is editable behind the gate.
    // A host merge always wins over a git overlay, so clear gitView too.
    set({ mergeConflicts: conflicts, mergeDecisions: {}, mergeApplying: false, mergeView: 'all', mergeCursor: 0, mergeHover: null, selection: new Set(), selectedEdgeId: null, gitView: null, diffByTable: null, columnDiffByTable: null, diffBaseByTable: null, diffGhosts: null, refDiff: null, diffRemovedRefs: null, diffCursor: 0 });
  },
  setMergeDecision(id, side) {
    set((s) => ({ mergeDecisions: { ...s.mergeDecisions, [id]: side } }));
  },
  setMergeDecisionsBulk(side) {
    set((s) => {
      if (!s.mergeConflicts) return s;
      const next: Record<string, 'ours' | 'theirs'> = {};
      for (const c of s.mergeConflicts) next[c.id] = side;
      return { mergeDecisions: next };
    });
  },
  setMergeApplying(applying) {
    set({ mergeApplying: applying });
  },
  setMergeView(view) {
    set({ mergeView: view });
  },
  setMergeCursor(index) {
    set((s) => {
      const n = s.mergeConflicts?.length ?? 0;
      if (n === 0) return s;
      return { mergeCursor: Math.max(0, Math.min(n - 1, index)) };
    });
  },
  mergeStep(delta) {
    set((s) => {
      const n = s.mergeConflicts?.length ?? 0;
      if (n === 0) return s;
      return { mergeCursor: Math.max(0, Math.min(n - 1, s.mergeCursor + delta)) };
    });
  },
  setMergeHover(hover) {
    set({ mergeHover: hover });
  },
  endMerge() {
    set({ mergeConflicts: null, mergeDecisions: {}, mergeApplying: false, mergeView: 'all', mergeCursor: 0, mergeHover: null });
  },
  setGitStatus(status) {
    set({ gitStatus: status });
  },
  setGitPanelOpen(open) {
    set({ gitPanelOpen: open });
  },
  setGitBusy(busy) {
    set({ gitBusy: busy });
  },
  setGitStashes(stashes) {
    set({ gitStashes: stashes });
  },
  setGitCommits(commits) {
    set({ gitCommits: commits });
  },
  enterTimeTravel(rev, label) {
    // Read-only preview of a past commit; drop selection so nothing edits behind the gate.
    set({ gitView: { kind: 'timeTravel', rev, label }, selection: new Set(), selectedEdgeId: null });
  },
  enterDiff(baseLabel, headLabel, diff) {
    const diffByTable = new Map<QualifiedName, TableDiffStatus>();
    const columnDiffByTable = new Map<QualifiedName, Map<string, ColumnDiffEntry>>();
    const diffBaseByTable = new Map<QualifiedName, Table>();
    const ghosts: DiffGhost[] = [];
    for (const t of diff.tables) {
      if (t.status === 'removed') {
        if (t.base && t.pos) ghosts.push({ table: t.base, pos: t.pos });
        continue;
      }
      diffByTable.set(t.table, t.status);
      if (t.base) diffBaseByTable.set(t.table, t.base); // Previous version for the hover card
      if (t.columns.length > 0) {
        const m = new Map<string, ColumnDiffEntry>();
        for (const c of t.columns) m.set(c.name, c);
        columnDiffByTable.set(t.table, m);
      }
    }
    const refDiff = new Map<string, RefDiffStatus>();
    const removedRefs: RefDiff[] = [];
    for (const r of diff.refs) {
      refDiff.set(r.id, r.status);
      if (r.status === 'removed') removedRefs.push(r);
    }
    set({
      gitView: { kind: 'diff', baseLabel, headLabel },
      diffByTable,
      columnDiffByTable,
      diffBaseByTable,
      diffGhosts: ghosts,
      refDiff,
      diffRemovedRefs: removedRefs,
      diffCursor: 0,
      selection: new Set(),
      selectedEdgeId: null,
    });
  },
  exitGitView() {
    set({
      gitView: null,
      diffByTable: null,
      columnDiffByTable: null,
      diffBaseByTable: null,
      diffGhosts: null,
      refDiff: null,
      diffRemovedRefs: null,
      diffCursor: 0,
    });
  },
  setFocusDimming(on) {
    set({ focusDimming: on });
  },
  setDiffCursor(index) {
    set({ diffCursor: index });
  },
  setHoveredTable(name) {
    set((s) => (s.hoveredTable === name ? s : { hoveredTable: name }));
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
  if (cmd.kind === 'edgeStyle') {
    const edgeLayouts = new Map(s.edgeLayouts);
    const merged: EdgeLayout = { ...(edgeLayouts.get(cmd.refId) ?? {}) };
    const t = direction === 'undo' ? cmd.from : cmd.to;
    if (t.color !== undefined) merged.color = t.color; else delete merged.color;
    if (t.sourceSide !== undefined) merged.sourceSide = t.sourceSide; else delete merged.sourceSide;
    if (t.targetSide !== undefined) merged.targetSide = t.targetSide; else delete merged.targetSide;
    writeLayout(edgeLayouts, cmd.refId, merged);
    return { edgeLayouts };
  }
  if (cmd.kind === 'arrange') {
    const positions = new Map(s.positions);
    const posEntries = direction === 'undo' ? cmd.from : cmd.to;
    for (const [name, pos] of posEntries) positions.set(name, { x: pos.x, y: pos.y });
    const edgeLayouts = new Map(s.edgeLayouts);
    const edgeEntries = direction === 'undo' ? cmd.edgesFrom : cmd.edgesTo;
    for (const [refId, layout] of edgeEntries) {
      if (layout) writeLayout(edgeLayouts, refId, { ...layout });
      else edgeLayouts.delete(refId);
    }
    return { positions, edgeLayouts };
  }
  const edgeLayouts = new Map(s.edgeLayouts);
  const merged: EdgeLayout = { ...(edgeLayouts.get(cmd.refId) ?? {}) };
  const target = direction === 'undo' ? cmd.from : cmd.to;
  if (target.length === 0) delete merged.waypoints;
  else merged.waypoints = target.map((w) => ({ x: w.x, y: w.y }));
  writeLayout(edgeLayouts, cmd.refId, merged);
  return { edgeLayouts };
}

/** Write a pruned EdgeLayout into the map, or delete the key when it carries no data. */
function writeLayout(map: Map<string, EdgeLayout>, refId: string, layout: EdgeLayout): void {
  const clean: EdgeLayout = { ...layout };
  if (clean.waypoints && clean.waypoints.length === 0) delete clean.waypoints;
  const hasData =
    (clean.waypoints !== undefined) ||
    clean.color !== undefined ||
    clean.sourceSide !== undefined ||
    clean.targetSide !== undefined ||
    clean.dx !== undefined ||
    clean.dy !== undefined;
  if (hasData) map.set(refId, clean);
  else map.delete(refId);
}

export function useAppStore<T>(selector: (state: AppState & AppActions) => T): T {
  const [, forceUpdate] = useReducer((c: number, _action: void) => c + 1, 0);
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
