# 13 — Smart Auto-Layout (ordenamiento automático enfocado en BD)

## Propósito

Calcular una posición `{x, y}` estéticamente ordenada para cada tabla del esquema DBML, donde la
posición de una tabla la determinan **sus relaciones (FK) y su grupo**. No es un layout genérico de
grafos: es un ordenador **enfocado en bases de datos** — los satélites orbitan a su padre, las tablas
puente (junction M:N) caen entre sus dos padres, los hubs anclan clústeres radiales, y los
TableGroups (bounded contexts) se respetan como contenedores de primer nivel.

Expone tres modos: `all` (reordenar todo), `new` (colocar solo tablas sin posición guardada) y
`selection` (mover solo lo seleccionado; el resto son obstáculos fijos).

## Contexto / Problema

Hoy el webview solo tiene `autoLayout()` (`src/webview/layout/autoLayout.ts`): un único paso dagre
plano (`rankdir: TB`) usado como *fallback* para tablas sin posición. No entiende roles de FK, no
agrupa por bounded context, no orbita agregados ni evita que el resultado sea una pila jerárquica
genérica. Para esquemas reales con decenas de tablas y varios grupos, el resultado es ilegible.

La idea (recuperada de `dddbml@838b2bb`) separa **inteligencia de BD** (clasificación + clustering,
propia y agnóstica del motor) de la **geometría** (el motor de layout). El insight clave: un motor de
layout (ELK, dagre) solo hace geometría — no sabe qué es un satélite, una junction o un bounded
context. ~80% de "buen orden de BD" son las heurísticas propias; ~20% es el motor debajo.

## Preguntas abiertas (Open Questions)

- [x] **Motor de geometría.** → **Decisión: ELK compound (`elkjs`).** Los TableGroups se vuelven
  contenedores anidados nativos; el motor da no-solape, minimización de cruces y ruteo jerárquico,
  reemplazando el "fake hierarchy" de dagre (meta-dagre + colisión AABB manual + expansión de caja
  manual). El peso del bundle **no** es restricción (la app ya pesa ~10MB; herramientas DBML pares
  también >10MB). (acordado con el usuario, 2026-05-29)
  - *Follow-up (2026-05-31):* la decisión de **usar** ELK se mantiene; pero como pesa ~71% del
    webview, se sacó del parse inicial vía **carga lazy** (asset aparte + `<script>` on-demand, ver
    "Carga lazy de ELK" abajo y `specs/07`). Abrir sin auto-ordenar ya no paga el costo de ELK.
- [x] **Riqueza de colocación específica de BD.** → **Decisión: heurísticas + colocación radial.**
  classify/cluster + alineación de columnas FK + **colocación radial/estrella dedicada** para
  clústeres hub+satélites (hub al centro, satélites en anillo ordenados por `inDeg`). (2026-05-29)
- [x] **Waypoints de aristas al mover en bloque.** → **Decisión: resetear los movidos.** Los
  waypoints son coordenadas de mundo absolutas y no siguen a las tablas (spec 05, desde 0.2.1); un
  movimiento masivo los deja varados (paths en escalera). Se limpian `waypoints` (+ `dx/dy` legacy)
  de aristas cuyos **dos extremos se movieron**, conservando `color` + `sourceSide`/`targetSide`. El
  ruteo se rehace limpio vía el `columnYResolver` existente. (2026-05-29)
- [x] **Disparadores.** → **Decisión: tres superficies** que llaman a un único `runSmartLayout(mode)`:
  command palette, botón+submenú en el ActionsPanel, y **menú contextual (click derecho) sobre tablas
  seleccionadas** ("Auto-arrange selected (N)"). (2026-05-29)
- [x] **Undo.** → **Decisión: sí, como comando compuesto.** Un solo Ctrl+Z revierte posiciones **y**
  los reseteos de waypoints (un `ArrangeCommand`). (2026-05-29)
- [x] **Determinismo.** → **Decisión: sin `Math.random()`.** El desempate del paso de alineación mueve
  el extremo de menor `totalDeg`; si empatan, el de nombre lexicográficamente menor. Requisito del
  layout git-friendly. (2026-05-29)

## Diseño

```
Schema ─▶ classify()      → Map<name, TableMeta>     (roles FK + grados)            [cerebro BD]
       ─▶ buildClusters()  → Cluster[]  (group/aggregate/component/orphans)         [cerebro BD]
       ─▶ smartLayout() (async):
            ├─ resolveOrientation()   TB|LR según la cadena FK más larga
            ├─ colocación radial      clústeres aggregate (hub+satélites) → coords locales fijas
            ├─ ELK compound           groups/components como contenedores anidados; aristas FK;
            │                         no-solape + min-cruces + ruteo jerárquico
            ├─ flatten a mundo        acumula offsets de padres de ELK
            ├─ columnAlignPass()      nudge de Y determinista para enderezar filas FK
            └─ collisionGuard()       red de seguridad AABB tras los nudges
       ─▶ Map<name,{x,y}> ─▶ runner: reset waypoints movidos + aplica + ArrangeCommand + persist
```

Todo bajo `src/webview/layout/smartLayout/`.

### Clasificación (`classify.ts`) — cerebro BD

Asigna a cada tabla un `Role` y los metadatos de grado que necesita el clustering. **Detalle de
corrección crítico:** `@dbml/core` reporta los extremos de un ref en orden inconsistente; se deriva
quién es **child** (porta la FK, lado "many") vs **parent** (lado "one") por los tags de relación, no
por la posición source/target:

```
sourceIsChild = (source.relation === '*') || (target.relation === '1')
```

Cascada ordenada (gana la primera): `island` (totalDeg 0) → `junction` (outDeg≥2, inDeg≤1, 2 targets
distintos, FK-cols ≥ max(2, ⌊cols/2⌋)) → `satellite` (out 1, in 0) → `leaf` (out 0, in≥1, 1 vecino) →
`chain` (out 1, in 1, 2 vecinos) → `hub` (totalDeg≥5) → `root` (in≥2, out≤1) → `free`.

Constantes: `HUB_THRESHOLD = 5`, `JUNCTION_MAX_IN_DEG = 1` (máximo inDeg para seguir siendo junction).

### Clustering (`cluster.ts`) — cerebro BD

`ClusterKind = 'group' | 'aggregate' | 'component' | 'orphans'`. Un `assigned: Map<name, clusterId>`
garantiza "cada tabla en exactamente un clúster". Fases en orden (saltando lo ya asignado):
1. Grupos declarados (máxima prioridad).
2. Adopción satélite/leaf/chain hacia el clúster del padre, iterando a punto fijo. Cross-group
   permitido: si el grupo propio difiere del anfitrión, se registra en `cluster.adoptedForeign` (dato;
   el render de caja expandida queda fuera de alcance).
3. Junctions → clúster del extremo de mayor `totalDeg`.
4. Agregados: hubs/roots sin asignar siembran un clúster `aggregate` (anchor = sí mismos) y absorben
   vecinos satélite/leaf/junction/chain.
5. Componentes conexos sobre el subgrafo restante (DFS). Nodo aislado (totalDeg 0) → orphans.
6. Orphans: un único clúster para islas.

### Motor de geometría: dagre de dos niveles (`layout.ts`)

El motor de geometría es **dagre** (ya en el bundle), usado en **dos niveles**, todo síncrono e
inline en `layout.ts` (no hay módulo wrapper de motor — dagre no se va a volver a cambiar):

1. **Nivel interno (`layoutClusterLocal`)** — un grafo dagre por clúster: sus tablas como nodos, los
   refs intra-clúster como aristas (`child→parent`), `rankdir` por clúster (`pickClusterOrientation`:
   clústeres ≤3 → LR; cadenas FK profundas → TB; si no, hereda el global). Se normaliza a un bbox de
   origen 0 y se devuelve `{positions, bbox}`.
2. **Nivel externo (`layoutMeta`)** — un grafo dagre sobre los **clústeres como meta-nodos** (tamaño =
   bbox del clúster + `clusterMargin`·2); los refs cross-clúster se agregan como aristas ponderadas
   por conteo. dagre da el origen de cada clúster; se **aplana** sumando el origen del clúster a las
   coords locales de sus tablas.

Los clústeres **aggregate** (hub+satélites) saltan el dagre interno y usan `radialPlace` (hub al
centro, satélites en anillo ordenado por `inDeg` asc, empate por nombre) → su bbox entra al nivel
externo como cualquier otro meta-nodo. Tras aplanar: `columnAlignPass` (alineación FK determinista) +
`resolveCollisions` (red AABB). Sólo se consumen posiciones `{x,y}` de tablas; las aristas las rutea
`edgeRouter.ts` (spec 05).

> **Densidad configurable (`spacing`).** dagre dos-niveles queda ~10% más suelto que ELK compound (un
> factor constante en las separaciones, no un defecto estructural). En vez de un post-pass de
> compactación frágil (un intento de "pull al centroide" se descartó por **reordenar** clústeres y
> romper la lectura por niveles), se expone un **multiplicador `spacing`** (`SmartLayoutInput.spacing`,
> default 1, clamp `[0.4, 2.5]`) que escala todas las separaciones/márgenes (`computeSeps`). El usuario
> lo controla vía `dddbml.ui.layoutSpacing` (spec 10). Bajarlo recupera (y supera) la compacidad de
> ELK; subirlo da diagramas más aireados. Determinista (seps redondeadas a enteros).
>
> *Trade-off documentado:* un re-pack 2D de las cajas de clúster sería más compacto aún, pero
> sacrifica la lectura por niveles (clústeres ordenados por profundidad FK) que hace legible el
> diagrama. Se prioriza legibilidad + control del usuario sobre densidad máxima automática.

### Orquestación (`layout.ts`)

- **Orientación** (`detectOrientation` + `longestPath`): TB si la cadena FK dirigida más larga
  ≥ `max(2, ⌈√N⌉)`, si no LR. Memoizado con set `visiting` para tolerar ciclos.
- **Grafo compound**: `root` con un contenedor por clúster (`group`/`component`); cada contenedor
  aloja sus tablas; refs intra-clúster como aristas locales, refs cross-clúster como aristas del
  root; dirección normalizada child→parent. Tamaños de nodo vía `estimateSize` (consciente de
  densidad).
- **Colocación radial** (clústeres `aggregate`): hub al origen, satélites en anillo ordenados por
  `inDeg` ascendente (empate por nombre), radio derivado de tamaños + `MIN_GAP`; se normaliza a un
  bbox local y se entrega a ELK como contenedor `elk.algorithm = fixed` (ELK posiciona el clúster
  entre sus hermanos pero conserva el interior radial).
- **`columnAlignPass`**: hasta 3 pasadas; para cada ref alinea la fila de `columns[0]` de ambos
  extremos moviendo el extremo movible por `clamp(±delta·0.3, ±ROW_H·2)`, con
  `ROW_H = columnCenterY(1) − columnCenterY(0)` (no existe un `TABLE_ROW_H` fijo; la geometría es
  consciente de densidad). Desempate **determinista** (menor `totalDeg`, luego nombre).
- **`collisionGuard`**: barrido AABB (≤8 iteraciones, sort por x + early-break) como red de
  seguridad tras los nudges, separando por el eje de menor penetración con `MIN_GAP`.
- **Modos**: `all` (ELK completo); `new`/`selection` (incremental — solo el subconjunto movible,
  anclado a vecinos FK fijos, colocado por búsqueda en espiral evitando obstáculos). Atajo: si
  `movable.size === tables.length`, se usa el camino `all`.

Constantes afinables: `INTRA_NODESEP=32`, `INTRA_RANKSEP=64`, `INTER_NODESEP=96`, `INTER_RANKSEP=128`,
`CLUSTER_MARGIN=48`, `MIN_GAP=16`, `COLUMN_ALIGN_PASSES=3`, `COLUMN_ALIGN_FACTOR=0.3`,
`INCREMENTAL_STEP=64`.

### Runner (`runner.ts`)

`runSmartLayout(mode)` es **async**. Toma snapshot de `positions` y `edgeLayouts` antes del `await`;
ejecuta `smartLayout`; calcula el conjunto movido; resetea waypoints (+ `dx/dy`) de aristas con ambos
extremos en el conjunto movido (conservando `color`/sides); aplica posiciones + reseteos; arma un
`ArrangeCommand` compuesto y lo empuja al historial; agenda persistencia. `selection` con selección
vacía cae a `all` por el atajo.

### Reset manual de relaciones (selección)

Acción independiente del auto-arrange: "resetear las relaciones de las tablas seleccionadas". Para
cada arista que **toca** la selección (source **o** target seleccionado) y que tiene forma manual
(waypoints / `dx,dy` / `sourceSide,targetSide`), se resetea a ruteo por defecto — se limpian
waypoints + legacy + sides, se **conserva el color** (misma semántica que "Reset line" por arista). Es
un único paso deshacible (reusa `ArrangeCommand` con posiciones vacías, vía `buildEdgesResetCommand`).
Deja al usuario limpiar el ruteo de un conjunto de tablas sin reposicionarlas. Disparador: ítem
"Reset relations (N)" en el menú contextual de una tabla seleccionada (N = aristas con forma que tocan
la selección; deshabilitado si N = 0). Lógica pura en `computeSelectionEdgeResets` (`edgeReset.ts`),
runtime en `resetSelectedEdges` (`runner.ts`).

## Modelo de datos / tipos afectados

- `src/shared/types.ts`: nuevo `AutoArrangeMode = 'all' | 'new' | 'selection'`; nuevo miembro en
  `HostToWebview`: `{ type: 'command:autoArrange'; payload: { mode: AutoArrangeMode } }`. El **schema
  del layout sidecar no cambia** (`EdgeLayout.waypoints[]` intacto; la reescritura de aristas de 0.2.2
  no alteró el formato).
- `src/webview/state/history.ts`: nuevo `ArrangeCommand` en la unión `EditCommand`:
  ```ts
  interface ArrangeCommand {
    kind: 'arrange';
    from: Array<[QualifiedName, { x: number; y: number }]>;
    to: Array<[QualifiedName, { x: number; y: number }]>;
    edgesFrom: Array<[string, EdgeLayout | null]>;
    edgesTo: Array<[string, EdgeLayout | null]>;
    label: string;
    timestamp: number;
  }
  ```
- `src/webview/state/store.ts`: acción `pushArrangeCommand` + caso `'arrange'` en `applyCommand`
  (restaura posiciones **y** edgeLayouts). `setPositionsBatch` ya devuelve un `Map` nuevo (reactivo).

## Puntos de extensión / integración

- **Historial undo/redo**: se usa el seam `EditCommand` (nuevo `kind: 'arrange'`), modelado sobre
  `MoveCommand`/`applyCommand`.
- **Geometría helpers**: `estimateSize`, `columnCenterY` (`layout/autoLayout.ts`), `densityMetrics`
  (`layout/density.ts`). Se reusa el helper; **no** el legacy `autoLayout()`.
- **Persistencia**: `schedulePersist` (`persistence.ts`) ya serializa el layout completo vía
  `toTableLayoutRecord` → no clobbering de hidden/color/grupos/viewport/aristas.
- **Menú contextual**: primitivo `contextMenu.tsx` (soporta `disabled`/`separator`); se extiende
  `ctxItems` en `tableNode.tsx`.
- **Botón**: primitivo `<Button variant="action">` (`ui/Button.tsx`).
- Archivos tocados: `smartLayout/*` (nuevos), `shared/types.ts`, `state/history.ts`, `state/store.ts`,
  `webview/main.tsx`, `render/actionsPanel.tsx`, `render/tableNode.tsx`, `icons.tsx`,
  `extension/extension.ts`, `extension/panel.ts`, `package.json` (+ dep `elkjs`).

## Protocolo host↔webview

Nuevo mensaje **host → webview**: `{ type: 'command:autoArrange'; payload: { mode: AutoArrangeMode } }`.
`extension.ts` registra `dddbml.autoArrange` → QuickPick de 3 modos → `panel.sendAutoArrange(mode)` →
`post(...)`. El webview (`main.tsx`) despacha `case 'command:autoArrange'` → `void runSmartLayout(mode)`.
Las otras dos superficies (ActionsPanel, menú contextual) llaman `runSmartLayout` directo, sin salto al
host.

## Anti-goals / fuera de alcance

- Remoción de solapes por gradiente (FORBID): v1 mantiene el guard AABB ligero.
- Alineación por restricciones suaves (WebCola), bundling de aristas, ruteo ortogonal con
  minimización de dobleces.
- Expansión **visual** de la caja del grupo para `adoptedForeign` (el dato se calcula; el render es
  follow-up — ver spec 06).
- Logging de conteo de cruces (bilayer cross-count) en `formatAnalysis` (validación útil; v1.1).

## Fallos conocidos / casos límite

- **Tabla única en `selection`**: el modo incremental la reubica anclada a sus vecinos FK fijos
  (útil, no degenerado).
- **FK auto-referente** (tabla→sí misma): ambos extremos "se mueven" → sus waypoints se resetean;
  el self-loop se re-rutea vía `columnYResolver`. Cubierto por test.
- **`columns[0]`-only**: FKs compuestas alinean solo por la primera columna.
- **Nombres de columna**: deben venir des-comillados consistentemente (invariante de `parser.ts`); si
  no, `findIndex` falla en silencio y la alineación simplemente no ocurre (sin crash).

## Error handling

- Esquema vacío → no-op temprano.
- `result.size === 0` → no-op (sin comando, sin persistencia).
- `ArrangeCommand` no-op (posiciones idénticas y sin reseteos) → no se empuja al historial.
- Fallo de `elk.layout` (rechazo de promesa) → se captura en el runner, se loguea vía `error:log`, no
  se mutan posiciones (transacción todo-o-nada).

## Performance budget (`specs/07-performance-budgets.md`)

- Objetivo: layout de 5000 tablas < 3000ms. **Medido** en `test/fixtures/huge.dbml` (5000 tablas,
  1000 refs, 20 grupos): `analyze` (classify+cluster) **24ms**, `smartLayout` (ELK + column-align +
  collision guard) **~2.57s** → dentro del presupuesto, sin Web Worker. Si esquemas más densos
  exceden 3s, mover ELK a un **Web Worker** (`elkjs` worker build) y/o bajar exhaustividad.
- El reset de waypoints es O(|aristas|) — despreciable. Payload postMessage < 10MB; escritura de
  sidecar < 50ms (ambos cubiertos por la persistencia existente).

## Test plan

Vitest, `*.test.ts` colocados en `smartLayout/`. Fixtures parseados con el `parseDbml` del host
(`src/extension/parser.ts` — solo Node/vitest). Fixtures: `test/fixtures/small.dbml`,
`test/fixtures/huge.dbml`.
- **Suite A — `analyze`**: cobertura disjunta (`assigned.size === tables.length`); todo rol definido;
  vuelca `formatAnalysis()` (incl. `adoptedForeign`) a un artefacto inspeccionable.
- **Suite B — `smartLayout`** (async): `all` → cubre todas, **cero solape AABB** (aserción
  portante); `new` → posiciones sembradas byte-exactas, solo coloca faltantes; `selection` → no
  seleccionadas byte-exactas; **determinismo** → dos corridas idénticas.
- **Suite C — runner/undo**: arrange empuja un `ArrangeCommand`; undo restaura posiciones +
  waypoints; aristas con ambos extremos movidos limpian `waypoints` y conservan `color`/sides; FK
  auto-referente no rompe.
- Manual (Extension Development Host): abrir `huge.dbml`, correr los 3 modos desde las 3 superficies;
  verificar grupos como cajas, hubs radiales, sin solapes, aristas limpias, Ctrl+Z único revierte
  todo, diff del sidecar entero/ordenado/mínimo.

## Documentos relacionados

- `03-layout-file-schema.md` (persistencia del sidecar)
- `05-edge-routing.md` (waypoints absolutos, `columnYResolver`, reset en arrange)
- `06-tablegroups.md` (bounded contexts; expansión visual de `adoptedForeign` futura)
- `07-performance-budgets.md` (presupuesto de layout)
- `11-action-history.md` (`ArrangeCommand`)
- `12-design-system.md` (densidad, tokens, primitivos UI)
