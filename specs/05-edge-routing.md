# 05 — Edge Routing

## Propósito

Rutear cada `Ref` del esquema como una **polilínea ortogonal (Manhattan)** limpia,
editable por el usuario, predecible y con ruteo ortogonal estándar. El usuario debe poder
doblar una arista (segmentar) **sin poder generar "picos"** (jogs/staircase) ni
diagonales, y tidiar una arista a un click ("Reset line").

## Contexto

`routeRefs()` (`src/webview/render/edgeRouter.ts`) corre dentro de `EdgeLayer`
(`src/webview/render/edgeLayer.tsx`) en cada render, sobre los refs ya filtrados
por visibilidad. El trabajo por frame escala con aristas visibles, no totales.

Estado del problema (capturas `2026-05-27`): el modelo v1 deja **colocar
waypoints libres en cualquier coord world**. Al mover una tabla los puertos
siguen a la tabla (se recomputan) pero los waypoints quedan **fijos** — y el
ruteo entre ellos produce escaleras/picos irregulares. El usuario investigó
ERD tools estándar y confirmó la semántica deseada:

- **Los waypoints NO siguen a la tabla.** Sólo el primer/último tramo (stub) se
  re-conecta al puerto flotante. Esto es correcto y deseado — no hay que anclar
  waypoints relativos.
- **El arreglo real es de *calidad de ruteo* + *modelo de edición*,** no de
  "seguir". Con ruteo ortogonal limpio + edición por arrastre de segmentos
  (picos imposibles) + un botón "Reset line", el sprawl post-move se vuelve
  tolerable y corregible a un click.

Terminología (para referencia): *orthogonal/Manhattan routing*; doblar
arrastrando tramos = *segment dragging* (draw.io/yEd); el puerto que desliza por
el lado de la tabla = *floating port/anchor*; los picos a eliminar = *jogs /
staircase artifacts*; eliminarlos = *collinear merge* + restringir el arrastre a
segmentos completos.

## Decisiones (resueltas con el usuario)

1. **Modelo de edición: sólo segment-drag por el punto medio (arrastre de segmento estándar).**
   Se eliminó el arrastre de puntos libres. Cada segmento (largo ≥ `MIN_GRIP_LEN`)
   muestra un *grip* en su punto medio cuando la arista está seleccionada; sólo
   ese grip arrastra, en su normal (`computeSegmentDrag`), insertando offsets
   limpios en los extremos del segmento. `simplifyWaypoints` colapsa colineales.
   Además `buildPath` rutea el último vértice **recto al puerto** (sin `midX`)
   cuando hay waypoints → la línea nunca se devuelve (sin picos).
2. **Modo imán: setting global.** `dddbml.ui.snapToGrid` (bool, default `false`)
   + `dddbml.ui.gridSize` (number, default 16), patrón spec 10. Snapper en
   `webview/layout/grid.ts`, aplicado a posiciones de tabla y vértices de arista.
3. **Color por arista:** `EdgeLayout.color` reusando `ColorPopup` + paleta BC.
4. **Flip de puerto: sólo izq↔der**, vía `EdgeLayout.sourceSide`/`targetSide`
   (override de `chooseSides`); arrastre del endpoint cruza el centro de la tabla.
5. **"Reset line":** resetea forma (waypoints + sides), conserva color.
6. **Entrega:** las 5 features en un solo cambio.

### Preguntas abiertas restantes

- **Undo de color/flip** vive en `EdgeStyleCommand` (`history.ts`); el undo de
  forma en `WaypointCommand`. Un reset emite ambos comandos.
- **Ruteo del flip "contra-natura"** (puerto forzado al lado opuesto del target)
  no dibuja un lazo de salida hacia afuera; usa el `midX` simple y puede cruzar
  la tabla. Pulido a futuro (relacionado con obstacle avoidance, v2).

## Diseño

### 1. Ruteo ortogonal base (v1, conservado)

Para cada ref, dado bbox source y target:

**Elegir lados** (`chooseSides`): siempre horizontal —
`dx = tgtCenter.x - srcCenter.x`; `dx >= 0` ⇒ source=right, target=left; si no,
source=left, target=right. (Override manual: ver §4.)

**Distribuir ports** en cada lado: agrupar por `(table, side)`, sortar por el
otro extremo, asignar `ratio = (i+1)/(n+1)` (equidistante, sin tocar esquinas;
clamp `[0.05, 0.95]`). Alinear `y` del puerto a la fila de la columna PK/FK vía
`columnYResolver` (`columnCenterY`).

**Computar path** (`buildPath` → `collapseColinear`): polilínea ortogonal de
ejes alternados, exit/enter horizontal por los puertos. Sin waypoints ⇒ H-V-H
con `midX`. `collapseColinear` fusiona corners colineales **excepto** los
waypoints de usuario. Migración legacy `dx`/`dy` conservada (ver código).

> **Invariante:** todo segmento es estrictamente H o V; ejes alternan. Esto ya
> se cumple. El bug no es éste — es que la *edición* puede crear waypoints en
> posiciones que generan escaleras de micro-segmentos.

### 2. Puertos flotantes + waypoints fijados (semántica de ports flotantes)

- Puertos se recomputan cada render desde el bbox actual (ya ocurre) → **siguen
  a la tabla**.
- Waypoints siguen en coords world absolutas (`EdgeLayout.waypoints`) → **fijos**.
- Al mover una tabla, sólo el tramo stub se re-rutea. **No** se implementa anclaje
  relativo ni "follow" de waypoints (decisión explícita del usuario).

### 3. Interacción: arrastre de segmentos (segment dragging) — picos imposibles

Reemplaza el arrastre de puntos libres. La ruta editable son corners
`[port_a, w0…w_{n-1}, port_b]`, segmentos alternando H/V.

- **Arrastrar un segmento interior** lo traslada **sólo en su normal**: un
  segmento vertical mueve el `x` de sus dos corners; uno horizontal mueve el `y`.
  Los corners se mantienen alineados ⇒ imposible crear diagonal o pico.
- **Arrastrar un tramo stub** (adyacente a un puerto) **inserta** un par de
  corners formando un codo limpio y luego traslada.
- **`collapseColinear` corre tras cada edición** ⇒ corners redundantes
  desaparecen; no se acumulan micro-segmentos.
- **Snap a rejilla** si el modo imán está ON: redondear el desplazamiento a
  `gridSize` (ver §6).
- **Borrar un codo**: arrastrar un segmento hasta colinealidad con sus vecinos
  (o doble-click sobre el corner) lo colapsa. Conserva el UX
  `NEIGHBOR_COLLAPSE_THRESHOLD` existente, adaptado a corners.

Implementación: nuevas acciones en `dragController.ts` (`startSegmentDrag`) y
mutadores de store que muevan *pares* de corners en vez de un punto. Eliminar la
proyección de punto libre (`startSegmentAddWaypoint` con punto arbitrario) y el
arrastre de punto libre (`startWaypointDrag`).

### 4. Flip de lado de puerto (origen izq↔der)

El usuario arrastra el endpoint de la relación al otro lado del campo (der→izq).
Se persiste un override por endpoint:

```ts
interface EdgeLayout {
  waypoints?: Waypoint[];
  color?: string;                       // §5
  sourceSide?: 'left' | 'right';        // override de chooseSides
  targetSide?: 'left' | 'right';
  dx?: number; dy?: number;             // @deprecated v1
}
```

`routeRefs` usa el override si existe; si no, `chooseSides`. Drag del endpoint
más allá del centro del campo conmuta el lado y persiste.

### 5. Toolbar de arista seleccionada (color + reset) — reemplaza click derecho

- Nuevo estado de selección de arista: `selectedEdgeId: string | null` en el
  store (+ acción `setSelectedEdge`). Click sobre la arista la selecciona;
  resalta y muestra toolbar flotante cerca del midpoint.
- Toolbar: **↻ Reset line** (resetea waypoints +
  flip de esa arista vía `resetEdgeWaypoints`) y **⚙ opciones** → abre
  `ColorPopup` reusando `popupAnchorFor`, escribe `EdgeLayout.color`.
- Reemplaza el `ContextMenu` por click derecho de waypoint en `edgeLayer.tsx`
  (más intuitivo, confirmado por el usuario).
- Render de arista aplica `stroke` desde `EdgeLayout.color` cuando existe.

### 6. Modo imán + rejilla (grid snap)

- **Toggle "imán"** en la barra de acciones (`actionsPanel.tsx`), junto a
  undo/redo/filter. Estado según OQ #2.
- **Fondo con puntos** (rejilla visible) sólo cuando el imán está ON: background
  `radial-gradient` de puntos en la capa world (`app.tsx` canvas), con
  `background-size = gridSize * zoom` y `background-position` siguiendo el pan
  del viewport. Tokens de diseño en `style.css` (spec 12), sin px/hex mágicos.
- **Snap** cuando ON: las posiciones de tabla (`dragController.startDrag`) y los
  corners de arista (§3) redondean a múltiplos de `gridSize`. OFF ⇒ libertad
  total (comportamiento actual).

### 7. Historia (undo/redo) y persistencia

- Reusar el patrón `EditCommand` (`history.ts`): el segment-drag y el flip
  emiten `WaypointCommand` (snapshot `from`/`to` de `waypoints` y/o sides). El
  color de arista puede emitir un `EdgeStyleCommand` nuevo, o reusar el flujo de
  `setEdgeLayout` + persist (ver patrón de `tableColors`). Decidir en
  implementación según mínima superficie.
- `persistence.ts` ya serializa `edges`; extender el serializador para incluir
  `color`, `sourceSide`, `targetSide` (omitir defaults; mantener escritura
  git-friendly: claves ordenadas, enteros, sin flags por defecto).

## Limitaciones conocidas

1. **No evita tablas en el camino** (sin obstacle avoidance). v2.
2. **Tie-break de lado** binario (45° ⇒ horizontal). Aceptable.
3. **Self-loops** (ref de tabla a sí misma) no soportados visualmente. v1.1.
4. **Sin curvatura** en codos (90° rígidos). v1.1 opcional.

## Test plan

`test/unit/edgeRouter*.test.ts` (actualizar `edgeRouter.waypoints.test.ts`):

- Misma fila, target a la derecha ⇒ source=right, target=left, H-V-H.
- Override `sourceSide`/`targetSide` respetado sobre `chooseSides`.
- Segment-drag de un tramo vertical mueve `x` de ambos corners; ejes siguen
  alternando; `collapseColinear` no deja micro-segmentos (no picos).
- Drag de stub inserta codo limpio.
- Snap ON ⇒ corners y posiciones múltiplos de `gridSize`.
- Bbox faltante ⇒ arista omitida (no crash).
- Back-compat: `waypoints=[]` ⇒ salida pixel-idéntica al H-V-H v1.

`history.waypoint.test.ts` / `store.history.test.ts`: undo/redo de segment-drag,
flip y color como replays puros.
