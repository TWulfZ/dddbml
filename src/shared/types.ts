/**
 * Shared types between extension host (Node.js) and webview (Preact).
 * These MUST be plain data — no class instances, no functions.
 * They cross the postMessage boundary and are JSON-serialized.
 */

import type { ExportCommandPayload, ExporterMeta } from './exporters/types';

export type QualifiedName = string; // e.g., "public.users"

export interface Column {
  name: string;
  type: string;
  pk?: boolean;
  notNull?: boolean;
  unique?: boolean;
  increment?: boolean;
  default?: string | null;
  note?: string | null;
}

export interface Table {
  name: QualifiedName;
  schemaName: string;
  tableName: string;
  columns: Column[];
  note?: string | null;
  groupName?: string | null;
}

export type RefEndpointRelation = '1' | '*'; // one or many

export interface Ref {
  id: string; // stable hash of endpoints
  source: { table: QualifiedName; columns: string[]; relation: RefEndpointRelation };
  target: { table: QualifiedName; columns: string[]; relation: RefEndpointRelation };
  name?: string | null;
}

export interface TableGroup {
  name: string;
  tables: QualifiedName[];
  note?: string | null;
}

export interface Schema {
  tables: Table[];
  refs: Ref[];
  groups: TableGroup[];
}

export interface ParseError {
  message: string;
  line?: number;
  column?: number;
}

/* ----- Layout file ----- */

export interface TableLayout {
  x: number;
  y: number;
  hidden?: boolean;
  color?: string;
}

export interface GroupLayout {
  collapsed?: boolean;
  hidden?: boolean;
  color?: string;
}

export interface ViewportLayout {
  x: number;
  y: number;
  zoom: number;
}

export interface Waypoint {
  x: number;
  y: number;
}

export interface EdgeLayout {
  /**
   * Orthogonal bend vertices in absolute world coords. Empty/undefined = auto H-V-H routing.
   * Edited via segment dragging (never free placement) so the path stays axis-aligned: a
   * waypoint's relevant coordinate pins a trunk while the router re-bridges the other axis to
   * the (table-following) ports — which is why moving a table never strands a waypoint.
   */
  waypoints?: Waypoint[];
  /** Per-edge stroke color (BC palette value or custom hex). Absent = theme default. */
  color?: string;
  /** Manual override of the auto-chosen source port side. Absent = `chooseSides`. */
  sourceSide?: 'left' | 'right';
  /** Manual override of the auto-chosen target port side. Absent = `chooseSides`. */
  targetSide?: 'left' | 'right';
  /** @deprecated v1 — single H-V-H midX offset. Migrated to a single waypoint on first persist. */
  dx?: number;
  /** @deprecated v1 — see `dx`. */
  dy?: number;
}

export interface Layout {
  version: 1;
  viewport: ViewportLayout;
  tables: Record<QualifiedName, TableLayout>;
  groups: Record<string, GroupLayout>;
  edges?: Record<string, EdgeLayout>;
}

/* ----- Collaborative merge (see specs/14) ----- */

export type MergeSection = 'tables' | 'groups' | 'edges';

/**
 * A single "both sides changed the same key" conflict, in a shape safe to cross the
 * postMessage boundary. Absent/deleted sides are `null` (NOT `undefined` — VS Code's
 * postMessage drops undefined keys). `id` = `${section}::${key}`, stable, keys the
 * resolution map the webview sends back. The host applies from its OWN retained
 * `MergeConflict[]`; this payload is display-only + identity.
 */
export interface SerializableMergeConflict {
  id: string;
  section: MergeSection;
  key: string;
  ours: TableLayout | GroupLayout | EdgeLayout | null;
  theirs: TableLayout | GroupLayout | EdgeLayout | null;
}

/* ----- Git integration (see specs/16) ----- */

/** Working-tree status of one diagram file. Mirrors the host `GitFileStatus`. */
export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';

export interface GitPathStatus {
  /** Repo-relative, forward-slash path. */
  relpath: string;
  status: GitFileStatus;
}

/** One commit touching the diagram files. */
export interface GitCommitMeta {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
}

/** One stash entry. `ref` = `stash@{N}`, `index` = N. */
export interface GitStashEntry {
  ref: string;
  index: number;
  message: string;
}

/** A git write op whose result is reported back so the webview can clear its busy state. */
export type GitOp = 'restore' | 'stashPush' | 'stashApply' | 'stashPop';

/* --- Schema diff overlay (spec 16, Phase 4) --- */

export type TableDiffStatus = 'added' | 'removed' | 'modified';
export type ColumnDiffStatus = 'added' | 'removed' | 'changed';
export type RefDiffStatus = 'added' | 'removed';

export interface ColumnDiffEntry {
  name: string;
  status: ColumnDiffStatus;
  /** Base column type — present for 'removed' so the synthetic ghost row can render; null otherwise. */
  type: string | null;
}

export interface TableDiff {
  table: QualifiedName;
  status: TableDiffStatus;
  /** Per-column diffs for 'modified' tables. Empty for added; for removed the ghost uses `base`. */
  columns: ColumnDiffEntry[];
  /** Full base table — present only for 'removed' (the ghost renders it). Null otherwise. */
  base: Table | null;
  /** Base world position from the base sidecar — present only for 'removed' (ghost placement). */
  pos: { x: number; y: number } | null;
}

export interface RefDiff {
  /** Stable ref id (matches `Ref.id`). */
  id: string;
  status: RefDiffStatus;
  source: QualifiedName;
  target: QualifiedName;
}

/** Serializable structural diff between two revisions. Only changed entities are listed. */
export interface SchemaDiff {
  tables: TableDiff[];
  refs: RefDiff[];
}

/**
 * Live git status of the diagram files, pushed to the webview on hydrate and on every
 * dbml/sidecar change. `files` lists only CHANGED files (a clean repo => empty), so
 * `dirty === files.length > 0`. All scoped to the diagram files only.
 */
export interface GitStatusSummary {
  inRepo: boolean;
  /** Current branch, or null when detached / not a repo. */
  branch: string | null;
  files: GitPathStatus[];
  dirty: boolean;
}

/* ----- Settings ----- */

export type UiDensity = 'compact' | 'cozy' | 'comfortable';

export interface AppSettings {
  zoomStep: number;
  zoomMin: number;
  zoomMax: number;
  lod: {
    lowThreshold: number;
  };
  ui: {
    density: UiDensity;
    /** Magnet mode: snap table positions and edge bend vertices to `gridSize`. */
    snapToGrid: boolean;
    /** World-unit grid spacing used when `snapToGrid` is on. */
    gridSize: number;
  };
  export: {
    defaultFormat: string;
    typeorm: {
      dialect: string;
      singularize: boolean;
      includeImports: boolean;
      emitNullableExplicit: boolean;
    };
  };
}

export function defaultSettings(): AppSettings {
  return {
    zoomStep: 1.2,
    zoomMin: 0.08,
    zoomMax: 4,
    lod: { lowThreshold: 0.3 },
    ui: { density: 'cozy', snapToGrid: false, gridSize: 16 },
    export: {
      defaultFormat: 'typeorm',
      typeorm: {
        dialect: 'postgres',
        singularize: true,
        includeImports: true,
        emitNullableExplicit: true,
      },
    },
  };
}

/* ----- Protocol: Host → Webview ----- */

export type ViewportCommand = 'zoomIn' | 'zoomOut' | 'resetView' | 'fitToContent';

/** Smart auto-layout modes. See specs/13-smart-auto-layout.md. */
export type AutoArrangeMode = 'all' | 'new' | 'selection';

export type HostToWebview =
  | { type: 'schema:update'; payload: { schema: Schema; parseError: ParseError | null } }
  | { type: 'layout:loaded'; payload: Layout }
  | { type: 'layout:external-change'; payload: Layout }
  | { type: 'theme:change'; payload: { kind: 'light' | 'dark' } }
  | { type: 'viewport:command'; payload: { action: ViewportCommand } }
  | { type: 'command:autoArrange'; payload: { mode: AutoArrangeMode } }
  | { type: 'exporters:list'; payload: { exporters: ExporterMeta[] } }
  | { type: 'export:result'; payload: { ok: boolean; warnings?: string[]; message?: string } }
  | { type: 'settings:loaded'; payload: AppSettings }
  | { type: 'merge:begin'; payload: { conflicts: SerializableMergeConflict[] } }
  | { type: 'merge:done' }
  | { type: 'git:status'; payload: GitStatusSummary }
  | { type: 'git:commitResult'; payload: { ok: boolean; message?: string } }
  | { type: 'git:stashes'; payload: { stashes: GitStashEntry[] } }
  | { type: 'git:opResult'; payload: { op: GitOp; ok: boolean; message?: string } }
  | { type: 'git:commits'; payload: { commits: GitCommitMeta[] } }
  | { type: 'git:timeTravel:enter'; payload: { rev: string; label: string; schema: Schema; layout: Layout } }
  | { type: 'git:timeTravel:exit' }
  | { type: 'git:diff:enter'; payload: { baseLabel: string; headLabel: string; diff: SchemaDiff } }
  | { type: 'export:prompt' };

/* ----- Protocol: Webview → Host ----- */

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'layout:persist'; payload: Partial<Layout> }
  | { type: 'command:reveal'; payload: { tableName: QualifiedName } }
  | { type: 'command:pruneOrphans' }
  | { type: 'command:export'; payload: ExportCommandPayload }
  | { type: 'settings:update'; payload: Partial<FlatSettingsPatch> }
  | { type: 'merge:resolve'; payload: { decisions: Record<string, 'ours' | 'theirs'> } }
  | { type: 'git:requestStatus' }
  | { type: 'git:commit'; payload: { message: string } }
  | { type: 'git:requestStashes' }
  | { type: 'git:restore' }
  | { type: 'git:stashPush'; payload: { message?: string } }
  | { type: 'git:stashApply'; payload: { ref: string } }
  | { type: 'git:stashPop'; payload: { ref: string } }
  | { type: 'git:requestCommits' }
  | { type: 'git:timeTravel:enter'; payload: { sha: string; label: string } }
  | { type: 'git:timeTravel:exit' }
  | { type: 'git:diff:enter' }
  | { type: 'error:log'; payload: { message: string; stack?: string } };

/**
 * Flat dotted-key patch shape used by `settings:update`. Keys match the
 * `dddbml.*` configuration keys (without the `dddbml.` prefix).
 */
export interface FlatSettingsPatch {
  'zoomStep': number;
  'zoomMin': number;
  'zoomMax': number;
  'lod.lowThreshold': number;
  'ui.density': UiDensity;
  'ui.snapToGrid': boolean;
  'ui.gridSize': number;
  'export.defaultFormat': string;
  'export.typeorm.dialect': string;
  'export.typeorm.singularize': boolean;
  'export.typeorm.includeImports': boolean;
  'export.typeorm.emitNullableExplicit': boolean;
}

/**
 * Flatten the nested {@link AppSettings} shape into the dotted-key
 * {@link FlatSettingsPatch} consumed by `settings:update`. Used to restore
 * defaults (whole-settings or a per-section slice) from the settings panel.
 */
export function flattenSettings(s: AppSettings): FlatSettingsPatch {
  return {
    'zoomStep': s.zoomStep,
    'zoomMin': s.zoomMin,
    'zoomMax': s.zoomMax,
    'lod.lowThreshold': s.lod.lowThreshold,
    'ui.density': s.ui.density,
    'ui.snapToGrid': s.ui.snapToGrid,
    'ui.gridSize': s.ui.gridSize,
    'export.defaultFormat': s.export.defaultFormat,
    'export.typeorm.dialect': s.export.typeorm.dialect,
    'export.typeorm.singularize': s.export.typeorm.singularize,
    'export.typeorm.includeImports': s.export.typeorm.includeImports,
    'export.typeorm.emitNullableExplicit': s.export.typeorm.emitNullableExplicit,
  };
}
