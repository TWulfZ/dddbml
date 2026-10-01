# 18 — Records, dependencias (`Dep`) y `headercolor`

## Propósito

Soportar dos construcciones DBML que hoy rompen el parse (issue #3): **`records`** (filas de
ejemplo por tabla) y **`Dep`** (dependencias lógicas upstream → downstream, p. ej. vistas
materializadas o lineage). Además, respetar `headercolor` del `.dbml` sin ensuciar el sidecar, y
ofrecer un color custom con gotero en el selector de color.

## Contexto / Problema

- `@dbml/core` 3.14.1 no parsea ninguna de las dos sintaxis (`Invalid start of operand ","`,
  `A custom element can only appear in a Project`). `records` aparece en 8.x; `Dep` sólo en
  **10.x**. Verificado con 3.14.1, 5.5.1, 8.3.1, 9.1.1 y 10.2.0.
- El export de 10.2.0 es idéntico al de 3.14.1 en todos los fixtures del repo salvo campos nuevos
  (`recordIds`, `metadata`, `checkIds`, `injectedPartialId`) e `increment: false`, que ahora se
  omite (sólo aparece cuando es `true`).
- Costo medido del bump: parse de `huge.dbml` (5000 tablas) **770 ms → 1770 ms** (mediana de 6
  corridas); bundle del host **1.7 → 2.8 MB gz**. Por eso el parse sale del hilo del host
  (ver §Parse en worker y spec 07).
- `headercolor` ya venía en el export pero `parser.ts` nunca lo leía; el color de tabla salía sólo
  del sidecar.

Sintaxis soportada (fuente: issue #3):

```dbml
records users (id, name) {
  1, 'a'
  2, 'b'
}

Table users {
  id int [pk]
  name varchar
  records { 1, 'a' }
}

Dep: raw_stripe -> stg_orders              // a nivel tabla
Dep: stg_orders.amount -> mart_revenue.revenue   // a nivel columna
Dep orders_lineage [color: #3b82f6, note: 'Aggregates paid orders'] {
  stg_orders -> mart_revenue
}
```

Un bloque `Dep` no puede mezclar aristas de tabla y de columna (lo rechaza el parser).

## Preguntas abiertas (Open Questions)

- [x] ¿Subir `@dbml/core` a 10.x pese al costo de parse? — **Decisión:** sí, a ^10.2.0, y además
  mover el parse a `worker_threads` (acordado con el usuario, 2026-10-01).
- [x] ¿Cómo se ve el preview de records? — **Decisión:** badge `▦ N` en el header de la tabla
  (LOD `full`); al hacer clic abre el `<Modal>` con una grilla. No se dibuja nada inline: no cambia
  la geometría de la tabla ni el layout (2026-10-01).
- [x] ¿Cómo se dibuja una `Dep`? — **Decisión:** **curva** (no ortogonal) con **stubs rectos
  rígidos** a la salida y a la entrada, igual que las refs, para que no choque con la tabla.
  Punteada, con flecha upstream → downstream y tooltip con la nota. Waypoints editables estilo
  dbdiagram: arrastrar el handle del medio de un tramo inserta un nodo, arrastrar un nodo lo mueve
  y doble clic lo borra (2026-10-01).
- [x] ¿Las `Dep` influyen en el auto-layout / A*? — **Decisión:** no. Sólo render + waypoints
  (2026-10-01).
- [x] ¿`headercolor` del `.dbml`? — **Decisión:** precedencia `sidecar > headercolor > default`.
  `headercolor` se pinta **sin escribir el sidecar**. Si el usuario cambia el color desde la UI en
  una tabla con `headercolor`, se guarda en el sidecar y aparece un **warning** con "Learn more"
  hacia la doc (diseño en el layout, datos en el DBML) (2026-10-01).
- [x] ¿Color custom? — **Decisión:** al final de la paleta un chip con ícono de gotero (sin texto)
  que abre el `<input type="color">` nativo. Aplica a tablas, grupos y aristas: los tres ya usan
  `ColorPopup` (2026-10-01).
- [x] ¿Enums? — **Decisión:** fuera de alcance; el usuario confirma que funcionan.
- [x] ¿Cuántas filas de records viajan al webview? — **Decisión:** máximo 200 por tabla, con el
  total real en `totalRows`. Acota el `postMessage` y el dedupe por `JSON.stringify` de
  `sendSchema`.
- [x] ¿El aviso de override de `headercolor` puede repetirse? — **Decisión:** una vez por tabla y
  por sesión del panel, para no molestar.

## Diseño

### Parse (host)

- `parseDbml` lee `export().records[]` y `schemas[].deps[]`. Los nombres se normalizan con los
  `unquote`/`qualify` existentes, así que una `Dep` y una `Ref` hacia la misma tabla resuelven
  igual.
- Los valores de records se reducen a `{v, t}`, donde `t` es el tipo que reporta el parser
  (`integer`, `string`, `bool`, `null`, `expression`, …).
- `headercolor` se mapea a `Table.headerColor`.
- `increment` se lee como truthy (10.x omite `increment: false`).

### Records (webview)

- `tableNode` muestra el badge sólo con LOD `full` y si la tabla tiene records. El mapa
  `QualifiedName → TableRecords` se memoiza a partir de `schema.records`; no se recorre en cada
  render.
- `RecordsModal` envuelve `ui/Modal` (`wide`) y se abre con la flag del store
  `recordsTable: QualifiedName | null`. La grilla tiene header sticky y muestra el tipo de cada
  columna. `null` va en itálica atenuada y las expresiones en mono. Si
  `totalRows > rows.length`, muestra "showing 200 of N".

### Dependencias — render

- Las `Dep` viven **fuera de `refs`**. Así el exporter TypeORM no las convierte en relaciones, el
  dedupe de `edgeKeyedRefs` no las fusiona con una FK de iguales endpoints y `schemaDiff` las
  ignora.
- Clave de arista: `dep:` + `edgeKey(upstream, cols, downstream, cols)`. Comparte
  `Layout.edges` con las refs sin colisionar y pasa `isEdgeKey` porque contiene `::`.
- Endpoints ocultos o colapsados se remapean con el mismo `mapEndpoint` que las refs.
- Geometría (`render/depRouter.ts`, puro):
  - Lados izquierda/derecha según los centros (misma regla que `chooseSides`).
  - Puerto Y: centro de la primera columna si la dep es a nivel columna; centro del header si es
    a nivel tabla.
  - Stubs horizontales rígidos de 24 px (= `MIN_STUB` de las refs), recortados a la mitad del gap
    cuando las tablas están muy juntas.
  - Entre los stubs:
    - Sin waypoints: una Bézier cúbica con handles horizontales (`max(40, |dx|/2)`).
    - Con waypoints: Catmull-Rom → Béziers que **pasan por** cada waypoint. La tangente en los
      extremos es la dirección del stub, así que no hay quiebre donde la curva sale de la tabla.
- La capa es el mismo SVG de `edgeLayer.tsx` (`<g class="ddd-dep-group">`), con trazo punteado
  `--ddd-dep` y marker de flecha al final. El culling es el mismo que el de las refs.
- Color: `EdgeLayout.color` (sidecar) > `Dep.color` (DBML) > token.
- Toggle efímero "Dependencies" en View options (`groupPanel`), activado por defecto y visible sólo
  si el schema tiene deps. Apagado también las saca del export de imagen.

### Dependencias — edición

- Sólo la dep seleccionada muestra handles: uno de inserción por tramo (punto t=0.5) y uno por
  waypoint.
- Arrastrar un handle de inserción crea un waypoint en `index`; arrastrar un waypoint lo mueve;
  doble clic lo borra.
- Undo/redo reutiliza `WaypointCommand` (está keyeado por un `refId` genérico, así que acepta
  claves `dep:`).
- La persistencia va por `Layout.edges[key].waypoints`, con coords enteras (invariante
  git-friendly de spec 03).

### `headercolor` y selector de color

- Color efectivo de la tabla = `layout.tables[t].color ?? table.headerColor ?? token`.
  "Reset" vuelve a `headerColor`.
- Cambiar el color desde la UI cuando no había color en el sidecar y la tabla tiene
  `headerColor` → el webview envía `notify:headerColorOverride`. El host responde con
  `showWarningMessage(…, 'Learn more')` y el botón abre la sección del README "Design vs data".
- `ColorPopup`: la fila custom deja de tener texto y pasa a ser un chip con ícono de gotero (último
  de la grilla) que envuelve el `<input type="color">` nativo (el picker de Chromium ya trae gotero
  de pantalla). Conserva el modelo existente: preview en vivo con `onPreview` y un único `onPick`
  al confirmar (listener nativo de `change`, porque preact/compat convierte el `onChange` de JSX en
  `oninput`). Resultado: un solo comando de undo y un solo aviso. Como el preview ya escribe el
  store, "la tabla no tenía color en el sidecar" se toma como foto al **abrir** el popup.

### Parse en worker

- `parser.ts` conserva `parseDbml` síncrono y puro (lo importan los tests de layout y el worker).
- `parseWorker.ts` es la entry de `worker_threads`; atiende dos operaciones con el mismo parser:
  `parse` y `locate`. Esta última es el go-to-source por doble clic (`tableLocation.findTableLine`),
  que antes hacía un parse síncrono completo en el host.
- `parseClient.ts`:
  - Un worker persistente para todo el extension host (`parseService.ts`).
  - Carriles **latest-wins** por canal (`live:<uri>`, `revision:<uri>`, `diffBase:`, `diffHead:`,
    `locate:`). Un pedido reemplazado resuelve `null`/`undefined` y su resultado se descarta.
  - Respawn si el worker muere (el pedido en vuelo se reporta como error de parse).
- `panel.ts`:
  - `sendSchema` espera `parseAsync`. Si una versión más nueva la reemplaza, espera a ese envío
    (`latestSchemaSend`), así hydrate y las salidas de overlay siguen viendo "schema publicado"
    antes de su siguiente mensaje.
  - Time travel y diff HEAD también usan el worker.
- Build: segunda entry de esbuild (`--outdir`) → `dist/extension/extension/parseWorker.js`.
  `extension.js` baja de 15.1 MB a 64 KB.
- Tests: `vite.config.mts` registra `src/extension/testing/parseSetup.ts`, que inyecta un "worker"
  en proceso, porque vitest no tiene el bundle de esbuild.

## Modelo de datos / tipos afectados

```ts
// src/shared/types.ts (aditivo, todo opcional)
export interface RecordValue { v: string | number | boolean | null; t: string }
export interface TableRecords { table: QualifiedName; columns: string[]; rows: RecordValue[][]; totalRows: number }
export interface DepEndpoint { table: QualifiedName; columns: string[] }
export interface DepEdge { id: string; upstream: DepEndpoint; downstream: DepEndpoint }
export interface Dep { name: string | null; color?: string; note?: string | null; edges: DepEdge[] }
// Schema: records?: TableRecords[]; deps?: Dep[]
// Table:  headerColor?: string
```

El sidecar no cambia de schema: las deps sólo agregan claves `dep:*` en `edges`.

## Puntos de extensión / integración

- `src/extension/parser.ts`: mapeo de records, deps y headerColor.
- `render/edgeKey.ts`: helper `depKey`.
- `render/depRouter.ts` (nuevo).
- `render/edgeLayer.tsx`: grupo de deps y handles.
- `render/recordsModal.tsx` (nuevo).
- `render/tableNode.tsx`: badge y color efectivo.
- `render/colorPopup.tsx`: chip con gotero.
- `state/store.ts`: `recordsTable`, `showDeps`.
- `state/history.ts`: sin cambios (se reutiliza `WaypointCommand`).
- `export/imageExport.ts`: deps en el SVG exportado.
- `extension/panel.ts`: aviso de headercolor y `parseAsync`.

## Protocolo host↔webview

- `schema:update` sin cambios de forma (`Schema` gana campos opcionales).
- Nuevo `WebviewToHost`: `{ type: 'notify:headerColorOverride'; table: QualifiedName }`.

## Anti-goals / fuera de alcance

- Preview de enums.
- Deps en dagre, smart layout, A* o `schemaDiff`.
- Editar records desde la UI.
- `!include`.
- Deps de nivel mixto (las rechaza el parser).
- Exportar deps a TypeORM.

## Fallos conocidos / casos límite

- Una dep entre tablas que se solapan en X recorta los stubs a la mitad del gap, igual que las
  refs, y la curva puede quedar casi recta.
- Una dep cuyo endpoint quedó colapsado dentro de un grupo se dibuja hacia el header del nodo del
  grupo. Su clave cambia mientras está colapsada (igual que las refs), así que los waypoints
  editados en ese estado son independientes de los de la dep expandida.
- Las filas por encima de 200 no se ven en el preview (se indica el total).

## Plan de pruebas

- `parser.test.ts`:
  - records top-level e inline, el tope de 200 filas y los tipos.
  - Dep a nivel tabla y a nivel columna, y un bloque con color/nota.
  - `headercolor`.
  - la sintaxis exacta del issue #3.
- `depRouter.test.ts`:
  - stubs fijos y lados espejados.
  - la curva pasa por los waypoints y es tangente a los stubs.
  - un handle de inserción por tramo; coords enteras al insertar.
- `edgeKey`: una clave `dep:` pasa `isEdgeKey`.
- `parseClient`: latest-wins y respawn.
- Manual en el Extension Development Host con `test/fixtures/records-deps.dbml`.

## Relacionado

- [02 — mapeo AST](02-dbml-ast-mapping.md)
- [03 — sidecar](03-layout-file-schema.md)
- [05 — edge routing](05-edge-routing.md)
- [07 — budgets](07-performance-budgets.md)
- [12 — design system](12-design-system.md)
- [17 — export de imagen](17-export-image.md)
