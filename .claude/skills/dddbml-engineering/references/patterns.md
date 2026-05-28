# Design patterns — reuse these, don't reinvent

Read this in step 3 before extending state, history, exporters, or the design
system. Each section ends with the exact way to extend the seam. Confirm current
signatures with `codegraph_context` / `codegraph_node` before you start.

## 1 · Zustand: single vanilla store + granular selectors

`src/webview/state/store.ts` holds **one** store typed `AppState & AppActions`
(no slices, no second store). Components read with
`useAppStore(s => s.something)` — a selector hook over `useSyncExternalStore`
that re-renders only when the selected value changes. This is mandatory at
~5000-table scale; a whole-state subscription re-renders the entire diagram.

`AppState` carries `schema`, `positions` (Map), `hiddenTables` (Set),
`tableColors`, `edgeLayouts`, `groups`, `viewport`, `selection`, `settings`,
`exporters`, modal flags, and the undo/redo stacks. `AppActions` are the setters.

**Add state:** extend `AppState` (the field) + `initial` (default) + `AppActions`
(the setter signature) + the action impl in `createStore`. Read it via a new
selector. Don't reach into the store from outside except via
`store.getState()` in non-component code (e.g. drag controller).

## 2 · Command pattern: undo/redo

`src/webview/state/history.ts` + `store.ts`. Spec: `specs/11-action-history.md`.

- `EditCommand` is a discriminated union (`kind`): `MoveCommand`, `WaypointCommand`.
- Each command snapshots **`from` and `to`** at push time, so undo→edit→redo is a
  deterministic replay (redo jumps to the original target, not latest state).
- `buildMoveCommand` / `buildWaypointCommand` construct a command and **return
  `null` on a no-op** (zero displacement) so clicks don't pollute history.
- Store keeps `past` / `future` arrays (tail = most recent), capped at
  `historyCapacity` (200, FIFO). Any new push clears `future`.
- `applyCommand(state, cmd, direction)` replays `from` (undo) or `to` (redo) and
  returns only the changed slice.

**Add a command type:**
1. Define the interface (`kind`, `from`, `to`, `label`, `timestamp`) in `history.ts`.
2. Add it to the `EditCommand` union.
3. Write a `buildXCommand(...)` that returns `null` on no-op.
4. Add a `pushXCommand` action in `store.ts` (push to `past`, clear `future`, cap).
5. Add a `case` to `applyCommand` for undo/redo replay.

## 3 · Exporter + dialect strategy

Spec: `specs/09-exporters.md`. Contract is shared (`src/shared/exporters/types.ts`);
implementations live host-side (`src/extension/exporters/**`).

- `Exporter extends ExporterMeta { export(input: ExportInput): ExportResult }`.
- `ExporterMeta { id, label, description?, language, optionsSchema }`. The
  `optionsSchema` is `ExporterOptionField[]` (boolean | string | enum) — the
  **webview builds the export modal form from this**, so you never write custom
  UI per exporter.
- Registry: `registerExporter()` / `getExporter()` / `listExporters()`
  (`src/extension/exporters/registry.ts`).
- TypeORM pipeline (`typeorm/`): `generateTypeOrm(input)` → `resolveOptions` →
  `getDialect` → `buildRelationPairs` + `relationsByOwner` (`relations.ts`,
  cardinality + ownership) → `emitEntity` / `emitImports` (`template.ts`),
  names via `naming.ts` (`toClassName`, `pluralize`, `singularize`).
- **Dialect strategy** (`typeorm/dialect.ts`): `Dialect { id, label,
  mapType(dbmlType): TsTypeMapping }`; `registerDialect()` / `getDialect()` /
  `listDialects()`. Model: `dialects/postgres.ts`.

**Add an exporter format:** create `exporters/<fmt>/index.ts` exporting an
`Exporter` (define `optionsSchema`, implement `export`), then `registerExporter`
it in `exporters/index.ts`. Update `specs/09-exporters.md`.

**Add a SQL dialect:** implement `Dialect` in `typeorm/dialects/<db>.ts`,
`registerDialect` it in `typeorm/dialects/index.ts`, and **extend the
`dddbml.export.typeorm.dialect` enum in `package.json`** so users can pick it.

## 4 · Design system

Spec: `specs/12-design-system.md`. File: `src/webview/style.css` (imported
`?inline`). Mirror for TS-side math: `src/webview/layout/density.ts`.

- **CSS `@layer` order:** `reset, tokens, base, surfaces, components, state,
  utilities`. Component rules read tokens — **no raw hex, no magic px.**
- **Tokens** are `--ddd-*` custom properties (spacing 4pt scale, radii, type,
  shadows, motion, semantic surfaces/fg/border/accent that fall back to
  `--vscode-*` theme vars).
- **BC palette:** 12 bounded-context colors `--ddd-bc-N-surface` /
  `--ddd-bc-N-border`. Assign deterministically with `bcIndex(name)` →
  `bcColorFor(name)` (`src/webview/groups/bcPalette.ts`), not by hand.
- **Density:** `[data-density='compact'|'cozy'|'comfortable']` on the root
  overrides `--ddd-table-*` tokens (cozy is the `:root` default). For layout
  math where you can't read the DOM (auto-layout, edge routing), use
  `densityMetrics(density)` from `density.ts` — keep the two in sync.

**Add a styled component:** add tokens if a value is new, write rules in the
right `@layer`, reference tokens only. For a new bounded-context color, add a
`--ddd-bc-N-*` pair and bump the palette size used by `bcIndex`.
