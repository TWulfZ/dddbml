# 16 — Integración Git (panel del diagrama)

## Propósito

Versionar el diagrama **desde el propio canvas**: confirmar cambios, descartarlos,
hacer stash, explorar versiones anteriores en solo lectura y previsualizar un diff
(qué tablas/columnas/relaciones cambiaron) sobre el diagrama. Pensado para trabajo
en equipo sobre `.dbml` + su sidecar, sin salir de la extensión.

## Contexto / Problema

El slot "Git" del menú de app (esquina sup-izq) existía solo como placeholder
deshabilitado (`appMenu.tsx`, reservado por [`15-app-menu.md`](15-app-menu.md) con
un chevron "submenú/panel futuro"). El diagrama ya es team-friendly: el view-state
salió de git ([`14-collaborative-merge.md`](14-collaborative-merge.md)) y existe un
merge 3-way in-extension. El harness git (`src/extension/gitStages.ts`,
`execFile`, sin dependencias) y el patrón de **canvas read-only + overlay de estado
on-canvas** (merge ghosts) ya estaban — esta entrega los reutiliza para una feature
pesada que se construye **por fases**, cada una desplegable por separado.

## Preguntas abiertas (Open Questions)

- [x] **Alcance de las operaciones git (qué archivos tocan commit/stash/revertir).**
  — **Decisión:** SOLO los archivos del diagrama (el `.dbml` + su `.layout.json`;
  los `!include` quedan como mejora best-effort, ver abajo). Nunca todo el repo. Un
  editor de diagramas no debe commitear el árbol entero; encaja con el scoping
  deliberado ya existente (`gitAdd` usa `add -- <path>`, nunca `add -A`). (Acordado
  con el owner, 2026-05-30.)
- [x] **Semántica de "Revertir cambios".** — **Decisión:** `git checkout HEAD --
  <paths>` (descartar cambios sin confirmar, restaurar a HEAD). Es **destructivo** →
  diálogo de confirmación que avisa que **no se podrá deshacer**, y en el mismo
  diálogo un empujón: *"¿solo temporal? usa Stash"* (que dispara el stash en lugar de
  restaurar). Revert y Stash quedan acoplados en la UI. (Acordado, 2026-05-30.)
- [x] **Mecanismo de "Explorar commits" (solo lectura).** — **Decisión:**
  time-travel **virtual**: leer el `.dbml` + sidecar del commit con
  `git show <rev>:<path>`, parsearlos en memoria en el host y renderizarlos en solo
  lectura. **No** ejecuta un `git checkout` real; no toca el working tree ni el
  editor abierto; reversible al instante. (Acordado, 2026-05-30.)
- [x] **Granularidad del diff.** — **Decisión:** tabla + columna + relación. El detalle
  columna a columna se ve en una **tarjeta Previous | Current** al hacer hover sobre una
  tabla cambiada. (Acordado, 2026-05-30.)
- [x] **Idioma de la app y framing del diff.** — **Decisión:** TODA la UI de la app en
  **inglés** (las specs siguen en español; mezclar idiomas en la app fue un error y se
  corrigió). El diff se enmarca como **Previous/Current** (antes/después), no como
  "added/removed/modified": en canvas las tablas cambiadas se marcan (borde) y las no-diff
  se **atenúan/desenfocan** (toggle "Blur background tables", on por defecto); el detalle
  vive en la tarjeta de hover Previous|Current; la barra trae botones **prev/next** que
  enfocan la cámara en cada cambio. (Acordado con el owner, 2026-05-31.)
- [ ] **Descubrimiento de `!include`.** Hoy el host parsea un solo archivo
  (`parser.ts`) y `resolveDiagram` (en `panel.ts`) solo incluye `.dbml` + sidecar.
  Cuando el parse multi-archivo aterrice, ampliar el alcance con un escaneo regex de
  `!include`. *No bloqueante.*
- [ ] **Diff de posiciones.** El diff v1 es **estructural** (schema). Diffear el
  layout (movimientos de tablas, colores) queda fuera de v1. *No bloqueante.*
- [ ] **Diff contra un commit arbitrario.** v1 solo compara *working vs HEAD*. Elegir
  par de revisiones (HEAD vs commit, commit vs commit) es follow-up. *No bloqueante.*

## Diseño

Punto de entrada: la fila **Git** del `appMenu` abre `gitPanel.tsx` — un modal de
dos paneles clonado del shell de `settingsPanel` (riel de secciones + contenido).
Secciones: **Commit**, **Historial**, **Diff**, **Stash**. Todas las operaciones de
escritura están acotadas a los archivos del diagrama (`diagramScope()` en
`panel.ts`).

### Commit (`Guardar commits`)
Muestra rama actual + los archivos del diagrama con cambios (de `git:status`) y un
campo de mensaje. "Guardar commit" stagea + confirma **solo** los archivos sucios
del diagrama: `git add -- <paths>` y `git commit -m <msg> -- <paths>` (el orden pone
`-m` antes de `--` para que no se interprete como pathspec). Confirma solo lo sucio.

### Revertir + Stash
"Revertir cambios" abre un `<Modal>` de confirmación (botón `danger`) que avisa que
**no se podrá deshacer** y ofrece *"Usar Stash en su lugar"*. Restore =
`git checkout HEAD -- <paths>` sobre los archivos **trackeados** sucios (los
untracked no tienen versión en HEAD → se omiten). Stash = `git stash push -- <paths>`
sobre los trackeados; la sección **Stash** lista los stashes (`git stash list`) con
*Aplicar* (`apply`) y *Pop* (`pop`). Tras restaurar/stash/pop el host re-lee el
diagrama del disco (`reloadFromDisk`) y un `pop` con conflicto cae en el resolver de
merge existente (marcadores → `loadSharedLayout`).

### Explorar versiones (time-travel virtual, solo lectura)
La sección **Historial** lista los commits que tocan el diagrama (`git log --
<paths>`). Al elegir uno, el host lee el `.dbml`+sidecar de esa revisión con
`git show <rev>:<path>`, los parsea **en memoria** y re-viste el layout compartido
con el view-state actual (pan/zoom/oculto se mantienen). Se renderiza en un overlay
de solo lectura (`gitView.kind === 'timeTravel'`). **No** se ejecuta `git checkout`
real. "Salir" pide al host re-enviar el estado de trabajo.

### Diff (lo más pesado) — framing Previous/Current
"Diff against HEAD" compara el working tree contra HEAD. El host parsea HEAD
(`git show HEAD:<dbml>` → `parseDbml`) y corre `diffSchemas(base, head)`
(`schemaDiff.ts`, puro; `base` = HEAD/Previous, `head` = working/Current). El webview
mantiene en pantalla el schema de trabajo y **superpone** el diff sin re-render paralelo:
- **Focus/blur:** las tablas **no** incluidas en el diff se atenúan + desenfocan
  (`is-diff-dimmed`); toggle **"Blur background tables"** (on por defecto, store
  `diffBlurBackground`). Solo afecta a las tablas visibles (el culling acota el set).
- **Marcador en canvas:** las tablas cambiadas llevan un borde (`is-diff-*`) — sin
  etiquetas de texto added/removed/modified. Las **eliminadas** (sin nodo vivo) se dibujan
  como ghosts (`DiffGhosts`) en su posición base, etiquetadas "Previous".
- **Hover → tarjeta Previous | Current** (`DiffHoverCard`): dos columnas con las columnas
  de la tabla en cada revisión; una columna ausente de un lado se lee como add/remove por
  su ausencia, una columna que difiere va en ámbar a ambos lados. La detección de hover usa
  una **hit-layer** transparente (`DiffHitLayer`) exenta del cinturón read-only, así el
  canvas sigue no-editable pero las tablas del diff son hover-ables.
- **Navegación:** la barra (`GitBanner`) trae botones prev/next + contador que enfocan la
  cámara en cada cambio (`fitToBbox`, store `diffCursor`).
- **Refs:** añadidas → tinte sobre el edge vivo (mapeo id-estable → key compuesta del edge
  layer); eliminadas → conector punteado en `DiffGhosts`.

El gate de solo lectura es único: `isCanvasReadOnly(s) = mergeConflicts != null ||
gitView != null`, consultado por drag/persist/undo/redo/marquee/teclado/smart-layout
y el cinturón CSS `.is-merge-locked`. Merge y git-overlay son mutuamente excluyentes
(un merge del host limpia `gitView`).

## Modelo de datos / tipos afectados

`src/shared/types.ts` (todo plano y serializable; `null` en vez de `undefined`):
`GitFileStatus`, `GitPathStatus`, `GitCommitMeta`, `GitStashEntry`,
`GitStatusSummary`, `GitOp`, y los tipos de diff `TableDiffStatus` /
`ColumnDiffStatus` / `RefDiffStatus` / `ColumnDiffEntry` / `TableDiff` / `RefDiff` /
`SchemaDiff`.

Store (`src/webview/state/store.ts`): `gitStatus`, `gitPanelOpen`, `gitBusy`,
`gitStashes`, `gitCommits`, `gitView`, `diffByTable`, `columnDiffByTable`,
`diffBaseByTable` (tabla Previous para la tarjeta de hover), `diffGhosts`, `refDiff`,
`diffRemovedRefs`, `diffBlurBackground` (default `true`), `diffHover` (tabla + ancla de
pantalla), `diffCursor` (nav) + acciones (`setGitStatus`, `setGitPanelOpen`, `setGitBusy`,
`setGitStashes`, `setGitCommits`, `enterTimeTravel`, `enterDiff`, `exitGitView`,
`setDiffBlurBackground`, `setDiffHover`, `setDiffCursor`). Helper exportado
`isCanvasReadOnly(s)`. Suscripciones granulares: los mapas de diff cambian de referencia
solo al entrar/salir (un re-render de `App`, igual que `mergeConflicts`). `TableDiff.base`
lleva la tabla Previous también para las tablas **modificadas** (no solo eliminadas).

## Puntos de extensión / integración

- Git I/O → `src/extension/gitStages.ts` (`execFile`, sin deps): `runGit` (export),
  `gitLog`, `showBlob` (generaliza `showStage`), `gitCommit`, `gitRestore`,
  `gitStashPush/List/Apply/Pop`, `gitStatusPorcelain`, `getCurrentBranch`.
- Diff puro → `src/extension/schemaDiff.ts` (`diffSchemas`).
- Orquestación host → `panel.ts` (`diagramScope`, `sendGitStatus`, `sendStashes`,
  `sendCommits`, `handleGitCommit/Restore/StashPush/StashOp`, `enterTimeTravel`,
  `exitTimeTravel`, `enterDiff`, `reloadFromDisk`).
- Read-only + overlay on-canvas → patrón de merge (gate `mergeConflicts`,
  `mergeGhosts`). Nuevo: `gitBanner.tsx`, `diffGhosts.tsx`, `diffHoverCard.tsx`
  (tarjeta Previous|Current), `diffHitLayer.tsx` (hover exento del cinturón read-only).
  Cámara → `fitToBbox` (`render/viewport.ts`).
- Panel de dos paneles → shell `.ddd-settings__*` (reusado). Primitivos: `Button`
  (variante nueva `danger`), `Modal`, `Field`, `Search`, `Tooltip`; codicons via
  `make()` (`git-commit`, `git-branch`, `history`, `diff`, `archive`).
- Inyección de diff → `tableNode.tsx` (`diffStatus`/`columnDiff` props) y
  `edgeLayer.tsx` (`refDiff` prop) sobre el render path culleado existente.

## Protocolo host↔webview

Namespace `git:`. **Host→Webview:** `git:status`, `git:commitResult`, `git:stashes`,
`git:opResult`, `git:commits`, `git:timeTravel:enter` (lleva schema+layout de la
revisión), `git:timeTravel:exit`, `git:diff:enter` (lleva `SchemaDiff`).
**Webview→Host:** `git:requestStatus`, `git:commit`, `git:requestStashes`,
`git:restore`, `git:stashPush`, `git:stashApply`, `git:stashPop`,
`git:requestCommits`, `git:timeTravel:enter` (`{sha,label}`), `git:timeTravel:exit`,
`git:diff:enter`. El *exit* del diff es local al webview (el host no cambió el
schema), a diferencia del time-travel (round-trip para restaurar).

## Anti-goals / fuera de alcance

- Sin cambio de rama / checkout real / operaciones que muten el árbol fuera de los
  archivos del diagrama.
- Sin diff de posiciones/layout en v1 (solo estructural).
- Sin diff contra commit arbitrario en v1 (solo working vs HEAD).
- Sin nueva UI de resolución de conflictos (un `stash pop` conflictivo reusa el
  resolver de merge de la spec 14).

## Fallos conocidos / casos límite

- **Refs eliminadas entre dos tablas que sobreviven**: se dibujan como línea recta
  punteada (no enrutada ortogonalmente). Aceptado para un overlay de diff.
- **Tinte de ref añadida con endpoints colapsados/ocultos**: el mapeo id-estable →
  key compuesta puede no coincidir si un endpoint está colapsado; el tinte se omite
  en ese caso.
- **`!include`**: el alcance v1 es `.dbml` + sidecar; los includes no se siguen
  todavía (ver Preguntas abiertas).
- **Sin repo / sin HEAD**: el panel muestra un aviso ("Initialize git" / "no committed
  version at HEAD"); ninguna operación lanza.
- **Detalle de columnas solo en hover**: una tabla modificada en canvas solo muestra el
  borde; el desglose columna a columna requiere hover (tarjeta Previous|Current). La tarjeta
  es pointer-transparent (peek), así que tablas muy largas no se pueden scrollear dentro de
  ella.

## Error handling

Las funciones de lectura de `gitStages` devuelven `null`/`[]` ante error
(best-effort, como `showStage`); las de escritura (`gitCommit`/`gitRestore`/stash)
lanzan y el host reporta vía `git:commitResult`/`git:opResult` + un
`showWarningMessage`/`showErrorMessage`. `git:status` degrada a `inRepo:false` sin
lanzar.

## Performance budget

Cumple [`07-performance-budgets.md`](07-performance-budgets.md) (5000 tablas, pan/zoom
60fps): los mapas de diff cambian de referencia solo al entrar/salir (un re-render de
`App`), los props de diff viajan por el `TableNode`/`EdgeLayer` ya culleado (sin render
de detalle paralelo), el `is-diff-dimmed` (opacity + blur) aplica solo a las tablas
**visibles** (el culling acota el set a un screenful, no a las 5000), la hit-layer y la
tarjeta de hover solo existen en modo diff, y el cálculo del diff (parse de dos
revisiones) corre en el host, fuera del render path.

## Test plan

Vitest colocados: `src/extension/schemaDiff.test.ts` (diff puro:
añadido/eliminado/modificado/identidad, columnas, refs), `src/extension/
gitStages.git.test.ts` (repo temporal real, patrón de
`mergeConflict.integration.test.ts`: commit acotado toca solo los paths nombrados,
`showBlob`/log/status, round-trip de stash, restore), `src/webview/state/
store.git.test.ts` (`enterTimeTravel`/`enterDiff`/`exitGitView`, `isCanvasReadOnly`,
undo/redo no-op bajo overlay, `beginMerge` limpia `gitView`). `pnpm typecheck` +
`pnpm test`. Manual en el Extension Development Host: abrir un `.dbml` en un repo →
menú → Git; confirmar (verificar con `git status` que solo se stagean los archivos
del diagrama); revertir muestra el confirm irreversible + nudge a stash; stash
apply/pop; Explorar abre una versión en solo lectura (working tree y editor intactos,
drag/undo bloqueados, Salir restaura); Ver diff resalta tablas/columnas/refs;
legibilidad en temas claro/oscuro; `prefers-reduced-motion` respetado.

## Documentos relacionados

- [`14-collaborative-merge.md`](14-collaborative-merge.md) — gate read-only + overlay
  on-canvas que esta spec reutiliza.
- [`15-app-menu.md`](15-app-menu.md) — el menú que aloja la entrada Git.
- [`03-layout-file-schema.md`](03-layout-file-schema.md) — sidecar git-friendly.
- [`04-render-pipeline.md`](04-render-pipeline.md) / [`05-edge-routing.md`](05-edge-routing.md) — paths de render que la inyección de diff reutiliza.
- [`07-performance-budgets.md`](07-performance-budgets.md) — presupuesto de render.
- [`12-design-system.md`](12-design-system.md) — primitivos (`Button` variante `danger`), tokens.
