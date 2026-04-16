# dddbml — DBML Diagram for VSCode, Git-friendly, DDD-aware

Visual, interactive DBML renderer inside VSCode. The **source of truth stays in your `.dbml`** — this extension only **reads** the schema and lets you arrange tables, group them into bounded contexts, and persist that arrangement as a sibling JSON file your team can review alongside the schema itself.

Built for:
- **DDD projects** — every `TableGroup` maps to a bounded context you can hide, collapse, or color.
- **Large schemas** — viewport culling + LOD rendering keeps pan/zoom smooth up to **~5000 tables**.
- **Git-based teams** — position and group state live in a sibling JSON file with stable key ordering, so diffs are minimal and reviewable.

![Overview](docs/screenshots/overview.png)

---

## Install

From the VSIX (until the Marketplace listing is live):

```bash
code --install-extension dddbml-0.1.0.vsix
```

Open any `.dbml` file, then run **`dddbml: Open Diagram`** from the command palette (or click the icon in the editor title bar). A webview opens beside the editor.

---

## Features

### Render & interact with large DBML files

- Every `Table`, `Ref`, and `TableGroup` declared in your DBML is parsed via the official `@dbml/core` and rendered as positioned nodes with Manhattan-routed edges.
- Pan: middle-click drag. Zoom: mouse wheel (or `Ctrl+=` / `Ctrl+-`). Fit: `Ctrl+1`. Reset: `Ctrl+0`.
- Auto-layout via `@dagrejs/dagre` the first time a table appears; after that, your saved positions win.

![Main view](docs/screenshots/main-view.png)

### Drag tables, with per-table and multi-select

- Click + drag any table to move it. Position is written to the sidecar file after a 300 ms debounce.
- Click-drag on empty space opens a **marquee selector**. Selected tables get an outline.
- Drag any selected table and the whole selection moves as a group.
- `Shift` + marquee extends the selection. `Esc` clears it.

![Selection](docs/screenshots/selection.png)

### Relationship lines that follow your columns

- Each FK line exits from the source column's row and enters at the target column's row — not the middle of the table.
- Paths are **Manhattan-routed** horizontally (source side → vertical jog → target side), matching dbdiagram.io's style.
- Cardinality endpoints: crow's-foot for many (`*`), perpendicular bar for one (`1`).
- **Drag the middle segment** of any edge to reroute it exactly where you want it — the offset persists in the layout file.

![Edges](docs/screenshots/edges.png)

### TableGroups as DDD bounded contexts

Every `TableGroup name { ... }` in your DBML becomes a first-class module in the diagram:

- **Container**: dashed colored rectangle wrapping its member tables, with a labeled tab on top-left.
- **Collapse**: groups fold into a single box node with aggregated edges. Double-click the label to collapse; double-click the box to expand.
- **Hide**: hides the whole group (or any single table) — edges to hidden tables are omitted.
- **Custom colors**: per-group and per-table, via the gear icon. 20 presets + custom hex picker.

![Table groups](docs/screenshots/groups.png)

### Diagram Views panel

Top-right floating panel with:

- Search across group names and member tables (auto-expands matches).
- **Hide all / Show all** in one click.
- **Collapse all / Expand all** groups in one click.
- Per-group: visibility toggle, collapse toggle, color picker.
- Per-table (expand a group): individual visibility toggle.

![Diagram Views](docs/screenshots/diagram-views.png)

### Column details & tooltips

- PK column: key icon next to the name.
- Column with a DBML `Note`: sticky-note icon; hover to show the full note in a floating card next to the table.
- Table-level `Note`: shown next to the table name and on hover.
- Flags: `NN` for `not null`, `U` for `unique`.

![Tooltip](docs/screenshots/tooltip.png)

### Viewport culling + LOD for 5000+ tables

- A grid-bucketed spatial index (512 × 512 px cells) tracks every table bounding box.
- On each pan/zoom frame the index is queried for the visible window only — unseen tables skip the render tree.
- Three level-of-detail modes selected automatically by zoom:
  - `full` (zoom ≥ 0.6): full columns.
  - `header` (0.3–0.6): name only.
  - `rect` (< 0.3): colored rectangle.

### Jump to source (double-click)

Double-click any table header to open the `.dbml` file at its `Table foo { ... }` declaration.

### Bottom actions panel

A collapsible panel hugging the bottom-center of the diagram:

- **PK/FK only**: hide every column that isn't a primary key or foreign key — collapses dense tables to their relational skeleton.

More actions will land here.

![Actions panel](docs/screenshots/actions-panel.png)

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+=` / `Ctrl++` | Zoom in |
| `Ctrl+-` | Zoom out |
| `Ctrl+0` | Reset view |
| `Ctrl+1` | Fit to content |
| `Esc` | Clear selection |
| Middle-click drag | Pan |
| Wheel | Zoom at cursor |

All of these are scoped to the webview via `activeWebviewPanelId`, so they don't conflict with VSCode's own shortcuts unless the diagram is focused.

---

## Git-friendly layout file

For `schema.dbml`, the extension reads and writes a sibling `schema.dbml.layout.json`:

```json
{
  "version": 1,
  "viewport": { "x": -120, "y": -80, "zoom": 0.75 },
  "tables": {
    "public.orders": { "x": 480, "y": 80 },
    "public.users":  { "x": 120, "y": 80, "color": "#8b5cf6" }
  },
  "groups": {
    "billing":  { "color": "#D0E8FF" },
    "identity": { "collapsed": true, "color": "#FFE4A0" }
  },
  "edges": {
    "public.orders(user_id)->public.users(id)": { "dx": 40 }
  }
}
```

Rules the writer follows to keep Git diffs minimal:

- All keys sorted alphabetically (tables, groups, edges).
- Default flags (`hidden: false`, `collapsed: false`) are omitted.
- Coordinates are integers (no subpixel noise).
- 2-space indent, LF line endings, trailing newline.
- Atomic write: temp file + rename, so a mid-write VSCode crash never leaves you with a broken layout.

After 10 users drag 10 different tables, `git diff` shows exactly 10 changed lines. That's the point.

### Commands

| Command | What it does |
|---|---|
| `dddbml: Open Diagram` | Opens the webview beside the active `.dbml` file. |
| `dddbml: Reset Layout` | Clears saved positions; re-runs auto-layout on next open. |
| `dddbml: Prune orphan layout entries` | Removes entries in the layout file whose table was deleted from the DBML. |
| `dddbml: Zoom In / Out / Reset View / Fit to Content` | Viewport commands (keyboard shortcuts above). |

---

## DDD workflow

1. Model every bounded context as a `TableGroup` in your DBML:
   ```dbml
   TableGroup billing {
     invoices
     payments
   }
   ```
2. Open the diagram. Groups appear as dashed containers.
3. Assign each group a color that matches your domain map (gear icon → color picker).
4. When reviewing changes to a far-away context, collapse everything else — keep only the context you care about visible.
5. Commit both `schema.dbml` and `schema.dbml.layout.json`. Reviewers see **what changed** and **how the diagram changed** in the same PR.

---

## Performance budgets (v1 targets)

| Metric | Target |
|---|---|
| Parse DBML, 5000 tables | < 2 s |
| Auto-layout, 5000 tables | < 3 s |
| FPS, pan continuous 10 s | ≥ 55 avg, ≥ 30 p99 |
| Webview idle memory | < 200 MB |
| Bundle (gzipped) | < 50 KB |

Measure yourself with `Developer: Open Webview Developer Tools` → Performance.

---

## Limitations (v1)

- **No editor in the app** — you edit DBML in VSCode's text editor. The diagram always reflects the last saved file.
- **Single-file projects** — `!include` from one DBML into another isn't followed yet.
- **Edges can cross tables** — the router doesn't avoid obstacles. Manually drag the middle segment if the auto route overlaps.
- **No export** — SQL / PNG / SVG export is not in v1.
- **Self-references** — refs from a table to itself render degenerately in v1; treat as known visual oddity.

See `specs/08-roadmap.md` for what's planned beyond v1.

---

## Development

```bash
pnpm install
pnpm run build      # tsc + vite build
pnpm run watch:extension    # tsc --watch on extension
pnpm run watch:webview      # vite --watch on webview
```

Press `F5` from the project root in VSCode to launch an Extension Development Host with the extension loaded. Open any `.dbml` file in that host and run the command.

### Package structure

- `src/extension/` — runs in the VSCode extension host (Node.js). Parser wrapper, layout file I/O, panel lifecycle, file watchers.
- `src/webview/` — runs in the webview (Preact). Renderer, spatial index, drag controllers, group panel, color picker, tooltip.
- `src/shared/` — types shared across the postMessage boundary.
- `specs/` — design documents (architecture, layout schema, edge routing, render pipeline, roadmap).

### Build outputs

- `dist/extension/extension/extension.js` — host entry (CommonJS).
- `dist/webview/webview.js` — IIFE bundle loaded into the webview.

### Stack

- TypeScript (strict).
- Preact + Zustand (vanilla) — zero React overhead in the webview.
- `@dbml/core` for DBML parsing.
- `@dagrejs/dagre` for auto-layout.
- Vite for the webview bundle, `tsc` for the extension.
- `@vscode/vsce` for packaging.

No React, no React Flow. The renderer is ~1 KLOC of custom code because we need column-aligned ports, LOD, and culling that existing libraries don't give at 5000 nodes.

---

## Related / prior art

Extensions on the VSCode Marketplace that also render DBML but don't persist per-table positions or support DDD workflows:

- `matt-meyers.vscode-dbml` — syntax highlighting only; complementary, not a competitor.
- `bocovo.dbml-erd-visualizer`, `PeakTech.dbml-erd-viewer`, `nicolas-liger.dbml-viewer`, `rizkykurniawan.dbml-previewer`, `dbdiagram.dbdiagram-vscode` — rendered diagrams but without Git-friendly layout persistence, group collapse, or viewport culling at scale.

`dddbml` specifically fills those gaps.

---

## Contributing

Issues and PRs welcome. If you're touching the render pipeline, please update the matching file in `specs/` in the same PR — those documents are the source of truth for design decisions.

---

## License

MIT. See `LICENSE`.
