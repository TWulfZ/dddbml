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
   *(El flip **manual** queda L/R; el pase A* on-demand de §9 sí puede asignar `top`/`bottom` — los
   tipos `sourceSide`/`targetSide` admiten los 4 lados, ver §9 "modelo de lado híbrido".)*
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
otro extremo (reducción baricéntrica de cruces: la arista cuyo extremo lejano está
más arriba/izquierda recibe el puerto más arriba/izquierda), **desempate por `ref.id`**
para que la asignación dependa sólo de geometría + ids estables, nunca del orden del
array `refs[]` (que `@dbml/core` puede reordenar al re-parsear — invariante git-friendly:
mismo schema ⇒ mismos puertos). Asignar `ratio = (i+1)/(n+1)` (equidistante, sin tocar
esquinas; clamp `[0.05, 0.95]`). Alinear `y` del puerto a la fila de la columna PK/FK vía
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

### 9. Ordenamiento automático de aristas (edge ordering)

> **Estado:** **aprobado e implementado (2026-05-31).** Resuelve "ordenar los edges de las relaciones
> de forma más limpia". Decisiones cerradas con el usuario (ver "Decisiones" abajo). Motor en
> `src/webview/layout/edgeOrder/` (`astar.ts` + `grid.ts` + `constants.ts`, puro y sin dependencias),
> glue de store en `smartLayout/runner.ts` (`runEdgeOrdering` + `runSmartLayout(mode, opts)`),
> adaptador en `smartLayout/edgeOrdering.ts`.

**Objetivo del usuario (4 metas):** menos cruces de aristas paralelas, espaciado uniforme en cada
lado, mejor selección de lado (hoy `chooseSides` fuerza izq/der), y menos cruces arista↔tabla
(obstacle avoidance). El ordenamiento **no es en tiempo real**: es una operación on-demand,
deshacible y persistida (escribe `EdgeLayout`), con indicador de progreso porque puede tardar.

**Disparo (acordado con el usuario):** vive en el **mismo botón/superficies de `runSmartLayout`**
(command palette + ActionsPanel + menú contextual, patrón spec 13). Al auto-ordenar tablas, el
**ordenamiento de aristas viene activado por defecto** (toggle para desactivarlo). Además, el mismo
control ofrece **"ordenar sólo aristas"** (las tablas no se mueven). En cada corrida el usuario elige
**alcance**: re-ordenar **todas** las aristas o **preservar las que ya modificó** manualmente
(default: preservar).

#### Arquitectura: UN router A* para todas las aristas; dagre sólo posiciona tablas

Decisión clave (usuario, 2026-05-31): **un único router ortogonal A* con evición de obstáculos** rutea
**todas** las aristas, sobre las posiciones **finales** de las tablas — sirva el arrange (tablas
recién movidas) o el modo "sólo aristas" (tablas fijas). **dagre no rutea aristas**: sigue siendo sólo
el motor de **posición de tablas** (`smartLayout`, spec 13). (Nota: el motor de tablas fue ELK en un
diseño previo; se reemplazó por dagre dos-niveles en commit `00551f2` — ELK quedó fuera del bundle a
propósito. Cualquier mención histórica a "ELK" en esta sección refiere ahora a `smartLayout`/dagre.)
Se rechazó reutilizar el ruteo del motor de layout porque (a) su obstacle-avoidance es intrínseco al
algoritmo en capas y **no** funciona con tablas fijas (modo "sólo aristas"), y (b) dos routers según
modo duplican superficie + obligan a reconciliar puertos ajenos con nuestro anclaje
`columnYResolver`. Un solo router respeta nativamente los stubs rígidos (decisión 7) y el anclaje a
fila de columna PK/FK.

##### Modelo de lado híbrido (resuelto con el usuario — resuelve el conflicto decisión-7 ↔ meta-3)

El spec tenía una tensión aparente: la decisión 7 dice "el router A* rutea **entre los stubs ya
elegidos**", mientras la meta-3 + "ampliar `chooseSides`" implican que A* **elige** el lado (incl.
top/bottom). Resolución acordada:

- **Camino de render siempre-activo (`chooseSides`, §1): se queda en `left`/`right`.** No cambia —
  preserva el anclaje a fila de columna y mantiene el ruteo barato/predecible.
- **El pase A* on-demand SÍ puede reasignar un extremo a `top`/`bottom`** (selección de 4 lados,
  `chooseSides4` en `astar.ts`) cuando reduce cruces/obstáculos, y persiste
  `sourceSide`/`targetSide ∈ 'left'|'right'|'top'|'bottom'` (E3 **se usa de verdad**). El render path
  luego dibuja fielmente ese lado persistido vía `portPoint` (que ya soporta los 4 lados).
- **`columnY` ancla sólo en `left`/`right`**; un puerto `top`/`bottom` usa un x-ratio sin ancla de
  fila. Ambas reglas ya estaban gateadas a L/R en `routeRefs` (líneas ~153-162).
- Sin contradicción: A* **rutea entre los stubs** (decisión 7 se mantiene) — pero el **adaptador**
  (`edgeOrdering.ts`) asigna los lados provisionales de 4 vías a TODAS las aristas **antes** de su
  pase `routeRefs`, de modo que los stubs ya distribuidos que A* conecta son los que persisten (sin
  codo en el primer render). El motor permanece agnóstico de puertos; el adaptador es dueño de los
  stubs finales.

**Dos planos de trabajo, distinta cadencia:**

1. **Calidad de puertos — SIEMPRE activa, barata (E2).** Mejora en el seam de asignación de puertos
   existente de `routeRefs` (§1 "Distribuir ports"), sin comando: sort baricéntrico con **desempate
   estable** determinista (menos cruces de aristas paralelas en un lado) + **espaciado uniforme**.
   Sigue O(aristas), memoizada, corre en cada cambio de geometría como hoy. El tramo medio queda en
   el H-V-H por defecto (sin A* en el camino caliente). **Nota:** el camino caliente **no** elige
   top/bottom — `chooseSides` permanece L/R (modelo híbrido arriba); los lados de 4 vías sólo los
   produce el pase A* on-demand y se persisten en `EdgeLayout`.
2. **Ruteo A* obstacle-avoiding — ON-DEMAND, costoso (E1).** El comando "ordenar aristas" corre A*
   sobre una grilla propia (cell = `ASTAR_CELL = 24` = `MIN_STUB`). Las celdas-obstáculo de las tablas
   se reúnen reusando la **clase** `SpatialIndex` — un índice **desechable** que el adaptador
   reconstruye desde las posiciones **finales** (la instancia de `app.tsx` no es alcanzable desde
   `runner.ts` y además tendría posiciones viejas durante un arrange). Rutea entre `sourceStub` y
   `targetStub` de cada arista, penalizando cruces con aristas ya ruteadas (crossing-min incremental
   vía una `WorldUsage` con clave en coords-mundo, independiente de la ventana). Produce bend-points
   → `EdgeLayout.waypoints` (esquinas literales, §3), que el ruteo base ya envuelve con stubs +
   fillets. **No** corre por frame ni en `routeRefs`: sólo al activar el comando; luego `routeRefs`
   dibuja a través de los waypoints guardados (`cornersThrough`). Funciona con tablas fijas (lo que el
   motor de tablas no daba).

**Mapeo al modelo existente (sin cambio de schema del sidecar):**
- Bend-points de A* (coords world) → `EdgeLayout.waypoints` (§3). Los stubs rígidos + fillets se
  aplican sin cambios; el anclaje de puerto a la fila PK/FK (`columnYResolver`, §1) se conserva en los
  extremos (A* rutea entre los stubs, no toca los puertos).
- Selección de lado → `EdgeLayout.sourceSide`/`targetSide`. **El tipo se amplió a
  `'left' | 'right' | 'top' | 'bottom'`** (E3, `EdgeSide` + guard `isEdgeSide` en `shared/types.ts`);
  `portPoint` ya dibuja los 4 lados. El **validador de lectura del host** (`layoutStore.ts:108-109`,
  antes hardcodeado a `left`/`right`) se amplió al whitelist de 4 lados — sin esto un `top`/`bottom`
  persistido se descartaba en cada reapertura. El **serializador no cambió** (ya hace
  `JSON.stringify` del valor; defaults omitidos sólo por ausencia, no por valor). `chooseSides`
  **NO** se amplió (queda L/R por diseño, modelo híbrido).

**Integración con el runner (`runner.ts`, spec 13):** hoy el arrange **limpia** los waypoints de
aristas cuyos dos extremos se movieron (para que `columnYResolver` re-rutee limpio). Con edge-ordering
ON, en vez de limpiar se **setean** los waypoints con la salida de A*. Reusa el snapshot de aristas que
el `ArrangeCommand` **ya** transporta (`edgesFrom`/`edgesTo`) → un único Ctrl+Z revierte tablas +
aristas, como ya ocurre. `preservar manuales` ⇒ se excluyen del re-ruteo las aristas con forma manual
previa (waypoints/sides/dx-dy).

**Tipos/opciones nuevas:** `runSmartLayout(mode, opts: ArrangeOptions)` con
`orderEdges: boolean` (default `true`) y `preserveManualEdges: boolean` (default `true`, E5);
entry-point `runEdgeOrdering({ preserveManual })` para el modo "sólo aristas" (reusa `ArrangeCommand`
con posiciones vacías, patrón `buildEdgesResetCommand` → un Ctrl+Z revierte sólo las aristas).
Determinismo: A* con costos + desempates **deterministas** (sin RNG ni reloj en ninguna decisión de
costo/orden; aristas procesadas en orden `ref.id`; bends redondeados a enteros; tie-break de la cola
de prioridad totalmente ordenado `(f, g, nodeKey)`; rasterización por membresía conmutativa) —
invariante git-friendly. **Atomicidad (crítico):** en el path de arrange, A* corre contra las
posiciones **computadas** (aún no aplicadas al store); el store se muta UNA sola vez, sólo al éxito;
cancelar = no-op puro (tablas nunca se movieron, no se empuja comando).

**Progreso (E4):** como **nosotros** controlamos el loop de A* (una arista a la vez), el indicador es
un **porcentaje real** (aristas ruteadas / total), no un spinner opaco. El loop cede (yield) cada
`YIELD_EVERY` aristas y emite progreso monótono 0→100; **cancelable** vía `AbortSignal`
(`cancelEdgeOrdering`). UI: overlay flotante `EdgeOrderProgress` (slice de store `edgeOrderProgress`,
selector granular que el memo de ruteo **no** lee → pumping el % no re-rutea; respeta
`prefers-reduced-motion`).

#### Decisiones (resueltas con el usuario, 2026-05-31)

- **E1 · Router.** → **A* propio para TODAS las aristas; dagre sólo posiciona.** Da obstacle-avoidance
  también con tablas fijas (modo "sólo aristas"). Un solo motor de aristas, sin reconciliar puertos
  ajenos. (El camino caliente de `routeRefs` sigue sin A*.)
- **E2 · Calidad de puertos siempre-on.** → **Sí.** Sort crossing-reduced + desempate estable +
  espaciado uniforme ya están en el `routeRefs` base (fase 1, commit `00551f2`; gratis para todo
  diagrama). La selección de lado de 4 vías y el A* son la parte on-demand.
- **E3 · Lados top/bottom.** → **Sí — `sourceSide`/`targetSide` ampliados a `'left'|'right'|'top'|'bottom'`** (`EdgeSide`).
  Sólo los produce el pase A* on-demand; `chooseSides` (render) queda L/R.
- **E4 · Progreso.** → **Porcentaje real** (loop A* propio, cede + emite progreso, cancelable).
- **E5 · `preserveManualEdges`.** → **El usuario elige por corrida; default ON** (preservar).

#### Presupuesto / riesgos del A*

- A* obstacle-avoiding es O(aristas × celdas exploradas). Medido contra spec 07 en
  `astar.perf.test.ts`: una grilla **densa** sintética de ~5000 tablas / ~1000 refs (no dagre — dagre
  separa tanto que ninguna arista necesitaría desvío, haciendo vacuo el peor caso) rutea en **< 3s**
  con `YIELD_EVERY` + cap `MAX_EXPLORED` de nodos explorados por arista (fallback a H-V-H sin crash) +
  ventana por arista (`GRID_MARGIN`) + procesar sólo no-manuales. **No** corre en el render path → no
  afecta FPS de pan/zoom (a diferencia de `routeRefs`, que sigue barato).
- El crossing-min de A* es **local/greedy** (penaliza cruces con lo ya ruteado, en orden `ref.id`),
  más débil que un layer-sweep global. Aceptable: el usuario priorizó un router único +
  obstacle-avoidance en tablas fijas sobre el óptimo global de cruces. Determinista pese a ser greedy.

## Limitaciones conocidas

1. **Obstacle avoidance** llega vía el comando on-demand de edge-ordering (§9, router A* propio,
   implementado), también con tablas fijas. El ruteo del **render path** (`routeRefs`, sin comando)
   sigue **sin** evitar tablas — sólo dibuja a través de los waypoints que A* persistió, o el H-V-H
   por defecto.
2. **Crossing-min greedy/local** (§9): A* penaliza cruces sólo contra lo ya ruteado, en orden
   `ref.id` — determinista pero no globalmente óptimo (más débil que un layer-sweep global).
3. **Tie-break de lado** binario (45° ⇒ horizontal) en el render path. Aceptable.
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

**Edge ordering (§9) — test plan (implementado):**
- **Grilla (`edgeOrder/grid.test.ts`):** origin snapeado a múltiplo de `ASTAR_CELL` (cells
  translation-invariant); `toWorld` enteros; `toCell→toWorld→toCell` idempotente; grid-too-big ⇒
  `null` (fallback); **rasterización conmutativa** (mismo mask con obstáculos en cualquier orden — el
  ancla de determinismo); inflado por `CLEARANCE`; `carveEndpoint` deja start/goal caminables aun bajo
  un obstáculo que cubre todo; `WorldUsage` clave por celda-mundo (colisión dentro de la celda,
  independiente entre celdas).
- **Motor A* (`edgeOrder/astar.test.ts`):** una arista cuya recta cruzaría una tabla intermedia se
  rutea rodeándola (**ningún segmento intersecta el bbox-obstáculo**); ruta ortogonal con ejes
  **alternados**; bends enteros; **entre `sourceStub`/`targetStub`** (los puertos no son waypoints; el
  primer/último bend conserva la Y del stub L/R ⇒ ancla columnY intacta); corredor limpio ⇒ `[]`
  waypoints; `chooseSides4` elige top/bottom apilado vertical, L/R lado-a-lado, y rutea un edge
  top/bottom rodeando un obstáculo lateral; **fallback** a `[]` (sin throw) al exceder `MAX_EXPLORED`;
  batch **determinista** (dos corridas byte-iguales; independiente del orden del array de entrada para
  aristas que no interactúan); **crossing accumula** (una arista paralela se desvía del corredor
  compartido — `WorldUsage` world-keyed); progreso monótono 0→100; **abort** lanza `AbortError` y no
  termina.
- **Perf (`edgeOrder/astar.perf.test.ts`):** grilla densa ~5000 tablas/~1000 refs **< 3000ms** con
  yield + cap; cap bajo ⇒ algunos fallbacks `[]` (degradación) y sigue < 3s; **ningún segmento de una
  arista ruteada intersecta un obstáculo, a escala** (muestreo); determinista a escala.
- **Runner / undo (`smartLayout/edgeOrdering.test.ts`):** `runEdgeOrdering` empuja **exactamente un**
  `ArrangeCommand` (posiciones vacías, `edgesTo` con waypoints SET); un Ctrl+Z restaura los
  `EdgeLayout` previos (color preservado), redo re-aplica; `preserveManual:true` deja la arista manual
  idéntica (la auto se re-rutea), `false` la re-rutea; no-op sin aristas; `computeEdgeOrdering`
  determinista.
- **Tipos/store (`store.edgeSide.test.ts`):** `setEdgeSide` acepta `top`/`bottom` y `null`;
  `EdgeStyleCommand` con `top` round-trip por undo/redo.
- **Serializador (`layoutStore.waypoints.test.ts`):** `sourceSide`/`targetSide` `top`/`bottom`
  round-trip; coexisten con waypoints; defaults omitidos; idempotente byte-estable; **rechaza** un
  valor de lado inválido (whitelist de 4).
