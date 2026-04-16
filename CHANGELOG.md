# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] — Unreleased

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
