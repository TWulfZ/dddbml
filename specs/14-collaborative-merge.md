# 14 — Fusión colaborativa del layout (merge 3-way in-extension)

## Propósito

Permitir que varios devs editen el mismo diagrama bajo Git sin que el sidecar de
layout produzca diffs ingestionables ni conflictos de merge a mano. La extensión
resuelve los conflictos del sidecar automáticamente cuando son inequívocos y
reduce el resto a una decisión humana simple y correcta — **sin ninguna
configuración manual de Git** (sin merge driver, sin `.gitattributes`, sin setup
por-clon). Instala y funciona.

## Contexto

El sidecar `<archivo>.dbml.layout.json` es un mapa plano keyed por identidad
estable (tabla = nombre qualified, grupo = nombre, arista = ref id). Antes:

1. Mezclaba view-state personal (`viewport`, `hidden`, `collapsed`) con diseño
   compartido → conflicto garantizado en cada commit. **Resuelto en
   `specs/03`** sacando el view-state a un archivo local (Tier 0).
2. El merge por-líneas de Git convierte movimientos disjuntos en un muro de
   conflictos falsos: tablas que nadie cambió caen en hunks `<<<<<<<` por estar
   pegadas a líneas que sí cambiaron.

Caso real medido: ~115 tablas, ~300 líneas de marcadores, pero los dos devs
trabajaron en regiones **disjuntas** — sólo **2 tablas** (`public.institution`,
`public.institutional_units`) fueron movidas por ambos. El resto (≈113 tablas +
grupos + aristas) eran conflictos falsos.

## Preguntas abiertas

- **Tier 3 (resuelto con el usuario, 2026-05-30).** Decidido vía `AskUserQuestion`:
  (a) tablas → fantasmas en lienzo; grupos/aristas → filas mía/suya en la barra
  (no se renderizan fantasmas de grupo/arista — diferido si se pide). (b) bloqueo
  **read-only con pan/zoom** (no fully-locked). (c) commit **batch**: los clicks
  son en memoria revertibles; un solo *Apply* escribe + `git add` una vez. La UI
  reemplaza al QuickPick nativo (que además tenía el bug de auto-destrucción).
- **"Keep both" descartado para tablas.** Una tabla es una identidad única con una
  posición; "quedarse con ambas" es incoherente (no se puede duplicar la key). La
  UI ofrece sólo *mía* / *suya*. Si en el futuro permite duplicar/renombrar, se
  reconsidera.
- **Ambos corren auto-arrange.** Si los dos reordenan todo, *cada* tabla es
  conflicto real → cientos de items. Mitigación presente: aceleradores
  `Resolve ALL as mine/theirs` que cortocircuitan el loop. `auto-arrange` queda
  como está (decisión del usuario); determinismo diferido.
- **`git add` automático.** Se hace sólo del sidecar, sólo tras escribir el archivo
  limpio, y sólo si el usuario no canceló. ¿Suficiente o pedir confirmación? Por
  ahora: automático (el usuario pidió que resuelva solo).

## Diseño

### Disparo

El watcher del sidecar (`panel.ts setupWatchers`/`onLayoutFs`) ya detecta cambios
externos (p.ej. tras un `pull`/`merge`). `readLayout` detecta marcadores de
conflicto y lanza `LayoutConflictError` (en vez de borrar el layout). El caller
(`loadSharedLayout`) enruta a `detectSidecarConflict`.

> **Bug corregido (2026-05-30): el diálogo se perdía para siempre.** El QuickPick
> interino escribía un archivo **limpio (sin marcadores) sesgado a `ours`** en
> cuanto el usuario lo cancelaba (Escape / click afuera). En la siguiente apertura
> `readLayout` ya no veía marcadores → `LayoutConflictError` nunca se lanzaba → el
> resolver no volvía a correr: **el diálogo de resolución se auto-destruía**. La UI
> de fantasmas lo arregla estructuralmente: **no se escribe NADA hasta que el
> usuario aplica** (sección siguiente). Si cierra el panel a medias, el sidecar
> conserva sus marcadores → reabrir re-dispara el resolver. El `git add` sigue
> ocurriendo sólo tras una resolución completa.

### Motor (stage-reader, solo lectura de Git)

`mergeResolver.resolveSidecarConflict` (orquestación) + `gitStages` (wrappers
`child_process.execFile('git', …)`):

1. `git rev-parse --show-toplevel` → repo root (también: "¿es repo?"). Si no hay
   repo → throw; el caller conserva el layout en memoria y avisa (no borra).
2. `git ls-files -u -- <relpath>` → qué stages 1/2/3 existen.
3. `git show :1:/:2:/:3:<relpath>` → las **tres versiones limpias** (JSON sin
   marcadores). Stage ausente (p.ej. add/add no tiene `:1:`) → `emptyLayout()`.
4. `mergeThreeWay(base, ours, theirs)` (puro, `mergeThreeWay.ts`): por sección
   (tables, groups, edges) y por key:

   | base | ours | theirs | resultado |
   |---|---|---|---|
   | A | B | A | B (sólo yo cambié) — auto |
   | A | A | C | C (sólo él cambió) — auto |
   | A | B | B | B (ambos igual) — auto |
   | A | B | C | ⚠️ **conflicto** → QuickPick (provisional = ours) |

   `eq` = deep-equal estructural (waypoints comparan orden). Cubre add/add
   distinto (base ausente) y editar-vs-borrar como conflicto.
5. Conflictos → QuickPick nativo (abajo). Diseño compartido ya resuelto se aplica
   en silencio.
6. `writeSharedLayout` escribe el sidecar limpio (forma compartida). Si no se
   canceló: `git add -- <relpath>` (nunca `add -A`). `viewport` y demás view-state
   se re-aplican desde el archivo local al postear (`applyViewState`).

### Resolución en webview (fantasmas — Tier 3)

El motor (stages + `mergeThreeWay`) **se queda en el host** (sólo el host puede
leer el índice de Git — misma regla que el parser). La **UI** vive en el webview.
Sólo el host escribe el sidecar. Flujo:

1. **Host detecta** (`detectSidecarConflict`): lee stages, corre `mergeThreeWay`,
   obtiene `merged` (provisional, sesgado a `ours`) + `conflicts[]`. Si
   `conflicts.length === 0` → auto-merge: escribe limpio + `git add`, devuelve
   `merged` (sin UI, como antes). Si `> 0` → **no escribe** (conserva marcadores),
   guarda `pendingMerge = { conflicts, repoRoot, relpath, merged }`, devuelve
   `merged` para que el diagrama tenga contexto espacial.
2. **Host postea** `merge:begin { conflicts }` (tras `schema:update`, para que el
   webview pueda dibujar las tablas fantasma). Cada conflicto serializado:
   `{ id: '<section>::<key>', section, key, ours, theirs }` con los lados
   `TableLayout | GroupLayout | EdgeLayout | null` (`null` = ausente/borrado — no
   se usa `undefined`: el `postMessage` de VS Code lo dropea). El host **retiene**
   los `MergeConflict` originales para aplicar; el webview sólo decide.
3. **Webview = modo conflicto bloqueante.** Mientras `mergeConflicts != null` el
   diagrama es **read-only**: pan/zoom sí (para ubicar cada conflicto), pero **no**
   selección / marquee / drag / edición / **undo-redo** / **auto-arrange** /
   persistencia. Regla del usuario: no se accede al diagrama hasta resolver. El
   gate es **defensa en profundidad** (se ataja en el origen, no sólo en la UI):
   `schedulePersist`, `store.undo/redo`, `runSmartLayout` y el handler de teclado
   (Ctrl+Z/Y) checan `mergeConflicts` y hacen no-op; el `ActionsPanel` se **oculta**;
   el marquee de `app.tsx` se salta. Así ningún botón ni atajo muta el layout
   provisional (que se descartaría al aplicar). El host además: (a) **no re-postea**
   `merge:begin` si el set de conflictos no cambió (firma por ids) → un watcher que
   dispara doble no borra las decisiones del usuario; (b) un `git pull` que cambia el
   set sí refresca (avisa); (c) `mergeResolving` evita Apply concurrentes (doble
   escritura/stage).
   - **Tablas** (con `(x,y)`): se ocultan sus `TableNode` normales y se dibuja la
     **tabla completa** (header + columnas, como en el diff view de spec 16) en cada
     posición candidata (@ours y @theirs), en coords world. **Sin etiquetas
     mine/theirs en el canvas** — la barra ya dice cuál es current vs incoming; el
     fantasma solo muestra la tabla tal cual está compuesta, en sus 2 posibles
     posiciones (mejor UX que un contorno + label). **Hover = preview, click =
     decide** (regla UX: no fiar acciones importantes sólo al hover). Hover/elegido →
     opacidad llena + ring `--ddd-accent`; el otro → atenuado + outline `--ddd-danger`
     (rojizo = "se descarta"). Revertible hasta *Apply*. Un lado que **borra** la
     posición (sin tabla que dibujar) muestra un chip compacto en vez de duplicar la
     otra posición.
   - **Grupos / aristas** (sin posición): filas mía/suya en la barra de conflictos
     (swatch de color para grupos; "ruta mía/suya" para aristas).
   - **Barra persistente:** `N conflictos · M resueltos`, **Resolver todo como
     mía** / **Resolver todo como suya** (bulk = llena las decisiones, **revertible**
     —no destruye nada por sí solo) y **Apply** (habilitado sólo con los `N`
     resueltos; es el **único** paso que escribe — descarta el lado perdedor sólo
     aquí, y es recuperable vía Git). Sin confirm extra: cada pick es deliberado y
     revertible hasta Apply.
4. **Apply:** el webview postea `merge:resolve { decisions: Record<id,'ours'|'theirs'> }`.
   El host mapea cada `id` → su `MergeConflict` retenido, `applySide(merged, c,
   side)`, **escribe limpio** (`writeSharedLayout`), `git add`, actualiza
   `lastWrittenSerialized`, limpia `pendingMerge`, postea `layout:loaded` (final,
   con view-state re-aplicado) y `merge:done`. El webview sale del modo conflicto
   en `merge:done`.

### Foco: atenuar el fondo (compartido con el diff de spec 16)

La cabecera de la barra incluye un toggle **"Blur background tables"** (on por defecto, store
`focusDimming`, el mismo flag que usa el diff de [`16-git-integration.md`](16-git-integration.md)):
atenúa + desenfoca (`is-diff-dimmed`) las tablas que **no** están en conflicto para enfocar los
fantasmas/conflictos. Solo afecta a las tablas visibles (culling).

### Dos vistas + foco de cámara por diff (stepper)

**Chrome compartido (ambas vistas, ancho fijo):** la barra tiene **ancho fijo**
(`min(420px, …)`) y un `__body` con `min-height` → alternar vistas **no salta**
(ni horizontal ni mucho vertical). Cabecera: título "Layout merge" (**sin** conteo) +
**píldora** `R/N resolved` — única región `aria-live="polite"` y **único** lugar donde se
muestra el número de conflictos. Debajo, **barra de progreso** token (`.ddd-merge-progress`
con `--ddd-merge-pct`; `--ddd-accent` → `--ddd-success` al 100% vía `[data-complete]`) y el
toggle segmentado `[Review all | Step through]` (`role=tablist/tab/aria-selected`). **Footer
único** en ambas vistas: dos botones bulk **compactos de 2 líneas** — "All" sobre el glifo de
marcador git (`<<<` current / `>>>` incoming), con la acción completa en el `Tooltip`
("Keep all current" / "Take all incoming") — y `Apply` a la derecha. `Apply` ya **no** lleva el
número: abre un **diálogo de confirmación** (`Modal`) que es el **único** sitio donde se reanuncia
el conteo (`Apply (N)`) — así no se contamina la UI repitiendo el número. El gate
`allResolved && !applying` se define una vez en `MergePanel`.

**Nombres estilo git:** los lados se rotulan **current** (ours/HEAD) e **incoming** (theirs),
no "mine/theirs", para reusar el modelo mental de un conflicto del editor. Las claves del store
siguen siendo `ours`/`theirs`; sólo cambian las etiquetas (`SIDE_LABEL` en `mergePanel.tsx`).

**Afordancia elegido/descartado:** el elegido se marca **sólo** con el relleno accent propio del
`<Button variant="action" active>` (**sin** ícono de check — el fondo ya lo dice). El descartado
(hay decisión y no es este lado) va con el CAP tachado + `--ddd-danger` y valor/swatch atenuados —
todo en **spans hijo** (`.ddd-merge-side__cap/__pos`), nunca en el bg/borde del botón (utilidades
Tailwind en `@layer utilities` ganarían sobre `@layer components`; por eso no hay `tailwind-merge`).

- **Review all:** hint (sin número) + filas grupo/arista; las tablas se eligen en el lienzo con
  los fantasmas. Bulk + Apply en el footer compartido.
- **Step through (`mergeStepper.tsx`):** un conflicto a la vez (`mergeCursor`), `i / N` (sin ✓),
  etiqueta del conflicto, y picks **current/incoming con la posición apilada debajo del nombre**
  (`X:… Y:…`, ahorra ancho). **Navegación sólo-chevron** — `<Button variant="history" size="tool">`
  con `<IconChevronRight flipX/>` (prev) / `<IconChevronRight/>` (next), cada uno en
  `<Tooltip placement="bottom">` (sin texto; dispara también en focus). El **riel de orbes**
  (`.ddd-merge-rail` → `.ddd-merge-dots`): cada orbe es un `<button>` con **padding transparente** que
  envuelve el círculo visible (`.ddd-merge-dot__orb`); con `gap:0` los hit-box **tilean** todo el ancho,
  así clickear el espacio entre orbes ya selecciona (no hay que acertar el círculo de 8px). Hover →
  borde accent del orbe; **clickable** salta a ese conflicto (`setMergeCursor(i)`); se colorea por el
  lado resuelto con los colores git del editor (`--ddd-merge-current/incoming`; gris hueco = sin
  resolver); cursor = orbe **escalado + borde accent** (distinto del anillo de `:focus-visible`).
  **Overflow:** por defecto **una fila con scroll horizontal** (alto constante; el orbe activo se
  auto-centra con `scrollIntoView` en cada next/prev); un **toggle de expandir** (sólo si hay >28
  orbes) cambia a la **grilla completa** envuelta, con alto tope + scroll vertical. El `__pos` central
  **no** es `aria-live` (lo es la píldora).
  - **Cámara enfoca el diff sólo en next/prev** (decisión del usuario: el zoom en
    *hover* marea y pelea con el pan). Un `useEffect([mergeCursor])` arma el bbox de
    los dos fantasmas (`estimateSize` + `(x,y)`) y llama `focusDiff` (`viewport.ts`):
    **encuadra ambos** + padding; si quedaran demasiado lejos para caber sobre un
    piso de zoom, **centra el midpoint a un zoom cómodo** ("fit both, clamped").
    `animateViewport` hace un tween rAF (easeOutCubic, ~220ms) cancelable; respeta
    `prefers-reduced-motion` (salto instantáneo). Sólo para conflictos de **tabla**
    (grupo/arista no tienen posición → sin movimiento).
  - **Cross-highlight:** el hover se comparte vía `mergeHover` en el store (sacado
    del estado local de `mergeGhosts.tsx`). Hover de un botón current/incoming ilumina su
    fantasma con el **mismo** efecto que el hover directo, y el fantasma ilumina el
    botón (`.ddd-merge-cross`). **El hover nunca mueve la cámara.**
  - **Pick = decide + auto-avanza** al siguiente conflicto sin decisión (`mergeStep`
    implícito vía `setMergeCursor`), así resolver en cadena es rápido.

## Casos borde

- **No-repo + marcadores** (≈imposible, los marcadores vienen de Git): throw →
  caller conserva el layout actual y avisa; **no** borra el archivo.
- **Stage faltante**: add/add (sin `:1:`), edit/delete (un lado ausente) → tolerado
  por `mergeThreeWay` vía `undefined`.
- **Loop del watcher**: tras escribir el resuelto, `lastWrittenSerialized` se
  actualiza a la serialización compartida → el watcher dedupea. Si re-dispara, el
  archivo ya está limpio → idempotente, sin loop.
- **Un panel por `dbmlUri`** (`DiagramPanel.panels`) → sin carrera intra-ventana.

## Pruebas

- `mergeThreeWay.test.ts`: matriz completa (only-ours, only-theirs, both-equal,
  conflicto, add/add, edit/delete, both-deleted) + el caso institution (disjunto
  auto-merge, sólo el solapamiento conflicta) + `deepEqual`.
- `mergeResolver.test.ts`: `toSerializableConflicts` mapea `undefined → null` y
  arma `id = '<section>::<key>'`; `applyResolvedConflicts` aplica un
  `Record<id,'ours'|'theirs'>` sobre el `merged` provisional (ours/theirs/borrado),
  e ids faltantes caen a `ours` (sesgo provisional). Puro, sin vscode/git en el test.
- `store.merge.test.ts`: `beginMerge` entra al modo; `setMergeDecision` /
  `setMergeDecisionsBulk` llenan `mergeDecisions`; `endMerge` limpia. Conteo
  resueltos = `Object.keys(mergeDecisions).length`. Además: undo/redo no-op en modo
  conflicto; toggle de vista; `mergeStep`/`setMergeCursor` con clamp; `mergeHover`.
- `mergeConflict.integration.test.ts`: arma un repo git temporal (os.tmpdir) donde
  ambas ramas mueven las mismas `N` tablas, mergea → conflicto, y corre el camino real
  (`gitStages` → `mergeThreeWay`) afirmando exactamente `N` conflictos (`N ∈ {3, 20}`);
  el resto auto-mergea. Se salta si no hay `git`.
- **Fixtures manuales (F5):** `node scripts/gen-fixtures.mjs merge 3` y `… merge 20`
  (o `pnpm test:gen:merge`) generan repos conflictuados listos para abrir en el host
  de desarrollo y probar el resolver con 3 y 20 diffs.
- Validación manual de la mecánica Git: en repo scratch, `git merge` divergente →
  `ls-files -u` lista stages 1/2/3; `git show :N:` devuelve JSON limpio. Confirmado
  que el formato `<mode> <sha> <stage>\t<path>` matchea el parser de `gitStages`.
- Manual end-to-end (requiere host VS Code): abrir el diagrama con sidecar
  conflictuado → QuickPick sólo para las tablas realmente en conflicto, resto
  auto, archivo limpio y staged.

## Archivos

- `mergeThreeWay.ts` — motor puro (sin vscode/git).
- `gitStages.ts` — lectura del índice de merge + `git add`.
- `mergeResolver.ts` — `detectSidecarConflict` (detect puro: stages + merge, auto
  cuando no hay conflictos) + `applyResolvedConflicts` (aplica decisiones, escribe,
  `git add`) + `toSerializableConflicts`. **Sin QuickPick** (la UI vive en webview).
- `panel.ts` — `loadSharedLayout` enruta a `detectSidecarConflict`, guarda
  `pendingMerge`, postea `merge:begin`; `handleWebviewMessage` recibe
  `merge:resolve` → `applyResolvedConflicts` → `layout:loaded` + `merge:done`.
- `shared/types.ts` — `SerializableMergeConflict` + mensajes `merge:begin` /
  `merge:resolve` / `merge:done`.
- `webview/state/store.ts` — slice de conflicto (`mergeConflicts`,
  `mergeDecisions`, `mergeApplying`) + acciones.
- `webview/render/mergeGhosts.tsx` — fantasmas de tabla en el lienzo (hover vía `mergeHover`).
- `webview/render/mergePanel.tsx` — barra + toggle de vista (conteo, bulk, Apply, filas grupo/arista).
- `webview/render/mergeStepper.tsx` — vista paso-a-paso (i/N, prev/next, foco de cámara, auto-avance).
- `webview/render/viewport.ts` — `fitToBbox`/`focusDiff`/`animateViewport` (tween rAF, reduced-motion).
- `webview/app.tsx` — gating read-only + render del modo conflicto.
- `webview/persistence.ts` — `schedulePersist` no-op en modo conflicto.
- `scripts/gen-fixtures.mjs` — generador unificado (`small`/`huge`/`merge <count>` → repo git real
  conflictuado bajo `test/fixtures/<count>/`, ya ignorado por git).
- `layoutStore.ts` — `LayoutConflictError`/`hasConflictMarkers`, `readLayout` no
  borra ante marcadores.
