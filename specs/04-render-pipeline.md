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

## Rendering framework decisions

- **Preact** no React: bundle más chico, compat aliases en vite para zustand.
- **useSyncExternalStore** sobre zustand vanilla: selectores granulares → solo los componentes que miran el slice afectado re-renderizan.
- **Mutación DOM directa durante drag** (M5): bypass Preact re-render, sólo se commit al store al `pointerup`.
- **`transform: translate3d(...)`**: GPU compositing, no layout/paint per-frame durante pan/zoom.
- **SVG overlay único**: reduce DOM node count vs un `<svg>` por edge.

## Performance budgets

Ver `07-performance-budgets.md` para targets numéricos y fixtures de benchmark.

## Anti-patterns a evitar

- **Re-render full tree en cada pan/zoom frame**: fatal a 5000 tablas. Por eso culling memoized + Preact keys estables.
- **Uso de `width`/`left`/`top`** para posicionar tablas: causa layout. Usar `transform`.
- **Rebuild spatial index en cada pan**: sólo cuando posiciones cambian (raro).
- **Recomputar dagre completo en cada frame**: sólo al cambio de schema para tablas sin posición.
- **SVG con un path por edge dentro de cada tabla**: causa N svgs anidados. Un solo overlay padre.
