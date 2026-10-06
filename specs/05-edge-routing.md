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
     (hit-line, que agarra toda sección no rígida de largo > 0, aun sin vértice) — **DESLIZA toda la sección** perpendicular (`slideSegment`, 1-DOF). Son los "3 nodos
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
   *(Ni `chooseSides` ni el pase A* de §9 asignan `top`/`bottom` (decisión 2026-10-03, Limitaciones
   5); los tipos `sourceSide`/`targetSide` siguen admitiendo los 4 lados por back-compat de overrides
   manuales, ver §9.)*
5. **"Reset line":** resetea forma (waypoints + sides), conserva color.
6. **Endpoint = sólo flip de lado.** El "nodo real" (endpoint sobre la tabla)
   conmuta izq↔der (§4); **no** traslada la arista ni re-ancla a otra columna
   (confirmado con el usuario). Mover toda la arista no es una acción de endpoint.
7. **Stub RÍGIDO de longitud fija en ambos extremos (`MIN_STUB = 24` world units).**
   El tramo `source → sourceStub` y `targetStub → target` es **inmutable**: nunca
   arrastrable, nunca subdividible, **nunca colapsado** (son los segmentos
   `rigid` primero/último, de largo exacto 24, saliendo **perpendiculares a su lado**:
   horizontales en `left`/`right`, verticales en `top`/`bottom` — `STUB_DIR`). Mantienen
   coherente el punto de conexión (el marcador `1`/pata de gallo nunca queda
   pegado a la tabla). **Toda la edición vive estrictamente entre `sourceStub` y
   `targetStub`**, que actúan como los extremos fijos del polígono editable
   (`buildPath` conecta las esquinas literales entre ellos vía `cornersThrough`;
   sin waypoints usa `defaultEditableCorners`; luego envuelve con los dos stubs).
   `slideSegment`/`notchAtQuarter`/`isDipRun`/`deleteNotch` materializan las esquinas
   (`editableCornersOf`) entre `sourceStub`/`targetStub`, así editar una sección no toca el resto.
   **Clamp anti-spike (decisión 2026-10-03):** sólo para stubs **opuestos sobre el mismo eje**
   (der↔izq, abajo↔arriba), cada stub mide `min(MIN_STUB, ⌊gap/4⌋)` (`gap` = distancia entre puertos
   en ese eje; con `gap < 4` el cuarto queda fraccional para que el stub no colapse sobre el borde).
   Aplica a todo gap: la **mitad central** del hueco queda siempre como sección editable y los stubs
   nunca se cruzan. **Excepción — S de hueco angosto (decisión 2026-10-05, estilo dbdiagram; umbral
   revisado el mismo día con capturas de dbdiagram):** stubs `left`/`right` **enfrentados** con
   `0 < gap < 2·MIN_STUB` (48) y filas de puerto a `|Δy| ≥ MIN_STUB` (24) conservan **ambos stubs
   completos** (24) aunque se crucen, y el medio es la S (`narrowGapSJog` en `layout/edgeSides.ts`, §1
   "S de hueco angosto"), siempre que algún escalón la deje fuera de ambas tablas. Con filas casi
   alineadas (`|Δy| < 24`, no cabe el escalón con sus esquinas redondeadas), puertos espalda con
   espalda o tocándose (`gap ≤ 0`), `gap ≥ 48` o una S que correría dentro de sus tablas sigue el clamp
   a un cuarto. La regla es sólo geométrica (puertos,
   lados y bboxes de sus dos tablas, nunca waypoints), así las esquinas materializadas de una S editada
   siguen tocando los mismos stubs.
   Stubs en la **misma dirección** (p. ej. la C, ambos `right`) o perpendiculares
   nunca se cruzan y conservan el largo completo — antes el clamp los colapsaba a 0 y la arista
   corría pegada al borde, sin sección editable (auditoría F52). *(Antes: mitad del gap, así una
   arista misma-fila a < `2*MIN_STUB` quedaba como conector recto rígido sin sección editable.)*
8. **Animación de flujo en hover/selected.** Una `<path>` overlay (clon de `r.d`,
   `pointer-events: none`) con puntos redondos (`stroke-dasharray`) y
   `@keyframes ddd-edge-flow` animando `stroke-dashoffset` negativo → los puntos
   fluyen en la dirección de la relación (source→target, porque el path se dibuja
   `M source … L target`). Sólo se renderiza para la arista seleccionada y/o en
   hover (≤ 2 a la vez) → cero churn en el render de 5000 tablas. Respeta
   `prefers-reduced-motion` (se oculta con `display:none`).

### Preguntas abiertas restantes

- **¿Cómo distinguir la salida de A* de una forma manual? (auditoría F20, bloqueante para el
  resto del fix).** Hoy `hasManualShape` trata como manual cualquier waypoint o lado persistido, así
  que una arista ruteada por A* con desvío o con lado `top`/`bottom` nunca se re-ordena con
  "preservar manuales", y `computeEdgeResets` conserva sus lados aunque una tabla se mueva (quedan
  apuntando a la geometría vieja). Opciones: (a) marcador `auto: true` en `EdgeLayout`, persistido
  en el sidecar (cambio de schema del spec 03, aditivo) y borrado por toda edición de usuario;
  (b) heurística sin cambio de schema: como el flip manual es sólo L/R (decisión 4), tratar
  `top`/`bottom` como automáticos — no distingue waypoints de A* de waypoints del usuario;
  (c) aceptar el comportamiento actual. **Decisión (2026-10-01): (a).** `EdgeLayout.auto?: true`
  se persiste en el sidecar (aditivo, spec 03) en toda salida de A\* / auto-arrange; cualquier
  edición del usuario sobre esa arista (waypoints, flip de lado, reset, color no cuenta) lo borra.
  `hasManualShape` ignora las aristas `auto`, y mover cualquiera de sus extremos descarta su forma
  `auto` (waypoints y lados) en vez de dejarla apuntando a la geometría vieja.
  **Arrastre de tablas (decisión 2026-10-01):** en un arrastre todas las tablas arrastradas se
  mueven el mismo delta, así que una arista (ref o Dep, manual o `auto`) con **ambos** extremos en
  el conjunto arrastrado **traslada** sus waypoints ese delta (la forma se conserva, `auto` se
  mantiene), en el mismo paso de undo que el movimiento. Las aristas con un solo extremo arrastrado
  siguen igual (forma `auto` descartada; manuales y deps conservan sus waypoints), y el
  auto-arrange, que mueve cada extremo distinto, sigue descartando formas. **Implementado**
  (`computeDragEdgeChanges`) — ver "Marcador `auto`" en §9.

- **¿Las deps lógicas (spec 18, `depRouter.ts`) deberían adoptar la regla de zonas con C por la
  derecha?** Hoy eligen L/R por centros y recortan stubs a la mitad del gap (§10), así que con
  x-overlap su curva puede pasar por detrás de las tablas, y una ref y una dep entre las mismas dos
  tablas salen por lados distintos. Opciones: (a) reusar `chooseHorizontalSides` y el clamp a un cuarto (la C de una
  curva necesita handles hacia afuera en ambos extremos); (b) dejarlas como están (curva libre,
  editable por waypoints). Sin decidir; fuera del alcance de la decisión 2026-10-03.
- **Anidado de C — pendientes (2026-10-05, no bloqueantes).** (1) ~~La caja de culling de una arista
  es la unión de sus tablas: un trunk anidado muy afuera puede quedar fuera de ella.~~ **Resuelto
  (2026-10-05):** las C y los lazos también se cullean por su extensión dibujada (§8). (2) Lazos de dos
  tablas distintas que se enciman no se anidan entre sí (sólo por tabla). (3) ~~Una C bloqueada en
  un hueco angosto se anidaba a través de la tabla vecina.~~ Resuelto con el espejado por vecinos
  (arriba); sigue abierto sólo con **ambos** lados bloqueados: el render la anida a través del vecino
  y A\* la fija dentro (sin solaparse en y con un lazo, por los carriles) o cae a fallback.
  ~~Los lazos no miran al vecino (dos lazos a `borde + 60`, a 4 px de una columna a 64).~~ **Resuelto
  (2026-10-05):** la pila se recoge a `LOOP_CLEARANCE` del vecino (§Self-loops).
  (4) Los carriles salen del pase
  provisional: si una C bloqueada sale de A\* con waypoints, las C despejadas que anidaba pueden
  quedar hasta un escalón más adentro de su carril. ¿Conviene un segundo pase?
  (5) ~~**Z frente a una pila de lazos sin x libre (Limitaciones 7).**~~ **Decidido (2026-10-05,
  con el usuario): (b)** — la pila cede un carril a la Z ajena que pasa a su lado, en un solo pase
  determinista (alcance por vecino → reclamos de las Z → alcance final), con fallback al medio cuando
  ni la pila más comprimida lo abre. Ver §Self-loops "Carril para Z ajenas"; invalidación en spec 04.
- **S de hueco angosto — pendientes (2026-10-05, no bloqueantes).** (1) En `gap` 47 → 48 → 49 la
  forma es continua (las verticales se juntan en el punto medio y las esquinas conservan el radio). Sí
  hay salto en los otros bordes de la ventana: con `|Δy|` 24 → 23 o al dejar de despejar sus tablas la
  ruta pasa de stubs completos con escalón a stubs recortados con trunk al medio. *(Historia: una
  revisión intermedia del 2026-10-05 cortaba en 32 porque el escalón de 1–15 px de gap 33–47 se veía
  como un serrucho; las capturas de dbdiagram muestran que ese escalón chico es el aspecto buscado, y
  el serrucho venía de redondear a enteros el fillet de < 1 px y de medir el radio contra el stub
  recortado — §1 "Esquinas".)* (2) Sólo `left`/`right`: un override manual `top`/`bottom` enfrentado y angosto
  sigue con el clamp. (3) Una S editada (waypoints) cuyo par sale de la ventana al mover una tabla
  pasa a stubs recortados y `cornersThrough` inserta un codo contra las esquinas guardadas (igual que
  cualquier cambio de clamp). (4) Tablas encimadas en x (gap < 24) sin hueco vertical no tienen S: el
  clamp las deja como Z con trunk en el hueco visible, que con pocos px sigue siendo angosto.
- ~~**¿Handles en las mitades de una fila alineada con hueco chico?**~~ **Resuelto (2026-10-03,
  verificación visual):** con el umbral de `MIN_HANDLE_LEN` (16) sobre la hit-line, un par alineado
  con hueco < ~64 px no se podía editar (hueco 40 ⇒ mitades de 10 px: sin vértice y el arrastre sólo
  seleccionaba), lo que incumplía la decisión 7. Ahora **agarrar** y **mostrar** van separados: toda
  sección no rígida de largo > 0 se desliza desde su hit-line (con cursor por eje), y sólo el vértice
  azul (`≥ MIN_HANDLE_LEN`) y los fantasmas (`≥ MIN_GHOST_LEN`) siguen con umbral, porque no caben
  en un tramo corto.
- **Undo de color/flip** vive en `EdgeStyleCommand` (`history.ts`); el undo de
  forma en `WaypointCommand`. "Reset line" emite **un solo** `ArrangeCommand` de sólo
  aristas (`buildEdgesResetCommand`, snapshot completo del `EdgeLayout`): un Ctrl+Z
  restaura waypoints, sides y `dx/dy` legacy. Sin forma (manual o `auto`) → no-op (no limpia redo).
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

**Elegir lados** (`chooseSides` → `chooseHorizontalSides` en `layout/edgeSides.ts`, compartida con
A\*, §9): **siempre `left`/`right`**, por zonas al estilo dbdiagram con la **derecha favorecida**
(decisión 2026-10-03, Limitaciones 5). Con `gapR = tgt.x − (src.x + src.w)` y
`gapL = src.x − (tgt.x + tgt.w)`:

- `gapR > 0` (target enteramente a la derecha) ⇒ source=`right`, target=`left` (Z).
- `gapL > 0` (target enteramente a la izquierda) ⇒ source=`left`, target=`right` (Z espejada).
- Solape en x, **tocarse incluido** (`gap ≤ 0`), **con hueco vertical** (`gapY > 0`) ⇒
  source=`right`, target=`right`: una **C por la derecha** que rodea ambas tablas (la geometría
  misma-dirección de `defaultEditableCorners`, trunk anidado, abajo).
- **Bboxes que se intersecan** (solape en x **y** en y, tocarse incluido: lado a lado con `gap = 0`
  o apiladas con `gapY = 0`, `boxesIntersect`) ⇒ **C por la derecha si no atraviesa ninguna de sus dos
  tablas; si no, C por la izquierda; si ambas atraviesan, el conector enfrentado** (decisión
  2026-10-05, reemplaza la Z enfrentada, que con solape real quedaba casi invisible: puertos cruzados
  bajo la otra tabla). "Atraviesa" (`cClearsEndpoints`): algún brazo (puerto → trunk, stub incluido) o
  el trunk a `MIN_STUB` del borde más lejano pasa por el **interior** abierto de alguna de las dos
  tablas (correr sobre un borde no cuenta; cada brazo arranca en el borde de su propia tabla, así que
  sólo puede atravesar la otra). El anidado sólo empuja el trunk más afuera, así que la C sin anidar
  decide por todas. El conector enfrentado es la geometría opuesta por orden de centros (centro-x del
  source ≤ el del target ⇒ `right`→`left`, si no `left`→`right`): en el caso típico (lado a lado,
  cada fila corre por la otra tabla) los stubs se recortan a 0 y la arista es el tramo vertical sobre
  el borde compartido. La regla necesita las **filas de puerto**: el router las lee a ratio ½ (fila de
  columna resuelta, si no el medio del lado; `halfRatioRows`), igual que las specs de trunk, así sólo
  depende de bboxes + filas de columna y `routeMoved` coincide con un rebuild. Llamadas sin filas
  (`chooseSides`/`chooseSides4` sólo con bboxes) usan las filas de los centros. La C elegida entra al
  anidado como cualquier C; su espejado por vecinos (abajo) sólo se permite si la C espejada tampoco
  atraviesa sus tablas.

**Anidado de C (decisión 2026-10-05, `nestTrunks` en `edgeRouter.ts`).** Antes todo trunk de C caía
en `max(stub)` = borde + 24, así que dos C distintas compartían una misma vertical y una C corría
sobre el trunk de un self-loop (visto en `selfloop.dbml`). Ahora, para toda C **automática** (mismo
lado `left`/`right` en ambos extremos, sin waypoints ni `dx` legacy; manual o `auto` sin waypoints
incluidas — las que llevan waypoints conservan su forma literal):

- **Piso:** en coordenadas locales del lado (x crece hacia afuera; `−x` a la izquierda), el trunk
  queda en `max` sobre sus dos tablas de `borde + (n > 0 ? loopReach(n + 1) : MIN_STUB)`, con `n` =
  lazos de esa tabla en ese lado: **`LOOP_STEP` (12) por fuera del lazo más lejano** de cualquiera de
  sus tablas (el lazo más lejano está a `loopReach(n)`), aunque sus puertos no caigan en el tramo
  del lazo. Sin lazos es el `max(stub)` de siempre (redondeado igual).
- **Anidado:** los lazos se colocan primero (fijos por su rango). Las C de un mismo lado se colocan
  por **tramo vertical** ascendente (`|a.y − b.y|` de sus puertos; desempate por `ref.id`, nunca el
  orden de `refs[]`): cada una arranca en su piso y, recorriendo las ya colocadas por trunk
  ascendente, salta a `otro + LOOP_STEP` cuando (a) sus extensiones verticales se solapan (cerradas),
  (b) los brazos de la otra arrancan dentro de su alcance (`otro.inner ≤ x`, `inner` = borde más
  cercano de donde salen sus brazos) y (c) `otro + LOOP_STEP > x`. Una sola pasada basta (los saltos
  sólo crecen). Resultado: la de tramo menor queda adentro, C con extensiones solapadas quedan a
  ≥ `LOOP_STEP` entre sí y fuera de todo lazo que toquen (también de una tercera tabla); C de otra
  columna (brazos fuera de alcance) no se empujan. A la izquierda es el espejo exacto.
- **Vecinos (decisión 2026-10-05, tras verificación visual).** El anidado empuja trunks hacia
  afuera sin mirar la columna vecina: con el hueco por defecto del layout (64 px) un trunk a
  `borde + loopReach(3)` (o la 3.ª C sin lazos) caía **bajo la tabla vecina** y la C parecía entrar
  en ella. Ahora el router recibe una consulta de obstáculos (`ObstacleQuery`: tablas y grupos
  colapsados renderizados; los contenedores de grupo no cuentan) y una C **automática** (lados sin
  persistir) se **espeja** (`left`/`left`) cuando su slot anidado no está libre y el espejado sí.
  "Libre" = ningún nodo ajeno a sus dos tablas toca la franja que va de su borde más cercano hasta
  `trunk + MIN_STUB` a lo largo de su tramo vertical (brazos + trunk, y el trunk queda fuera de la
  franja de stubs del vecino). Con ambos lados bloqueados conserva el suyo (el anidado manda; "Order
  edges" puede desviarla). Una C con lados persistidos (manual o de A\*) nunca se espeja. Sin consulta
  (tests, callers viejos) no hay espejado. Con 64 px caben 2 C anidadas por lado sin lazos; con un
  lazo en una de sus tablas, ninguna. La regla es determinista: la C se decide en el orden del
  anidado (tramo, `ref.id`) y las specs leen los lados **base** (sin espejar), filas de columna y
  bboxes —nunca ratios de puertos—, así un espejado no realimenta su propia causa; sólo el tramo de
  un puerto sin columna resuelta (ratio ½) es aproximado. La usan el canvas (`app.tsx` pasa el
  `spatialIndex` de la escena), el export de imagen y el pase provisional de A\* (§9).
- **Drag:** el rango depende de posiciones, así que `routeMoved` recalcula el `TrunkSpec` de cada
  arista afectada y, si alguna es o era lazo/C —o hay alguna C espejable y consulta de obstáculos,
  porque mover **cualquier** nodo (aun sin refs) puede bloquear o liberar su lado— re-anida
  **todas**, re-decide los puertos de las C cuyo espejado cambió y re-rutea cada C cuyo trunk cambió.
  Las specs no afectadas no cambian (lados base, filas y bboxes), así que equivale a un rebuild
  completo. Costo: `O(C log C + vecinos)` + una consulta al índice por C espejable, por frame, sólo
  cuando hay C en juego (huge.dbml: frame incremental ~0,7 ms, sin cambio medible).

La Z llega hasta que las tablas se tocan: con un hueco de 1 px sigue siendo Z, el clamp de stubs
(decisión 7) deja la mitad central editable y el trunk cae en el **punto medio** del hueco
(`midpointBetween`: el medio redondeado, o el exacto si redondear lo pegaría a un extremo de stub,
gaps de 1–3 px). Nunca sale por `top`/`bottom`: ni por sí misma ni por un lado persistido, manual o
`auto`, que se ignora entero (§Migración de formas pre-0.4). Los self-loops no pasan por esta regla (§Self-loops).

**S de hueco angosto (decisión 2026-10-05, referencia dbdiagram; umbral sólo en x).** Con el clamp a
un cuarto, un par a pocos px (p. ej. hueco 10 ⇒ stubs de 2) dejaba el trunk apretado contra ambas
tablas. Ahora, para stubs `left`/`right` enfrentados con `0 < gap < 2·MIN_STUB` (48) y
`|Δy| ≥ MIN_STUB` entre las filas de puerto (`narrowGapSJog`): ambos stubs miden `MIN_STUB` completos,
el escalón mide `48 − gap` (1 px en gap 47: un escalón chico es lo esperado, como en dbdiagram) y
el medio por defecto es `aStub → (aStub.x, jogY) → (bStub.x, jogY) → bStub`: baja (o sube) pegado a
su stub, cruza en horizontal y baja al stub destino. Son **tres tramos editables** separados (V-H-V),
cada uno con su vértice/fantasmas cuando su largo alcanza los umbrales. El `dx` legacy no aplica (no
hay un trunk único).
**Consciente de las cajas (revisión 2026-10-05).** Con `gap < 24` los stubs completos pasan el borde
de la otra tabla, y en layouts empaquetados (huecos de 16) la S corría escondida bajo sus propias
tablas. `jogY` se elige entre dos candidatos, en orden: el punto medio de las filas
`round((a.y + b.y) / 2)` y, si una tabla está entera encima de la otra, el medio del hueco vertical
entre ellas (como dbdiagram, que escalona en ese hueco). Se toma el primero con el que **ningún tramo**
(los dos verticales, el escalón y cada stub contra la otra tabla) entra en el bbox de alguna de las
dos tablas inflado `S_CLEARANCE` (4 px; un tramo sobre el contorno se dibuja debajo de la tabla). Si
ninguno sirve (p. ej. lado a lado con filas solapadas a hueco 10–16, o un hueco vertical de < 8 px)
rige el clamp, cuyo trunk queda en el hueco visible. Fuera de la ventana rige lo de arriba (clamp +
trunk al punto medio). Aplica también a lados persistidos (manuales o de A\*) que cumplan la
geometría.
**Continuidad en 48.** Con `gap = 48` los dos stubs completos terminarían en la misma x, que es
justo el punto medio donde la Z (clamp a 12 + trunk al medio) pone su trunk: una sola vertical. De
ahí en adelante rige la Z, así 47 → 48 → 49 mueve cada esquina a lo sumo 1 px. Con `gap ≤ 0` y
hueco vertical rige la C (arriba).
**Esquinas** (`roundedPathString`). El radio de cada fillet se acota a la mitad del **tramo recto**
a cada lado hasta el próximo giro, atravesando puntos colineales (el fin de un stub recortado): en
gap 48 el trunk tiene el mismo radio 8 que la vertical de la S en 47, en vez de 6 por el stub de 12.
Un punto colineal se emite sólo fuera de los fillets vecinos (dentro haría retroceder el path). Las
coordenadas de fillet se redondean a 2 decimales, no a enteros: un escalón de 1 px tiene fillets de
0,5 que redondeados a entero colapsaban en un `Q` degenerado y un salto seco.

**Z frente a lazos (decisión 2026-10-05; lazos propios, revisión 2026-10-05).** El trunk de una Z enfrentada (sin waypoints ni `dx`
legacy, filas distintas, no la S: su **carril** `facingZLane`, estrictamente entre los fines de stub ×
sus dos filas) que en el punto medio cae dentro de la **envolvente** de los lazos de una **tercera**
tabla —`borde … trunk del lazo` × filas del lazo, inflada `LOOP_CLEARANCE` (8), con las filas solapando
(cerrado) el tramo vertical de la Z— se **desliza** a la x libre más cercana al medio, estrictamente
entre los fines de stub (`placeZTrunk`). De los lazos de sus **propias** tablas sólo cuenta el
**trunk**, `trunk ± 8` sobre las filas del lazo (`loopBlock`): su puerto sale por esa envolvente igual,
así que cruzar sus brazos es inevitable, pero el trunk de la Z nunca corre pegado al del lazo
(revisión 2026-10-05: con hueco 96 el medio caía justo sobre el lazo `W+48` de departments). La S no
desliza (sus verticales son los stubs completos).
**Carril cedido (decisión 2026-10-05, opción (b) de la pregunta abierta (5)).** Si el carril no tiene
x libre, la pila de lazos que lo bloquea **se recoge** para dejarle una (§Self-loops "Carril para Z
ajenas"); sólo si ni la pila más comprimida alcanza, el trunk conserva el medio. Caso de referencia
(`selfloop.dbml` completo + `audit` a 64 px + `departments.audit_id → audit.id`, carril `W+16 … W+48`,
medio `W+32`): los lazos de employees pasan de `W+44`/`W+56` (recogidos por el vecino) a
`W+32`/`W+39`, el lazo propio `parent_id` de departments de `W+48` a `W+39`, y el trunk de la Z a
`W+47`, a 8 px de ambos trunks `W+39`; su brazo en la fila de `manager_id` corre `W+47 → W+64`, el
del lazo `W → W+32`, y su brazo de salida (fila `audit_id`, bajo el lazo de departments) no cruza
nada: nada se toca. (La primera versión ignoraba el lazo propio, que quedaba en `W+48` a 1 px del
trunk `W+47` y desaparecía bajo la Z.) Con 120 px de hueco el trunk ya tiene x libre (`W+68`) y los
lazos no cambian.
**`routeMoved`.** Las rutas cuyo carril (índice por x, `LaneGrid`) toca la envolvente vieja o nueva de
un lazo que cambió se re-rutean; ninguna otra ruta lee envolventes. Así coincide con un rebuild sin
recorrer todas las rutas.

**Distribuir ports** en cada lado: agrupar por `(table, side)`, sortar por el
otro extremo a lo largo del lado (reducción baricéntrica de cruces: en `left`/`right` por la `y`
del centro lejano — más arriba ⇒ puerto más arriba —; en `top`/`bottom` por su `x` — más a la
izquierda ⇒ puerto más a la izquierda. Hasta 2026-10-02 el eje estaba invertido y el orden salía
casi siempre del desempate), **desempate por `ref.id`**
para que la asignación dependa sólo de geometría + ids estables, nunca del orden del
array `refs[]` (que `@dbml/core` puede reordenar al re-parsear — invariante git-friendly:
mismo schema ⇒ mismos puertos). Asignar `ratio = (i+1)/(n+1)` (equidistante, sin tocar
esquinas; clamp `[0.05, 0.95]`). Alinear `y` del puerto a la fila de la columna PK/FK vía
`columnYResolver` (`columnCenterY`).

**Filas renderizadas, no columnas del schema.** El índice de fila y el alto del bbox salen
de `buildRowGeometry` (`layout/tableRows.ts`), el mismo helper (`renderedRows`) con el que
`TableNode` dibuja: con "PK/FK columns only" cuentan sólo las filas PK/FK, y una tabla
added/modified en diff cuenta sus filas de diff inline (el puerto va a la fila viva —
context/added/`+`new—, nunca a la `-`old/removed). App lo memoiza en `rowGeometry` y lo usa
también para contenedores de grupo, spatial index, `worldBbox` y objetivos de diff; antes
todo usaba la lista completa y con el filtro el puerto FK quedaba filas por debajo de la
tabla y el contenedor de grupo sobresalía (auditoría F08). El export de imagen sigue con
todas las columnas (spec 17), con sus propios contenedores (`exportContainers`). El pase A*
on-demand (§9) sigue midiendo columnas completas: lo que persiste no depende del filtro de
vista.

**Computar path** (`buildPath`): polilínea ortogonal de ejes alternados. El
**polígono editable** se rutea entre los extremos fijos `aStub`/`bStub` (decisión
7) conectando las **esquinas literales** del usuario directamente (`cornersThrough`,
sin colapsar — un codo de seguridad sólo para un par no-alineado v1, que junto a un
stub avanza primero sobre el eje de ese stub, así tras un stub `top`/`bottom` nunca
corre plano sobre el borde); sin waypoints ⇒ `defaultEditableCorners`: stubs
horizontales opuestos ⇒ H-V-H con `midX` en el punto medio (`midpointBetween`, + `dx` legacy), salvo
la **S de hueco angosto** (V-H-V entre stubs completos, `narrowGapSCorners`, ver arriba);
**misma fila** (`aStub.y === bStub.y`) ⇒ el mismo H-V-H con trunk de largo 0: dos esquinas
coincidentes en `midX` parten el tramo medio en **dos mitades editables** (deslizar/notch), y se
dibuja como una sola recta (decisión 2026-10-03; antes era un único tramo recto sin división); stubs
verticales (sólo override manual) ⇒ el espejo V-H-V con `midY` en el punto medio (el `dx` legacy no
aplica); uno de
cada ⇒ una sola L; stubs en la **misma dirección** ⇒ ruta en C cuyo trunk queda más
allá del stub que más sobresale (`max`/`min`), nunca de vuelta sobre un stub ni a
través de una tabla. Luego se **envuelve** con los stubs rígidos: `corners = [a, ...editable, b]`,
así `a→aStub` y `bStub→b` sobreviven como segmentos propios. `buildSegments` marca
`rigid` el primero y el último. (Las ops de edición usan `cleanCorners` —quita sólo
puntos coincidentes/colineales redundantes— tras un *slide*; el ruteo base no
canonicaliza.) Migración legacy `dx`/`dy` conservada. `routeRefs` expone
`sourceStub`/`targetStub` en el `EdgeRoute`.

> **Invariante:** todo segmento es estrictamente H o V; ejes alternan. Los stubs
> primero/último son `rigid` (inmutables), de largo fijo `MIN_STUB` y perpendiculares
> a su lado.

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
- **Deslizar (vértice real / agarrar la sección):** la hit-line `.ddd-edge-segment-handle` (en toda
  sección no rígida de largo > 0, también las demasiado cortas para el vértice, p. ej. las mitades de
  10 px de un par alineado a 40 px) o el vértice central inician `startSegmentSlide` → `slideSegment` (1-DOF perpendicular, inmediato). La
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
- **S de hueco angosto (§1):** sus tres tramos (vertical junto al stub origen, escalón horizontal,
  vertical junto al stub destino) se deslizan y aceptan notch como cualquier sección; deslizar un
  vertical inserta el codo contra su stub (vecino paralelo), deslizar el escalón mueve sus dos
  esquinas. Las esquinas materializadas son literales y, como el largo del stub sólo depende de la
  geometría, siguen tocando los stubs completos.
- **Snap a rejilla** si el imán está ON.

Implementación: `edgeLayer.tsx` (`SelectedEdgeRuns`: hit-line agarrable `!loop && !rigid && len > 0`;
vértice real `+ len ≥ MIN_HANDLE_LEN`; fantasmas
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
más allá del centro del campo conmuta el lado y persiste. El gesto arranca tras
`CLICK_THRESHOLD_PX` (4 px de pantalla), como el drag de tabla: sin umbral, el temblor de un click
sobre un puerto cercano al centro-x de la tabla (p. ej. uno `top`/`bottom` de override manual)
fijaba un lado y reemplazaba la ruta automática (2026-10-02). El flip parte del layout **dibujado**:
sobre una forma `auto` legada con `top`/`bottom` (ignorada, §9) la reemplaza entera.

### 5. Toolbar de arista seleccionada (color + reset) — reemplaza click derecho

- Nuevo estado de selección de arista: `selectedEdgeId: string | null` en el
  store (+ acción `setSelectedEdge`). Click sobre la arista la selecciona;
  resalta y muestra toolbar flotante cerca del midpoint.
- Toolbar: **↻ Reset line** (resetea waypoints +
  flip de esa arista vía `resetEdgeWaypoints`) y **⚙ opciones** → abre
  `ColorPopup` reusando `popupAnchorFor`, escribe `EdgeLayout.color`.
- Reemplaza el `ContextMenu` por click derecho de waypoint en `edgeLayer.tsx`
  (más intuitivo, confirmado por el usuario).
- Spec 19: la toolbar de una FK suma **🗑 Delete relation** (`schema:delete { kind: 'ref' }`), y el
  click derecho sobre una FK abre un `ContextMenu` con esa sola acción. Las aristas `Dep` no la
  tienen. El borrador del arrastre de FK es un `<path>` más de este mismo SVG overlay.
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
   hover. Ahora el ruteo es O(refs) una vez por movimiento, no por frame. Durante un drag ni
   siquiera eso: `EdgeRouteCache.routeMoved` re-rutea sólo las refs de las tablas movidas y las
   que comparten grupo de puertos con ellas, conservando la identidad del resto (spec 04 "Drag
   incremental").
2. **Route-all-then-cull (puertos estables).** Se rutean **todas** las
   `effectiveRefs` (no el subconjunto visible) y luego se filtran las *rutas* por
   `visibleRefIds` (cajas de escena, spec 04) **o** por su extensión dibujada cuando la ruta puede
   salir de la unión de sus tablas: una C (trunk anidado afuera de lazos y otras C) o un lazo
   (`routeReachBoxes` + `useVisibleEdgeIds` en `EdgeLayer`, decisión 2026-10-05). Así una arista
   cuyo trunk está en pantalla nunca se cullea aunque ambas tablas estén fuera, sin importar la
   profundidad del anidado (antes sólo lo cubría `VISIBILITY_MARGIN`, ~19 niveles).
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

> **Estado real de las 4 metas (auditoría 2026-09-08):** la meta 3, *mejor selección de lado*,
> sigue **abierta**: `routeOneEdge` hace **una** búsqueda con los lados que le da `chooseSides4`
> y descarta el coste; no existe comparación de coste entre pares de lados (su docstring lo
> afirmaba y se corrigió). Desde 2026-10-03 la única alternativa de lado es la C de
> `provisionalSides` cuando una franja de stub está bloqueada (abajo). **`MAX_GRID_CELLS` bajó de 4M a 250k**: `searchGrid` reserva ~105 B por
> celda antes del primer pop, así que el tope es en realidad un tope de memoria (250k ≈ 26 MB por
> arista; 4M permitía ~420 MB con una sola tabla lejana). Ventanas mayores caen al H-V-H por defecto.

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

##### Modelo de lados: sólo `left`/`right` (decisión 2026-10-03, reemplaza el modelo híbrido)

La decisión 7 dice que A* rutea **entre los stubs ya elegidos**; la meta 3 sugería que A* eligiera
el lado (incl. top/bottom). Del 2026-05-31 al 2026-10-02 rigió un modelo **híbrido** (A* podía
persistir `top`/`bottom`, y desde 2026-10-01 también el render con x-overlap); se revirtió porque
dejaba FKs pegadas bajo la tabla, puertos despegados de la fila de columna y tablas apiladas unidas
por una recta vertical (Limitaciones 5). Modelo vigente:

- **Render y A* usan la misma regla de zonas** (§1, `chooseHorizontalSides` en
  `layout/edgeSides.ts`; `chooseSides` y `chooseSides4` la delegan). El módulo es puro y sólo importa
  tipos, así `edgeOrder/` sigue sin importar nada de `render/edgeRouter.ts`. Siempre `left`/`right`:
  el puerto queda anclado a su fila de columna (`columnY` ancla sólo en L/R).
- **Franja de stub bloqueada.** `provisionalSides` (`smartLayout/edgeOrdering.ts`) prueba, en
  orden, el par de zonas, una C por la **derecha** y una C por la **izquierda**; gana el primero cuyas
  dos franjas de stub (todo el lado × `ASTAR_CELL + CLEARANCE` hacia afuera) no tocan una **tercera**
  tabla — en tablas empaquetadas (hueco `BASE_MIN_GAP` = 16 < stub) el extremo del stub caería dentro
  de la vecina y A\* sólo llegaría a él cruzándola. Si ninguno está libre se queda el par de zonas.
  Una C candidata además debe despejar sus **dos tablas** (`cClearsEndpoints` con las filas de
  columna de los puertos): lado a lado, un brazo de cualquier C atraviesa la otra tabla y la arista
  queda escondida (revisión 2026-10-05, par `quotas → payment_applications` de isga al ordenar).
  *(Desde esta decisión el chequeo corre también sobre L/R, así layouts empaquetados pueden persistir
  más C por la izquierda que antes.)* Tablas que se intersecan no prueban C aquí: conservan el par de
  zonas, cuya C o conector enfrentado elige el render en vivo (§1).
- **C despejadas quedan al render (decisión 2026-10-05).** El pase `routeRefs` provisional incluye
  **todas** las refs dibujables (lazos y manuales preservadas también: comparten grupos de puertos y
  el render anida contra ellas) y recibe el índice de tablas como `ObstacleQuery`, así espeja las C
  que un vecino bloquea igual que el canvas (§1 "Vecinos"). Para eso el resolver provisional **no**
  fija el par de zonas (sólo un par distinto, p. ej. el de franja bloqueada), y los lados que A\*
  recibe son los **dibujados** (`sidesOf` de la ruta), no los provisionales. Una arista cuya ruta por
  defecto —ya anidada y quizá espejada— es una C que no cruza el interior de una **tercera** tabla no
  pasa por A\*, tampoco una **S de hueco angosto** (§1, que `narrowGapSJog` ya dejó fuera de sus dos tablas) que no cruza el interior de una tercera tabla
  (su escalón a media altura entre stubs completos es justo lo que A\* aproximaría en su grilla, y viva
  sigue a las tablas), ni un par de tablas que se intersecan dibujado como **conector enfrentado** (§1;
  si el render eligió una C que no atraviesa sus tablas, es una C más): sale con `[]` waypoints
  (lados sólo si difieren de `chooseSides`) y el render la anida a `LOOP_STEP`, más fino que la
  grilla de 24 de A\* y re-anidada en vivo al mover tablas (los waypoints de A\* son fijos). Sólo una
  C bloqueada va a A\*. Si A\* la resuelve con una recta entre stubs (`[]`), `pinStraightC` la fija
  como waypoints en esa columna (nunca dentro de un stub; stubs alineados ⇒ una esquina al medio):
  sin waypoints el render la volvería a anidar contra la tabla que la bloqueó. Una C espejada por el
  render sale `{}` (su par base coincide con `chooseSides`): no se persiste el espejado, así el render
  lo re-decide en vivo si la vecina se mueve. Llega a A\* sólo una C con ambos lados bloqueados.
  **Z con carril cedido (2026-10-05):** una Z cuya ruta provisional lleva `laneClaim` (§Self-loops
  "Carril para Z ajenas") y no cruza una tercera tabla también sale `{}`: persistir cualquier forma
  terminaría su reclamo y la pila volvería a abrirse sobre el carril. Así lo que A\* vio (lazos
  recogidos) es lo que el render dibuja.
- **Carriles (lanes) — A\* nunca corre por un trunk de lazo ni de C (decisión 2026-10-05).** El
  adaptador pasa como `lanes` los tramos verticales editables de los lazos, de las C que quedaron al
  render y de las C manuales preservadas; `orderEdges` suma los tramos verticales de cada C que rutea
  (lados iguales, con waypoints) para las aristas siguientes. `RouteGrid.rasterizeLane` marca cada
  celda cuyo centro cae a ≤ `CLEARANCE` del carril (también en y) como **prohibida en vertical**:
  `searchGrid` no entra ni sale en N/S de ella, pero cruzarla en horizontal sigue permitido (un
  puerto dentro del tramo de un lazo puede salir). Garantía: ningún tramo vertical de A\* queda a
  menos de `LOOP_STEP` de un carril con extensión solapada; si no hay salida, fallback `ok:false`
  (ruta por defecto, anidada). Un lazo recogido por un reclamo aporta **dos** carriles: su trunk
  dibujado y `unyieldedTrunkX`, donde vuelve cuando la Z que reclamó (y que cruza una tercera tabla,
  así que va a A\*) persiste sus waypoints y deja de reclamar. Se descartó usar el sobre del lazo como obstáculo duro: bloqueaba
  todo puerto del lado dentro del tramo del lazo y forzaba fallbacks.
- **Waypoints siempre con sus dos lados; sin waypoints, sólo lados que aportan información**
  (auditoría F20, ajuste 2026-10-03): toda salida de A\* con waypoints persiste `sourceSide` y
  `targetSide` aunque coincidan con `chooseSides`, así el render nunca empareja un desvío con otros
  puertos y un `auto` con waypoints y sin lados queda reconocible como legado (abajo). Sin waypoints,
  un par igual a `chooseSides` no se escribe (la C izquierda sí), y un fallback (`ok:false`) no
  escribe lados provisionales. Todo va marcado `auto` (abajo), así que no cuenta como forma manual.
- **Formas legadas se ignoran** (`isLegacyEdgeShape`, `layout/edgeSides.ts`): se tratan como
  ausentes (`effectiveEdgeLayout` las reduce a su color) (a) cualquier forma con algún lado
  `top`/`bottom`, **manual o `auto`** (decisión 2026-10-06, §Migración de formas pre-0.4: el A\*
  anterior podía persistirlos y la UI sólo fija izquierda/derecha), y (b) un `auto` con waypoints, **sin** lados, entre tablas
  cuyo par de zonas es la C `right`/`right` (x-solape): los pases anteriores dejaban los lados
  implícitos y ruteaban para `bottom`/`top` (v0.3.0, columnas apiladas del auto-arrange) o para L/R
  por centros (antes de `1b3e970`), nunca para la C, y dibujarlos con sus stubs la hacía volver
  atrás atravesando la tabla. (b) necesita los bboxes, así que el filtro corre en `decideSides` y el
  layout filtrado viaja en la decisión hasta `buildRoute`: lados y waypoints de una ruta salen
  siempre del mismo layout. Un `auto` sin lados entre tablas sin x-solape se conserva (su zona no
  cambió). La ruta marca `shapeIgnored`; la edición parte de lo dibujado: `forgetIgnoredShape`
  (`dragController.ts`) borra la forma ignorada (conserva el color, fuera del undo: nunca se veía)
  antes de deslizar, hacer/borrar un notch o tocar un endpoint, así un flip no revive waypoints
  ruteados para otros puertos. `setEdgeWaypoints`, `setEdgeSide` y el snapshot del drag además leen
  el layout efectivo sin bboxes (cubre (a)). Fuera de (a), un override **manual** (sin `auto`) se
  respeta siempre. `hasManualShape` también lee el layout efectivo: una forma ignorada no cuenta como
  manual, así "preservar manuales" no la deja sin ordenar.
- **S bloqueada.** Una S que sí cruza una tercera tabla va a A\* entre los stubs **completos** que dibuja
  el render (los extremos cruzados: `aStub.x` más allá de `bStub.x`); su fallback (`ok:false`, sin
  waypoints) es la S misma. Los lados de una intersección se deciden en el render con las filas reales:
  el adaptador sólo compara pares por bboxes (`chooseSides4` = `chooseSides` sin filas), así que nunca
  persiste lados para ellas y el render los re-decide en vivo.
- Sin contradicción con la decisión 7: el **adaptador** asigna los lados provisionales a TODAS las
  aristas **antes** de su pase `routeRefs`, de modo que los stubs ya distribuidos que A* conecta son
  los que persisten (sin codo en el primer render). El motor permanece agnóstico de puertos (sigue
  ruteando lados `top`/`bottom` si un llamador se los da).

**Dos planos de trabajo, distinta cadencia:**

1. **Calidad de puertos — SIEMPRE activa, barata (E2).** Mejora en el seam de asignación de puertos
   existente de `routeRefs` (§1 "Distribuir ports"), sin comando: sort baricéntrico con **desempate
   estable** determinista (menos cruces de aristas paralelas en un lado) + **espaciado uniforme**.
   Sigue O(aristas), memoizada, corre en cada cambio de geometría como hoy. El tramo medio queda en
   el H-V-H por defecto, o la C por la derecha con x-overlap (sin A* en el camino caliente).
2. **Ruteo A* obstacle-avoiding — ON-DEMAND, costoso (E1).** El comando "ordenar aristas" corre A*
   sobre una grilla propia (cell = `ASTAR_CELL = 24` = `MIN_STUB`). Las celdas-obstáculo de las tablas
   se reúnen reusando la **clase** `SpatialIndex` — un índice **desechable** que el adaptador
   reconstruye desde las posiciones **finales** (la instancia de `app.tsx` no es alcanzable desde
   `runner.ts` y además tendría posiciones viejas durante un arrange). Las dos tablas **extremo** de
   la arista también son obstáculo (decisión 2026-10-02; antes se excluían y A\* podía cruzar su
   propia tabla y llegar al extremo del stub desde el lado-tabla, lo que el render dibujaba como un
   espolón de vuelta sobre el stub); `carveEndpoint` sigue abriendo la celda del extremo del stub y la
   siguiente hacia afuera. Rutea entre `sourceStub` y
   `targetStub` de cada arista, penalizando cruces con aristas ya ruteadas (crossing-min incremental
   vía una `WorldUsage` con clave en coords-mundo, independiente de la ventana). Produce bend-points
   → `EdgeLayout.waypoints` (esquinas literales, §3), que el ruteo base ya envuelve con stubs +
   fillets. **No** corre por frame ni en `routeRefs`: sólo al activar el comando; luego `routeRefs`
   dibuja a través de los waypoints guardados (`cornersThrough`). Funciona con tablas fijas (lo que el
   motor de tablas no daba).

**Mapeo al modelo existente (único cambio de schema: el marcador aditivo `auto`, abajo):**
- Bend-points de A* (coords world) → `EdgeLayout.waypoints` (§3). Los stubs rígidos + fillets se
  aplican sin cambios; el anclaje de puerto a la fila PK/FK (`columnYResolver`, §1) se conserva en los
  extremos (A* rutea entre los stubs, no toca los puertos).
- Selección de lado → `EdgeLayout.sourceSide`/`targetSide`. **El tipo se amplió a
  `'left' | 'right' | 'top' | 'bottom'`** (E3, `EdgeSide` + guard `isEdgeSide` en `shared/types.ts`);
  `portPoint` ya dibuja los 4 lados. El **validador de lectura del host** (`layoutStore.ts:108-109`,
  antes hardcodeado a `left`/`right`) se amplió al whitelist de 4 lados — sin esto un `top`/`bottom`
  persistido se descartaba en cada reapertura. El **serializador no cambió** (ya hace
  `JSON.stringify` del valor; defaults omitidos sólo por ausencia, no por valor). Desde la decisión
  2026-10-03 ningún camino automático escribe `top`/`bottom`: el whitelist de 4 lados queda por
  back-compat (overrides manuales y sidecars viejos, cuyo `auto` vertical se ignora).

**Integración con el runner (`runner.ts`, spec 13):** hoy el arrange **limpia** los waypoints de
aristas cuyos dos extremos se movieron (para que `columnYResolver` re-rutee limpio). Con edge-ordering
ON, en vez de limpiar se **setean** los waypoints con la salida de A*. Reusa el snapshot de aristas que
el `ArrangeCommand` **ya** transporta (`edgesFrom`/`edgesTo`) → un único Ctrl+Z revierte tablas +
aristas, como ya ocurre. `preservar manuales` ⇒ se excluyen del re-ruteo las aristas con forma manual
previa (waypoints/sides/dx-dy **sin** `auto`).

**Marcador `auto` (auditoría F20, decisión 2026-10-01).** Toda forma que escribe el pase A\*
(`edgeOrdering.ts`: waypoints con sus dos lados y/o lados que aportan información) lleva `EdgeLayout.auto: true`, que
viaja por todo el camino de persistencia (sidecar `edges.*.auto`, spec 03; `persistence.ts`;
`store.setLayout`). Reglas:

- `hasManualShape` = tiene forma (`hasShape`) **y no** es `auto`: una corrida con "preservar
  manuales" re-ordena las aristas de A\* (antes la segunda corrida era un no-op silencioso).
- Mover un extremo descarta la forma `auto` entera (waypoints + lados, conserva color) —
  `computeAutoShapeDrops` (`edgeReset.ts`), con **cualquiera** de los dos extremos movido (el lado
  depende de la geometría relativa). Aplica en el auto-arrange (`runner.ts`, junto a
  `computeEdgeResets`, que ahora ignora las `auto`), en el reacomodo de selección y en el commit de
  un drag de tabla **sólo** para las aristas con un único extremo arrastrado. Se evalúa sobre
  **todas** las refs del schema con su clave cruda (`rawLayoutRefs`): una arista cuyo otro extremo
  está oculto/colapsado sigue siendo de A\* y queda igual de vieja.
- **Drag de tablas** (`computeDragEdgeChanges`, decisión 2026-10-01): toda arista — ref (manual o
  `auto`) o dep (`rawLayoutDeps`) — con **ambos** extremos en el set arrastrado traslada sus
  waypoints por el delta **realmente commiteado** (con snap, el delta ya redondeado de la tabla
  `source`/`upstream`; si los orígenes están fuera de grilla cada tabla puede moverse distinto, o
  quedarse quieta, y la arista viaja con su `source`: sigue siendo "interna" aunque el snap deje un
  extremo en su lugar, así una forma `auto` no se descarta por eso). Lados, color y `auto` no
  cambian; una forma `auto` sin waypoints (sólo lados) queda intacta porque la geometría relativa no
  cambió. Los self-loops no se trasladan (§Self-loops): no tienen waypoints. Todo en el mismo
  `ArrangeCommand` del movimiento (label `Move …`, spec 11): un Ctrl+Z devuelve tablas y waypoints, el redo los re-aplica. Se calcula una
  vez en el commit (no por frame: durante el arrastre los waypoints quedan fijos y el drag
  incremental del spec 04 no cambia); en solo lectura no se aplica nada.
- Toda edición del usuario de esa arista borra el marcador: waypoints (agregar/mover/quitar,
  arrastre de segmento, borrar muesca) vía `setEdgeWaypoints`, flip de lado vía `setEdgeSide`,
  "Reset line" (deja sólo el color). El **color no cuenta**. Un gesto que termina donde empezó (sin
  comando) devuelve el layout previo con su marcador.
- Undo/redo: `WaypointCommand.fromAuto` y `EdgeStyle.auto` guardan el marcador, así deshacer la
  primera edición devuelve la forma de A\* como `auto` y rehacerla la vuelve del usuario;
  `ArrangeCommand` ya guarda el `EdgeLayout` completo.
- El marcador sin forma no significa nada: se poda al escribir (`hasAutoShape`).
- Nunca en una clave `dep:` (spec 18): las deps no pasan por A\*. `hasAutoShape(key, layout)` es
  falso para ellas, así que el marcador se descarta al leer el sidecar, en `setLayout`, en toda
  escritura del store (`writeLayout`) y en el persist. Ordenar aristas, `computeAutoShapeDrops`,
  `computeEdgeResets` y "Reset relations" recorren sólo `schema.refs`, así que nunca tocan una
  clave `dep:`.

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
`YIELD_EVERY` aristas **como macrotarea** (`MessageChannel`, fallback `setTimeout 0`) — un
`await Promise.resolve()` sólo vacía la cola de microtareas y el navegador nunca pintaba el
overlay ni despachaba el click de Cancel (bug corregido 2026-09) — y emite progreso monótono
0→100; **cancelable** vía `AbortSignal`
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
- **E3 · Lados top/bottom.** → ~~Sí, los produce el pase A* on-demand~~ **Revertido (decisión
  2026-10-03, Limitaciones 5):** ni A\* ni `chooseSides` producen `top`/`bottom`. El tipo `EdgeSide`
  conserva los 4 lados (`'left'|'right'|'top'|'bottom'`) sólo para leer sidecars viejos; cualquier
  forma con `top`/`bottom`, manual o `auto`, se ignora al dibujar (§Migración de formas pre-0.4).
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

### 10. Aristas `Dep` (spec 18)

Las dependencias lógicas no usan el ruteo ortogonal: `render/depRouter.ts` traza una **curva** entre dos stubs horizontales rígidos de 24 px (mismo `MIN_STUB`, recortados a la mitad del gap; las refs usan un cuarto, decisión 7). Sin waypoints es una Bézier con handles horizontales; con waypoints, Catmull-Rom → Béziers que pasan por cada punto, tangente a los stubs en los extremos. Lados izquierda/derecha por centros (no la regla de zonas de `chooseSides`, §1: una dep nunca hace C; ver Preguntas abiertas); puerto Y = centro de la primera columna (`rows.indexOf`) o `headerCenterY()` para deps a nivel tabla. Edición: sólo la dep seleccionada muestra handles de inserción (t=0.5 de cada tramo) y de waypoint (mover / doble clic = borrar); reutiliza `runEdgeDrag` + `WaypointCommand`. Se pintan en el **mismo SVG** (`DepPaths` en la capa base, `DepOverlay` en la de overlay) y se cullean con el mismo `visibleRefIds`. No participan en auto-layout, A* ni puertos compartidos con refs, nunca llevan `auto` (§9) y los resets de forma por movimiento de tablas no las tocan. Durante un drag se re-rutean sólo las deps de las tablas movidas (`DepRouteCache`, spec 04 "Drag incremental").

### 11. Migración de formas pre-0.4 (decisión 2026-10-06)

**Problema.** El router left/right de v0.4.0 (Z, S y C estilo dbdiagram) sólo ignoraba las formas
legadas marcadas `auto` (§9). Los diagramas guardados antes de 0.4 traen waypoints y lados **sin**
`auto` (overrides de versiones viejas o salidas de A\* previas al marcador), así que se dibujaban como
manuales: FKs saliendo por `top`/`bottom` y waypoints calculados para la geometría vieja de stubs que
ahora dibujan muescas y rodeos. "Reset" los arreglaba, pero arista por arista o reubicando tablas.

**Decisiones (resueltas con el usuario):**

1. **`top`/`bottom` se ignoran siempre**, manual o `auto`, sin preguntar. La UI sólo fija
   izquierda/derecha (flip de endpoint, decisión 4) y ningún router actual los produce, así que sólo
   pueden venir de un router anterior. Ignorar un lado ignora la forma entera del par de extremos
   (lados + waypoints + `dx/dy`), conservando el color, igual que el filtro de §9: es la misma
   función (`isLegacyEdgeShape` → `effectiveEdgeLayout`), así render (`routeRefs`), `routeMoved`,
   export de imagen (pasa por `routeRefs`), ediciones (`forgetIgnoredShape`, `setEdgeSide`,
   `setEdgeWaypoints`, snapshot del drag) y "Order edges" (`hasManualShape`) coinciden.
2. **Marcador de router en el sidecar:** `edgeRouting: 2` en la raíz (spec 03). Un archivo **sin**
   marcador cuyas aristas FK traen forma guardada (waypoints, lados o `dx/dy`; no cuentan color, deps,
   claves ≤0.2.8 sin `::` ni self-loops) es **pre-0.4**. Los self-loops se reconocen por la clave
   (`isLoopEdgeKey`: misma tabla antes del primer `::` y tras el `|`), porque el host no tiene el
   schema al leer; "Update" usa el mismo test, así que el aviso nunca ofrece una acción que no cambia
   nada (un archivo cuyo único flip guardado es el de un lazo se sella al leerse). Cualquier otro archivo sin marcador recibe el marcador al
   leerse (`resolveEdgeRouting`) y lo escribe en su próximo guardado normal: sin aviso ni escritura
   forzada (el churn-guard compara contra la forma ya marcada).
3. **Aviso único** en el diagrama para un archivo pre-0.4 (`render/edgeMigrationBanner.tsx`, barra
   flotante superior apilada bajo el banner de parse error en `.ddd-top-stack`, mismo estilo que la
   barra git de spec 16 —spec 12 §Barra flotante—; UI en inglés como el resto):
   *"Relations in this diagram were drawn by an earlier version."* con dos acciones
   (`layout/edgeMigration.ts`):
   - **Update relations** (`<Button variant="primary">`): borra waypoints, lados y `dx/dy` de **todas**
     las aristas FK (color conservado; deps intactas) como **un solo** comando de undo (`arrange`,
     `buildEdgesResetCommand`, etiqueta "Update relations"), sella el marcador y persiste una vez.
     Ctrl+Z restaura las formas; la respuesta queda registrada (el archivo sigue marcado), así que tras
     deshacer equivale a "Keep".
   - **Keep** (`secondary`): pide confirmación con un `<Modal>` que avisa que no volverá a preguntar
     y que borrar `"edgeRouting": 2` del `.dbml.layout.json` (y reabrir) recupera la opción (decisión
     2026-10-06: un Keep por error no tenía vuelta atrás visible). Al confirmar conserva las formas,
     sella el marcador y persiste una vez. No vuelve a preguntar.
   Los **self-loops** se excluyen de "Update": su única forma es el flip izquierda/derecha, que ambos
   routers dibujan igual (descartarlo perdería una elección del usuario que el cambio de router no
   invalidó). Un lado `top`/`bottom` en un lazo ya se dibuja a la derecha (`loopSide`).

**Gate de solo lectura.** El aviso no se muestra ni actúa durante merge, diff ni time-travel
(`showEdgeMigrationNotice` = pendiente ∧ `!isCanvasReadOnly`); las acciones son no-op ahí y nada se
escribe (además el host descarta todo `layout:persist` en solo lectura). Al salir del overlay el host
reenvía el layout de trabajo y `setLayout` recalcula si el aviso corresponde.

**Flujo de datos.** El host lee el marcador (`parseLayout`), lo preserva en `mergeLayout` (un persist
sin marcador conserva el actual), `applyViewState`, `applyDecisions` y el merge 3-way (spec 14), y lo
escribe con `serializeSharedLayout`. El webview lo guarda en el store (`edgeRouting`,
`edgeMigrationPending` calculado en `setLayout`) y lo manda en cada `layout:persist` una vez definido.
Un guardado normal de un archivo pre-0.4 sin respuesta **no** lo sella (el aviso vuelve a aparecer al
reabrir), salvo que ya no quede forma FK que migrar.

**Preguntas abiertas.**

- **Equipos con versiones mixtas.** v0.4.0 no conoce el marcador y lo pierde al reescribir el
  archivo; si además quedan formas, v0.4.1+ vuelve a preguntar. Aceptado: la transición es corta y
  preguntar de más es inocuo (no-bloqueante).
- **Formas manuales post-0.4 sin marcador.** Un archivo editado sólo con v0.4.0 (sin marcador) cuyas
  formas ya eran del router nuevo también recibe el aviso una vez; "Keep" lo resuelve. No hay forma
  de distinguirlas sin el marcador (no-bloqueante).

## Limitaciones conocidas

1. **Obstacle avoidance** llega vía el comando on-demand de edge-ordering (§9, router A* propio,
   implementado), también con tablas fijas. El ruteo del **render path** (`routeRefs`, sin comando)
   sigue **sin** evitar tablas — sólo dibuja a través de los waypoints que A* persistió, o el H-V-H
   por defecto.
2. **Crossing-min greedy/local** (§9): A* penaliza cruces sólo contra lo ya ruteado, en orden
   `ref.id` — determinista pero no globalmente óptimo (más débil que un layer-sweep global).
3. **Tie-break de lado** binario (45° ⇒ horizontal) en el render path. Aceptable.
3. ~~**Self-loops** no soportados.~~ **Decisión 2026-10-01: se dibujan** (ver §Self-loops).

### Self-loops (decisión 2026-10-01)

Una ref cuyo origen y destino son la **misma tabla visible** (no dos tablas colapsadas en el mismo
grupo, que siguen sin arista) se dibuja como lazo ortogonal por **un mismo lado** (por defecto
`right`; el flip L/R aplica a ambos extremos): sale del puerto de la columna origen, se aleja
`LOOP_OFFSET` (2× stub) más un escalón por cada otro lazo del mismo lado de esa tabla, corre en
vertical hasta la fila de la columna destino y vuelve a entrar por el mismo lado. Si origen y
destino son la misma columna, los puertos se separan ±¼ de fila. Los puertos del lazo entran al
grupo de puertos del lado como cualquier otra arista. v1: seleccionable, color, flip de lado,
borrar (spec 19) y entra en culling/export; **sin waypoints editables** y fuera del A\* (§9).

Implementación (`edgeRouter.ts` `buildLoopRoute`):

- **Clave.** `edgeKeyedRefs` conserva la self-ref cruda (`T::a|T::b`, también en `rawLayoutRefs` y en
  `refKeyByStableId`, así "Delete relation" la nombra). Se sigue descartando toda ref cuyos dos
  extremos caen en el mismo nodo de grupo colapsado, incluida una self-ref de una tabla colapsada.
- **Geometría.** Puertos en las filas de las columnas (`columnYResolver`); stubs rígidos de
  `MIN_STUB`; tronco vertical a `loopReach(rango + 1)` = `LOOP_OFFSET` (48) + `rango × LOOP_STEP`
  (12) del borde. Misma Y en ambos puertos (misma columna) ⇒ origen −¼ fila, destino +¼
  (`rowHeight` de la densidad, que `routeAll` recibe).
- **Apilado.** Los lazos de un mismo (tabla, lado) se ordenan por alto del tramo (menor adentro, así
  los anidados no se cruzan), desempate por id. El rango sólo depende de refs, filas y layouts —nunca
  de posiciones— así un drag (`routeMoved`) no re-ordena y coincide con un rebuild completo.
- **Vecino cercano (decisión 2026-10-05, `clampedLoopReach`).** Con consulta de obstáculos, si un
  nodo a nivel de la tabla (solape en y) queda más cerca del lado que `loopReach(n) + LOOP_CLEARANCE`
  (8), la pila se recoge: el lazo más lejano termina a `LOOP_CLEARANCE` del vecino y el resto lo sigue
  a `LOOP_STEP`, comprimiendo el paso hasta `LOOP_STEP / 2` sin bajar de `MIN_STUB + CORNER_RADIUS`
  (32, un fillet pasado el stub). Si ni así cabe (vecino a < ~40 px con un lazo) queda en esa pila
  mínima, dentro del vecino: no hay geometría de lazo por ese lado que lo evite, y cambiar de lado
  solo es decisión del usuario (flip). Ejemplo: 2 lazos y columna a 64 ⇒ `borde + 44 / + 56` (antes
  48/60, a 4 px). La reach depende de posiciones, así que `routeMoved` la recalcula en cada frame con
  consulta y lazos (una consulta al índice por pila) y re-rutea los lazos que cambian. El piso de
  las C (`loopReach(n + 1)`) y la caja de culling de escena siguen con el alcance sin recoger
  (superset).
- **Carril para Z ajenas (decisión 2026-10-05).** Con consulta de obstáculos, una pila se recoge más
  que por su vecino cuando una Z enfrentada que pasa a su lado no tiene x libre
  (§1 "Z frente a lazos"). Un solo pase, sin realimentación: (1) alcance por vecino
  (`preReach`, el de arriba) y su envolvente; (2) cada Z con ambas columnas resueltas (`claimLaneOf`:
  su carril sale de la decisión base y las filas de columna, nunca del reparto de puertos) **reclama**
  sólo si con esas envolventes queda **atascada** (`placeZTrunk` = `'stuck'`, contando los trunks de
  sus lazos propios, §1) y apunta su trunk a `free = ⌈hi⌉ − 1` (derecha; izquierda `⌊lo⌋ + 1`). Ceden
  todas las pilas que la bloquean **y** toda pila de sus propias tablas cuyo trunk, a cualquier
  alcance entre 32 y su `preReach`, quedaría a menos de 8 de `free` (`trunkMayReach`). Todas deben
  mirar al carril desde el mismo lado con su tabla en el extremo cercano (pilas derechas con borde
  `B ≤ lo`, izquierdas con `B ≥ hi`) y poder abrirlo: `roomZ = ⌊free − B − 8⌋` (izquierda
  `⌊B − 8 − free⌋`) ≥ `minStackReach(n) = 32 + (n − 1)·6`. Si alguna no puede, o hay pilas de ambos
  lados (p. ej. un lazo propio de la tabla lejana mirando al carril), **ninguna** cede y la Z
  conserva el medio (fallback). (3) Alcance final = `clampedLoopReach(rango, n, min(roomVecino, roomZ
  de cada reclamo))`. (4) Trunk specs, anidado, puertos y rutas como siempre, la Z deslizando contra
  las envolventes **finales**. Por qué alcanza un pase: bajar un alcance achica la envolvente de una
  tercera tabla (nunca bloquea más), pero **corre hacia adentro** el trunk de un lazo propio, que
  otro reclamo podría dejar justo en `free`; por eso esas pilas propias se reclaman aunque hoy no
  bloqueen, y su trunk final queda `≤ B + roomZ`, es decir `trunk + 8 ≤ free`. Así ningún reclamo
  le cierra el carril a otro; con varias Z sobre una pila gana el `min`, que satisface a todas; los
  reclamos se leen de `preReach`, así que el orden de las refs no importa. `roomZ` es entero y deja
  libre `⌈x1 + 8⌉ ≤ free < hi` aun con posiciones fraccionarias.
  Continuidad (2 lazos, hueco `g` de la columna de audit): 62 ⇒ `32/38`, trunk `W+46`; 64 ⇒ `32/39`,
  `W+47`; 80 ⇒ `39/51`, `W+59`; 90 ⇒ `47/59`, `W+67`; ≥ 91 el deslizamiento alcanza solo y los lazos
  quedan `48/60`. El único salto está en el umbral de admisión (61 ↔ 62: `roomZ` 37 < 38), donde el
  fallback vuelve a `41/53` con la Z al medio. Tres lazos con hueco 64 (`roomZ` 39 < 44) ⇒ fallback
  (`32/44/56`, Z en `W+32`). La ruta de la Z lleva `laneClaim`, y cada lazo recogido por un reclamo
  `unyieldedTrunkX` (dónde vuelve sin él), ambos para A\* (§9). Sin consulta de obstáculos (tests,
  llamadores viejos) no hay reclamos. Las C nunca reclaman; una C que pasa junto a lazos ajenos se
  anida contra sus trunks finales y puede quedar a pocos px del trunk de una Z que reclamó (C y Z no
  se conocen entre sí, igual que antes).
- **C por fuera (decisión 2026-10-05).** Toda C automática de ese lado de la tabla pone su trunk
  `LOOP_STEP` más allá del lazo más lejano (`loopReach(n + 1)`), y una C que pasa junto a lazos de
  una tercera tabla también los esquiva (§1 "Anidado de C"). Los lazos nunca se mueven por una C. En
  "Ordenar aristas" sus trunks son carriles que A\* no puede recorrer (§9).
- **Lado.** `sourceSide ?? targetSide` (sólo `left` cuenta; `top`/`bottom` persistidos se ignoran);
  `right` por defecto y **no se persiste**: el flip a la derecha borra el override. Waypoints
  persistidos de un lazo se ignoran.
- **UI.** Seleccionado: sin handles de tramo (ni doble clic de notch: `isDipRun` es falso en un
  lazo), pero cada tramo conserva su línea de hit, que sólo selecciona — sin ella un clic o clic
  derecho sobre el lazo seleccionado caía al canvas (deseleccionaba / menú de canvas). Los dos
  endpoints siguen siendo handles de flip y mueven ambos extremos. Toolbar: *Flip side* (en lugar de *Reset line*), color y *Delete relation*.
  En LOD `rect` mantiene su forma (la recta puerto-puerto quedaría sobre el borde de la tabla).
- **Fuera de:** A\* (`computeEdgeOrdering` los filtra), `computeEdgeResets`,
  `computeAutoShapeDrops`, "Reset relations" y la traslación de waypoints del drag: su única forma
  es el lado elegido por el usuario, que ningún movimiento invalida.
- **Culling/export.** Caja = tabla ∪ alcance del lado (spec 04); el export rutea con `routeRefs` y
  sus bounds incluyen las esquinas del lazo.
4. **Sin curvatura** en codos (90° rígidos). v1.1 opcional.
5. ~~**Retroceso en x-overlap**~~ **Decisión 2026-10-03 (con el usuario, estilo dbdiagram):**
   zonas con la derecha favorecida (§1): target enteramente a la derecha ⇒ Z `right→left`;
   enteramente a la izquierda ⇒ Z `left→right`; cualquier solape en x, tocarse incluido ⇒ C
   `right→right` que rodea ambas tablas. La Z llega hasta que las tablas se tocan, con el trunk en el
   punto medio del hueco, y dos tablas alineadas en la misma fila siempre tienen una división
   editable en el medio (decisión 7, §1 "Computar path"). A\* usa la misma regla (§9) y una forma
   `auto` legada con `top`/`bottom` se ignora al dibujar. `routeMoved` re-decide los lados de las
   refs afectadas, así un drag que cruza `gap = 0` (Z↔C) coincide con un rebuild completo; el export
   de imagen usa el mismo `routeRefs`. Tests en `edgeRouter.xOverlap.test.ts`.
   *Historia:* el retroceso original (target con borde izq dentro del extent-x del source ⇒ la ruta
   se devolvía) se atacó el 2026-10-01 con puertos `bottom`→`top` en el render cuando los extents-x
   se solapaban (`1b3e970`), y el 2026-10-02 con el eje de menor penetración para bboxes que se
   intersecan (`7dee0a3`) y el descarte de stubs verticales bloqueados en A\*. Ambas decisiones se
   **revierten**: las FKs quedaban bajo la tabla, el puerto se despegaba de la fila de su columna y
   dos tablas apiladas quedaban unidas por una recta vertical sin intersecciones editables. Sobreviven
   el umbral de click del flip (§4) y el chequeo de franjas de stub de A\*, ahora sobre pares L/R (§9).
   ~~*Pendiente conocido:* bboxes que se intersecan con la C atravesando la tabla target.~~
   **Decisión 2026-10-05:** bboxes que se intersecan (tocarse lado a lado incluido) usan la C por la
   derecha si no atraviesa ninguna de sus tablas, si no la izquierda, y sólo si ambas atraviesan el
   conector enfrentado (§1); la Z enfrentada que se usó brevemente antes quedaba casi invisible.
   Toda C se anida fuera de lazos y de otras C (§1 "Anidado de C").
6. **Tablas tocándose lado a lado o muy encimadas pueden esconder la relación (aceptado, decisión
   2026-10-05).** Cuando ninguna C despeja ambas tablas, el conector enfrentado corre sobre el borde
   compartido o bajo la otra tabla (§1, bboxes que se intersecan) y la arista puede quedar casi
   invisible. No se agregan rutas `top`/`bottom` para este caso: separar las tablas la vuelve a
   mostrar.
7. **Z/S frente a lazos ajenos sin hueco libre.** ~~Con el hueco por defecto (64) junto a una pila de
   dos lazos no quedaba x libre y la Z cruzaba la pila, con un brazo sobre el brazo de un lazo, y
   "Ordenar aristas" tampoco lo resolvía (A\* no encontraba ruta y escribía la ruta por defecto).~~
   **Resuelto (decisión 2026-10-05, opción (b)):** la pila cede un carril (§Self-loops "Carril para Z
   ajenas"); en el caso de referencia (`selfloop.dbml` completo, con el lazo propio de departments)
   lazos de employees `W+32`/`W+39`, lazo de departments `W+39`, trunk `W+47`. Sigue abierto: (a) con
   una pila que ni comprimida al mínimo abre el carril (hueco < 62 con 2 lazos, 3 lazos a 64), o con
   pilas que bloquean desde ambos lados (incluido un lazo propio de la tabla lejana mirando al
   carril), la Z conserva el medio dentro de la pila; (b) una Z con una columna
   sin resolver no reclama (sólo desliza); (c) la S no reclama ni desliza; (d) en el umbral de
   admisión la pila salta de golpe (p. ej. `41/53` ↔ `32/38` en 61 ↔ 62 px), inherente al fallback;
   (e) mover una tabla ajena (la de la Z) cambia la forma de los lazos de otra, que es justo lo
   pedido pero es nuevo; (f) sin reclamo, la Z que se aparta del trunk de un lazo propio elige la x
   libre más cercana al medio (empate ⇒ la menor), que puede quedar dentro de la envolvente del lazo
   y cruzar sus dos brazos en vez de pasar por fuera.

## Test plan

`test/unit/edgeRouter*.test.ts` (actualizar `edgeRouter.waypoints.test.ts`):

- Misma fila, target a la derecha ⇒ source=right, target=left; recta enmarcada
  por dos stubs rígidos, con el tramo medio partido en dos mitades editables.
- Override `sourceSide`/`targetSide` respetado sobre `chooseSides`.
- **Zonas (`edgeRouter.xOverlap.test.ts`):** target a la derecha ⇒ Z desde `right` con trunk en el
  punto medio; a la izquierda ⇒ Z espejada; **S de hueco angosto:** gaps 1–47 (1, 2, 3, 10, 24, 32,
  40, 47) con filas a 300 ⇒ stubs de 24, escalón de `48 − gap` y esquinas exactas
  `aStub → (aStub.x, midY) → (bStub.x, midY) → bStub` (V-H-V, tres tramos no rígidos), espejo a la
  izquierda con `midY` redondeado; `|Δy| = 24` ya es S, `|Δy| < 24` vuelve al clamp con trunk al medio
  (también en 47); gap 48 ⇒ una sola vertical en `W + 24` (path exacto); 49/60/95 ⇒ Z (stubs
  `⌊gap/4⌋`, un trunk al medio); **continuidad 47 → 48 → 49:** puntos de control de los fillets
  exactos (a lo sumo 1 px de diferencia) y radio 8 en la esquina del trunk en los tres; escalones de
  1–7 px (gaps 41/45/46/47) sin `NaN` y con el path monótono (nunca retrocede);
  **empaquetadas:** lado a lado con filas solapadas a hueco 10/16 ⇒ clamp sin tramos dentro de las
  tablas y trunk en el hueco; una sobre la otra con el medio de las filas dentro de una tabla
  (geometría de isga `evaluation_coordinator_assignments → indicator_evidences`) ⇒ escalón exacto en
  el medio del hueco vertical; hueco vertical de 1 px ⇒ clamp; gaps chicos con filas casi
  alineadas (incl. 1 px) siguen en Z con trunk editable en el punto medio exacto y sin espolón; x-overlap (target corrido a izq o der, tocarse incluido) ⇒ C
  `right`/`right` sin tramos dentro de ninguna tabla; nunca sale por `top`/`bottom` sola; self-loops
  sin cambio. **Misma fila:** el medio se parte en dos tramos editables y se dibuja como una recta.
  **Lados persistidos:** `top`/`bottom`, manual o `auto`, ignorado entero (lados + waypoints); la salida
  exacta de A\* v0.3.0 para a(0,0)→b(0,600) rodeando m(0,300) (waypoints `auto` sin lados) se dibuja
  igual que sin layout; `auto` sin lados sin x-solape y `auto` `right`/`right` con waypoints
  conservados; `auto` L/R conservado; override manual L/R en ambos extremos respetado. `routeMoved` ==
  rebuild completo barriendo ambos bordes `gap = 0` y en drags aleatorios con > 20 flips Z↔C.
- **Edición de las formas nuevas (`edgeRouter.segmentDrag.test.ts`):** deslizar o hacer notch en
  cualquiera de las dos mitades de una fila alineada (también con hueco chico) dobla la línea sin
  mover puertos ni stubs; el trunk de una Z de hueco angosto con filas casi alineadas desliza de
  costado; en la **S** los tres tramos son editables: deslizar cada vertical (codo contra su stub) y
  el escalón (sus dos esquinas) da las esquinas exactas, y un notch en cualquiera queda local; al
  re-rutear con esos waypoints puertos y stubs completos no se mueven y las esquinas son literales.
  **Overlay (`edgeLayer.selected.test.ts`):** la S seleccionada expone tres hit-lines agarrables con
  su vértice.
- **Pase A\* (`edgeOrdering.test.ts`):** waypoints persisten siempre con ambos lados (C bloqueada y Z
  incluidas), así ninguna forma nueva cumple `isLegacyEdgeShape`; una C despejada sale `{}` (el render
  la anida); una C cuyo trunk derecho cruza una tercera tabla sale `{}` (el render la espeja a la
  izquierda libre); bloqueada en ambos lados va a A\* (waypoints + ambos lados) y, con la columna del
  stub libre, queda fijada a esa columna (`pinStraightC`); tablas que se intersecan (solape, lado a
  lado, encimadas) salen `{}`; una superposición donde el render elige la C izquierda sale `{}` y se
dibuja a la izquierda. **S:** una S despejada sale `{}` y se dibuja con stubs completos y tramos
V-H-V; con franjas bloqueadas, lado a lado (hueco 32, filas alineadas, tercera tabla bajo b en la
franja de a) nunca persiste una C cuyo brazo cruce a o b; empaquetadas lado a lado (hueco 16, filas solapadas) ningún tramo queda dentro de las tablas
tras ordenar; una sobre la otra a 16 px sale `{}` con el escalón en el medio del hueco; una S cruzada por una tercera tabla va a A\* (waypoints + `right`/`left` + `auto`) y la ruta
dibujada conserva los stubs completos, sin retroceso ni tramos dentro de las tres tablas. **Columna vecina a 64 px** (la del fixture "nb": `audit` a la derecha
  con una Z desde departments): `emp.dept` y `proj.owner` salen `{}`, se dibujan a la izquierda y
  ningún tramo cruza una tercera tabla. **Columna de `selfloop.dbml`** (employees con 2 lazos /
  projects / departments con 1, huecos 16), tal cual y con una tabla bloqueando el trunk de
  `proj.owner` (sin carriles corría por el trunk del lazo `mentor`): ningún tramo vertical a menos de
  `LOOP_STEP` de un trunk de lazo ni de otra ruta con extensión solapada; las C despejadas sin
  waypoints y fuera de todos los lazos.
- **Anidado de C (`edgeRouter.nest.test.ts`):** trunk a `borde + loopReach(n + 1)` con lazos en
  cualquiera de sus tablas (también con puertos fuera del tramo del lazo); lazos del otro lado no
  empujan; C manual `left`/`left` espejada; C con waypoints intacta; dos C de una columna ⇒ tramo
  menor adentro a `LOOP_STEP`, igual con `refs[]` invertido; empate de tramo ⇒ por `ref.id`; C sin
  solape vertical o de otra columna no se empujan; columna de `selfloop.dbml` y 30 columnas
  aleatorias ⇒ ningún par de trunks (lazo/C) con extensión solapada a < `LOOP_STEP`. **Bboxes que se
  intersecan:** b sobre la esquina inferior derecha de a (la fila de a corre por b) ⇒ C izquierda,
  ambos puertos visibles y ningún tramo dentro de las tablas; solape que la C derecha despeja ⇒ C
  derecha; lado a lado (cada fila corre por la otra) ⇒ conector directo sobre el borde compartido,
  ambos sentidos; apiladas tocándose / encimadas ⇒ C derecha sin `NaN`; hueco vertical de 1 px ⇒ C;
  un vecino espeja una C de intersección sólo si la C espejada despeja ambas tablas. **Cache:** `routeMoved` == rebuild en 200 drags aleatorios de
  una columna angosta con lazos, C, lados manuales, waypoints y `dx` (> 50 trunks anidados vistos), y
  un drag de una tercera tabla re-anida una C que no toca; `routeMoved` == rebuild en 250 drags de un cúmulo apretado con consulta de
obstáculos que recorren la S (> 50), la C derecha, la C izquierda y el conector enfrentado de
intersección (> 30 cada uno). **Vecinos:** sin `ObstacleQuery` el trunk
  queda en su slot (bajo la vecina); con ella la C se espeja a `−MIN_STUB` sin cruzar terceros y los
  lazos no se mueven; bloqueada en ambos lados conserva el suyo; con lados persistidos nunca se
  espeja; 4 C de una columna con vecina a 64 ⇒ `W+24`, `W+36`, `−24`, `−36` (igual con `refs[]`
  invertido); `routeMoved` == rebuild en 150 drags con tablas sin refs cruzando la franja (> 20
  espejados vistos); con la vecina a 64 los dos lazos se recogen a `W+44`/`W+56`.
- **Lazos y vecinos, Z frente a lazos (`edgeRouter.loopNeighbours.test.ts`):** `clampedLoopReach`
  (pila que cabe intacta; recogida a la room con `LOOP_STEP`; compresión a `LOOP_STEP/2` sobre 32 y
  pila mínima si no cabe); 2 lazos con columna a 64 ⇒ `W+44`/`W+56` (sin consulta, 48/60); vecino
  fuera de nivel o más allá de la pila no recoge; espejo a la izquierda. Z departments→audit con
  hueco 120 ⇒ trunk en `W+68` (sin lazos, `W+60`); un lazo propio cuyo trunk no estorba (`W+48` con
  medio `W+60`) o lazos fuera de sus filas no la mueven; con hueco 96 el medio cae sobre el trunk
  propio `W+48` y la Z se aparta ≥ 8 sin reclamar;
  `routeMoved` == rebuild en 200 drags de la tabla con lazos, extremos de la Z y un vecino (> 5
  deslizamientos vistos). **Carril cedido:** hueco 64 ⇒ lazos `W+32`/`W+39`, trunk `W+47`, `laneClaim`,
  ningún brazo de la Z sobre un brazo de lazo y `unyieldedTrunkX` `W+44`/`W+56`; `selfloop.dbml`
  completo (lazo propio `parent_id` de departments, Z desde `audit_id`) ⇒ employees `W+32`/`W+39`,
  departments `W+39` (`unyieldedTrunkX` `W+48`), trunk `W+47`, ninguna vertical de la Z a < 8 de un
  trunk de lazo sobre filas compartidas (sin consulta: medio `W+32`); 3 lazos a 64 ⇒
  fallback (`32/44/56`, Z en `W+32`, sin marcadores); hueco 120 o sin consulta ⇒ lazos intactos;
  un lazo propio que no estorba o lazos fuera de las filas no ceden; waypoints, `dx` legacy, S (hueco 40) o columna sin
  resolver ⇒ nunca reclama; espejo a la izquierda (`−32/−39`, trunk `−47`); dos pilas del mismo lado
  ceden ambas, pilas de ambos lados ⇒ fallback; dos Z sobre una pila ⇒ gana el `min` y ambos carriles
  quedan libres; barrido de hueco 48 → 130 px a px ⇒ reclama exactamente en 62–90 y cada lazo/trunk se
  mueve ≤ 6 px por px salvo en el umbral 61 ↔ 62; posiciones fraccionarias (+¼, ½, ¾) ⇒ carril libre
  y trunk estrictamente entre stubs; `routeMoved` == rebuild en 400 drags con pila izquierda, segunda
  pila, el lazo propio de departments y su Z a audit, y huecos 48–130 (> 100 pasos con reclamos, > 40
  cambios de reclamo; toda Z que reclama queda a ≥ 8 de todo trunk de lazo — este chequeo encontró
  que un reclamo ajeno podía correr un lazo propio hasta el `free` de otra Z, de ahí `trunkMayReach`).
- **Carril cedido en export y A\*:** `imageExport.test.ts` dibuja exactamente las rutas del router vivo
  (con reclamo); `edgeOrdering.laneClaim.test.ts`: la Z del caso de referencia no llega a A\* y sale
  `{}` (el render conserva `W+32/W+39` y `W+47`); una Z que reclama pero cruza una tercera tabla va a
  A\*, que recibe como carriles tanto los trunks recogidos como `unyieldedTrunkX`.
- **Perf (`dragFrame.perf.test.ts`, variante con lazos):** `huge.dbml` + lazos sintéticos (1 en cada 5ª
  tabla de la grilla, 2 en cada 10ª, más la tabla arrastrada y la selección) y una Z por pila desde su
  vecina derecha a la de abajo (> 100 reclamos activos): incremental < 4 ms y < ½ del rebuild con 1
  tabla; con 50 tablas < 5 ms y < ¼ del rebuild (spec 07).
- **Culling por extensión (`useVisibleNames.test.ts`):** `routeReachBoxes` cubre todos los puntos de
  30 C anidadas y de un lazo, y omite la Z; con la cámara pasado `tablas + 256 + 50` la caja de escena
  no se ve pero la C exterior sí.
- **Carriles A\* (`astar.test.ts`):** un carril sobre el tramo vertical libre de una Z lo desplaza
  ≥ `LOOP_STEP`; un carril que corta el corredor recto se cruza (`[]`); una C ruteada deja su carril:
  en un corredor de una sola columna la segunda C cae a fallback en vez de compartirla.
  `chooseSides4` con bboxes que se intersecan (filas de centros) ⇒ conector enfrentado si ambas C
  atraviesan una tabla; apiladas tocándose ⇒ C derecha; si sólo la izquierda despeja ⇒ C izquierda.
- **Overlay (`edgeLayer.selected.test.ts`):** par alineado a 40 px ⇒ dos mitades de 10 px sin
  vértice que se agarran desde su hit-line. **`forgetIgnoredShape` (`dragController.test.ts`):** un
  flip sobre una ruta con forma legada ignorada no revive sus waypoints.
- **Legado en el store (`store.edgeAuto.test.ts`):** editar waypoints o el lado de una arista con
  `auto` `top`/`bottom` reemplaza la forma entera conservando el color; re-aplicar los waypoints
  dibujados (vacíos) no toca lo guardado.
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
  editable. `slideSegment`/`notchAtQuarter` sobre un `rigid` es no-op. Ambos extremos en el
  mismo lado (`left`/`left`, `right`/`right`) ⇒ stubs completos de 24 + ruta en C editable, sin
  retroceso ni tramos dentro de una tabla. Stubs opuestos recortados a un cuarto del gap (la mitad
  central queda editable), salvo la S (gap 10–47 con filas a 200 ⇒ stubs de 24; 48 ⇒ 12, 95 ⇒ 23). Lados `top`/`bottom` manuales ⇒ stubs verticales
  fuera del borde, ningún tramo sobre el borde de la tabla; puertos alineados conservan un tramo
  medio editable; par mixto (`right`→`top`) ⇒ L sin retroceso (`edgeRouter.stub.test.ts`).
- **Deslizar sin movimiento neto** perpendicular devuelve los waypoints guardados (una ruta
  automática sigue automática, sin entrada de undo).
- **Esquinas redondeadas** (`edgeRouter.rounding.test.ts`, más continuidad/escalones en
  `edgeRouter.xOverlap.test.ts`): `roundedPathString` deja recta
  una polilínea colineal (sin `Q`); redondea una esquina interior con un `Q` cuyo punto de
  control es el vértice; clampa `r` a media-sección adyacente; descarta puntos coincidentes;
  `≤ 2` puntos ⇒ segmento plano. Vía `routeRefs`: arista misma-fila sin `Q`; arista doblada
  con `Q` (el waypoint es una esquina literal → `Q<waypoint>`).
- **Self-loops (`edgeRouter.loop.test.ts`):** un lazo sale y vuelve por la derecha a
  `LOOP_OFFSET`; dos lazos del mismo lado se apilan (el de tramo menor adentro); un lazo del otro lado
  no empuja; misma columna ⇒ puertos ±¼ fila; flip ⇒ ambos extremos a la izquierda; waypoints y
  lados top/bottom persistidos se ignoran; entra al grupo de puertos; `routeMoved` de su tabla ==
  rebuild completo. Clave (`edgeKey.test.ts`), controles del lazo seleccionado (`edgeLayer.selected.test.ts`), caja de culling (`sceneCache.test.ts`), export
  (`imageExport.test.ts`), resets/drag (`edgeReset.test.ts`), A\* (`edgeOrdering.test.ts`) y flip
  (`dragController.test.ts`).
- Bbox faltante ⇒ arista omitida (no crash).
- Back-compat: `waypoints=[]` ⇒ recta misma-fila (dividida al medio) / H-V-H offset con stubs.

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
  **alternados**; bends enteros; **entre `sourceStub`/`targetStub`** (los puertos no son waypoints; los
  stubs conectan con los waypoints por tramos ortogonales ⇒ ancla columnY intacta; `anchorEndpoint`
  lleva el extremo al eje del stub, y como las tablas extremo son obstáculo el camino nunca llega al
  stub desde el lado-tabla — `orderEdges` no cruza su propia tabla en una columna apilada con una
  tabla en medio, en ambos sentidos; e2e `computeEdgeOrdering → routeRefs` sin retrocesos en
  `smartLayout/edgeOrdering.test.ts`); corredor limpio ⇒ `[]`
  waypoints; `chooseSides4` sigue la regla de zonas (`right`/`left`, `left`/`right`, C derecha con
  x-overlap, nunca `bottom`/`top`), y el motor aún rutea lados `top`/`bottom` dados por el llamador
  rodeando un obstáculo lateral; **fallback** a `[]` (sin throw) al exceder `MAX_EXPLORED`;
  batch **determinista** (dos corridas byte-iguales; independiente del orden del array de entrada para
  aristas que no interactúan); **crossing accumula** (una arista paralela se desvía del corredor
  compartido — `WorldUsage` world-keyed); progreso monótono 0→100; **abort** lanza `AbortError` y no
  termina.
- **Perf (`edgeOrder/astar.perf.test.ts`):** grilla densa ~5000 tablas/~1000 refs **< 3000ms** con
  yield + cap; cap bajo ⇒ algunos fallbacks `[]` (degradación) y sigue < 3s; **ningún segmento de una
  arista ruteada intersecta un obstáculo ni sus tablas extremo, a escala** (muestreo); determinista a
  escala. Hueco de la grilla = 64: un corredor necesita `2 × CLEARANCE` más un centro de celda; con
  48 no quedaba ninguno y los únicos "desvíos" cruzaban su propia tabla.
- **Runner / undo (`smartLayout/edgeOrdering.test.ts`):** `runEdgeOrdering` empuja **exactamente un**
  `ArrangeCommand` (posiciones vacías, `edgesTo` con waypoints SET); un Ctrl+Z restaura los
  `EdgeLayout` previos (color preservado), redo re-aplica; `preserveManual:true` deja la arista manual
  idéntica (la auto se re-rutea), `false` la re-rutea; no-op sin aristas; `computeEdgeOrdering`
  determinista. **Columna apilada con una tabla en medio** (geometría de `selfloop.dbml` al abrir,
  huecos 16 y 80, ambos sentidos): ningún waypoint dentro de una tabla extremo, sin espolón de
  retroceso y ningún tramo cruza el interior de ninguna de las tres tablas. Tablas apiladas ⇒ C por
  la derecha con stubs horizontales, sin lados persistidos (coincide con `chooseSides`); una tercera
  tabla en la franja del stub derecho ⇒ C por la izquierda persistida con `auto`.
- **Tipos/store (`store.edgeSide.test.ts`):** `setEdgeSide` acepta `top`/`bottom` y `null`;
  `EdgeStyleCommand` con `top` round-trip por undo/redo.
- **Serializador (`layoutStore.waypoints.test.ts`):** `sourceSide`/`targetSide` `top`/`bottom`
  round-trip; coexisten con waypoints; defaults omitidos; idempotente byte-estable; **rechaza** un
  valor de lado inválido (whitelist de 4).
- **Migración pre-0.4 (§11):** `layoutStore.edgeRouting.test.ts` — el lector conserva el marcador,
  deja sin marcar un archivo con formas FK, sella uno sin nada que migrar (color, deps, claves sin
  `::`), ignora marcadores malformados y preserva uno más nuevo; el writer lo pone tras `version` en
  ambas formas, round-trip byte-estable marcado o pendiente, un guardado normal no sella un pendiente
  y sí uno sin formas; `mergeLayout`, merge 3-way (ambos marcados → el mayor; un lado sin marcar →
  sin marcar), `applyDecisions` y `applyViewState` lo preservan. `edgeMigration.test.ts` — detección,
  oculto en time-travel/diff/merge, "Update" (formas FK fuera, color/lazos/deps intactos, marcador,
  un persist) es un solo undo que restaura todo, "Keep" no toca formas ni historia, el marcador viaja
  en persists posteriores, y en solo lectura ninguna acción edita, sella ni escribe.
  `edgeRouter.stub/xOverlap.test.ts` y `store.edgeAuto.test.ts` — `top`/`bottom` manual ignorado
  entero en render y edición; `edgeReset.test.ts` — una forma `top`/`bottom` no cuenta como manual.
