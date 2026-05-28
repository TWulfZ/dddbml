---
name: dddbml-engineering
description: >-
  Use for any work on **dddbml** — the VS Code extension that turns `.dbml`
  schema files into an interactive, editable diagram. Trigger whenever a task
  touches this DBML diagram tool, even when the repo isn't named, by describing
  symptoms or features: tables/columns rendering as empty or flashing boxes,
  paint/culling/LOD/perf, FK reference edges (including self-referencing loops),
  table-group or bounded-context boxes overlapping/collapsing, drag/waypoint
  edits, undo-redo or adding a new undoable action (Ctrl+Z), layout sidecar
  persistence, settings, `!include` / multi-file `.dbml`, or exporting the
  diagram's schema to TypeORM entities and adding SQL dialects to that exporter.
  It maps each area to its spec + source files, enforces the spec-first
  workflow, and reuses existing seams. Do NOT use for generic
  Preact/Zustand/VS-Code-extension work, or for *using* TypeORM (writing
  migrations/DTOs/entities) in a backend app — only this `.dbml`-to-diagram
  renderer.
---

# dddbml Engineering Playbook

`dddbml` is a VS Code extension that renders `.dbml` files as an interactive
diagram. It runs as **two processes**: an extension host (Node.js) that parses
DBML and does file I/O, and a Preact webview that renders. They talk only over
`postMessage`. The schema's source of truth is the user's `.dbml`; table
positions live in a Git-friendly sidecar JSON.

This project is built **spec-first**, but the existing 13 specs in `specs/` are
**inconsistent in structure and partly stale — do not treat them as absolute
truth.** Read them as design intent and history. What matters is the *practice*:
when you touch an area, read its spec critically, keep it in sync with your
change, and upgrade it toward the better-structured template (which includes an
**Open Questions** section). This skill exists so you follow that practice every
time, navigate with codegraph, and reuse existing patterns instead of
re-deriving the codebase or freewheeling.

> Specs are written in **Spanish** (match the existing 13). Code, identifiers,
> types, and commit messages stay in **English**.

## The workflow — spec-driven, not vibe-driven

Run these in order. The point is that *design decisions live in specs and the
graph*, not in your head — skipping a step is how you reintroduce a bug a spec
already warns about, or hand-roll a fourth way to do something the codebase
already does three times.

- **0 · Orient with codegraph.** Start with `codegraph_context` for the area you
  are touching — it returns the entry points, related symbols, and key code in
  one call, so you don't grep blindly. For "how does X reach Y" use
  `codegraph_trace`. If you are unsure the index is current, `codegraph_status`
  lists pending files.
- **1 · Read the matching spec.** Find your area in the **spec ↔ area map**
  below and read that spec *before* touching code. It encodes the intended
  behavior, known failure modes, and the test plan.
- **2 · Decide: feature or fix — and surface the unknowns.**
  - **New feature or a change to a pipeline's design/behavior** → write or
    update the Spanish spec **first**, including a populated **Preguntas
    abiertas (Open Questions)** section, and resolve the *blocking* questions
    **with the user** before writing code. Filling ambiguity with a generic
    default is exactly the vibe-coding failure mode this gate exists to stop —
    when the request is underspecified, the answer is a question for the user,
    not a guess. The spec edit ships **in the same change** as the code, never
    deferred. Use `references/spec-template.md`.
  - **Small fix that doesn't change design** → cite the relevant spec; edit it
    only if behavior changes. If the "fix" turns out to encode a design
    decision, treat it as a feature and open the questions.
- **3 · Plan against existing patterns.** Before adding a store, a base class,
  an exporter, or command machinery, check the **reusable extension points**
  below and `references/patterns.md`. The codebase already has the seam you
  need — extend it, don't reinvent it.
- **4 · Implement** following `references/code-rules.md`. Before you edit
  `src/shared/types.ts`, the Zustand store, or the host↔webview protocol, run
  `codegraph_impact` on the symbol — these are blast-radius hubs touched by both
  processes.
- **5 · Verify and close the loop.** `pnpm typecheck` and `pnpm test` must pass.
  For pipeline work, check the relevant **performance budget**
  (`specs/07-performance-budgets.md`). Update the matching spec in the same
  change so the spec and code never drift apart.

## Spec ↔ area ↔ source map

Find what you're touching, read that spec, navigate those files via codegraph.

| Touching… | Read spec | Key source |
|---|---|---|
| DBML parse / AST → internal model | `specs/02-dbml-ast-mapping.md` | `src/extension/parser.ts`, `src/shared/types.ts` |
| Layout sidecar / persistence | `specs/03-layout-file-schema.md` | `src/extension/layoutStore.ts`, `src/webview/persistence.ts` |
| Render pipeline / culling / LOD | `specs/04-render-pipeline.md` | `src/webview/render/{spatialIndex,lod,tableNode,viewport}.*`, `src/webview/app.tsx` |
| Edge routing / waypoints | `specs/05-edge-routing.md` | `src/webview/render/{edgeRouter,edgeLayer}.*` |
| TableGroups / bounded contexts | `specs/06-tablegroups.md` | `src/webview/groups/{groupPanel,bcPalette}.*`, `src/webview/render/{groupContainer,collapsedGroupNode}.tsx` |
| Performance budgets | `specs/07-performance-budgets.md` | cross-cutting |
| Exporters (TypeORM / dialects) | `specs/09-exporters.md` | `src/extension/exporters/**`, `src/shared/exporters/types.ts` |
| Settings | `specs/10-settings.md` | `src/extension/settings.ts`, `src/webview/render/settingsPanel.tsx`, `package.json` → `contributes.configuration` |
| Undo / redo / action history | `specs/11-action-history.md` | `src/webview/state/{history,store}.ts` |
| Design system / CSS / density | `specs/12-design-system.md` | `src/webview/style.css`, `src/webview/layout/density.ts`, `src/webview/groups/bcPalette.ts` |
| Host↔webview protocol / lifecycle | `specs/01-architecture.md` | `src/extension/{extension,panel}.ts`, `src/webview/{main,vscode}.ts`, `src/shared/types.ts` |

`specs/00-overview.md` (goals, anti-goals, success criteria) and
`specs/08-roadmap.md` (scope) are context, not tied to one area.

## Tech stack (ground truth — `package.json`)

| Concern | Choice |
|---|---|
| UI | **Preact 10** (not React; aliased in `vite.config.ts`) |
| State | **Zustand 5** vanilla store + `useAppStore(selector)` |
| DBML parsing | `@dbml/core` 3.9 — **host only** |
| Auto-layout | `@dagrejs/dagre` 3 |
| Webview build | **Vite** → `dist/webview/webview.js` (IIFE); CSS inlined via `?inline` |
| Extension build | **esbuild** → `dist/extension/.../extension.js` (CJS) |
| Tests | **Vitest 2**, colocated `*.test.ts` |
| Package manager | **pnpm 10** — never `npm` / `yarn` |
| TypeScript | **strict**, `noUncheckedIndexedAccess`, `noImplicitOverride` |

## Hard rules (guardrails)

These are load-bearing — each prevents a concrete failure. Don't quietly break
them; if a task seems to require it, surface that to the user.

- **Parser is host-only.** Never import `@dbml/core` in the webview — it would
  bloat the bundle (budget < 50 KB gzipped) and break the host/webview split.
  All FS and parsing happen in the host and cross via `postMessage`.
- **Granular Zustand selectors.** Subscribe with `useAppStore(s => s.field)`,
  never to the whole state. The diagram can hold ~5000 tables; a coarse
  subscription re-renders everything.
- **One SVG layer for all edges** (`edgeLayer.tsx`). Don't add per-edge SVG
  elements — it explodes DOM node count and kills drag performance.
- **Respect the culling/LOD contract.** Only visible tables render; LOD is
  chosen by zoom. Don't bypass the spatial index or force full detail.
- **Git-friendly layout writer.** The sidecar writer keeps keys sorted, omits
  default flags, uses integer coords, and writes atomically (temp + rename).
  Preserve these invariants or you ruin reviewable diffs (`layoutStore.ts`).
- **Design tokens only.** No magic px or hex in components. Use density tokens,
  the BC palette, and the CSS `@layer` order. See `references/code-rules.md`.
- **pnpm + strict TS, no `any`.** Match the existing strictness.

## Reusable extension points — use these, don't reinvent

Verified seams in the code. Extending them keeps the diff small and consistent.

- **Add an exporter format** → implement the `Exporter` contract
  (`src/shared/exporters/types.ts`) and call `registerExporter()`
  (`src/extension/exporters/registry.ts`).
- **Add a SQL dialect** → implement `Dialect` and call `registerDialect()`
  (`src/extension/exporters/typeorm/dialect.ts`; model:
  `dialects/postgres.ts`). Then extend the `dddbml.export.typeorm.dialect` enum
  in `package.json`.
- **Add an undo/redo-able edit** → add an interface + `kind` to the
  `EditCommand` union and a `buildXCommand` builder in
  `src/webview/state/history.ts`; add a `pushXCommand` action and an
  `applyCommand` case in `src/webview/state/store.ts`. (Models: `MoveCommand`,
  `WaypointCommand`.)
- **App state** → extend the single store via `AppState`/`AppActions` in
  `state/store.ts`; don't create a second store.
- **Colors / spacing** → `bcIndex`/`bcColorFor` (`groups/bcPalette.ts`) and
  density metrics (`layout/density.ts`).

## Reference files — read on demand

- `references/architecture.md` — two-process model, the `postMessage` protocol
  and message types, the domain model, session lifecycle. Read when you touch
  the host↔webview boundary or need the big picture.
- `references/patterns.md` — Zustand store + selectors, the undo/redo command
  pattern, the exporter + dialect strategy, and the design system. Read in
  step 3 before extending any of these.
- `references/code-rules.md` — strict-TS conventions, naming, perf budgets, the
  git-friendly layout invariants, and the design-token rules. Read in step 4.
- `references/spec-template.md` — the Spanish feature-spec template. Use in
  step 2 when writing or updating a spec.

## Spec vs code: which is authoritative

**No spec here is absolute truth.** The existing specs are inconsistent in
structure and some are stale — e.g. `01-architecture.md` names modules
(`watcher.ts`, `protocol.ts`) that no longer exist; watching lives in `panel.ts`
and protocol types in `src/shared/types.ts`. So: **code + codegraph are
authoritative for what exists now**; specs capture **intent and open
decisions**. When they conflict, trust the code, flag the drift, and as part of
your change bring the spec back in sync *and* up to the template structure
(Propósito → Contexto → Open Questions → Diseño → …). A spec with unresolved
blocking Open Questions is not ready to implement — take them to the user first.
