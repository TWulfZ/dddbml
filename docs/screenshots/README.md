# Screenshots

Place feature screenshots here matching the paths referenced in the project `README.md`:

- `overview.png` — hero shot showing the whole diagram with groups and edges
- `main-view.png` — typical usage (tables, edges, pan/zoom)
- `selection.png` — marquee selection with multiple tables highlighted
- `edges.png` — close-up of column-aligned edges with cardinality markers
- `groups.png` — two groups (one expanded as a container, one collapsed as a box)
- `diagram-views.png` — the Diagram Views side panel open
- `tooltip.png` — a column-note tooltip floating next to a table
- `actions-panel.png` — bottom actions panel open with PK/FK-only toggled

PNG is preferred for static shots. For interactions like drag or selection, a short GIF (≤ 3 MB, ≤ 8 s) recorded from the Extension Development Host works well.

Suggested workflow:
1. Launch Extension Development Host (`F5`).
2. Open `test/fixtures/tiny.dbml` or a real project DBML.
3. Run `dddbml: Open Diagram`.
4. Use the Windows Snipping Tool (`Win+Shift+S`) for stills, or ScreenToGif / LICEcap for animations.
5. Save directly into this folder with the filenames above.
