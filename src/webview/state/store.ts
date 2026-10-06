import { createStore } from 'zustand/vanilla';
import { useEffect, useReducer, useRef } from 'preact/hooks';
import type { AppSettings, ColumnDiffEntry, ColumnRef, EdgeLayout, EdgeSide, GitCommitMeta, GitStashEntry, GitStatusSummary, GroupLayout, Layout, ParseError, QualifiedName, RefDiff, RefDiffStatus, Schema, SchemaDiff, SerializableMergeConflict, Table, TableDiffStatus, TableLayout, ViewportLayout, Waypoint } from '../../shared/types';
import { defaultSettings, hasAutoShape, isEdgeSide } from '../../shared/types';
import type { ExporterMeta } from '../../shared/exporters/types';
import type { ArrangeCommand, EditCommand, EdgeStyleCommand, MoveCommand, SchemaEditCommand, WaypointCommand } from './history';
import { isEdgeKey } from '../render/edgeKey';
import { densityMetrics, type DensityMetrics } from '../layout/density';
import { effectiveEdgeLayout } from '../layout/edgeSides';
import { recordPositionsDelta } from './positionsDelta';

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
  /** Set by the first `setLayout`. Only that one adopts the saved camera; later host pushes
   *  (watcher, merge apply, overlay exit, reset) keep the live one (spec 03, F26). */
  cameraAdopted: boolean;
  theme: 'light' | 'dark';
  ready: boolean;
  selection: Set<QualifiedName>;
  tooltip: TooltipState | null;
  /** Ephemeral view flag: render only PK + FK columns in tables. Not persisted. */
  showOnlyPkFk: boolean;
  /** Ephemeral view flag: draw DBML `Dep` edges (spec 18). Not persisted. */
  showDeps: boolean;
  /** Table whose sample records are open in the records modal (spec 18). Null = closed. */
  recordsTable: QualifiedName | null;
  settings: AppSettings;
  exporters: ExporterMeta[];
  /** When true, the Export (schema) modal is open. */
  exportPromptOpen: boolean;
  /** When true, the Export image modal is open. */
  exportImagePromptOpen: boolean;
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
  /** Working undo/redo set aside while a git overlay is up, with the table set it was recorded
   *  against (spec 11: looking at a revision is not editing; F76). */
  historyStash: { past: EditCommand[]; future: EditCommand[]; tables: Set<QualifiedName> } | null;
  /** Active layout-merge conflicts (spec 14). Non-null ⇒ the diagram is in blocking
   *  conflict-resolution mode: pan/zoom only, no select/drag/edit/persist until resolved. */
  mergeConflicts: SerializableMergeConflict[] | null;
  /** Set when the host could not read the conflict from git: still blocking, nothing to pick. */
  mergeError: string | null;
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
  /** Bumped on every successful commit — the commit pane clears its message on this, not optimistically. */
  gitCommitOkCount: number;
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
  /** Index into the change list for the banner's prev/next camera navigation; -1 = none focused yet. */
  diffCursor: number;
  /** Table currently hovered on the canvas — reveals its (otherwise faded) connected edges. */
  hoveredTable: QualifiedName | null;
  /** Pan-tool toggle (the hand button beside the zoom controls). Ephemeral, not persisted.
   *  When on (or `spacePan`), left-drag pans the canvas instead of selecting/dragging tables. */
  panMode: boolean;
  /** True while the spacebar is held — a temporary pan override regardless of `panMode`. */
  spacePan: boolean;
  /**
   * On-demand edge-ordering progress (spec 05 §9). `null` ⇒ idle; non-null ⇒ a run is in flight and
   * the cancelable progress overlay is shown. Ephemeral, never persisted, and NOT read by the edge
   * route memo, so pumping it never re-routes edges.
   */
  edgeOrderProgress: { pct: number } | null;
  /**
   * Ids of diagram `.dbml` edits (applied, or asked to undo/redo) whose schema push may still be on
   * its way: that push changes the table set without invalidating the history (spec 11, spec 19).
   */
  schemaEchoes: ReadonlySet<string>;
  /** Transient canvas notice (no-op explanations); `seq` restarts its timer on a repeat. */
  notice: { text: string; seq: number } | null;
  /** FK dropped on a column, waiting for its cardinality pick (spec 19 §Crear FK). */
  refDraft: { from: ColumnRef; to: ColumnRef; x: number; y: number } | null;
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
  setEdgeSide(refId: string, end: 'source' | 'target', side: EdgeSide | null): void;
  resetEdgeShape(refId: string): void;
  setSelectedEdge(refId: string | null): void;
  setSelection(names: Iterable<QualifiedName>): void;
  clearSelection(): void;
  setTooltip(t: TooltipState | null): void;
  toggleShowOnlyPkFk(): void;
  toggleShowDeps(): void;
  setRecordsTable(name: QualifiedName | null): void;
  setSettings(s: AppSettings): void;
  setExporters(list: ExporterMeta[]): void;
  setExportPromptOpen(open: boolean): void;
  setExportImagePromptOpen(open: boolean): void;
  setSettingsPanelOpen(open: boolean): void;
  setAppMenuOpen(open: boolean): void;
  setViewsPanelOpen(open: boolean): void;
  openViewsAndFocusSearch(): void;
  pushMoveCommand(cmd: MoveCommand): void;
  pushWaypointCommand(cmd: WaypointCommand): void;
  pushEdgeStyleCommand(cmd: EdgeStyleCommand): void;
  pushArrangeCommand(cmd: ArrangeCommand): void;
  pushSchemaCommand(id: string, label: string): void;
  /** The host did not undo/redo `id`: remove it from either stack without applying it. */
  dropSchemaCommand(id: string): void;
  /** Host-chosen spot of a table it is about to write; the table may not be in the schema yet. */
  placeTable(name: QualifiedName, x: number, y: number): void;
  showNotice(text: string): void;
  clearNotice(seq: number): void;
  setRefDraft(draft: AppState['refDraft']): void;
  undo(): void;
  redo(): void;
  clearHistory(): void;
  /** The working layout changed under a git overlay: its stashed history no longer applies. */
  dropHistoryStash(): void;
  beginMerge(conflicts: SerializableMergeConflict[], error?: string | null): void;
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
  noteGitCommitOk(): void;
  setGitStashes(stashes: GitStashEntry[]): void;
  setGitCommits(commits: GitCommitMeta[]): void;
  enterTimeTravel(rev: string, label: string): void;
  enterDiff(baseLabel: string, headLabel: string, diff: SchemaDiff): void;
  exitGitView(): void;
  setFocusDimming(on: boolean): void;
  setDiffCursor(index: number): void;
  setHoveredTable(name: QualifiedName | null): void;
  setPanMode(on: boolean): void;
  setSpacePan(on: boolean): void;
  /** Show the edge-ordering overlay at 0% (start of an on-demand run). */
  startEdgeOrderProgress(): void;
  /** Update the overlay percentage, monotonically (ignores a lower value than the current one). */
  setEdgeOrderProgress(pct: number): void;
  /** Hide the edge-ordering overlay (run finished or canceled). */
  endEdgeOrderProgress(): void;
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
  cameraAdopted: false,
  theme: 'light',
  ready: false,
  selection: new Set(),
  tooltip: null,
  showOnlyPkFk: false,
  showDeps: true,
  recordsTable: null,
  panMode: false,
  spacePan: false,
  edgeOrderProgress: null,
  schemaEchoes: new Set(),
  notice: null,
  refDraft: null,
  settings: defaultSettings(),
  exporters: [],
  exportPromptOpen: false,
  exportImagePromptOpen: false,
  settingsPanelOpen: false,
  appMenuOpen: false,
  viewsPanelOpen: true,
  viewsSearchFocusNonce: 0,
  past: [],
  future: [],
  historyCapacity: 200,
  historyStash: null,
  mergeConflicts: null,
  mergeError: null,
  mergeDecisions: {},
  mergeApplying: false,
  mergeView: 'all',
  mergeCursor: 0,
  mergeHover: null,
  gitStatus: null,
  gitPanelOpen: false,
  gitBusy: false,
  gitCommitOkCount: 0,
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
  diffCursor: -1,
  hoveredTable: null,
};

const NO_DIFF = {
  diffByTable: null,
  columnDiffByTable: null,
  diffBaseByTable: null,
  diffGhosts: null,
  refDiff: null,
  diffRemovedRefs: null,
  diffCursor: -1,
} satisfies Partial<AppState>;

/** The canvas is read-only (pan/zoom only) during a merge OR any git overlay (time-travel / diff).
 *  Single predicate so every edit gate honors all three without scattering `||` checks (spec 14/16). */
export function isCanvasReadOnly(s: AppState): boolean {
  return s.mergeConflicts !== null || s.gitView !== null;
}

export const store = createStore<AppState & AppActions>((set, get) => ({
  ...initial,
  setSchema(schema, parseError) {
    set((s) => {
      const newNames = new Set(schema.tables.map((t) => t.name));
      const sameTableSet = sameNames(newNames, s.schema.tables.map((t) => t.name));
      const patch: Partial<AppState> = { schema, parseError, ready: true, schemaEchoes: NO_ECHOES };
      // A diagram edit's own echo keeps the stack: the change is on it and undoes through the host.
      if (!sameTableSet && s.schemaEchoes.size === 0) {
        patch.past = [];
        patch.future = [];
      }
      if (!sameTableSet) {
        patch.selection = withoutSelected(s.selection, [...s.selection].filter((n) => !newNames.has(n)));
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
    // No position: the auto-layout effect places these, and they then persist as hidden (F66).
    for (const name of layout.hiddenUnplaced ?? []) hiddenTables.add(name);
    for (const [id, eo] of Object.entries(layout.edges ?? {})) {
      // Orphans no edge can resolve; dropping them here cleans the sidecar on the next persist.
      if (!isEdgeKey(id)) continue;
      const e: EdgeLayout = {};
      if (Array.isArray(eo.waypoints) && eo.waypoints.length > 0) {
        e.waypoints = eo.waypoints.map((w) => ({ x: Math.round(w.x), y: Math.round(w.y) }));
      } else if (eo.dx !== undefined || eo.dy !== undefined) {
        if (eo.dx !== undefined) e.dx = eo.dx;
        if (eo.dy !== undefined) e.dy = eo.dy;
      }
      if (eo.color) e.color = eo.color;
      if (isEdgeSide(eo.sourceSide)) e.sourceSide = eo.sourceSide;
      if (isEdgeSide(eo.targetSide)) e.targetSide = eo.targetSide;
      if (eo.auto === true && hasAutoShape(id, { ...e, auto: true })) e.auto = true;
      if (e.waypoints || e.color || e.sourceSide || e.targetSide || e.dx !== undefined || e.dy !== undefined) {
        edgeLayouts.set(id, e);
      }
    }
    set((s) => ({
      positions,
      hiddenTables,
      tableColors,
      edgeLayouts,
      groups: { ...layout.groups },
      viewport: s.cameraAdopted ? s.viewport : { ...layout.viewport },
      cameraAdopted: true,
      past: [],
      future: [],
    }));
  },
  setTablePos(name, x, y) {
    set((s) => {
      const next = new Map(s.positions);
      next.set(name, { x: Math.round(x), y: Math.round(y) });
      recordPositionsDelta(s.positions, next, [name]);
      return { positions: next };
    });
  },
  setPositionsBatch(entries) {
    set((s) => {
      const next = new Map(s.positions);
      const names: QualifiedName[] = [];
      for (const [name, pos] of entries) {
        next.set(name, { x: Math.round(pos.x), y: Math.round(pos.y) });
        names.push(name);
      }
      recordPositionsDelta(s.positions, next, names);
      return { positions: next };
    });
  },
  setViewport(vp) {
    // Identity guard: pan/zoom call this per pointer frame; an unchanged camera must not notify.
    set((s) => {
      const next = { ...s.viewport, ...vp };
      return next.x === s.viewport.x && next.y === s.viewport.y && next.zoom === s.viewport.zoom ? s : { viewport: next };
    });
  },
  setTheme(kind) {
    set({ theme: kind });
  },
  setGroup(name, patch) {
    set((s) => {
      if (isCanvasReadOnly(s)) return s; // Diagram Views edits during merge/overlay would be reverted or lost
      const existing = s.groups[name] ?? {};
      const merged: GroupLayout = { ...existing, ...patch };
      if (merged.collapsed === false) delete merged.collapsed;
      if (merged.hidden === false) delete merged.hidden;
      if (merged.color === '') delete merged.color;
      const unrendered = merged.collapsed || merged.hidden;
      const members = unrendered ? s.schema.groups.find((g) => g.name === name)?.tables ?? [] : [];
      return { groups: { ...s.groups, [name]: merged }, selection: withoutSelected(s.selection, members) };
    });
  },
  setTableHidden(name, hidden) {
    set((s) => {
      if (isCanvasReadOnly(s)) return s;
      const next = new Set(s.hiddenTables);
      if (hidden) next.add(name); else next.delete(name);
      return { hiddenTables: next, selection: hidden ? withoutSelected(s.selection, [name]) : s.selection };
    });
  },
  setTableColor(name, color) {
    set((s) => {
      if (isCanvasReadOnly(s)) return s;
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
      const wps = waypoints.map((w) => ({ x: Math.round(w.x), y: Math.round(w.y) }));
      // Per-pointermove caller: an unchanged list must not mint a new Map (that re-routes every ref).
      // Edits start from what is drawn: an ignored legacy shape is not, so it is replaced whole.
      const current = effectiveEdgeLayout(s.edgeLayouts.get(refId));
      if (sameWaypoints(current?.waypoints, wps)) return s;
      const next = new Map(s.edgeLayouts);
      const merged: EdgeLayout = { ...(current ?? {}) };
      if (wps.length > 0) merged.waypoints = wps; else delete merged.waypoints;
      delete merged.auto;
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
      if (isCanvasReadOnly(s)) return s;
      const next = new Map(s.edgeLayouts);
      const merged: EdgeLayout = { ...(next.get(refId) ?? {}) };
      if (color) merged.color = color; else delete merged.color;
      writeLayout(next, refId, merged);
      return { edgeLayouts: next };
    });
  },
  setEdgeSide(refId, end, side) {
    set((s) => {
      const current = effectiveEdgeLayout(s.edgeLayouts.get(refId));
      const currentSide = end === 'source' ? current?.sourceSide : current?.targetSide;
      if ((currentSide ?? null) === side) return s;
      const next = new Map(s.edgeLayouts);
      const merged: EdgeLayout = { ...(current ?? {}) };
      if (end === 'source') {
        if (side) merged.sourceSide = side; else delete merged.sourceSide;
      } else {
        if (side) merged.targetSide = side; else delete merged.targetSide;
      }
      delete merged.auto;
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
  toggleShowDeps() {
    set((s) => ({ showDeps: !s.showDeps }));
  },
  setRecordsTable(name) {
    set({ recordsTable: name });
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
  setExportImagePromptOpen(open) {
    set({ exportImagePromptOpen: open });
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
  pushSchemaCommand(id, label) {
    const cmd: SchemaEditCommand = { kind: 'schema', id, label, timestamp: Date.now() };
    set((s) => ({ ...pushHistory(s, cmd), schemaEchoes: withEcho(s.schemaEchoes, id) }));
  },
  dropSchemaCommand(id) {
    set((s) => {
      const keep = (c: EditCommand) => c.kind !== 'schema' || c.id !== id;
      const echoes = new Set(s.schemaEchoes);
      echoes.delete(id);
      return { past: s.past.filter(keep), future: s.future.filter(keep), schemaEchoes: echoes };
    });
  },
  placeTable(name, x, y) {
    set((s) => {
      if (isCanvasReadOnly(s)) return s;
      const positions = new Map(s.positions);
      positions.set(name, { x: Math.round(x), y: Math.round(y) });
      recordPositionsDelta(s.positions, positions, [name]);
      // A hidden orphan entry of the same name would make the table the user just created invisible.
      return { positions, hiddenTables: s.hiddenTables.has(name) ? withoutName(s.hiddenTables, name) : s.hiddenTables };
    });
  },
  showNotice(text) {
    set((s) => ({ notice: { text, seq: (s.notice?.seq ?? 0) + 1 } }));
  },
  clearNotice(seq) {
    set((s) => (s.notice?.seq === seq ? { notice: null } : s));
  },
  setRefDraft(draft) {
    set({ refDraft: draft });
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
        ...(cmd.kind === 'schema' ? { schemaEchoes: withEcho(s.schemaEchoes, cmd.id) } : {}),
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
        ...(cmd.kind === 'schema' ? { schemaEchoes: withEcho(s.schemaEchoes, cmd.id) } : {}),
      };
    });
  },
  clearHistory() {
    set({ past: [], future: [] });
  },
  dropHistoryStash() {
    set((s) => (s.historyStash === null ? s : { historyStash: null }));
  },
  beginMerge(conflicts, error = null) {
    // Enter blocking conflict mode; drop any stale selection so nothing is editable behind the gate.
    // A host merge always wins over a git overlay, so clear gitView too.
    const mergeDecisions = keepUnchangedDecisions(get(), conflicts);
    set({ mergeConflicts: conflicts, mergeError: error, mergeDecisions, mergeApplying: false, mergeView: 'all', mergeCursor: 0, mergeHover: null, selection: new Set(), selectedEdgeId: null, gitView: null, historyStash: null, ...NO_DIFF });
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
    set({ mergeConflicts: null, mergeError: null, mergeDecisions: {}, mergeApplying: false, mergeView: 'all', mergeCursor: 0, mergeHover: null });
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
  noteGitCommitOk() {
    set((s) => ({ gitCommitOkCount: s.gitCommitOkCount + 1 }));
  },
  setGitStashes(stashes) {
    set({ gitStashes: stashes });
  },
  setGitCommits(commits) {
    set({ gitCommits: commits });
  },
  enterTimeTravel(rev, label) {
    // Read-only preview of a past commit; drop selection so nothing edits behind the gate. Diff maps
    // are only valid under a diff view: kept, they would tint the past revision (F63).
    set((s) => ({ ...NO_DIFF, ...stashHistory(s), gitView: { kind: 'timeTravel', rev, label }, selection: new Set(), selectedEdgeId: null }));
  },
  enterDiff(baseLabel, headLabel, diff) {
    const diffByTable = new Map<QualifiedName, TableDiffStatus>();
    const columnDiffByTable = new Map<QualifiedName, Map<string, ColumnDiffEntry>>();
    const diffBaseByTable = new Map<QualifiedName, Table>();
    const s = get();
    const ghosts = placeDiffGhosts(diff, s.positions, densityMetrics(s.settings.ui.density));
    for (const t of diff.tables) {
      if (t.status === 'removed') continue;
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
      ...stashHistory(s),
      gitView: { kind: 'diff', baseLabel, headLabel },
      diffByTable,
      columnDiffByTable,
      diffBaseByTable,
      diffGhosts: ghosts,
      refDiff,
      diffRemovedRefs: removedRefs,
      diffCursor: -1,
      selection: new Set(),
      selectedEdgeId: null,
    });
  },
  exitGitView() {
    set((s) => {
      const stash = s.historyStash;
      // Same rule as setSchema: commands recorded against tables that no longer exist cannot undo.
      const restore = stash !== null && sameNames(stash.tables, s.schema.tables.map((t) => t.name));
      return { ...NO_DIFF, gitView: null, historyStash: null, ...(restore ? { past: stash.past, future: stash.future } : {}) };
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
  setPanMode(on) {
    set((s) => (s.panMode === on ? s : { panMode: on }));
  },
  setSpacePan(on) {
    set((s) => (s.spacePan === on ? s : { spacePan: on }));
  },
  startEdgeOrderProgress() {
    set({ edgeOrderProgress: { pct: 0 } });
  },
  setEdgeOrderProgress(pct) {
    set((s) => {
      if (!s.edgeOrderProgress) return s;
      const next = Math.max(s.edgeOrderProgress.pct, Math.min(100, Math.round(pct)));
      return next === s.edgeOrderProgress.pct ? s : { edgeOrderProgress: { pct: next } };
    });
  },
  endEdgeOrderProgress() {
    set((s) => (s.edgeOrderProgress === null ? s : { edgeOrderProgress: null }));
  },
}));

/**
 * Selection minus `names`. Unrendered (hidden / collapsed / removed) tables must leave the selection
 * or a multi-drag and every selection-scoped action would still act on them. Returns the same Set
 * when nothing is removed so `selection` subscribers don't re-render.
 */
function withoutSelected(sel: Set<QualifiedName>, names: Iterable<QualifiedName>): Set<QualifiedName> {
  let next: Set<QualifiedName> | null = null;
  for (const n of names) {
    if (!sel.has(n)) continue;
    next ??= new Set(sel);
    next.delete(n);
  }
  return next ?? sel;
}

/** A refreshed conflict list keeps the picks whose conflict is identical (same id, same sides); a
 *  pick made against values that changed on disk would apply something the user never saw. */
function keepUnchangedDecisions(s: AppState, next: SerializableMergeConflict[]): Record<string, 'ours' | 'theirs'> {
  if (!s.mergeConflicts) return {};
  const prev = new Map(s.mergeConflicts.map((c) => [c.id, JSON.stringify(c)]));
  const kept: Record<string, 'ours' | 'theirs'> = {};
  for (const c of next) {
    const decision = s.mergeDecisions[c.id];
    if (decision && prev.get(c.id) === JSON.stringify(c)) kept[c.id] = decision;
  }
  return kept;
}

/** Moving into a git overlay sets the working history aside; a diff opened from time travel keeps
 *  the stash taken when the first overlay opened. */
function stashHistory(s: AppState): Partial<AppState> {
  if (s.historyStash !== null) return {};
  return { historyStash: { past: s.past, future: s.future, tables: new Set(s.schema.tables.map((t) => t.name)) }, past: [], future: [] };
}

const NO_ECHOES: ReadonlySet<string> = new Set();

function withEcho(echoes: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return new Set(echoes).add(id);
}

function withoutName(set: Set<QualifiedName>, name: QualifiedName): Set<QualifiedName> {
  const next = new Set(set);
  next.delete(name);
  return next;
}

function sameNames(a: Set<QualifiedName>, b: QualifiedName[]): boolean {
  const bs = new Set(b);
  return a.size === bs.size && [...a].every((n) => bs.has(n));
}

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
  // The host owns the text: the caller posts schema:undo / schema:redo (historyActions.ts).
  if (cmd.kind === 'schema') return {};
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
    if (t.auto) merged.auto = true; else delete merged.auto;
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
  if (direction === 'undo' && cmd.fromAuto) merged.auto = true; else delete merged.auto;
  writeLayout(edgeLayouts, cmd.refId, merged);
  return { edgeLayouts };
}

/** Write a pruned EdgeLayout into the map, or delete the key when it carries no data. */
function writeLayout(map: Map<string, EdgeLayout>, refId: string, layout: EdgeLayout): void {
  const clean: EdgeLayout = { ...layout };
  if (clean.waypoints && clean.waypoints.length === 0) delete clean.waypoints;
  if (clean.auto && !hasAutoShape(refId, clean)) delete clean.auto;
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

function sameWaypoints(a: Waypoint[] | undefined, b: Waypoint[]): boolean {
  const aa = a ?? [];
  if (aa.length !== b.length) return false;
  for (let i = 0; i < aa.length; i++) {
    if (aa[i]!.x !== b[i]!.x || aa[i]!.y !== b[i]!.y) return false;
  }
  return true;
}

export function useAppStore<T>(selector: (state: AppState & AppActions) => T): T {
  const [, forceUpdate] = useReducer((c: number, _action: void) => c + 1, 0);
  const value = selector(store.getState());
  // Refs, not closure captures: the effect runs once, but the selector may close over props and
  // the store may change between this render and the subscription below.
  const selectorRef = useRef(selector);
  const lastRef = useRef(value);
  selectorRef.current = selector;
  lastRef.current = value;
  useEffect(() => {
    const check = () => {
      const next = selectorRef.current(store.getState());
      if (!Object.is(lastRef.current, next)) {
        lastRef.current = next;
        forceUpdate();
      }
    };
    const unsub = store.subscribe(check);
    check();
    return unsub;
  }, []);
  return value;
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

/**
 * Ghost placement for removed tables. HEAD's sidecar has no entry for a table nobody ever dragged,
 * so the base position falls back to where this webview last drew it (`positions` is never pruned
 * on schema change); failing that, the ghost is synthesized next to its removed-ref neighbours or
 * stacked beside the diagram. A removed table is never dropped: it must stay a banner target and a
 * line anchor for its removed refs (spec 16).
 */
function placeDiffGhosts(
  diff: SchemaDiff,
  positions: Map<QualifiedName, { x: number; y: number }>,
  m: DensityMetrics,
): DiffGhost[] {
  const gap = m.headerHeight * 2;
  const ghosts: DiffGhost[] = [];
  const placed = new Map<QualifiedName, { x: number; y: number }>();
  const unplaced: Table[] = [];
  for (const t of diff.tables) {
    if (t.status !== 'removed' || !t.base) continue;
    const pos = t.pos ?? positions.get(t.table);
    if (pos) {
      ghosts.push({ table: t.base, pos });
      placed.set(t.table, pos);
    } else unplaced.push(t.base);
  }
  if (unplaced.length === 0) return ghosts;

  let right = -Infinity;
  let top = Infinity;
  for (const p of [...positions.values(), ...placed.values()]) {
    right = Math.max(right, p.x + m.tableWidth);
    top = Math.min(top, p.y);
  }
  const stackX = Number.isFinite(right) ? Math.round(right + gap) : 0;
  let stackY = Number.isFinite(top) ? Math.round(top) : 0;

  for (const table of unplaced) {
    const neighbours: Array<{ x: number; y: number }> = [];
    for (const r of diff.refs) {
      if (r.status !== 'removed') continue;
      const other = r.source === table.name ? r.target : r.target === table.name ? r.source : null;
      const p = other != null && other !== table.name ? (positions.get(other) ?? placed.get(other)) : undefined;
      if (p) neighbours.push(p);
    }
    let pos: { x: number; y: number };
    if (neighbours.length > 0) {
      const x = Math.max(...neighbours.map((p) => p.x)) + m.tableWidth + gap;
      const y = neighbours.reduce((acc, p) => acc + p.y, 0) / neighbours.length;
      pos = { x: Math.round(x), y: Math.round(y) };
    } else {
      pos = { x: stackX, y: stackY };
      stackY += m.headerHeight + table.columns.length * m.rowHeight + m.colsPad + gap;
    }
    ghosts.push({ table, pos });
    placed.set(table.name, pos);
  }
  return ghosts;
}
