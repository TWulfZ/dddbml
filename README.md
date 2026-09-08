# dddbml — DBML diagrams for VS Code, Git-friendly, DDD-aware

Interactive diagram for `.dbml` files, rendered beside the editor. The **source of truth stays in your `.dbml`**: the extension only reads it. Table positions, group colors and edge shapes live in a sibling JSON file with deterministic formatting, so your team reviews the diagram in the same PR as the schema.

<img width="1917" height="1001" alt="dddbml overview" src="https://github.com/user-attachments/assets/021105af-da16-4f30-8e5b-313f72ac43a6" />

Built for:

- **DDD projects** — every `TableGroup` is a bounded context you can hide, collapse or color.
- **Large schemas** — viewport culling + level of detail keep pan/zoom smooth on thousands of tables.
- **Git-based teams** — sorted keys, integer coordinates, no view-state noise; conflicts on the layout file are resolved inside the diagram.

## Install

```bash
code --install-extension dddbml-<version>.vsix
```

Open a `.dbml` file and run **`dddbml: Open Diagram`** (command palette or the editor-title icon).

## Features

**Canvas**
- Tables, refs and groups parsed with the official `@dbml/core`; auto-layout for tables that have no saved position.
- Pan with middle-click, `Space` + drag, or the hand tool. Zoom with the wheel, `Ctrl+=` / `Ctrl+-`, fit with `Ctrl+1`, reset with `Ctrl+0`.
- Drag tables, marquee-select on empty space, `Shift` to add to the selection, `Esc` to clear. Undo/redo with `Ctrl+Z` / `Ctrl+Shift+Z`.
- Two detail levels by zoom: full tables, or colored rectangles for a bird's-eye view (threshold configurable).
- Double-click a table header to jump to its declaration in the `.dbml`.

**Relationships**
- Orthogonal edges that leave and enter at the FK/PK column rows, with crow's-foot / bar cardinality markers.
- Edit an edge by sliding a segment or dragging a ghost handle to add a notch; flip the port side by dragging an endpoint; recolor; "Reset line" to tidy.
- **Auto-arrange** (whole diagram, new tables only, or the selection) with an obstacle-avoiding edge router, cancelable with real progress.

**Bounded contexts (`TableGroup`)**
- Dashed container per group; collapse to a single node with aggregated edges; hide a group or a single table.
- Per-group and per-table colors from a palette or a custom hex.
- **Diagram Views** panel: search, hide/show all, collapse/expand all, per-table visibility.

**Git, from the canvas**
- Commit, discard or stash the diagram files only (`.dbml` + layout); browse history read-only; overlay a diff vs HEAD with inline column changes.
- Layout-file merge conflicts are resolved in-diagram with ghost positions, never by hand-editing markers.

**Export**
- Schema → **TypeORM entities** (PostgreSQL dialect; more dialects pluggable). Export the whole schema or the selection.
- Diagram → **PNG / SVG / clipboard**, whole diagram, current view or selection. Prefer SVG for very large diagrams.

**Settings** — zoom step and limits, LOD threshold, UI density, snap-to-grid, layout spacing and export defaults, editable from the in-app Settings panel or VS Code settings (`dddbml.*`).

## Layout file

For `schema.dbml` the extension writes `schema.dbml.layout.json` next to it:

```json
{
  "version": 1,
  "tables": {
    "public.orders": { "x": 480, "y": 80 },
    "public.users": { "x": 120, "y": 80, "color": "#8b5cf6" }
  },
  "groups": {
    "billing": { "color": "#D0E8FF" }
  },
  "edges": {
    "public.orders(user_id)->public.users(id)": {
      "waypoints": [{ "x": 360, "y": 120 }]
    }
  }
}
```

Only shared design goes into this file. Your camera position and which groups you hid or collapsed are per-user view state, stored in VS Code's global storage, so pan/zoom never dirties the repo. The writer sorts keys, rounds coordinates to integers, omits defaults, uses LF + trailing newline and writes atomically. Moving three tables changes three lines.

## Commands

| Command | Effect |
|---|---|
| `dddbml: Open Diagram` | Open the diagram beside the active `.dbml`. |
| `dddbml: Auto-arrange Diagram…` | Smart layout (all / new / selection) with edge ordering. |
| `dddbml: Export Schema…` | TypeORM export. |
| `dddbml: Export Image…` | PNG / SVG / clipboard export. |
| `dddbml: Reset Layout` | Drop saved positions and re-run auto-layout. |
| `dddbml: Prune orphan layout entries` | Remove layout entries whose table or group no longer exists. |
| `dddbml: Zoom In / Zoom Out / Reset View / Fit to Content` | Viewport commands, bound to the shortcuts above while the diagram is focused. |

## Limitations

- The diagram reflects the last **saved** file; editing happens in the text editor.
- One `.dbml` per diagram — `!include` is not followed yet.
- Self-referencing refs render degenerately.

See `specs/08-roadmap.md` for what is planned.

## Development

```bash
pnpm install
pnpm build            # extension (esbuild) + webview (vite)
pnpm test             # vitest
pnpm typecheck
```

Press `F5` to launch an Extension Development Host, open a `.dbml` there (e.g. `test/fixtures/huge.dbml`, 5000 tables) and run the command. `pnpm watch:extension` / `pnpm watch:webview` rebuild on change.

- `src/extension/` — VS Code host: parsing, layout file I/O, git, exporters, panel lifecycle.
- `src/webview/` — Preact + Zustand renderer: culling, LOD, edges, drag, panels.
- `src/shared/` — types crossing the `postMessage` boundary.
- `specs/` — design documents (Spanish). If you change a pipeline, update its spec in the same PR.

Performance budgets and how to measure them: `specs/07-performance-budgets.md`.

## License

MIT. See `LICENSE`.
