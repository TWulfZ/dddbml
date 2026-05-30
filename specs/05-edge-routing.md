# 05 — Edge Routing

## Propósito

Rutear cada `Ref` del esquema como una **polilínea ortogonal (Manhattan)** limpia,
editable por el usuario, predecible y con ruteo ortogonal estándar. El usuario dobla una
arista con gestos **controlados** (deslizar una sección, o crear un notch simétrico local
con un fantasma ¼/¾) — **nunca diagonales ni staircase accidental** — y puede tidiar a un
click ("Reset line").

## Contexto

`routeRefs()` (`src/webview/render/edgeRouter.ts`) corre dentro de `EdgeLayer`
(`src/webview/render/edgeLayer.tsx`), **memoizado por geometría** (no por frame):
se rutean **todas** las `effectiveRefs` una sola vez por cambio de posiciones /
layout / schema, y las *rutas* resultantes se **cullean por visibilidad** al
render (route-all-then-cull). Bajo pan/zoom las posiciones world no cambian (sólo
el transform CSS del world container), así que el ruteo **no recomputa por
frame** ni al cambiar hover/selección. Ver Diseño §8.

Estado del problema (capturas `2026-05-27`): el modelo v1 deja **colocar
waypoints libres en cualquier coord world**. Al mover una tabla los puertos
siguen a la tabla (se recomputan) pero los waypoints quedan **fijos** — y el
ruteo entre ellos produce escaleras/picos irregulares. El usuario investigó
ERD tools estándar y confirmó la semántica deseada:

- **Los waypoints NO siguen a la tabla.** Sólo el primer/último tramo (stub) se
  re-conecta al puerto flotante. Esto es correcto y deseado — no hay que anclar
  waypoints relativos.
  - *Smart auto-layout (spec 13):* como un reordenamiento masivo deja varados los
    waypoints absolutos, auto-arrange **resetea** la forma (waypoints + `dx/dy`) de
    aristas cuyos dos extremos se movieron, conservando color y `sourceSide`/`targetSide`;
    el `columnYResolver` re-ancla los puertos a las filas de columna FK/PK.
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

1. **Modelo de edición: DOS niveles por sección — vértice REAL al centro (desliza) + FANTASMAS a ¼/¾ (notch simétrico local) + esquinas redondeadas.**
   Confirmado con el usuario (analizó el edge de dbdiagram.io y eligió opciones ASCII: "Real centro +
   fantasmas ¼/¾", "notch simétrico", "local al cuarto agarrado"). Los waypoints son las **esquinas
   literales** de la polilínea editable (no pass-through): ruta = `[a, aStub, ...waypoints, bStub, b]`
   conectada con segmentos ortogonales directos + fillets.
   - **Vértice REAL (azul) en el medio de cada sección editable** (`!rigid && len ≥ MIN_HANDLE_LEN`),
     visible al seleccionar (sin hover). Arrastrarlo — o agarrar la sección en cualquier punto
     (hit-line) — **DESLIZA toda la sección** perpendicular (`slideSegment`, 1-DOF). Son los "3 nodos
     por defecto" de dbdiagram (uno por sección de un H-V-H). Deslizar mueve las 2 esquinas de la
     sección; donde el vecino es **paralelo** (stub rígido / brazo colineal) inserta un codo para que
     el ancla del puerto **no se mueva**; donde es **perpendicular** la esquina compartida sólo se
     desplaza (el vecino se alarga).
   - **FANTASMAS (gris) a ¼ y ¾** de cada sección (`len ≥ MIN_GHOST_LEN`), visibles **sólo en hover**.
     Arrastrar un fantasma perpendicular **CREA un notch simétrico LOCAL** centrado en ese cuarto
     (`notchAtQuarter` → `localNotchCorners`): 2 *pins* al nivel original (a `¼ ∓ ⅛`) + 2 esquinas
     *hundidas*; el resto de la sección **queda plano** (lead-in corto, cola larga). Al soltar, el
     fantasma pasa a vértice real (la nueva sección hundida trae su propio vértice central + sus
     fantasmas). Crear exige cruzar `CREATE_THRESHOLD_PX = 8px`. El ¼ talla a la izquierda, el ¾ a la
     derecha (subdivisión local, no centrada).
   - **Profundizar / borrar:** el dip-run de un notch es una sección editable normal → su vértice
     central lo **desliza** (`slideSegment`, profundiza/aplana). Arrastrarlo a **menos de
     `NOTCH_MERGE_SNAP` (10 u world)** del nivel del pin ⇒ snap al pin y el notch se **disuelve**
     (`cleanCorners`, smart-delete con tolerancia — no requiere precisión). Doble-click en el dip-run
     ⇒ `deleteNotch` (quita las 4 esquinas). `isDipRun` lo detecta vía `isDip` (¿los pins a ambos
     lados al mismo nivel, distinto del run?).
   - **1-DOF perpendicular** (h→↑↓, v→←→) con **cursor de redimensionar** por eje (`ns-resize` ↕
     horizontal, `ew-resize` ↔ vertical). **No hay handles en las esquinas** (vueltas redondeadas).
   - **Materialización:** al editar, las esquinas actuales se vuelven waypoints explícitos
     (`editableCornersOf`) **antes** de insertar/mover, así editar una sección **no mueve el resto**.
   - **Esquinas redondeadas (`roundedPathString`, `CORNER_RADIUS = 8`):** cada esquina interior ⇒
     fillet `L (esquina−r) · Q esquina (esquina+r)`, `r = min(CORNER_RADIUS, dPrev/2, dNext/2)`.
     Colineal/coincidente ⇒ `L` plano. Suavizado **sólo de render**: una vuelta nunca es nodo.
   *(Iteraciones revertidas: (a) nodo sólido por sección + ghost-hover-only; (b) vértice-por-esquina
   2D "B1"; (c) segment-SLIDE global + `simplifyWaypoints` que canonicalizaba (colapsaba el notch en
   aguja); (d) **notch desde el medio del vértice real** — confundía el nodo real con el fantasma
   intermedio: subdividía DESTRUYENDO el vértice real en vez de generar uno nuevo desde la mitad
   (corrección clave del usuario). El modelo correcto son 2 niveles: el vértice real desliza; el
   fantasma intermedio crea un notch local de 4 esquinas literales — sin canonicalización destructiva,
   sólo `cleanCorners` tras un slide.)*
2. **Modo imán: setting global.** `dddbml.ui.snapToGrid` (bool, default `false`)
   + `dddbml.ui.gridSize` (number, default 16), patrón spec 10. Snapper en
   `webview/layout/grid.ts`, aplicado a posiciones de tabla y vértices de arista.
3. **Color por arista:** `EdgeLayout.color` reusando `ColorPopup` + paleta BC.
4. **Flip de puerto: sólo izq↔der**, vía `EdgeLayout.sourceSide`/`targetSide`
   (override de `chooseSides`); arrastre del endpoint cruza el centro de la tabla.
5. **"Reset line":** resetea forma (waypoints + sides), conserva color.
6. **Endpoint = sólo flip de lado.** El "nodo real" (endpoint sobre la tabla)
   conmuta izq↔der (§4); **no** traslada la arista ni re-ancla a otra columna
   (confirmado con el usuario). Mover toda la arista no es una acción de endpoint.
7. **Stub RÍGIDO de longitud fija en ambos extremos (`MIN_STUB = 24` world units).**
   El tramo `source → sourceStub` y `targetStub → target` es **inmutable**: nunca
   arrastrable, nunca subdividible, **nunca colapsado** (son los segmentos
   `rigid` primero/último, siempre horizontales, de largo exacto 24). Mantienen
   coherente el punto de conexión (el marcador `1`/pata de gallo nunca queda
   pegado a la tabla). **Toda la edición vive estrictamente entre `sourceStub` y
   `targetStub`**, que actúan como los extremos fijos del polígono editable
   (`buildPath` conecta las esquinas literales entre ellos vía `cornersThrough`;
   sin waypoints usa `defaultEditableCorners`; luego envuelve con los dos stubs).
   `slideSegment`/`notchAtQuarter`/`isDipRun`/`deleteNotch` materializan las esquinas
   (`editableCornersOf`) entre `sourceStub`/`targetStub`, así editar una sección no toca el resto.
   **Clamp anti-spike:** la longitud del stub se limita a la mitad de la
   distancia horizontal entre puertos, así los dos stubs **se encuentran en vez de
   cruzarse** cuando las tablas están a < `2*MIN_STUB`. Consecuencia: una arista
   misma-fila muy cercana queda como conector recto rígido sin sección editable;
   una arista offset cercana conserva su trunk vertical editable.
8. **Animación de flujo en hover/selected.** Una `<path>` overlay (clon de `r.d`,
   `pointer-events: none`) con puntos redondos (`stroke-dasharray`) y
   `@keyframes ddd-edge-flow` animando `stroke-dashoffset` negativo → los puntos
   fluyen en la dirección de la relación (source→target, porque el path se dibuja
   `M source … L target`). Sólo se renderiza para la arista seleccionada y/o en
   hover (≤ 2 a la vez) → cero churn en el render de 5000 tablas. Respeta
   `prefers-reduced-motion` (se oculta con `display:none`).

### Preguntas abiertas restantes

- **Undo de color/flip** vive en `EdgeStyleCommand` (`history.ts`); el undo de
  forma en `WaypointCommand`. Un reset emite ambos comandos.
- **Ruteo del flip "contra-natura"** (puerto forzado al lado opuesto del target)
  no dibuja un lazo de salida hacia afuera; usa el `midX` simple y puede cruzar
  la tabla. Pulido a futuro (relacionado con obstacle avoidance, v2).
- **Ruteo de >10k refs (§8).** `route-all-then-cull` rutea el set completo por
  cada cambio de geometría. A ~1000 refs (fixture `huge`) es trivial; a decenas
  de miles, el ruteo único podría costar decenas de ms en cada drag/commit (no
  por frame). Mitigación futura: rutear por celda del spatial index + cache por
  arista, o un LOD de ruteo. No bloqueante hoy (fuera del presupuesto de
  fixtures, spec 07).

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

**Computar path** (`buildPath`): polilínea ortogonal de ejes alternados. El
**polígono editable** se rutea entre los extremos fijos `aStub`/`bStub` (decisión
7) conectando las **esquinas literales** del usuario directamente (`cornersThrough`,
sin colapsar — un codo de seguridad sólo para un par no-alineado v1); sin waypoints
⇒ `defaultEditableCorners` (recta misma-fila, o H-V-H con `midX` centrado entre los
stubs). Luego se **envuelve** con los stubs rígidos: `corners = [a, ...editable, b]`,
así `a→aStub` y `bStub→b` sobreviven como segmentos propios. `buildSegments` marca
`rigid` el primero y el último. (Las ops de edición usan `cleanCorners` —quita sólo
puntos coincidentes/colineales redundantes— tras un *slide*; el ruteo base no
canonicaliza.) Migración legacy `dx`/`dy` conservada. `routeRefs` expone
`sourceStub`/`targetStub` en el `EdgeRoute`.

> **Invariante:** todo segmento es estrictamente H o V; ejes alternan. Los stubs
> primero/último son `rigid` (inmutables) y de largo fijo `MIN_STUB`.

### 2. Puertos flotantes + waypoints fijados (semántica de ports flotantes)

- Puertos se recomputan cada render desde el bbox actual (ya ocurre) → **siguen
  a la tabla**.
- Waypoints siguen en coords world absolutas (`EdgeLayout.waypoints`) → **fijos**.
- Al mover una tabla, sólo el tramo stub se re-rutea. **No** se implementa anclaje
  relativo ni "follow" de waypoints (decisión explícita del usuario).

### 3. Interacción: dos niveles por sección (vértice real desliza + fantasmas ¼/¾ crean notch local)

Los waypoints son las **esquinas literales** de la polilínea editable entre
`sourceStub`/`targetStub`; los stubs son `rigid`. Estilo dbdiagram: cada sección trae un **vértice
real** (azul) que la **desliza** entera, y dos **fantasmas** (gris) a ¼/¾ que **subdividen** creando
un notch local — sin mover el resto.

- **Visibilidad:** hover de una arista **no** seleccionada ⇒ **nada** (sólo flujo, §8). Al
  **seleccionar** ⇒ **vértice real** (`.ddd-edge-handle`, azul) en el midpoint de cada sección
  editable (`!rigid && len ≥ MIN_HANDLE_LEN`), visible sin hover; más los 2 handles de endpoint
  (flip, §4). En **hover de una sección** (`len ≥ MIN_GHOST_LEN`) ⇒ **2 fantasmas** (`.ddd-edge-ghost`,
  gris) a ¼ y ¾. **No hay handles en las esquinas.**
- **Deslizar (vértice real / agarrar la sección):** la hit-line `.ddd-edge-segment-handle` o el
  vértice central inician `startSegmentSlide` → `slideSegment` (1-DOF perpendicular, inmediato). La
  sección entera se mueve a un nivel paralelo; vecino perpendicular ⇒ la esquina se desplaza, vecino
  paralelo (stub/brazo colineal) ⇒ se inserta un codo (el ancla del puerto no se mueve). Deslizar un
  dip-run lo **profundiza**; arrastrarlo a < `NOTCH_MERGE_SNAP` (10 u) del nivel del pin ⇒ snap y el
  notch se **disuelve** (`cleanCorners`, tolerancia de re-unión).
- **Crear notch (fantasma ¼/¾):** `startNotchDrag(quarter)` → `notchAtQuarter` → `localNotchCorners`:
  2 pins al nivel original (a `¼ ∓ ⅛`) + 2 esquinas hundidas; resto plano. Gate `CREATE_THRESHOLD_PX
  = 8px`. ¼ ⇒ notch a la izquierda, ¾ ⇒ a la derecha. Al soltar, queda como vértice real.
- **Borrar:** doble-click en el dip-run ⇒ `deleteEdgeNotch` → `deleteNotch` (4 esquinas). `isDipRun`
  lo identifica.
- Ambos gestos **recomputan desde el snapshot ORIGINAL + delta** (idempotente) y **materializan** las
  esquinas (`editableCornersOf`) antes de editar, así el resto de la ruta no se mueve. **1-DOF
  perpendicular** (h→↑↓, v→←→) con **cursor de redimensionar** por eje.
- **Esquinas redondeadas** (`roundedPathString`, `CORNER_RADIUS = 8`): cada esquina interior ⇒
  fillet `L (esquina−r) · Q esquina (esquina+r)`, `r = min(CORNER_RADIUS, dPrev/2, dNext/2)`.
  Colineal/coincidente ⇒ `L` plano. Suavizado **sólo de render**; nunca un nodo.
- **Stubs rígidos:** el primer/último segmento (`rigid`) nunca recibe handle ni se edita.
- **Snap a rejilla** si el imán está ON.

Implementación: `edgeLayer.tsx` (vértice real `selected && !rigid && len ≥ MIN_HANDLE_LEN`; fantasmas
`+ len ≥ MIN_GHOST_LEN && hover`; doble-click → `deleteEdgeNotch`), `dragController.ts` →
`startSegmentSlide` + `startNotchDrag` (gate de 8px) + `deleteEdgeNotch`, ambos sobre el loop
compartido `runEdgeDrag`. Reusa `setEdgeWaypoints` + `WaypointCommand`. Motor (`edgeRouter.ts`):
`slideSegment`/`notchAtQuarter`/`isDipRun`/`deleteNotch`/`localNotchCorners`/`cleanCorners`/
`editableCornersOf` + `cornersThrough`/`defaultEditableCorners` + `roundedPathString`.

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

### 8. Rendimiento con miles de relaciones (memoización + cull de rutas + LOD)

Mismo patrón que las tablas (spatial index + LOD + memo), aplicado a las aristas.
Cuatro piezas, escalonadas:

1. **Ruteo memoizado, desacoplado del viewport.** `routeRefs` se envuelve en
   `useMemo([refs, positions, tablesByName, groupSizes, edgeLayouts])`. Como
   `positions`/`edgeLayouts` se reemplazan **inmutablemente** en el store (un
   `new Map(...)` por edición), el memo sólo invalida cuando cambia la geometría
   o el layout — **nunca en pan/zoom** (que sólo tocan el transform CSS), ni al
   cambiar hover/selección (estado local de `EdgeLayer`). Antes `routeRefs`
   corría en el cuerpo del render → se recomputaba en cada frame de pan y en cada
   hover. Ahora el ruteo es O(refs) una vez por movimiento, no por frame.
2. **Route-all-then-cull (puertos estables).** Se rutean **todas** las
   `effectiveRefs` (no el subconjunto visible) y luego se filtran las *rutas* por
   `visibleRefIds` (memo en `app.tsx`: refs con ≥ 1 endpoint en `visibleNames`).
   Esto además **arregla un jitter**: la distribución de puertos
   (`ratio = (i+1)/(n+1)` por `(table, side)`) dependía del subconjunto visible,
   así que `n` cambiaba al panear y los puertos **temblaban**. Ruteando sobre el
   set completo, `n` es estable.
3. **Overlay interactivo sólo para la arista seleccionada.** Antes el overlay
   construía, por cada arista visible, un `<g>` + por-segmento un `<line>` hit de
   14px con 5 listeners — miles de nodos interactivos que Preact difea cada
   render. Ahora: las aristas **no** seleccionadas reciben **un solo
   `path.ddd-edge-hit`** transparente (`pointer-events: stroke`,
   `stroke-width = SEGMENT_HOVER_THICKNESS`) que hace select-on-click +
   hover-flow; los handles por-segmento (slide / fantasmas ¼-¾ / endpoints) se
   renderizan **sólo para la arista seleccionada** (1 arista). El flujo
   (Decisiones §8) sigue en seleccionada ∪ hover (≤ 2). DOM/listeners del overlay
   pasan de O(Σ segmentos sobre visibles) a O(segmentos de 1). Costo: una arista
   no seleccionada ya no tiñe el segmento al hover (`.ddd-edge-segment-handle
   :hover`); el feedback de hover es el flujo, que ya existía.
4. **LOD de arista por zoom (recta a bajo zoom).** Cuando `lod === 'rect'`
   (zoom < `lowThreshold`, el texto de tabla ya es ilegible), cada arista se
   dibuja como **recta `M source L target`**: sin fillets, sin crow's-foot, sin
   direction dots, y el **overlay entero se omite** (no hay edición cuando no se
   lee nada). A vista pájaro de 5000 tablas, cada arista es 1 `<path>`.
   `header`/`full` conservan el ruteo ortogonal completo. El ruteo (memoizado)
   sigue corriendo para resolver los puertos que anclan los extremos de la recta.

Implementación: `app.tsx` (memo `visibleRefIds`; pasa `refs=effectiveRefs`,
`visibleRefIds`, `lod` a `EdgeLayer`); `edgeLayer.tsx` (`useMemo` de `routes` +
`visibleRoutes`; rama low-zoom; overlay seleccionada-only + `.ddd-edge-hit`);
`style.css` (`.ddd-edge-hit`). Presupuesto y regresiones a vigilar: spec 07.

## Limitaciones conocidas

1. **No evita tablas en el camino** (sin obstacle avoidance). v2.
2. **Tie-break de lado** binario (45° ⇒ horizontal). Aceptable.
3. **Self-loops** (ref de tabla a sí misma) no soportados visualmente. v1.1.
4. **Sin curvatura** en codos (90° rígidos). v1.1 opcional.
5. **Retroceso en x-overlap** (target con borde izq dentro del extent-x del source ⇒
   `chooseSides` invierte el span y la ruta se devuelve, incluso a cero-waypoints):
   régimen degenerado contra-natura (v2). Las geometrías bien separadas (caso normal)
   quedan limpias; el `clamp(newX)` evita que el slide lo agrave.

## Test plan

`test/unit/edgeRouter*.test.ts` (actualizar `edgeRouter.waypoints.test.ts`):

- Misma fila, target a la derecha ⇒ source=right, target=left; recta enmarcada
  por dos stubs rígidos (`M…aStub…bStub…b`), una sección editable en medio.
- Override `sourceSide`/`targetSide` respetado sobre `chooseSides`.
- **Deslizar (`edgeRouter.segmentDrag.test.ts`):** `slideSegment` sobre el trunk vertical ⇒ mueve
  sus 2 esquinas (sin agregar puntos); sobre un brazo (colineal con su stub) ⇒ inserta un codo (el
  ancla del puerto no se mueve). 1-DOF (v ignora `dy`, h ignora `dx`); `rigid` ⇒ no-op; idempotente.
- **Notch (`notchAtQuarter`):** fantasma ¼ de una corrida horizontal ↓ ⇒ notch simétrico LOCAL en la
  porción izquierda (2 pins al nivel original a `¼∓⅛`, 2 hundidas; cola plana); los extremos quedan;
  ortogonal. ¾ ⇒ a la derecha. Mirror vertical (←→). 1-DOF; idempotente; profundidad 0 ⇒ sin notch.
- **Deepen/delete:** `isDipRun` true en el dip-run, false en plano/trunk; `slideSegment` sobre el
  dip-run mueve sólo las 2 hundidas (pins quedan); volver al nivel del pin ⇒ aplana el notch
  (smart-delete, queda sólo el trunk); `deleteNotch` quita las 4 esquinas.
- **Stub rígido:** primer y último segmento `rigid===true`, horizontales y de
  largo exacto `MIN_STUB`; los interiores `rigid===false`; existe ≥ 1 sección
  editable. `slideSegment`/`notchAtQuarter` sobre un `rigid` es no-op.
- **Esquinas redondeadas** (`edgeRouter.rounding.test.ts`): `roundedPathString` deja recta
  una polilínea colineal (sin `Q`); redondea una esquina interior con un `Q` cuyo punto de
  control es el vértice; clampa `r` a media-sección adyacente; descarta puntos coincidentes;
  `≤ 2` puntos ⇒ segmento plano. Vía `routeRefs`: arista misma-fila sin `Q`; arista doblada
  con `Q` (el waypoint es una esquina literal → `Q<waypoint>`).
- Bbox faltante ⇒ arista omitida (no crash).
- Back-compat: `waypoints=[]` ⇒ ruta recta misma-fila / H-V-H offset con stubs.

`history.waypoint.test.ts` / `store.history.test.ts`: undo/redo de notch (create/deepen/
delete), flip y color como replays puros (mismo `WaypointCommand`, op `add`/`move`/`remove`).
