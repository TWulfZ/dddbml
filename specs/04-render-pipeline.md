# 04 — Render Pipeline

## Goals

- 60fps pan/zoom con 5000 tablas.
- Mover tabla individual a 60fps sin recomputar todo.
- Reflejar cambios de schema (reparse del DBML) sin perder posiciones.

## Pipeline

```
Schema update ─▶ positions update ─▶ SpatialIndex rebuild ─▶ visibleNames query ─▶ render tables subset + edges subset
    (infrequent)       (drag / new)      (infrequent)          (per viewport change)  (per frame)
```

### Stages

**1. Schema ingestion** — host parsea DBML, envía `schema:update`. Store sets `schema`. Effect: si hay tablas sin posición, corre dagre auto-layout sólo sobre las nuevas.

**2. Positions** — Map<QualifiedName, {x,y}>. Mutado por:
- Auto-layout inicial (effect post schema:update).
- Drag de usuario (M5).
- Layout file load (layout:loaded).

**3. Spatial index** — grid bucketing 512x512px. Se reconstruye cuando cambian schema, filtros (grupos ocultos/colapsados, tablas ocultas), filas renderizadas o densidad, o cuando `positions` cambia sin un delta conocido (carga de layout, undo, auto-layout masivo). Un frame de drag sólo **mueve** las entradas afectadas (`move`) sobre la misma instancia — ver "Drag incremental". Ver `render/spatialIndex.ts` y `render/sceneCache.ts`.

**4. Viewport culling** — memoized por `viewport × viewportRect × positions × schema`. Query al spatial index con bbox de viewport + margen 256px. Retorna Set<QualifiedName>.

**5. Render** — map sobre `schema.tables` + filter por visibleNames. Edges filtrados: al menos un endpoint visible.

## Spatial Index

**Estructura**:
- `Map<cellKey, Set<QualifiedName>>` — cell key = `"cx,cy"` con cx=floor(x/512), cy=floor(y/512).
- `Map<QualifiedName, string[]>` — membership (keys de celdas donde el nodo está registrado). Permite remove O(c).
- `Map<QualifiedName, Bbox>` — bboxes para filtrado fino durante query.

**Operaciones**:
- `insert(name, bbox)`: calcula celdas, registra en cada una. Si el nombre ya existe, `remove` primero.
- `remove(name)`: lookup membership, borra de cada celda.
- `move(name, bbox)`: alias de insert (que ya hace remove interno).
- `query(bbox)`: recorre celdas que intersecan bbox, acumula nombres, filtra por bbox real.
- `version`: contador que sube en cada mutación. Como el drag muta la instancia en sitio,
  `useVisibleNames` usa `version` (además de la identidad) como clave de su caché de culling.

**Complejidad**:
- insert / move / remove: O(c) donde c = celdas que span el nodo (típico 1-4).
- query: O(k) donde k = nodos en celdas que intersecan viewport (típicamente ≤ visible + frontera).

**Celda de 512px**: tabla típica ~240x200px → ocupa 1-2 celdas. Viewport 1920x1080 a zoom=1 → query cubre ~12 celdas → típicamente <150 nodos candidatos en DBs densas.

## LOD (Level of Detail)

| Zoom | Nivel | Render |
|---|---|---|
| `>= lowThreshold` | `full` | Header + columnas completas con flags |
| `< lowThreshold` | `rect` | Rectángulo coloreado, sin texto; nombre al hacer hover |

Decidido por `lodForZoom(viewport.zoom, settings.lod)` en `render/lod.ts`. Un solo
umbral configurable (`lowThreshold`, default `0.3`) — `full` a zoom normal/in,
`rect` para vista "pájaro" de 5000 tablas (puntos de color agrupados por grupo).

El rectángulo de `rect` se dimensiona con `estimateSize` (métrica de densidad en px), no
por CSS como el nodo `full`. Por eso `TableNode` se suscribe a `settings.ui.density`: si
no, el nodo memoizado conservaba el tamaño de la densidad anterior (al cambiarla o al
abrir con una densidad no-default, ya que `settings:loaded` llega tras el schema) y
desalineaba aristas, contenedores de grupo y spatial index.

> **Un solo modo de detalle (por feedback de usuarios).** El antiguo nivel
> intermedio `header` (sólo la franja del título, sin columnas) se eliminó: aportaba
> poco y duplicaba el umbral. Hoy hay dos niveles y un único `lowThreshold`.

### Etiqueta de nombre al hover en `rect`

En `rect` el nombre no se dibuja (el texto sería ilegible a ese zoom). Al hacer
hover sobre una tabla se revela su nombre como **label en screen-space**, reusando
el slot único `tooltip` del store (`setTooltip`) + el componente `<Tooltip/>` — el
mismo mecanismo que las notas de columna.

**Los grupos** (contenedor expandido y nodo colapsado) ganan la misma etiqueta de
nombre al hover, **sólo en `rect`**, sin cambiar su render. La condición se evalúa
dentro del handler (`lodForZoom(...) === 'rect'`), sin suscripción extra.

**Regla de un solo label (invariante):**
1. El store tiene **un único** slot `tooltip` y `<Tooltip/>` renderiza uno → es
   estructuralmente imposible mostrar dos labels a la vez.
2. Las **zonas** de hover no se solapan: el cuerpo de `GroupContainer` es
   `pointer-events: none` (sólo su franja-label es interactiva), así que al pasar el
   cursor sobre una tabla *dentro* de un grupo dispara el hover de la tabla, nunca el
   del contenedor. El handler del grupo vive en la franja-label, no en el cuerpo.

   Resultado: tabla dentro de grupo → label de la tabla; área vacía / franja-label /
   nodo colapsado → label del grupo.

## Edge rendering

**v1 (M2-M3)**: líneas rectas center-to-center.
**v1 (M4)**: Manhattan ortogonal (ver spec 05).
**v0.2 (perf, miles de relaciones)**: ruteo **memoizado por geometría** (no por
frame) + **route-all-then-cull** + **overlay interactivo sólo para la arista
seleccionada** + **LOD de arista** (recta a `lod === 'rect'`). Detalle: spec 05 §8.

Un solo `<svg>` overlay en el world container (regla dura: nunca un `<svg>` o path
suelto por edge fuera de esta capa). Edge culling:
- El ruteo se memoiza (`[refs, positions, rows, groupSizes, edgeLayouts]`) sobre un
  `EdgeRouteCache` persistente; las posiciones world no cambian en pan/zoom → el ruteo no
  recomputa por frame. Un frame de drag re-rutea sólo las refs afectadas (ver "Drag incremental").
- Cada arista visible es un hijo `memo` (`EdgeStroke` / `DepStroke` en la capa base, `EdgeHit` en
  el overlay, todos `<g>` dentro del **único** `<svg>` de su capa): las rutas que conservan
  identidad no se re-diffean. Sólo la arista seleccionada construye inline su DOM de edición. Los
  hit-paths de deps (`DepOverlay`) no están memoizados: son pocos frente a las refs.
- Se rutean todas las `effectiveRefs`; las *rutas* se filtran por `visibleRefIds`
  (`useVisibleEdgeIds`): una arista es visible si su **caja** (rects de sus dos nodos
  extremo ∪ waypoints ∪ alcance de un self-loop, `edgeBoxes` en `app.tsx`) cruza el viewport +
  margen 256px. Un lazo extiende la caja de su tabla por `loopReach(lazos de la tabla)` del lado en
  que se dibuja (superset: cuenta los lazos de ambos lados; spec 05 §Self-loops). Además
  `EdgeLayer` cullea por su extensión dibujada las rutas que pueden salir de esa caja (C con trunk
  anidado y lazos, `routeReachBoxes`): una arista se dibuja si cualquiera de las dos cajas cruza el
  viewport + margen (spec 05 §8).
  Probar sólo los extremos no basta: una arista entre dos tablas fuera de pantalla
  que cruza el viewport desaparecía y parpadeaba al panear. La caja es un superset
  (una diagonal en `rect` puede no tocar el viewport aunque su caja sí) — renderizar
  de más es aceptable. Escaneo lineal por frame de cámara (no grid: una arista larga
  ocuparía cientos de celdas); re-render sólo si cambia la membresía, como
  `useVisibleNames`.
- `lod === 'rect'`: arista = recta `M source L target`, sin markers/dots/overlay.

## Interacción de canvas (pan + selección)

Los handlers de pointer viven en el `useEffect` de `app.tsx` (sobre `.ddd-viewport`,
fase de bubbling); el drag de tabla vive en `drag/dragController.ts` (sobre el nodo).
El orden table→viewport en bubbling es lo que permite delegar.

### Pan

Tres formas de paneo, todas vía `panBy` (`render/viewport.ts`):
- **Botón central del mouse** (`e.button === 1`) — siempre, sin estado.
- **Toggle "herramienta mano"** — botón junto a los controles de zoom
  (`render/zoomButtons.tsx`, `<Button variant="zoom" active={panMode}>`). Persiste
  hasta volver a pulsarlo. Estado: `panMode` en el store (efímero, no persistido).
- **Mantener `Space`** — override temporal independiente del toggle. Estado:
  `spacePan` (keydown `' '` → `setSpacePan(true)`; keyup / `blur` → `false`). Como es
  navegación (no edición) funciona incluso en overlays read-only (merge/diff).
  - Sólo reclama la tecla si el foco está en el viewport (canvas + sus toolbars) o en
    ningún sitio (`body`), y nunca en un campo de texto. Modales (`<dialog>`) y menús
    portaleados viven fuera del viewport, así que sus botones/radios/selects conservan
    la activación nativa con Space.
  - Cuando la reclama, cancela **todos** los keydown (incluidos los auto-repeat) y el
    keyup final: un repeat sin cancelar arma el botón de toolbar enfocado y el keyup lo
    clickea (un undo / zoom extra al soltar).

`panActive = panMode || spacePan`. Cuando está activo es una **herramienta mano
pura** (decisión de UX): arrastrar en cualquier parte panea, los clicks **no**
seleccionan ni mueven tablas. Implementación:
- `app.tsx onPointerDown`: el paneo sólo arranca si el pointerdown cae en el
  **canvas** — `target === el || target.closest('.ddd-world')`. El chrome flotante
  (barra de zoom, menús, paneles) vive **fuera** de `.ddd-world`, así que la
  herramienta mano nunca le roba el click (si no, no podrías ni apagar su propio
  toggle ni usar los menús). Con `panActive` se omite el marquee.
- `app.tsx onWheel`: el zoom con rueda usa el **mismo** test de canvas
  (`isCanvasTarget`). Sobre el chrome flotante la rueda no se cancela, así las listas
  con scroll (Diagram Views, "Review all" del merge) hacen scroll en vez de hacer zoom.
- `dragController.startDrag`: retorna temprano si `panActive` — **antes** de
  `stopPropagation`, para que el pointerdown burbujee al viewport y este panee.
- Cursor: `.ddd-viewport.is-pan-mode { cursor: grab }` (clase reactiva desde
  `panActive`), `.is-panning { cursor: grabbing }` (imperativa durante el gesto;
  segura porque `panActive` no cambia a mitad de un gesto → Preact no reescribe la
  clase y no borra `is-panning`).

**Foco del teclado.** Los listeners de teclado (Space-pan, undo/redo, Escape) viven
en `window`, que sólo recibe teclas mientras el iframe del webview tiene foco — y
pasar el cursor por el canvas no lo enfoca. Por eso el viewport (con `tabIndex=0`) se
**enfoca en `pointerenter`** (salvo que un input/textarea/contenteditable tenga el
foco), de modo que mantener Space sobre el canvas arma el paneo de inmediato.

### Fit to content

`fitToContent` (Ctrl+1, botón de zoom, comando) encuadra **lo que se dibuja**, no el
schema completo: usa `deriveSceneGeometry` + `sceneBounds` (`render/sceneGeometry.ts`),
los mismos helpers que `App` usa para `derived` y `worldBbox`. Omite tablas ocultas y
miembros de grupos ocultos, usa el nodo de un grupo colapsado en vez de sus miembros e
incluye padding + header del contenedor de grupo expandido. Si todo está oculto, no
mueve la cámara.

### Selección

- **Click simple** sobre una tabla → la selecciona sólo a ella (`setSelection([n])`).
- **Shift-click** → alterna (toggle) la tabla en/fuera del set. Sólo `Shift`
  (consistente con el marquee, que usa `Shift` para sumar).
- **Marquee** (arrastre sobre área vacía) → sin cambios; `Shift` suma al set.
- **Escape** limpia selección y arista seleccionada, **salvo** que cierre un overlay
  (modal `<dialog>`, menú contextual, color popup, menú de app) o venga de un campo de
  texto (p. ej. el `%` de zoom). Se evalúa en fase de *captura* en `window`: los overlays
  se cierran desde sus propios handlers y Preact los desmonta en un microtask antes de
  que un listener en *bubbling* pudiera verlos.
- Click vs drag usa un umbral **latcheado** (`CLICK_THRESHOLD_PX = 4`, screen-px
  desde el press): nada se mueve hasta cruzarlo; la primera vez que se cruza el
  gesto pasa a drag para siempre (mueve, empuja `MoveCommand` aunque vuelva cerca
  del origen). Si nunca se cruzó = click (resuelve selección, sin `MoveCommand`,
  sin desplazamiento residual).
- El delta del drag (tablas y aristas) se mide en **espacio world** desde el punto
  agarrado, no como delta de pantalla / zoom: un zoom con rueda o pan a mitad del
  drag mantiene la tabla bajo el cursor (se re-aplica al cambiar el viewport).
- *Select-on-press*: un press plano sobre una tabla no seleccionada la selecciona ya
  en el `pointerdown`, así un drag mueve sólo a ella; los press aditivos (Shift)
  difieren la decisión al click. El multi-drag (press sobre miembro de una
  multi-selección) mueve todo el set.

## Drag incremental (commit por frame)

**Decisión 2026-10-01 (b)** — ver Preguntas abiertas. Antes cada `pointermove` hacía
`setPositionsBatch` y cada commit rehacía `derived`, el spatial index, las cajas de arista,
`worldBbox` y **ruteaba todas las refs**: ~8 ms de JS por evento en `huge.dbml`.

- **Commit por rAF.** `dragController` sólo guarda el último puntero en `pointermove` (y en
  cambios de cámara); un `requestAnimationFrame` aplica el movimiento: escribe el transform del
  nodo arrastrado y hace **un** `setPositionsBatch`. El umbral click/drag (4 px) se evalúa por
  evento, no por frame (una excursión deshecha dentro del mismo frame sigue siendo drag). El
  `pointerup` cancela el frame pendiente y aplica la última posición antes de empujar el
  `MoveCommand`. Un frame que llega con el canvas ya en solo lectura (overlay merge/git) no
  escribe, y el `pointerup` no empuja comando ni persiste; si algún frame ya se había commiteado
  antes del bloqueo, el `pointerup` devuelve esas tablas a su origen (sin entrada de undo: sin esto
  el movimiento quedaba en el store sin poder deshacerse y se colaba al sidecar con la siguiente
  edición). Sólo revierte las entradas que siguen siendo las que escribió el drag (identidad del
  objeto): un time-travel que cargó su propio layout entretanto se respeta.
- **Delta de posiciones.** `setPositionsBatch`/`setTablePos` registran en
  `state/positionsDelta.ts` qué nombres cambiaron entre el `Map` previo y el nuevo (versiones en
  un `WeakMap` + log acotado de 16 entradas: no retiene mapas viejos). `positionsMovedSince(prev,
  next)` une los deltas encadenados (varios commits entre dos renders) o devuelve `null` si el
  linaje es desconocido (carga de layout, undo, reset) → rebuild completo. `smallPositionsDelta`
  además devuelve `null` si se movió más de ¼ de las tablas.
- **Escena incremental (`render/sceneCache.ts`).** `SceneCache.update` reemplaza los memos de
  `App` (`derived`, spatial index, `edgeBoxes`, `worldBbox`). Si sólo cambió `positions` por un
  delta pequeño de tablas **renderizadas** (no ocultas ni miembros de grupo colapsado):
  - recalcula sólo el contenedor de los grupos expandidos tocados (`groupContainerRects`,
    el mismo helper que `deriveSceneGeometry`) y su gemelo de export;
  - `SpatialIndex.move` para las tablas movidas y sus contenedores (misma instancia);
  - re-calcula sólo las cajas de las aristas (refs y deps visibles, spec 18) que tocan una tabla
    movida;
  - `worldBbox`: une los rects nuevos; re-escanea todo sólo si un rect movido sostenía un lado
    del bbox y ya no lo alcanza (encogimiento).
  - `effectiveRefs`, `effectiveDeps`, `collapsedNodes`, `hiddenTables`/`collapsedTables`
    conservan identidad.
  `showDeps` es un input más de la escena: apagarlo quita las cajas de las deps (rebuild
  completo; es un toggle, no un frame).
  Cualquier otro cambio (o un delta que toca una tabla oculta/colapsada) cae al rebuild completo,
  cuyo resultado es idéntico (test de equivalencia aleatorio en `sceneCache.test.ts`). Un cambio
  sólo de `edgeLayouts` (edición de waypoints) reutiliza geometría e índice y rehace cajas/bbox.
- **Re-ruteo incremental (`EdgeRouteCache`, `render/edgeRouter.ts`).** Con `refs`, `rows`,
  `groupSizes` y `edgeLayouts` idénticos y un delta pequeño, `routeMoved` re-rutea: (1) las refs
  con un extremo en el conjunto movido (lados recalculados) y (2) toda ref que comparte un
  **grupo de puertos** (tabla + lado) — antes o después del movimiento — con una de ellas y cuyo
  ratio cambió: el orden baricéntrico del grupo depende del extremo lejano, así que mover una
  tabla puede reordenar/re-espaciar los stubs de sus vecinas. El resto de rutas conserva
  identidad. El orden del grupo desempata por id de ref y luego por (índice de arista, origen
  antes que destino), así el re-sort incremental coincide con el completo.
  **Lazos y carriles cedidos (spec 05 §Self-loops, 2026-10-05).** Con consulta de obstáculos y al menos
  una pila de lazos, cada frame sigue el orden de `routeAll`: (1) decisiones base de las refs de las
  tablas movidas; (2) room por vecino de **todas** las pilas (una consulta al índice por pila: una caja
  de grupo colapsado cambia sin que su nombre esté en el delta), y alcance/envolvente previos;
  (3) los reclamos de las Z cuyo carril se movió (refs de tablas movidas) o toca la banda vieja o nueva
  de una pila cuya tabla se movió o cuyas envolventes previas cambiaron; las bandas (superset de toda
  envolvente posible de la pila) viven en un arreglo ordenado por x con búsqueda binaria, y los carriles
  dibujados en un índice por x (`LaneGrid`), así nunca se recorren aristas × lazos; (4) alcance final de
  todos los lazos (aritmética O(lazos), sin consultas); los lazos que cambian entran como afectados y
  las Z cuyo reclamo cambió se re-dibujan. Las Z cuyo carril toca una envolvente final que cambió se
  re-rutean por el mismo índice de carriles. Sin pilas el camino es el de antes (cero costo extra).
  Test: `routeMoved` == rebuild en 400 drags (`edgeRouter.loopNeighbours.test.ts`).
- **Deps (`DepRouteCache`, `render/depRouter.ts`).** Una dep no reparte puertos con nadie: su ruta
  depende sólo de sus dos rects y sus waypoints. Con `deps`, `rows`, `groupSizes`, `edgeLayouts` y
  densidad idénticos y un delta pequeño, `routeMoved` re-rutea sólo las deps con un extremo
  movido; el resto conserva identidad (y `DepStroke` no se re-diffea).
- **Coste medido** (`render/dragFrame.perf.test.ts`, `huge.dbml` 5000 tablas / 1000 refs, 20
  grupos expandidos; commit + escena + ruteo + las dos consultas de culling, sin Preact ni
  paint): antes ~7.7–10 ms/frame; ahora ~0.55–0.8 ms/frame (1 tabla) y ~0.7–0.8 ms (50 tablas).
  El resto es la copia del `Map` de 5000 posiciones del store (~0.5 ms). Con 1000 deps
  sintéticas además de las 1000 refs: rebuild ~13–15 ms/frame, incremental ~0.55–0.85 ms (1 y 50 tablas);
  el ruteo de las 1000 deps solo cuesta ~1.6 ms completo frente a ~0.01 ms incremental. Con ~1550
  lazos sintéticos en ~1050 pilas y ~1000 Z que pasan a su lado (> 500 reclamos activos): rebuild
  ~34–42 ms/frame (antes de los reclamos ~48–51), incremental ~2.2–2.7 ms (1 tabla, antes ~2.7) y
  ~3.5–4.6 ms (50 tablas; 5883c33 medido lado a lado ~4.4–4.7: el barrido O(rutas × envolventes
  cambiadas) se reemplazó por el índice de carriles). Lo que queda es la consulta de vecinos por pila (~1.2 ms) y el re-anidado
  completo, ambos previos a los reclamos. Ver spec 07.

## Cámara fuera de Preact (pan/zoom sin re-render)

**Problema (2026-09, reportado con esquemas grandes):** `App` seleccionaba `s.viewport` y
`setViewport` creaba un objeto nuevo por llamada; `panBy` lo llama en cada `pointermove`.
Resultado: **todo el árbol** (tablas visibles, `EdgeLayer`, menús flotantes, modales cerradas)
re-renderizaba por frame de pan/zoom. Con miles de tablas/refs el hilo principal se saturaba y,
al agotarse el presupuesto de la GPU, Chromium evictaba tiles de todo el proceso → el chrome
flotante "desaparecía o se partía".

**Diseño vigente:**
- **`App` no se suscribe a `viewport`.** Sólo a su proyección LOD
  (`useAppStore(s => lodForZoom(s.viewport.zoom, s.settings.lod))`, un string estable).
- **Transform imperativo.** Un `useEffect` hace `store.subscribe` y escribe
  `worldRef.current.style.transform` cuando cambia `viewport` — la misma técnica que el drag.
  El nodo `.ddd-world` se engancha con un *callback ref* (`attachWorld`) que aplica la cámara
  actual en el commit, antes del paint: con un `useEffect` post-paint el primer frame tras
  montar (o tras "Retry" del boundary) se pintaba a escala identidad.
  `.ddd-world` **no** recibe `style` desde JSX (si lo recibiera, Preact re-aplicaría el valor
  viejo en cada render).
- **Culling estable: `useVisibleNames`** (`render/useVisibleNames.ts`). Se suscribe al store
  fuera de Preact, consulta el spatial index y **devuelve la misma instancia de `Set`** mientras
  la membresía no cambie. Sólo fuerza render de `App` cuando una tabla entra o sale del
  viewport (+ margen 256 px). Las aristas usan el mismo mecanismo (`useVisibleEdgeIds`). Así
  `visibleRefIds` → `visibleRoutes` → vnodes SVG se cachean entre frames. Recalcula sincrónicamente si cambian `spatialIndex` (identidad o `version`: el drag lo muta en sitio), `viewportRect` o `ready`.
- **`setViewport` con identity guard:** una cámara sin cambios no notifica (mismo patrón que
  `setHoveredTable`).
- **Lo único que sigue la cámara en `App` es el `%` del statusbar**, aislado en el leaf
  `ZoomPct` (selector primitivo). `ZoomButtons` selecciona `s.viewport.zoom`, no el objeto.
- **`memo()` como cortafuegos.** `TableNode`, `EdgeLayer`, `GroupContainer`,
  `CollapsedGroupNode`, `AppMenu`, `GroupPanel`, `ZoomButtons`, `ActionsPanel`, `SettingsPanel`,
  `GitPanel`, `ExportModal`, `MergePanel`, `EdgeOrderProgress` están envueltos en `memo`
  (`preact/compat`, ya en bundle por `createPortal`): un render de `App` por otro slice
  (selección, hover, tooltip) ya no arrastra al chrome ni a las modales cerradas. Cada uno
  sigue re-renderizando por **sus propias** suscripciones. Las props que llegan desde `App`
  deben ser estables (primitivos o memos) — `edgeRefDiff` se memoiza por eso.
- **Listeners del canvas** (`app.tsx` effect de pointer/teclado) dependen sólo de `[ready]`;
  el spatial index se lee por `ref` en el `pointerup` del marquee. Antes dependía de
  `spatialIndex` → 10 listeners se re-ataban y el estado del gesto se reseteaba en cada
  cambio de posiciones.

## Capas compositadas (GPU)

**Regla:** un único layer compositado para el mundo (`.ddd-world { will-change: transform }`);
tablas, contenedores de grupo, nodos colapsados y ghosts se posicionan con `translate(x, y)`
**2D** y pintan dentro de ese layer.

**Por qué (2026-09):** los nodos usaban `translate3d(x, y, 0)`. En Blink una transformación 3D
es *direct compositing reason*: cada tabla visible se convertía en su propio layer con
textura propia, re-rasterizado en cada cambio de escala (zoom). Con cientos de tablas
visibles el presupuesto de memoria GPU se agotaba y Chromium evictaba tiles de **todo el
proceso** — el chrome flotante (fuera de `.ddd-world`) desaparecía o se pintaba a pedazos. Con
2D, el mundo es un layer tileado: al panear sólo cambia su transform (sin re-raster), y al
zoomear se re-rasterizan sólo los tiles visibles. El único nodo que gana `will-change`
temporalmente es el que se arrastra (`dragController` lo pone en `startDrag` y lo limpia en
`pointerup`).

**Superficies world-size (SVG de aristas, `.ddd-grid`).** Siguen dimensionadas al bbox
completo del mundo (`worldBbox`: escena dibujada ∪ cajas de las aristas dibujadas —waypoints y lazos—, + 400
de margen; sin los waypoints, un tramo deslizado más allá de la tabla más externa se
recortaba junto con su handle). Al no estar promovidas viven dentro del layer tileado del mundo, por lo
que su tamaño no crea texturas gigantes; el coste es sólo de *paint records*. Si la medición
en DevTools → Layers sigue mostrando presión de memoria tras este cambio, el siguiente paso
es acotar esas superficies al rect visible cuantizado (Preguntas abiertas).

## Error boundaries

Preact no tiene boundary por defecto: una excepción durante el diff **aborta el commit** y
los hermanos que se diffean después del subárbol que lanzó quedan a medio actualizar. Como
el chrome flotante (`AppMenu`, `GroupPanel`, `ZoomButtons`, …) es hermano posterior de
`.ddd-world`, cualquier throw en `EdgeLayer`/`TableNode` dejaba los menús "a pedazos" y sin
diagnóstico. `App` monta tres `ErrorBoundary` (`ui/ErrorBoundary.tsx`): `canvas`
(`.ddd-world`), `toolbars` (chrome dentro del viewport) y `overlays` (modales, tooltip,
progreso). Cada uno confina el fallo, lo envía al host por `error:log` con el scope, y ofrece
"Retry" (re-monta el subárbol). No sustituye a arreglar la causa: convierte un síntoma visual
en un stack trace en el Output del host.

## Preguntas abiertas (Open Questions)

- [x] **Commit del drag por frame vs. en `pointerup`.** **Decisión (2026-10-01): (b)** — commit por
  rAF, spatial index actualizado incrementalmente (`move`) y re-ruteo sólo de las refs con un
  extremo en el conjunto arrastrado (más las que comparten lado de puerto con ellas, para que los
  stubs sigan bien repartidos); las aristas siguen a la tabla en vivo. **Implementado** — ver
  "Drag incremental (commit por frame)". Contexto original: Este spec dice "mutación DOM directa
  durante drag, commit al store al `pointerup`", pero `dragController` hace `setPositionsBatch`
  en cada `pointermove` (así las aristas siguen a la tabla en vivo). Cada commit rehace
  `derived`, el spatial index, `worldBbox` y **rutea todas las refs** (`routeRefs`). Opciones:
  (a) volver al spec — aristas congeladas durante el drag, commit único; (b) commit por rAF +
  ruteo incremental sólo de las refs cuyos extremos se movieron. **Decidir con el usuario**;
  no es el síntoma de pan/zoom que se corrigió en 2026-09.
- [x] **Persistir la cámara en pan/zoom.** — **Decisión 2026-10-01 (F26, spec 03 "Cámara"):**
  una suscripción al store en `persistence.ts` postea `viewport:persist` 300 ms después del
  último cambio de `viewport` (cualquier origen: rueda, paneo, botones, fit, tween). Mensaje
  propio, no `schedulePersist`: ese postea el layout entero (caro con 5000 tablas) y está
  bloqueado en solo lectura; la cámara es personal y se guarda también en overlays/merge. El
  host la escribe sólo en el view-state local. `setLayout` adopta el `viewport` del host sólo
  la primera vez (`cameraAdopted`); los pushes posteriores conservan la cámara viva. (Antes
  este punto decía que los botones de zoom persistían: sólo undo/redo lo hacían.)
- [ ] **Acotar las superficies world-size** (SVG de aristas, `.ddd-grid`) al rect visible si la
  medición en DevTools → Layers sigue mostrando presión de memoria tras el cambio a 2D.

## Rendering framework decisions

- **Preact** no React: bundle más chico, compat aliases en vite para zustand.
- **`useAppStore(selector)`** sobre zustand vanilla (hook propio con `Object.is`): selectores granulares → solo los componentes que miran el slice afectado re-renderizan. **Nunca un selector que devuelva objeto/array/Set nuevo** (siempre "cambia").
- **Drag con commit por frame**: transform del nodo arrastrado escrito directo + un commit al store por `requestAnimationFrame`, aplicado incrementalmente a escena, índice y ruteo (ver "Drag incremental").
- **`transform: translate(x, y)` (2D) en los nodos; sólo `.ddd-world` lleva `will-change: transform`.** Ver "Capas compositadas".
- **SVG overlay único**: reduce DOM node count vs un `<svg>` por edge.

## Performance budgets

Ver `07-performance-budgets.md` para targets numéricos y fixtures de benchmark.

## Anti-patterns a evitar

- **Re-render full tree en cada pan/zoom frame**: fatal a 5000 tablas. Por eso la cámara vive fuera de Preact (ver "Cámara fuera de Preact"), culling con `Set` estable y `memo()` en los hijos. **Nunca** volver a seleccionar `s.viewport` desde `App` ni pasar el transform por `style`.
- **Uso de `width`/`left`/`top`** para posicionar tablas: causa layout. Usar `transform`.
- **Rebuild spatial index en cada pan**: sólo cuando posiciones cambian (raro).
- **Recomputar dagre completo en cada frame**: sólo al cambio de schema para tablas sin posición.
- **SVG con un path por edge dentro de cada tabla**: causa N svgs anidados. Un solo overlay padre.
