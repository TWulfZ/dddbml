/**
 * Shared types between extension host (Node.js) and webview (Preact).
 * These MUST be plain data — no class instances, no functions.
 * They cross the postMessage boundary and are JSON-serialized.
 */

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

export interface EdgeLayout {
  dx?: number;
  dy?: number;
}

export interface Layout {
  version: 1;
  viewport: ViewportLayout;
  tables: Record<QualifiedName, TableLayout>;
  groups: Record<string, GroupLayout>;
  edges?: Record<string, EdgeLayout>;
}

/* ----- Protocol: Host → Webview ----- */

export type ViewportCommand = 'zoomIn' | 'zoomOut' | 'resetView' | 'fitToContent';

export type HostToWebview =
  | { type: 'schema:update'; payload: { schema: Schema; parseError: ParseError | null } }
  | { type: 'layout:loaded'; payload: Layout }
  | { type: 'layout:external-change'; payload: Layout }
  | { type: 'theme:change'; payload: { kind: 'light' | 'dark' } }
  | { type: 'viewport:command'; payload: { action: ViewportCommand } };

/* ----- Protocol: Webview → Host ----- */

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'layout:persist'; payload: Partial<Layout> }
  | { type: 'command:reveal'; payload: { tableName: QualifiedName } }
  | { type: 'command:pruneOrphans' }
  | { type: 'error:log'; payload: { message: string; stack?: string } };
