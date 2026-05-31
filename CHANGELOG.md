# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.6] — 2026-05-30

Conflict-resolver panel UX overhaul (`specs/14`, `specs/12`). Pure-webview — no host/protocol changes.

### Changed
- **Chevron-only stepper nav + progress spine.** Step-through Prev/Next are now icon-only chevrons with tooltips; a count pill, a progress bar (success-green at 100%) and a per-conflict dot rail replace the old text nav. The panel keeps a stable width so toggling Review-all ↔ Step-through no longer jumps.
- **Git-style naming.** Sides are labeled **current** / **incoming** (not mine/theirs) to match an editor merge conflict (store keys stay `ours`/`theirs`). The step picks stack the position (`X:… Y:…`) under the side name to save width.
- **Diff-orb rail.** The dot rail is clickable — jump to any conflict — with generous tiled hit targets (no need to land on the small circle) and a hover border cue. Orbs are colored by the resolved side using the editor's git current/incoming colors (`--ddd-merge-current/incoming`); unresolved = hollow grey; the cursor orb scales + accent border. It scrolls as one row by default (active orb auto-centered on next/prev) and an **expand toggle** (past ~28 orbs) reveals the full wrapped, height-capped grid.
- **Less redundancy + a confirm step.** The conflict count now appears only in the `R/N resolved` pill (dropped from the title, the hint and the Apply button); **Apply opens a confirmation dialog** that restates the count. Removed the redundant check ticks. Bulk actions are compact two-line buttons (“All” over a git marker glyph `<<<`/`>>>`, full action in the tooltip).

### Fixed
- Resolver accessibility: a single `aria-live` region (the count pill), the dot rail exposes a labeled `role="group"`, dots carry per-conflict labels + `aria-current`, and the cursor indicator was made visually distinct from the keyboard focus ring.

## [0.2.5] — 2026-05-30

A "premium" UI polish pass: a floating, icon-only tool bar, a reusable styled tooltip, one canonical icon button across every overlay menu, and tasteful token-driven motion (`specs/12`, `specs/06`). Pure-webview — no host/protocol changes.

### Added

#### Reusable `Tooltip` primitive (`src/webview/ui/Tooltip.tsx`, `specs/12`)
- Lightweight styled tooltip for icon-only buttons, distinct from the rich canvas tooltip. Shows on **hover and keyboard focus**, with an open delay, Escape-dismiss, and a fade+rise entrance. Clones its trigger to inject `aria-label`/`aria-describedby` and drop the native `title` (no doubled OS tooltip); portaled to `<body>`. Optional shortcut-key chip (e.g. `Ctrl+Z`).

### Changed

#### Floating, icon-only action bar (`src/webview/render/actionsPanel.tsx`, `specs/12`)
- The bottom bar now **floats** (lifted off the edge, full border + shadow + radius in every state) instead of docking flush. It is **collapsible** to a single chevron handle and expands to one row of **fixed-size, icon-only** buttons (Auto-arrange · Grid/snap · Search · Export · Settings) with a staggered entrance. **Auto-arrange opens a popover** (Re-arrange all / Place new tables / Re-arrange selection) reusing the generic `ContextMenu`.

#### Canonical icon button (`src/webview/ui/Button.tsx`, `specs/12`)
- One fixed `size="tool"` (28×28) square for **all** floating-toolbar/menu icon buttons (action bar, zoom cluster, Diagram Views header, edge toolbar); dense list rows keep `size="icon"`. Geometry now lives in `size` and the icon variants (`history`/`zoom`/`toolbar`) carry **color/state only** — conflict-free, still no `tailwind-merge`. Press feedback (`active:scale`) moved to the base so every button gets it.

#### Command relocations
- **Undo/Redo → the zoom cluster** (history navigation now pairs with viewport navigation; a divider separates the groups).
- **PK/FK-only filter → Diagram Views** as a *View options* toggle (it's a view option). The panel now **always renders** (even with no groups) and its open/focus state is store-driven, so the tool bar's **Search** button opens Diagram Views and focuses its search input.
- Edge toolbar and the Diagram Views header buttons adopt the canonical icon button + tooltips.

#### Motion (tokens only, `specs/12`)
- Tooltip fade-rise, staggered tool-bar entrance, and a unified button press transition — all via existing `--ddd-*` tokens. `prefers-reduced-motion: reduce` now also zeroes `animation-delay` so the staggered entrance plays instantly.

### Notes
- *Deferred:* "select all relations" — needs a multi-edge selection model the store doesn't have yet (today only a single edge is selectable). It will land as a future command.

## [0.2.4] — 2026-05-30

Collaborative layout merge under Git, an in-canvas conflict resolver, and a large edge-rendering performance pass for thousands of relations (`specs/03`, `specs/14`, `specs/04`, `specs/05`, `specs/07`).

### Added

#### Collaborative 3-way layout merge (`specs/03`, `specs/14`)
- **View-state left Git.** `viewport`, group `hidden`/`collapsed`, and table `hidden` now persist to a local-only file; the tracked sidecar carries **only** shared design (table x/y/color, group color, edges) — eliminating the per-commit conflict storm. Pan/zoom never touches the Git file.
- **In-extension 3-way merge — zero manual git config.** On a conflicted sidecar, the extension reads Git's merge-index stages `:1:/:2:/:3:` and merges per key: unambiguous changes auto-resolve, and only genuine "both moved the same key" conflicts are surfaced. No merge driver, `.gitattributes`, or per-clone setup. `readLayout` now throws on conflict markers instead of silently wiping the layout.

#### In-canvas ghost conflict resolver (`specs/14` §Tier-3)
- Replaces the native QuickPick with a **blocking in-webview resolver**. Each table-position conflict draws **two ghost tables** — mine @ours, theirs @theirs — on the canvas. Hover previews (kept = accent bloom, the other dims red = discarded); click commits; every pick is revertible until **Apply**. Group/edge conflicts resolve as mine/theirs rows.
- **Two views:** *Review all* (all-at-once list + bulk "keep all mine/theirs") and *Step through* (one diff at a time). The stepper **flies the camera to frame both ghost positions** of each diff — on **next/prev only**, never on hover — and picking **auto-advances** to the next unresolved conflict. Hovering a mine/theirs button **cross-highlights** its ghost (and vice-versa). Camera animation respects `prefers-reduced-motion`.
- **Read-only while resolving:** pan/zoom only — no select, drag, edit, undo/redo, auto-arrange, or persist until you Apply (which writes the clean sidecar + `git add` once).
- **Test fixtures:** one generator (`scripts/gen-fixtures.mjs` → `small | huge | merge <count>`) builds a real conflicted Git repo under `test/fixtures/<count>/` for hands-on review (`pnpm test:gen:merge` → 3- and 20-conflict scenarios).

### Fixed
- **Lost conflict dialog (data-flow bug).** The old QuickPick wrote a marker-free, ours-biased file the moment it was cancelled, so the next open saw no markers and never re-ran the resolver — the dialog destroyed its own trigger. Now **nothing is written until Apply**: the conflicted file keeps its markers, so closing mid-merge re-triggers the resolver on reopen.

### Performance
- **Edges scale to thousands of relations** (`specs/04`, `specs/05`, `specs/07`). `routeRefs` is memoized on geometry, so routing no longer recomputes on every pan/zoom frame; **route-all-then-cull** also fixes a port jitter during pan. The interactive overlay (per-segment hit-DOM) is now built **only for the selected edge** — a single transparent hit-path per other edge — and a zoom LOD draws straight, marker-less lines at bird's-eye. Net: per-frame edge CPU and overlay node count drop sharply on large diagrams.

## [0.2.3] — 2026-05-29

Smart auto-layout — database-focused automatic table ordering (`specs/13-smart-auto-layout.md`).

### Added

#### Smart auto-layout
- New **Auto-arrange** that positions every table from its foreign-key relationships and declared table groups: satellites orbit their parent, junction (M:N) tables sit between their two parents, hubs anchor radial star clusters, and TableGroups (bounded contexts) are honored as first-class clusters.
- Three modes: **all** (re-arrange everything), **new** (place only un-positioned tables), **selection** (move only the selected tables; the rest stay as fixed obstacles).
- Engine: ELK compound layout (`elkjs`) over a database-aware *classify → cluster* pipeline; dedicated radial placement for hub clusters; a column-alignment pass straightens FK rows; an AABB safety pass guarantees no overlaps. Output is deterministic (git-friendly).
- Three triggers, all funnelling into one action: the command palette (`dddbml: Auto-arrange Diagram…`), the in-canvas Actions panel (wand button + 3-mode submenu, with a live selection count), and the right-click context menu on selected tables (*Auto-arrange selected (N)*).

#### Reset relations
- New *Reset relations (N)* on the right-click menu of selected tables: resets every edge touching the selection back to default routing — waypoints, legacy offsets and port-side overrides cleared, colour kept. One undoable step.

### Changed
- **Undoable auto-arrange (composite).** A single Ctrl+Z reverts a whole arrange — both the table moves and the edge-waypoint resets it triggered — via a new `ArrangeCommand` in the action history.
- **Bulk moves reset stranded edge waypoints.** Waypoints are absolute world coords that don't follow tables, so a bulk move would strand them into staircase paths. Auto-arrange now clears the shape (colour + port sides preserved) of edges whose *both* endpoints moved; they re-route cleanly via the column-row resolver. The sidecar layout format is unchanged.

### Notes
- The ELK engine (`elkjs`) adds ~600 KB gzip to the webview bundle — a deliberate, accepted trade for higher-quality grouped layout (see `specs/07-performance-budgets.md`). Measured layout on the 5000-table fixture ≈ 2.6 s, within the 3 s budget.

## [0.2.2] — 2026-05-29

Major rework of interactive edge editing and edge visuals (`specs/05-edge-routing.md`, `specs/12-design-system.md`).

### Changed

#### Edge editing — two-tier control model
- Editing a selected edge is now split into two tiers, replacing the v0.2.0 "hover a segment → ghost circle → drag to insert a waypoint" flow.
- **Slide** — each editable run shows a real handle at its centre; drag it (or grab the run anywhere) to move the whole run perpendicular (1-DOF: horizontal ↕, vertical ↔). Sliding an end-arm inserts a jog so the rigid port stub never moves.
- **Notch** — hovering a run reveals a ghost handle at the ¼ and ¾ positions (only the one nearest the cursor is shown); dragging it perpendicular carves a *local symmetric notch* — a new vertex — while the rest of the run stays flat (¼ carves the left side, ¾ the right).
- Waypoints are now the literal orthogonal corners of the route; the previous collinear-collapse canonicalization is gone, so local bends are preserved. Editing one run never disturbs the rest (the route's corners are materialized first).
- Every turn is a render-only rounded fillet — a corner is never a draggable node.

### Added

#### Edge editing
- **Notch re-merge tolerance**: drag a notch's dipped run back to within ~10 world units of its original level and it snaps flat, dissolving the notch — no pixel-perfect aim needed. Double-clicking a notch also removes it.
- Ghost handles grow on their own hover and show an axis-aware resize cursor (`ns-resize` / `ew-resize`); the centre (slide) handle stays visible while the edge is selected.

#### Edge visuals
- The marching-dot **flow** animation now renders on both hover **and** selection (previously hover only), with a pronounced bloom; the selected line carries its own subtle bloom.
- Flow dots are true circles (`stroke-dasharray: 0 gap` + round caps) and the loop is seamless — no jump at the wrap.
- New design tokens: `--ddd-edge-ghost-r` / `-hover`, `--ddd-edge-flow-width` / `-gap` / `-duration`, `--ddd-edge-bloom-flow` / `-selected`.

### Notes
- Sidecar format unchanged: `EdgeLayout.waypoints[]` still stores the route corners and existing layouts load without migration (edges without waypoints are unchanged); the new model reinterprets stored waypoints as literal corners.

---

## [0.2.0] — 2026-05-27

### Added

#### Export to TypeORM
- New **Export** button in the actions panel opens a modal to generate TypeORM entities from the full schema or a selection of tables.
- Registry+strategy architecture: adding Prisma, SQL DDL, or Mermaid requires one new module and one line of registration — no changes to dispatch or modal code.
- PostgreSQL dialect: full DBML→TypeScript type mapping (`int`, `bigint`, `varchar(N)`, `uuid`, `boolean`, `timestamp`/`timestamptz`, `numeric(P,S)`, `json`/`jsonb`, `bytea`, and more); unknown types fall back to `string` with a warning.
- Relation decorators generated from DBML `Ref`: `@OneToOne`, `@OneToMany`, `@ManyToOne`, `@ManyToMany` with `@JoinColumn`/`@JoinTable` on the owning side.
- Composite foreign keys emitted as `@JoinColumn([{ name: 'a' }, { name: 'b' }])`.
- Scope `Selected`: tables outside the selection emit their FK column as a plain property; a warning identifies each cut relation.
- English singularization with known irregulars (`children→Child`, `people→Person`, `addresses→Address`, etc.).
- Export options: SQL dialect, singularize class names, include `typeorm` import line, emit `nullable` explicitly.
- Result opens as an untitled VSCode document; the user decides where to save it.
- Command palette entry `dddbml: Export Schema…` delegates to the active webview modal.

#### Settings
- All formerly hardcoded viewport and render constants are now configurable in VSCode Settings UI and `settings.json` under the `dddbml.*` namespace.
- `dddbml.zoomStep`, `dddbml.zoomMin`, `dddbml.zoomMax` — zoom behaviour.
- `dddbml.lod.mediumThreshold`, `dddbml.lod.lowThreshold` — LOD breakpoints.
- `dddbml.export.defaultFormat`, `dddbml.export.typeorm.*` — export defaults.
- Changes propagate to the webview immediately via `settings:loaded` without a reload.
- Settings panel inside the webview (gear icon in the actions panel) with numeric inputs, toggles, selects, and a "Reset to defaults" button.

#### Edge waypoints
- Any edge segment can now carry user-defined waypoints: hover a segment to reveal a ghost circle, click-drag to insert a waypoint at that position.
- Double-click a waypoint circle to remove it; context-menu "Reset edge waypoints" clears all waypoints on an edge.
- Waypoints are stored in `EdgeLayout.waypoints[]` in the sidecar JSON and survive reloads.
- Routing with waypoints uses strict horizontal/vertical alternation; collinear points are collapsed.
- Full backward compatibility: an edge with no waypoints produces a path identical to the original H-V-H algorithm. The legacy `dx` midpoint offset is still honoured until the user adds a waypoint.

#### Undo / Redo
- `Ctrl+Z` / `Cmd+Z` undoes the last diagram edit; `Ctrl+Shift+Z` and `Ctrl+Y` redo.
- **Move commands**: single-table drag and multi-table marquee drag each produce one undoable command. A drag with zero net displacement is a no-op and adds nothing to the stack.
- **Waypoint commands**: add, move, remove, and clear operations on edge waypoints are individually undoable.
- Stack capacity: 200 entries; oldest entries drop FIFO when the cap is exceeded.
- Undo / Redo buttons in the actions panel; both are disabled while their respective stack is empty.
- The history stack is cleared when the layout is reloaded from disk or when the set of table names changes (prevents undo-to-a-deleted-table). Schema edits that only modify columns preserve the stack.
- Undo and redo trigger a debounced layout persist so the sidecar stays in sync.

#### Design system
- CSS rewritten with `@layer reset, tokens, base, surfaces, components, state, utilities`; layer order enforces specificity without `!important`.
- Complete design token set: spacing (4 pt scale, `--ddd-space-0..8`), border radii, typography scale, dark-tuned drop shadows, and motion tokens with three durations and three easings.
- Three density modes — `compact`, `cozy` (default), `comfortable` — toggled via `data-density` on the root element and persisted as `dddbml.ui.density`. Table width, row height, padding, header height, and font size all respond.
- `densityMetrics()` TypeScript mirror in `src/webview/layout/density.ts` keeps `estimateSize()` in sync with the CSS values.
- Bounded Context colour palette: 12 curated colours (`--ddd-bc-{1..12}-surface/border`) that are colour-blind safer and tuned for dark VSCode themes, replacing the previous `hsl(hash, 55%, 60%)` approach.
- `bcIndex(name)` deterministic hash assigns a stable palette slot to each group name across reloads.
- Semantic tokens (`--ddd-surface-*`, `--ddd-fg-*`, `--ddd-border-*`, `--ddd-accent`, `--ddd-edge-*`) map to `--vscode-*` variables with literal fallbacks; the diagram reacts to theme changes without a reload.
- `prefers-reduced-motion: reduce` sets all animation durations to `0ms`.
- All magic pixel and hex values removed from component CSS; every value reads from a token.

### Changed

- Export TypeORM and Settings configuration keys (`dddbml.export.typeorm.dialect` enum) added to `package.json#contributes.configuration`.
- `EdgeLayout` in the sidecar schema gains an optional `waypoints` array; existing files without it are read as empty-waypoint edges (no migration needed).
- Group and table colours now default to the BC palette slot derived from the group name; existing explicit hex values in the sidecar are preserved as-is.
- LOD `lowThreshold` and `mediumThreshold` are now read from settings rather than hardcoded constants.

### Deferred to future releases

- TypeORM: DBML `enum` types → `@Column({ type: 'enum', enum: … })`.
- TypeORM: DBML `indexes` → `@Index([…])` decorator.
- TypeORM dialects: MySQL, SQLite, MSSQL.
- Edge: arrowhead markers to distinguish cardinality (`1:*` vs `*:*`).
- Edge: self-loop path (currently degenerates visually).
- Edge: rounded elbows (`stroke-linejoin: round`).
- Minimap, go-to-table search, edge highlight on table hover.
- A*-based edge routing that avoids crossing tables.
- Export to Prisma, Mermaid, SQL DDL, PNG, SVG.
- Light and High-Contrast theme support for the design system.

---

## [0.1.0] — 2026-04-16

Initial release.

### Added

- Open Diagram command renders any `.dbml` file as an interactive diagram in a webview beside the editor.
- Parser wrapper over `@dbml/core` (dbmlv2) with quoted-identifier normalization.
- Auto-layout with `@dagrejs/dagre` for tables without saved positions; existing positions preserved on reparse.
- Sidecar layout file (`<name>.dbml.layout.json`) with Git-friendly stable ordering, integer coordinates, atomic writes.
- Persistence of per-table position, per-table color, per-table hidden flag, per-group collapse/hide/color, per-edge midpoint offset, viewport pan/zoom.
- Grid-bucketed spatial index (512 × 512 px) with viewport culling; 3-level LOD (`rect`/`header`/`full`) selected by zoom.
- Manhattan edge router, always horizontal (column-aligned), with port distribution to minimize overlap across multiple refs on the same side.
- Cardinality markers: crow's-foot (many) and perpendicular bar (one), at both endpoints.
- Draggable middle segment per edge with persisted `dx` offset.
- Marquee selection (click-drag on empty viewport, `Shift` to extend, `Esc` to clear) and multi-table drag.
- Double-click table header → reveals the `Table foo { ... }` declaration in the DBML editor.
- Custom tooltip on hover for columns and tables with `Note`.
- Gear button per table and per group opens a color picker with 20 presets + custom + reset.
- `TableGroup` support: visible container (dashed box with labeled tab), collapsed (single box with aggregated edges), hidden.
- "Diagram Views" panel: search, hide-all, collapse-all, per-group rows, per-table rows inside expanded groups.
- Bottom actions panel with "PK/FK only" toggle (collapses columns to PK + FK only).
- Zoom controls: `+` / `-` buttons, editable zoom percentage input, fit-to-content, reset.
- Keyboard shortcuts registered with `when: activeWebviewPanelId == 'dddbml.diagram'`:
  - `Ctrl+=` / `Ctrl+shift+=` — zoom in
  - `Ctrl+-` — zoom out
  - `Ctrl+0` — reset view
  - `Ctrl+1` — fit to content
- Hot-reload: FS watcher on both the DBML file and its layout sidecar; self-write suppression prevents echo loops.
- Commands: `dddbml.openDiagram`, `dddbml.resetLayout`, `dddbml.pruneOrphans`, `dddbml.zoomIn`, `dddbml.zoomOut`, `dddbml.resetView`, `dddbml.fitToContent`.
- Respects active VSCode color theme (light / dark / high-contrast).
- Synthetic 5000-table fixture generator (`scripts/gen-huge-fixture.mjs`) and medium/tiny fixtures under `test/fixtures/`.

### Deferred to future releases

- DBML `!include` / multi-file projects.
- A*-based edge routing that avoids crossing tables.
- Export to SQL, Prisma, PNG, SVG.
- Minimap, go-to-table search, edge highlight on table hover.
- Collaborative cursors.
