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
  columna a columna se renderiza **inline en la tabla** como un diff unificado de git.
  (Acordado, 2026-05-30; presentación revisada 2026-05-31, ver abajo.)
- [x] **Idioma de la app y presentación del diff.** — **Decisión:** TODA la UI de la app en
  **inglés** (las specs siguen en español; mezclar idiomas en la app fue un error y se
  corrigió). El diff se renderiza como un **diff unificado estilo editor de VS Code**, inline
  dentro de cada tabla: filas eliminadas en rojo con `−`, añadidas en verde con `+`, una
  columna modificada como par `−`viejo / `+`nuevo, usando los **colores de diff del tema de
  VS Code** (`--vscode-diffEditor-*`). Se descartó la tarjeta de hover Previous|Current (no
  aportaba). Las tablas no-diff se **atenúan/desenfocan** (toggle "Blur background tables",
  on por defecto), y la barra trae botones **prev/next** que enfocan la cámara en cada cambio.
  El mismo toggle de blur se aplica al **merge resolver** para enfocar los conflictos.
  (Acordado con el owner, 2026-05-31.)
- [x] **Dónde se aplica el gate de solo lectura.** — **Decisión:** en dos capas, host
  autoritativo + webview (ver "Gate en dos capas"). Solo-webview se descartó: cualquier fuga
  futura vuelve a escribir el sidecar. (Acordado con el owner, 2026-10-01.)
- [x] **Historial de undo/redo al entrar/salir de time-travel o diff.** — **Decisión:** se
  conserva; undo/redo quedan inactivos durante el overlay (spec 11). (Acordado, 2026-10-01.)
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
untracked no tienen versión en HEAD → se omiten; los staged-new `A` tampoco la tienen →
sólo se des-stagean con `git rm --cached -f`, quedan untracked en disco; incluirlos en el
checkout hacía fallar el revert entero). Stash = `git stash push -- <paths>`
sobre los trackeados; la sección **Stash** lista los stashes (`git stash list`) con
*Aplicar* (`apply`) y *Pop* (`pop`). Tras restaurar/stash/pop el host re-lee el
diagrama del disco (`reloadFromDisk`) y un `pop` con conflicto cae en el resolver de
merge existente (marcadores → `loadSharedLayout`). git sale con código ≠ 0 en ese caso
aunque el stash sí se aplicó: si algún archivo del diagrama queda unmerged
(`ls-files -u`), el host lo trata como **aplicado con conflictos** (recarga, refresca la
lista de stashes, `git:opResult ok:true` + aviso informativo de que el stash se conserva
hasta resolver), nunca como "falló".

### Explorar versiones (time-travel virtual, solo lectura)
La sección **Historial** lista los commits que tocan el diagrama (`git log --
<paths>`). Al elegir uno, el host lee el `.dbml`+sidecar de esa revisión con
`git show <rev>:<path>`, los parsea **en memoria** y re-viste el layout compartido
con el view-state actual (pan/zoom/oculto se mantienen). Se renderiza en un overlay
de solo lectura (`gitView.kind === 'timeTravel'`). **No** se ejecuta `git checkout`
real. "Salir" pide al host re-enviar el estado de trabajo. Mientras dura, el host guarda
el overlay (`gitOverlay`, con el schema+layout de la revisión) y **Export Schema** exporta esa
revisión (lo que está en pantalla, igual que Export image), no el working tree; se limpia al
salir y al entrar en merge. Un webview recargado recibe de nuevo `git:timeTravel:enter`.

### Diff (lo más pesado) — framing Previous/Current
"Diff against HEAD" compara el working tree contra HEAD. El host parsea HEAD
(`git show HEAD:<dbml>` → `parseDbml`) y corre `diffSchemas(base, head)`
(`schemaDiff.ts`, puro; `base` = HEAD/Previous, `head` = working/Current). `head` se
re-lee y re-parsea del disco en ese momento (no el `lastValidSchema` cacheado); si el
working tree no parsea, el host avisa y no entra en diff (antes mostraba todo como
removido). El webview
mantiene en pantalla el schema de trabajo y **superpone** el diff sin re-render paralelo:
- **Focus/blur:** las tablas **no** incluidas en el diff se atenúan + desenfocan
  (`is-diff-dimmed`); toggle **"Blur background tables"** (on por defecto, store
  `focusDimming`, compartido con el merge resolver). Solo afecta a las tablas visibles (el
  culling acota el set).
- **Diff inline (estilo editor):** `TableNode` recibe `diffBase` (tabla Previous) +
  `columnDiff` y construye un **diff unificado** de sus columnas (`buildDiffRows`): eliminadas
  `−` (rojo), añadidas `+` (verde), modificadas como par `−`viejo/`+`nuevo, intercaladas en el
  orden de la tabla base. Las filas usan los tokens `--ddd-diff-add/del-*` → `--vscode-diffEditor-*`.
  Las tablas cambiadas llevan además un borde (`is-diff-*`). Las **eliminadas** (sin nodo vivo)
  se dibujan como ghosts (`DiffGhosts`) en su posición base, con sus columnas en rojo `−`.
  Si el sidecar de HEAD no tiene posición (tabla nunca arrastrada), `enterDiff` usa la última
  posición del webview (`positions` no se poda al cambiar el schema); si tampoco existe, sintetiza
  una junto a sus vecinas por refs eliminadas, o apilada a la derecha del diagrama. Una tabla
  eliminada **nunca** se descarta: sigue siendo objetivo de prev/next y ancla de sus refs eliminadas.
- **Navegación:** la barra (`GitBanner`) trae botones prev/next + contador que enfocan la
  cámara en cada cambio (`fitToBbox`, store `diffCursor`). Al abrir el diff la cámara **no**
  se mueve: `diffCursor = -1` y el contador muestra `– / N`; el primer *next* enfoca el
  cambio 1 y el primer *prev* el último (`diffNavIndex`). Los objetivos (`buildDiffTargets`) y
  los extremos de las refs eliminadas pasan por los filtros de vista (`liveViewBox`): una tabla
  **oculta** no es objetivo y su línea no se dibuja, pero el contador las suma aparte
  (`– / N · +k hidden`) para que el usuario sepa que existen (decisión 2026-10-01); una tabla dentro de un grupo **colapsado**
  apunta al nodo del grupo (un objetivo por grupo), nunca a su posición cruda.
- **Refs:** añadidas → tinte sobre el edge vivo (mapeo id-estable → key compuesta del edge
  layer); **cambiadas** (`'changed'`: mismo id pero otra cardinalidad, dirección o
  emparejamiento de columnas compuestas; se comparan en orientación canónica, así `a > b` y
  `b < a` son iguales) → tinte `--ddd-warning` sobre el edge vivo; eliminadas → conector
  punteado en `DiffGhosts`. El id estable no basta para detectar cambios: ignora relación y
  emparejamiento. Los edges con cambio quedan a
  opacidad llena (auto-focus) mientras los demás siguen el fade global (ver abajo).

### Edges suavizados (fade + reveal on focus)
Los edges son secundarios: por defecto se renderizan con opacidad reducida (`.ddd-edge-group`
~0.4) y solo se revelan a opacidad llena cuando están **enfocados** — su tabla está en hover o
seleccionada, el propio edge está en hover/seleccionado, o (en diff) el edge tiene un cambio.
El hover de tabla se comparte vía store `hoveredTable` (lo setea `TableNode`); `edgeLayer`
marca `is-focused` los routes cuyo endpoint coincide. Aplica en vista normal, diff y merge.

El gate de solo lectura es único: `isCanvasReadOnly(s) = mergeConflicts != null ||
gitView != null`, consultado por drag/persist/undo/redo/marquee/teclado/smart-layout,
edición de edges, el panel **Diagram Views** (ocultar/colapsar/color de grupos, ocultar tablas:
botones deshabilitados y las acciones `setGroup`/`setTableHidden`/`setTableColor`/`setEdgeColor`
del store son no-op) y el cinturón CSS `.is-merge-locked`. Entrar en time-travel limpia los mapas
de diff (solo son válidos bajo `gitView.kind === 'diff'`). Merge y git-overlay son
mutuamente excluyentes (un merge del host limpia `gitView`).

### Gate en dos capas: host autoritativo + webview (decisión 2026-10-01)

La auditoría 2026-09-22 (F02–F05, F21, F27, F30, F31, F71, F73) mostró que un gate solo en
el webview se fuga: una recarga del webview lo pierde, un timer de persist programado antes
de entrar sigue vivo, y el host acepta cualquier escritura. Por eso:

- **Host (autoridad).** Cada `DiagramPanel` mantiene `readOnly: 'merge' | 'timeTravel' | 'diff' | null`.
  Mientras no sea `null`:
  - descarta `layout:persist` y los comandos que escriben el sidecar (Reset Layout, Prune
    Orphans) con un aviso, y no deja hacer Commit/Stash/Revert de los archivos del diagrama
    durante un merge (staging del sidecar con marcadores borraría los stages de git);
  - en `webview:ready` (recarga/re-show del webview) re-postea el estado vigente
    (`merge:begin` con los conflictos actuales, o el overlay git) en vez del layout editable;
  - los pushes del watcher (`schema:update`, `layout:*`) durante un overlay git se difieren
    hasta salir; no reemplazan la revisión que se está mirando.
- **Conflictos resueltos fuera del diagrama.** El watcher del sidecar re-detecta: si ya no hay
  conflicto, el host postea `merge:end` y recarga el layout; si la detección falla, el panel
  queda en solo lectura con el error visible (nunca un layout vacío editable).
- **Webview.** `schedulePersist` postea **al instante** (F22: sin timer propio que pueda
  dispararse ya dentro de un overlay o morir con el iframe) y evalúa el gate en ese momento; la
  última edición de trabajo ya está en el host cuando se pide un overlay. Un write fallido al aplicar
  un merge conserva las decisiones del usuario (no re-postea `merge:begin` desde cero).
- Salir de cualquier overlay (incluido "Diff against HEAD" abierto desde time-travel) vuelve
  siempre al estado de trabajo.

**Implementación.** `readOnly` del host es un getter derivado de su estado real
(`pendingMerge` / `mergeUnreadable` → `'merge'`, si no `gitOverlay.kind`), así entrada y salida no
pueden desincronizarse con una bandera aparte. Entrar en time-travel o diff vuelca antes el persist
pendiente del host (la última edición de trabajo llega al disco); el webview no tiene persist
pendiente (postea cada edición al instante). Diff desde time-travel: el host re-envía primero el schema+layout de trabajo y
luego `git:diff:enter` (el diff siempre cubre el working tree). Un reload del watcher o de una
operación git (stash/revert) durante un overlay se marca `reloadDeferred` y se aplica al salir;
el host postea el `exit` **al final** (schema → layout → `merge:begin` si apareció → exit), así el
webview nunca queda editable con la revisión pasada. Ese layout (y el que precede a un diff abierto
desde time-travel) va como `layout:external-change` sólo si el texto del sidecar cambió desde la
última vez que el host lo vio; si no, `layout:loaded` — el webview conserva el historial de undo
guardado al entrar (spec 11, F76). Un webview recargado durante un diff recibe
el diff **recalculado** (el working tree pudo cambiar); el host lo calcula **antes** de postear el
layout/schema de trabajo, que salen seguidos del `git:diff:enter`: si no, el webview fresco quedaba
editable mientras el host descartaba sus persists.

Las transiciones de overlay (entrar/salir de time-travel o diff, y el `ready` de hidratación) se
**serializan** en el host: un doble click en *Exit* hacía que el segundo exit se posteara antes de
que el primero enviara el estado de trabajo, desbloqueando la revisión pasada; el siguiente drag
escribía esa revisión sobre el sidecar. Un exit sin overlay activo (repetido, o un merge que ya
tomó el control) no postea nada. Además `sendLayout` descarta el persist pendiente: lo que el webview
va a mostrar es la verdad, y un persist aceptado contra lo que mostraba antes no puede sobrevivirle.
Si el host descarta un `layout:persist` por el gate, al salir del overlay re-envía el layout aunque
no haya otro cambio, así la edición descartada se revierte a la vista en vez de quedar como guardada.

## Modelo de datos / tipos afectados

`src/shared/types.ts` (todo plano y serializable; `null` en vez de `undefined`):
`GitFileStatus`, `GitPathStatus`, `GitCommitMeta`, `GitStashEntry`,
`GitStatusSummary`, `GitOp`, y los tipos de diff `TableDiffStatus` /
`ColumnDiffStatus` / `RefDiffStatus` / `ColumnDiffEntry` / `TableDiff` / `RefDiff` /
`SchemaDiff`.

Store (`src/webview/state/store.ts`): `gitStatus`, `gitPanelOpen`, `gitBusy`,
`gitStashes`, `gitCommits`, `gitView`, `diffByTable`, `columnDiffByTable`,
`diffBaseByTable` (tabla Previous para el diff inline), `diffGhosts`, `refDiff`,
`diffRemovedRefs`, `focusDimming` (default `true`, compartido con el merge resolver),
`diffCursor` (nav) + acciones (`setGitStatus`, `setGitPanelOpen`, `setGitBusy`,
`setGitStashes`, `setGitCommits`, `enterTimeTravel`, `enterDiff`, `exitGitView`,
`setFocusDimming`, `setDiffCursor`). Helper exportado
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
  `leaveOverlay`, `enterDiff`, `reloadFromDisk`).
- Read-only + overlay on-canvas → patrón de merge (gate `mergeConflicts`,
  `mergeGhosts`). Nuevo: `gitBanner.tsx`, `diffGhosts.tsx`. Diff inline → `tableNode.tsx`
  (`buildDiffRows` + filas `is-diff-add/del`). Cámara → `fitToBbox` (`render/viewport.ts`).
  Blur compartido (`focusDimming`) → `tableNode` (`is-diff-dimmed`) consumido por diff y por
  el merge bar (`mergePanel.tsx`).
- Panel de dos paneles → shell `.ddd-settings__*` (reusado). Primitivos: `Button`
  (variante nueva `danger`), `Modal`, `Field`, `Search`, `Tooltip`; codicons via
  `make()` (`git-commit`, `git-branch`, `history`, `diff`, `archive`).
- Inyección de diff → `tableNode.tsx` (`diffStatus`/`columnDiff` props) y
  `edgeLayer.tsx` (`refDiff` prop) sobre el render path culleado existente.

## Protocolo host↔webview

Namespace `git:`. **Host→Webview:** `git:status`, `git:commitResult`, `git:stashes`,
`git:opResult`, `git:commits`, `git:timeTravel:enter` (lleva schema+layout de la
revisión), `git:timeTravel:exit`, `git:diff:enter` (lleva `SchemaDiff`), `git:diff:exit`.
**Webview→Host:** `git:requestStatus`, `git:commit`, `git:requestStashes`,
`git:restore`, `git:stashPush`, `git:stashApply`, `git:stashPop`,
`git:requestCommits`, `git:timeTravel:enter` (`{sha,label}`), `git:timeTravel:exit`,
`git:diff:enter`, `git:diff:exit`. El *exit* del diff también es un round-trip (decisión
2026-10-01): el host necesita saber que el overlay terminó para volver a aceptar persists, y
responde `git:diff:exit` tras re-enviar el estado de trabajo si quedó un reload diferido.

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
- **Orden del diff de columnas**: las columnas eliminadas se intercalan según el orden de la
  tabla **base**; si la tabla se reordenó mucho entre revisiones el intercalado es aproximado
  (no es un LCS), pero el contenido (qué se añadió/quitó/cambió) es exacto.

## Error handling

Las funciones de lectura de `gitStages` devuelven `null`/`[]` ante error
(best-effort, como `showStage`); las de escritura (`gitCommit`/`gitRestore`/stash)
lanzan y el host reporta vía `git:commitResult`/`git:opResult` + un
`showWarningMessage`/`showErrorMessage`. `git:status` degrada a `inRepo:false` sin
lanzar.

## Performance budget

Cumple [`07-performance-budgets.md`](07-performance-budgets.md) (5000 tablas, pan/zoom
60fps): los mapas de diff cambian de referencia solo al entrar/salir (un re-render de
`App`), las filas de diff inline + props viajan por el `TableNode`/`EdgeLayer` ya culleado
(sin render de detalle paralelo), el `is-diff-dimmed` (opacity + blur) aplica solo a las
tablas **visibles** (el culling acota el set a un screenful, no a las 5000), y el cálculo del
diff (parse de dos revisiones) corre en el host, fuera del render path.

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
