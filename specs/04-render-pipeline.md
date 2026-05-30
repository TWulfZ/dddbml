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
| `>= 0.6` | `full` | Header + columnas completas con flags |
| `0.3 - 0.6` | `header` | Sólo header con nombre, sin columnas |
| `< 0.3` | `rect` | Rectángulo coloreado, sin texto |

Decidido por `lodForZoom(viewport.zoom)` en `render/lod.ts`. Umbrales empíricos:
- `full` a zoom normal y zoom in.
- `header` útil cuando ves muchas tablas a la vez pero aún distingues nombres.
- `rect` para vista "pájaro" de 5000 tablas → sólo puntos de color agrupados por grupo.

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
