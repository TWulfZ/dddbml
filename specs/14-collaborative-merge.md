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
   - **Tablas** (con `(x,y)`): se ocultan sus `TableNode` normales y se dibujan
     **dos fantasmas** (mía @ours, suya @theirs) en coords world (dentro de
     `.ddd-world`, paneando con el lienzo). **Hover = preview, click = decide**
     (regla UX: no fiar acciones importantes sólo al hover). Hover/elegido →
     opacidad llena + bloom `--ddd-accent`; el otro → atenuado + tinte
     `--ddd-danger` (rojizo = "se descarta"). La decisión es **revertible**
     (re-click del otro fantasma) hasta *Apply*.
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

### Dos vistas + foco de cámara por diff (stepper)

**Chrome compartido (ambas vistas):** cabecera con título + **píldora de conteo**
`R/N resolved` (única región `aria-live="polite"`), debajo una **barra de progreso**
token (`.ddd-merge-progress` con `--ddd-merge-pct`; fill `--ddd-accent`, pasa a
`--ddd-success` al 100% vía `[data-complete]`), luego el toggle segmentado
`[Review all | Step through]` (`mergeView`; `role=tablist`/`role=tab`/`aria-selected`).
Abajo, **un solo footer** (`.ddd-merge-bar__footer`) en **ambas** vistas: bulk
*Keep all mine* / *Take all theirs* + `Apply` (anclado a la derecha; el gate
`allResolved && !applying` se define una sola vez en `MergePanel`; etiqueta
`Apply (R/N)` → `Apply (N)` al completar).

**Afordancia mía/descartada** (filas y picks del stepper): el lado **elegido** usa el
relleno accent propio del `<Button variant="action" active>` + una **marca ✓**; el
**descartado** va con el CAP tachado + tinte `--ddd-danger` y swatch atenuado. Los
colores de descarte viven en **spans hijo** (`.ddd-merge-side__cap/__mark`), nunca en
el bg/borde del botón (esas son utilidades Tailwind en `@layer utilities`, que ganarían
sobre una regla de `@layer components` — el motivo por el que no usamos `tailwind-merge`).

- **Review all:** el contenido all-at-once (hint + filas grupo/arista); las tablas se
  eligen en el lienzo con los fantasmas. El bulk + Apply viven en el footer compartido.
- **Step through (`mergeStepper.tsx`):** un conflicto a la vez (`mergeCursor`),
  `i / N`, etiqueta del conflicto, botones mía/theirs (con coords para tablas) y
  **navegación sólo-chevron** — `<Button variant="history" size="tool">` con
  `<IconChevronRight flipX/>` (prev) / `<IconChevronRight/>` (next), cada uno envuelto
  en `<Tooltip label="Previous"/"Next" placement="bottom">` (sin texto, ahorra espacio;
  el tooltip dispara también en focus de teclado) — `mergeStep(±1)`. Un **riel de puntos**
  (`.ddd-merge-dots`, sin clicks) refleja resueltos/cursor. El `__pos` central **no** es
  `aria-live` (lo es la píldora de cabecera — evita doble anuncio).
  - **Cámara enfoca el diff sólo en next/prev** (decisión del usuario: el zoom en
    *hover* marea y pelea con el pan). Un `useEffect([mergeCursor])` arma el bbox de
    los dos fantasmas (`estimateSize` + `(x,y)`) y llama `focusDiff` (`viewport.ts`):
    **encuadra ambos** + padding; si quedaran demasiado lejos para caber sobre un
    piso de zoom, **centra el midpoint a un zoom cómodo** ("fit both, clamped").
    `animateViewport` hace un tween rAF (easeOutCubic, ~220ms) cancelable; respeta
    `prefers-reduced-motion` (salto instantáneo). Sólo para conflictos de **tabla**
    (grupo/arista no tienen posición → sin movimiento).
  - **Cross-highlight:** el hover se comparte vía `mergeHover` en el store (sacado
    del estado local de `mergeGhosts.tsx`). Hover de un botón mía/theirs ilumina su
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
