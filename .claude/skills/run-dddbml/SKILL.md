---
name: run-dddbml
description: >-
  Launch and drive the real dddbml extension to see a change working, not just unit tests: (1) the
  built webview in headless Chromium with a fake host that replays a real parsed .dbml (click, drag,
  context menus, FK drag, screenshots, posted host messages, frame-time measurement on huge.dbml), and
  (2) a real VS Code instance with the extension loaded (activation, parse worker, Ctrl+click links,
  watcher/save path). Use when asked to run, test by hand, screenshot, reproduce a UI bug, or measure
  drag/pan perf in dddbml.
---

# Run dddbml

Two drivers. Paths are relative to this skill dir (`.claude/skills/run-dddbml`); the repo root is
three levels up. Tooling installs into this folder only — it is never part of the extension bundle.

## Setup (once)

```bash
K=.claude/skills/run-dddbml
pnpm --dir $K install --ignore-workspace          # playwright-core + @vscode/test-electron
node $K/node_modules/playwright-core/cli.js install chromium
pnpm build                                        # the harness serves dist/webview; rebuild after webview edits
pnpm test:gen                                     # test/fixtures/{small,huge}.dbml (gitignored)
```

## 1 · Webview in Chromium (fake host)

```bash
$K/fixture.sh small test/fixtures/small.dbml      # → .work/small.json  (also: huge, or $K/selfloop.dbml)
node $K/serve.mjs 8765 &                          # stop: kill the listener on 8765
node $K/drive.mjs small 8765 <<'EOF'
ss initial
edges
rclick 900 500
clicktext New table here
posted schema:
errors
EOF
```

The page is `harness.html`: it stubs `acquireVsCodeApi`, records every webview→host message in
`window.__posted`, and on `ready` replays panel.ts's hydrate order (layout, schema, theme, settings).
Inject any host message with `deliver {json}` — e.g. `{"type":"layout:place",...}`,
`{"type":"viewport:command","payload":{"action":"fitToContent"}}`,
`{"type":"command:autoArrange","payload":{"mode":"all","orderEdges":false,"preserveManualEdges":true}}`,
`{"type":"git:timeTravel:enter",...}` to test read-only. The host side is NOT exercised here: replies
such as `schema:applied` or a new `schema:update` must be delivered by hand.

Driver commands (one per line): `ss <name>` (→ `.work/shots/<name>.png`; **look at it**), `wait ms`,
`eval <js>`, `click x y`, `dbl x y`, `rclick x y`, `move x y`, `mv x y [steps]`, `down`, `up`,
`drag x1 y1 x2 y2 [steps] [Shift+Control]`, `wheel x y dx dy [n]`, `key <Key>`, `clicktext <text>`,
`deliver <json>`, `posted [typePrefix]`, `clearposted`, `bbox <css>`, `edges` (all edge `d`s),
`framesStart` / `framesStop` (rAF frame-time stats: mean/p50/p95/max/over33), `errors`.

Useful selectors: `.ddd-table[data-id]`, `.ddd-table__col[data-col]`, `.ddd-table__col-port` (FK drag
handle; hover the row first), `[data-edge]` (edge keys), `[role=menuitem]`, status bar text via
`eval document.querySelector('[class*=status]')?.textContent`.

## 2 · Real VS Code

```bash
node $K/vsc/run-vscode.mjs [path/to/file.dbml]    # default: $K/selfloop.dbml
```

Downloads VS Code once into `$K/.vscode-test`, opens a temp workspace with the file as `model.dbml`,
and runs `vsc/smoke.cjs` inside the extension host: activation, `dddbml.openDiagram`, the Ctrl+click
`DocumentLink`s (they come from the parse worker, so links present ⇒ the bundled worker runs),
`dddbml.revealInDiagram`, then an edit + save. Prints `.work/vscode-smoke.txt`. Extension-host log:
`.work/vscode-ud/logs/*/window1/exthost/exthost.log` (grep `dddbml`, `[error]`). Extend `smoke.cjs`
for new host flows. The webview inside VS Code is not driven here — use driver 1 for UI.

## Gotchas

- Needs a display for driver 2: WSLg (`DISPLAY=:0`) works; elsewhere wrap in `xvfb-run -a`. The
  `native-keymap` / `AgentHost` / GitHub-session noise in its stdout is VS Code's, not ours.
- Driver 1 serves `dist/webview` directly: after any webview change run `pnpm build:webview` first.
- Edge layout keys are the composite edge key (`render/edgeKey.ts`), not `Ref.id`; read real keys with
  `eval [...document.querySelectorAll('[data-edge]')].map(e=>e.dataset.edge)` before injecting layouts.
- A table press captures the pointer on the table node, so events land on the table, not the row —
  that is real browser behaviour unit tests cannot see; reproduce such bugs here.
- Headless Chromium paints in software; frame times are a relative signal (compare before/after), not
  the Extension Development Host's absolute numbers.
