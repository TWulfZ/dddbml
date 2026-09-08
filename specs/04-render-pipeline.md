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

**3. Spatial index** — grid bucketing 512x512px. Se reconstruye cada vez que `positions` o `schema` cambia (raro). Ver `render/spatialIndex.ts`.

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
- `routeRefs` se memoiza (`[refs, positions, tablesByName, groupSizes, edgeLayouts]`);
  las posiciones world no cambian en pan/zoom → el ruteo no recomputa por frame.
- Se rutean todas las `effectiveRefs`; las *rutas* se filtran por `visibleRefIds`
  (al menos un endpoint en `visibleNames`). El margen de 256px ya incluye aristas
  que cruzan el borde.
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

`panActive = panMode || spacePan`. Cuando está activo es una **herramienta mano
pura** (decisión de UX): arrastrar en cualquier parte panea, los clicks **no**
seleccionan ni mueven tablas. Implementación:
- `app.tsx onPointerDown`: el paneo sólo arranca si el pointerdown cae en el
  **canvas** — `target === el || target.closest('.ddd-world')`. El chrome flotante
  (barra de zoom, menús, paneles) vive **fuera** de `.ddd-world`, así que la
  herramienta mano nunca le roba el click (si no, no podrías ni apagar su propio
  toggle ni usar los menús). Con `panActive` se omite el marquee.
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

### Selección

- **Click simple** sobre una tabla → la selecciona sólo a ella (`setSelection([n])`).
- **Shift-click** → alterna (toggle) la tabla en/fuera del set. Sólo `Shift`
  (consistente con el marquee, que usa `Shift` para sumar).
- **Marquee** (arrastre sobre área vacía) → sin cambios; `Shift` suma al set.
- Click vs drag se decide en `pointerup` por distancia recorrida
  (`CLICK_THRESHOLD_PX = 4`, screen-px): `< 4` = click (resuelve selección, sin
  `MoveCommand`); `>= 4` = drag (mueve, empuja `MoveCommand`).
- *Select-on-press*: un press plano sobre una tabla no seleccionada la selecciona ya
  en el `pointerdown`, así un drag mueve sólo a ella; los press aditivos (Shift)
  difieren la decisión al click. El multi-drag (press sobre miembro de una
  multi-selección) mueve todo el set.

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
  `.ddd-world` **no** recibe `style` desde JSX (si lo recibiera, Preact re-aplicaría el valor
  viejo en cada render).
- **Culling estable: `useVisibleNames`** (`render/useVisibleNames.ts`). Se suscribe al store
  fuera de Preact, consulta el spatial index y **devuelve la misma instancia de `Set`** mientras
  la membresía no cambie. Sólo fuerza render de `App` cuando una tabla entra o sale del
  viewport (+ margen 256 px). Así `visibleRefIds` → `visibleRoutes` → vnodes SVG se cachean
  entre frames. Recalcula sincrónicamente si cambian `spatialIndex`, `viewportRect` o `ready`.
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
completo del mundo. Al no estar promovidas viven dentro del layer tileado del mundo, por lo
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

- [ ] **Commit del drag por frame vs. en `pointerup`.** Este spec dice "mutación DOM directa
  durante drag, commit al store al `pointerup`", pero `dragController` hace `setPositionsBatch`
  en cada `pointermove` (así las aristas siguen a la tabla en vivo). Cada commit rehace
  `derived`, el spatial index, `worldBbox` y **rutea todas las refs** (`routeRefs`). Opciones:
  (a) volver al spec — aristas congeladas durante el drag, commit único; (b) commit por rAF +
  ruteo incremental sólo de las refs cuyos extremos se movieron. **Decidir con el usuario**;
  no es el síntoma de pan/zoom que se corrigió en 2026-09.
- [ ] **Persistir la cámara en pan/zoom con rueda.** Sólo los botones de zoom llaman a
  `schedulePersist`; `panBy`/`zoomAt` no. Una sesión de sólo navegación pierde la cámara al
  reabrir (spec 03 la guarda en view-state local, no en el sidecar, así que persistirla es
  barato). ¿Intencional? Si no: `schedulePersist` con debounce en `setViewport`.
- [ ] **Acotar las superficies world-size** (SVG de aristas, `.ddd-grid`) al rect visible si la
  medición en DevTools → Layers sigue mostrando presión de memoria tras el cambio a 2D.

## Rendering framework decisions

- **Preact** no React: bundle más chico, compat aliases en vite para zustand.
- **`useAppStore(selector)`** sobre zustand vanilla (hook propio con `Object.is`): selectores granulares → solo los componentes que miran el slice afectado re-renderizan. **Nunca un selector que devuelva objeto/array/Set nuevo** (siempre "cambia").
- **Mutación DOM directa durante drag** (M5): bypass Preact re-render, sólo se commit al store al `pointerup`.
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
