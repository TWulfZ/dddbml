# Architecture

Read this when you touch the host↔webview boundary, add a message, or need the
big picture. Canonical spec: `specs/01-architecture.md` (but see the drift note
in `SKILL.md` — trust the code). Navigate symbols with `codegraph_context`.

## Two processes, one boundary

```
Extension Host (Node.js)                Webview (Chromium + Preact)
- @dbml/core parser  ─ parser.ts        - render pipeline ─ render/*
- layout file I/O    ─ layoutStore.ts   - spatial index / culling / LOD
- panel lifecycle    ─ panel.ts         - drag controller ─ drag/*
- settings + watchers                   - Zustand store   ─ state/store.ts
        └──────────── postMessage (JSON only) ────────────┘
```

The webview is a sandboxed iframe with **no filesystem access**. Everything —
parsing, reading/writing the `.dbml` and the sidecar — happens in the host and
crosses as JSON `postMessage`. This is why `@dbml/core` must never be imported
in the webview, and why **shared types are plain data only — no class instances,
no functions** (`src/shared/types.ts` header enforces this by convention).

Builds: Vite bundles the webview to `dist/webview/webview.js` (IIFE, CSS inlined
via `import './style.css?inline'` in `main.tsx`); esbuild bundles the host to
`dist/extension/.../extension.js` (CJS). `pnpm build` does both.

## The postMessage protocol (`src/shared/types.ts`)

Discriminated unions on `type`. This is the contract — adding a feature that
crosses the boundary means adding a variant here first.

**Host → Webview (`HostToWebview`):**
- `schema:update` — parsed `Schema` + `parseError`. Sent on open and on `.dbml` change.
- `layout:loaded` — the sidecar `Layout` after hydration.
- `layout:external-change` — sidecar changed on disk (git pull / external edit).
- `theme:change` — VS Code light/dark.
- `viewport:command` — zoomIn / zoomOut / resetView / fitToContent (from keybindings/commands).
- `exporters:list` — available `ExporterMeta[]` for the export modal.
- `export:prompt` — open the export modal; `export:result` — close it with ok/warnings.
- `settings:loaded` — `AppSettings` from workspace config.

**Webview → Host (`WebviewToHost`):**
- `ready` — webview booted; triggers hydration.
- `layout:persist` — `Partial<Layout>` deltas, debounced ~300 ms in the webview.
- `command:reveal` — jump to a table's `Table foo { … }` in the `.dbml`.
- `command:pruneOrphans` — drop layout entries for deleted tables.
- `command:export` — run an exporter (`ExportCommandPayload`: formatId, scope, selection, options).
- `settings:update` — `Partial<FlatSettingsPatch>` (dotted keys mirroring `dddbml.*` config).
- `error:log` — webview error telemetry.

Host side: `DiagramPanel.post(msg)` (`panel.ts`). Webview side: `postToHost(msg)`
(`vscode.ts`, wraps `acquireVsCodeApi()`); receive via the `window` message
listener in `main.tsx`.

## Domain model (`src/shared/types.ts`)

- `QualifiedName` — `"schema.table"` string; the table key everywhere.
- `Schema { tables: Table[]; refs: Ref[]; groups: TableGroup[] }` — parser output.
- `Table { name, schemaName, tableName, columns: Column[], note?, groupName? }`.
- `Column { name, type, pk?, notNull?, unique?, increment?, default?, note? }`.
- `Ref { id, source/target: { table, columns[], relation: '1'|'*' }, name? }` — an edge.
- `TableGroup { name, tables: QualifiedName[], note? }` — a DDD bounded context.
- `Waypoint { x, y }`, `EdgeLayout { waypoints?, dx?/dy? (deprecated) }`.
- `Layout { version: 1, viewport, tables, groups, edges? }` — the sidecar file.
- `AppSettings` + `defaultSettings()` — typed mirror of `dddbml.*` config.

## Session lifecycle

1. User opens a `.dbml`, runs `dddbml: Open Diagram`.
2. `extension.ts` creates/reuses a `DiagramPanel` (one per file) beside the editor.
3. Webview loads, sends `ready`.
4. Host parses the `.dbml` → `schema:update`; reads the sidecar (empty if none) → `layout:loaded`.
5. Webview runs dagre auto-layout for tables without a saved position, then renders.
6. Watchers re-send `schema:update` / `layout:external-change` on file changes.
7. Drag → debounced `layout:persist` → host `writeLayout()` (atomic temp + rename).

## Key files

| Role | Path |
|---|---|
| Host entry / commands | `src/extension/extension.ts` |
| Panel + RPC + watchers | `src/extension/panel.ts` |
| DBML parse | `src/extension/parser.ts` |
| Sidecar I/O | `src/extension/layoutStore.ts` |
| Settings | `src/extension/settings.ts` |
| Shared types + protocol | `src/shared/types.ts` |
| Webview entry / listener | `src/webview/main.tsx` |
| `postToHost` bridge | `src/webview/vscode.ts` |
| Root component | `src/webview/app.tsx` |
| Store | `src/webview/state/store.ts` |
