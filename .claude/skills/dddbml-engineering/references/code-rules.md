# Code rules

Read this in step 4 (implementation). These are the conventions the codebase
already follows — matching them keeps diffs reviewable and types sound.

## TypeScript (strict)

`tsconfig.json`: `target ES2022`, `module ESNext`, `moduleResolution Bundler`,
`strict: true`, plus:
- **`noUncheckedIndexedAccess`** — `arr[i]` is `T | undefined`. Guard it or use
  `!` only when an invariant guarantees presence (the codebase does, e.g.
  `from[0]![0]`). Don't disable the flag.
- **`noImplicitOverride`** — mark overrides `override`.
- **`isolatedModules`** — use `import type { … }` for type-only imports.
- **No `any`.** Prefer precise unions and `unknown` + narrowing.
- JSX: `jsxImportSource: "preact"`. Import hooks from `preact/hooks`. React names
  resolve via the Vite alias — write Preact, not React.

## Naming & files

- PascalCase: types, interfaces, Preact components. camelCase: functions, vars,
  fields. `*.tsx` for components, `*.ts` for logic.
- **Shared types are plain data** — no classes, no functions, no `Date`. They
  JSON-serialize across `postMessage` (`src/shared/types.ts`).
- Tests are colocated `*.test.ts` next to the unit (e.g.
  `state/history.test.ts`, `render/edgeRouter.waypoints.test.ts`).

## Tooling — pnpm only

`packageManager: pnpm@10.33`. Never `npm`/`yarn`. Scripts:
- `pnpm build` — `build:extension` (esbuild) + `build:webview` (vite).
- `pnpm watch:extension` / `pnpm watch:webview` — dev watch (F5 launches the
  Extension Development Host).
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm test` / `pnpm test:watch` — Vitest. `pnpm test:gen` regenerates the
  small/huge DBML fixtures under `test/fixtures/`.
- Single test: `pnpm exec vitest run <path>` or `-t '<name>'`.

## Performance budgets (`specs/07-performance-budgets.md`)

These shape architecture — respect them when touching the pipeline:

| Metric | Target |
|---|---|
| Parse 5000 tables | < 2 s |
| Auto-layout 5000 tables | < 3 s |
| Pan FPS (10 s) | ≥ 55 avg, ≥ 30 p99 |
| Webview idle memory | < 200 MB |
| Bundle (gzipped) | < 50 KB |

Consequences you must not violate: webview dependencies stay tiny (Preact, no
React, parser host-only); only visible tables render (spatial index + LOD); one
SVG layer for all edges; auto-layout runs once per schema change, not per frame.

## Git-friendly layout writer (`src/extension/layoutStore.ts`)

`serializeLayout()` invariants — the whole point of the sidecar is minimal,
reviewable diffs. Preserve all of them:
- Keys (tables, groups, edges) sorted alphabetically.
- Default flags (`hidden: false`, `collapsed: false`) omitted.
- Coordinates rounded to integers (no subpixel churn).
- 2-space indent, LF endings, trailing newline.
- Atomic write: temp file + rename (a crash mid-write never corrupts the file).

## Design tokens

No raw hex or magic px in components. Use `--ddd-*` tokens, the BC palette via
`bcColorFor`, and density tokens. See `references/patterns.md` § 4.

## Comments

Match the codebase: short, why-not-what. The existing code documents non-obvious
invariants (e.g. why command snapshots are taken at push time) and skips
narrating the obvious. Don't add ceremony.
