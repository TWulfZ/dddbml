# 19 — Edición asistida: el diagrama como navegador del `.dbml`

## Propósito

Hacer que el diagrama acelere la edición del `.dbml` **sin convertirse en un editor de schema**:
navegar código↔diagrama, crear tablas y FKs desde el canvas, y borrar con confirmación. El texto
sigue siendo la única fuente de verdad y el lugar donde se escribe el detalle (campos, tipos).

## Contexto / Problema

Hoy el diagrama solo lee el `.dbml`: el doble click en una tabla abre su línea (`command:reveal`),
pero no hay forma de ir del código al diagrama, ni de crear una tabla en una posición concreta, ni
de dibujar una FK. La auditoría 2026-09-22 mostró además la clase de bug que este feature debe
evitar: dos escritores del mismo estado (el webview reescribiendo el sidecar con un snapshot viejo,
F01/F27). Aquí hay dos archivos en juego (`.dbml` y sidecar), así que la propiedad de cada uno
tiene que ser explícita.

## Preguntas abiertas (Open Questions)

- [x] **¿Editor de schema en el diagrama o asistencia al editor de texto?** — **Decisión:**
  asistencia. Los campos y tipos se escriben en el editor de texto; el diagrama redirige a él.
  (Acordado con el owner, 2026-10-01.)
- [x] **Cómo se aplica una edición.** — **Decisión:** edición de texto mínima sobre el documento
  + guardar; nunca regenerar el archivo. (2026-10-01.)
- [x] **Navegación código → diagrama.** — **Decisión:** Ctrl+click sobre el nombre en la
  declaración `Table` enfoca la tabla en el diagrama, como dbdiagram.io. Sin seguimiento del
  cursor (más estado y más frágil). (2026-10-01.)
- [x] **Creación de FK.** — **Decisión:** arrastrar desde el puerto de un campo hasta un campo de
  otra tabla; al soltar se elige la cardinalidad; se escribe inline `[ref: > tabla.campo]`. (2026-10-01.)
- [x] **Alcance v1.** — **Decisión:** navegación código↔diagrama (incluye doble click en campo →
  línea del campo), crear tabla con click derecho, agregar campo (redirige al editor), crear FK,
  borrar tabla/campo/FK. **Diferido:** selector de tipos, enums en el diagrama y autocompletado
  del editor. (2026-10-01.)
- [x] **Buffer con cambios sin guardar.** — **Decisión:** no agregar lógica propia; apoyarse en
  VS Code. La edición se aplica y se guarda siempre. Si `files.autoSave` está en `off`, el panel
  muestra **una vez por sesión** una advertencia recomendando activar el autoguardado (con botón
  que abre esa opción), porque el diagrama refleja el archivo guardado. (Acordado, 2026-10-01.)
- [x] **Undo de una edición de schema hecha desde el diagrama.** — **Decisión:** Ctrl+Z en el
  diagrama la revierte: el host guarda la edición inversa y la versión del documento tras
  aplicarla; el undo aplica la inversa solo si el documento no cambió desde entonces; si cambió,
  avisa y remite al Ctrl+Z del editor (el comando sale del historial sin aplicarse). (2026-10-01.)
- [ ] **Borrar un campo que participa en un índice compuesto.** Opciones: quitar el campo del
  índice (y el índice si queda vacío) / rechazar con aviso. *No bloqueante* (default propuesto:
  rechazar con aviso). **Implementado el default** (rechazar); un índice de **una sola** columna
  sobre ese campo se borra con él y aparece en la confirmación (sin él el archivo no parsearía).
- [ ] **Contenido de una tabla nueva.** Default propuesto: `id int [pk]`. *No bloqueante.*
  **Implementado el default.**


## Diseño

### Propiedad del estado (la regla que evita sobrescrituras)

| Estado | Único escritor | Cómo llega al otro proceso |
|---|---|---|
| Texto del `.dbml` | **host** (`WorkspaceEdit` sobre el `TextDocument`) | watcher → `sendSchema` (parse del buffer) |
| `tables`/`edges`/`groups` del sidecar mientras el panel está abierto | **webview** (`layout:persist`) | `writeShared` en el host |
| Posición de una tabla creada desde el canvas | **webview** (recibe `layout:place` antes de que exista la tabla) | persist normal |

El webview **nunca** envía texto ni un schema: envía *intenciones* (`schema:addTable`,
`schema:addRef`, `schema:delete…`). El host las resuelve contra una lectura fresca del buffer y un
parse fresco (tokens de `@dbml/core` para ubicar rangos, como `tableLocation.ts`), y aplica solo si
`document.version` no cambió entre el parse y el `applyEdit` (si cambió, reintenta una vez; si no,
avisa). El host no escribe `tables` del sidecar mientras el panel está abierto: así el persist del
webview, que reemplaza `tables` entero, no puede borrar una entrada que el host acabara de escribir.

Toda intención se rechaza (con aviso) si el panel está en solo lectura (spec 16, gate en dos capas)
o si el buffer actual no parsea (no hay rangos fiables).

Implementación (host, `schemaEditor.ts`): las intenciones de un panel corren **de a una** (cola). Cada
una lee `document.getText()` + `document.version`, pide la edición al worker (op `schemaEdit`, canal
`edit:<uri>`) y aplica el `WorkspaceEdit` solo si la versión sigue igual; si cambió, recalcula una
vez y si vuelve a cambiar avisa ("kept changing") sin tocar nada. El worker además **re-parsea el
resultado** antes de devolverlo: una edición que dejaría el archivo inválido (p. ej. una tabla que
aún nombra un bloque `Records` o `Dep`, o una ref inline declarada en un `TablePartial`) se rechaza
con el motivo, nunca se aplica.

### Navegación

- **Código → diagrama:** `DocumentLinkProvider` para `.dbml` que marca el nombre de cada
  declaración `Table` con un link `command:dddbml.revealInDiagram?<qualifiedName>` (tooltip
  "Show in diagram"). Ctrl+click abre el panel si no está abierto, centra la cámara en la tabla
  (`fitToBbox`) y la selecciona. Una tabla oculta o dentro de un grupo colapsado enfoca su grupo.
- **Diagrama → código:** doble click en una tabla abre su línea (ya existe); doble click en un
  campo abre la línea de ese campo (`findColumnLocation` en `tableLocation.ts`, op `locateColumn`;
  cursor sobre el nombre del campo, canal `locate:<uri>` compartido con el doble click de tabla).
- Detalle del link: los argumentos del comando son `[uri del documento, nombre calificado]`
  (JSON en la query del `command:` URI), así el comando abre el panel de **ese** archivo. Los
  rangos salen del worker (op `tableLinks`) con un **escaneo léxico** (comentarios y strings
  excluidos, solo declaraciones de nivel superior) en vez de un parse: VS Code pide links en cada
  pausa de tipeo, deben funcionar con el buffer roto, y un parse de 5000 tablas ocuparía la cola
  del worker ~2 s. El foco espera a que el webview esté hidratado (`whenHydrated`).

### Crear tabla (click derecho en el canvas vacío)

1. Menú "New table here" → el host pide el nombre (`showInputBox`, valida identificador, permite
   `schema.tabla`, rechaza duplicados). Al cerrarse el input vuelve a mirar el gate de solo lectura
   (un merge o una vista git pudo abrirse mientras se escribía).
2. Host → webview `layout:place { table, x, y }` (coords world del click, snap a grilla si está
   activo). El webview guarda la posición aunque la tabla aún no exista en el schema.
3. Host inserta al final del archivo `Table <nombre> {\n  id int [pk]\n}`; si el click cayó dentro
   del contenedor de un grupo expandido, agrega también el nombre al bloque `TableGroup`.
4. Guarda, abre el editor con el cursor en una línea nueva dentro del bloque, listo para escribir
   campos. Al llegar el schema, la tabla aparece donde se hizo click (no se auto-coloca).

Detalles fijados: el nombre se escribe `tabla` o `schema.tabla`; cada parte es texto libre (se
escribe entre `"…"` si lo necesita, `addDoubleQuoteIfNeeded` de `@dbml/core`) y una parte con punto
va entre comillas en el input. El archivo guardado queda limpio (`Table x {⏎  id int [pk]⏎}`); la
línea vacía indentada del cursor se inserta **después** de guardar, sin guardar (igual que "Agregar
campo"), y el undo de la intención la quita junto con la tabla. Se separa del contenido previo con
una línea en blanco y respeta el fin de línea del archivo (LF/CRLF). El miembro del `TableGroup` va
antes de su `}` con la indentación de los demás miembros. El webview manda `x, y` ya ajustados a la
grilla; el host los reenvía tal cual en `layout:place`, antes de aplicar la edición.

### Agregar campo

Click derecho en una tabla → "Add field" → el host abre el editor, inserta una línea vacía con la
indentación del bloque antes del `}` y coloca el cursor. No escribe nada más: el usuario teclea y
guarda; el diagrama se actualiza al guardar. Como no guarda, **no** produce `schema:applied` ni
entra al historial del diagrama (el undo del editor lo cubre); sí respeta el gate de solo lectura.

### Crear FK (arrastre campo → campo)

Arrastrar desde el puerto de un campo (fila visible en LOD `full`) hasta un campo de otra tabla.
Al soltar, un popup elige la cardinalidad (`>`, `<`, `-`, `<>`). El host agrega `ref: <op>
schema.tabla.campo` a los settings del campo origen (dentro del `[...]` existente, o creando
`[ref: ...]`). Las refs a la misma tabla (self-ref) se permiten. Respeta el gate de solo lectura.
El schema `public` se omite (`@dbml/core` 10 resuelve los endpoints sin schema a `public`, sea cual
sea el schema de la tabla origen). Un `[]` pegado al tipo (`text[]`) es parte del tipo, no settings.
Se rechaza una ref que ya existe (mismos extremos) y la de un campo inyectado por `TablePartial`.

### Borrar (tabla, campo, FK)

Desde el menú contextual de la tabla, del campo o del edge, con confirmación modal en el host
(muestra qué refs se borran también). Tabla: su bloque, las refs inline o `Ref:` que la mencionan y
su línea en cada `TableGroup`; la entrada del sidecar queda huérfana (spec 03: `Prune orphans` la
limpia; así un undo recupera la posición). Campo: su línea y las refs que lo usan. FK: el `ref:`
inline (y el `[]` si queda vacío) o la sentencia `Ref:`.

Detalles fijados:
- Todo borrado (también una FK sola) pide confirmación; el modal lista la cascada en `detail`. Tras
  confirmar se recalcula contra el buffer actual; si la cascada difiere de la confirmada, se avisa y
  no se aplica.
- Una línea que queda vacía se borra entera (con su comentario final); si el bloque borrado estaba
  entre dos líneas en blanco (o un borde del archivo) se lleva una de ellas. Al sacar un setting se
  conservan los separadores del resto (`[ref: > a.id, not null]` → `[not null]`).
- Un miembro de grupo se reconoce también por el alias de la tabla.
- Campo: se rechaza si es la única columna, si viene de un `TablePartial` o si está en un índice
  compuesto (ver Preguntas abiertas); un índice de una sola columna sobre él se borra con él.

### Escritura y autoguardado

`applyEdit` + `document.save()` en cada intención. Si la configuración `files.autoSave` es `off`,
la primera intención de la sesión muestra un `showWarningMessage` no modal: "dddbml writes your
.dbml from the diagram; enable Auto Save to keep both in sync" con acción "Enable Auto Save"
(`workbench.action.toggleAutoSave`) y "Don't show again" (memento global).
"Primera intención" = la primera que guarda (no "Agregar campo"); "Don't show again" se guarda en
`globalState` bajo `dddbml.autoSaveWarningDismissed`.

### Undo

Cada intención aplicada produce un `SchemaEditCommand` en el historial del diagrama (spec 11) con
un id; el host guarda `{ id, uri, versionAfter, inverse: TextEdit[], placed?: tabla }`. Ctrl+Z en el
diagrama envía `schema:undo { id }`: el host aplica `inverse` si `document.version === versionAfter`
y guarda; si no, avisa ("the .dbml changed since; use Undo in the editor") y descarta el comando.
Redo análogo con la edición directa. Deshacer "crear tabla" no borra su posición del sidecar
(queda huérfana, spec 03), así un redo la vuelve a colocar en el mismo punto.

Detalles fijados:
- El **host** genera el id y lo informa con `schema:applied { id, label }` tras guardar; el webview
  empuja entonces el `SchemaEditCommand`. El host guarda por panel `{ label, estado, edits
  pendientes, versión }` (sin `placed`: el sidecar no se toca), con tope de 200 entradas como el
  historial (spec 11).
- Si el host no ejecuta un `schema:undo`/`schema:redo` (versión cambiada, id desconocido, estado que
  no corresponde, solo lectura, edición rechazada por VS Code) responde `schema:discarded { id }` y
  el webview saca el comando del historial sin aplicarlo.
- Tras cada guardado se compara el texto con el esperado: si un participante de guardado (formato,
  `trimTrailingWhitespace`, …) reescribió más que la edición, la inversa pasa a ser el diff mínimo
  entre el texto actual y el anterior, así el undo restaura exactamente el texto previo igual.
- La inversa la calcula el worker junto con la edición (`inverse` en offsets del texto editado).

### Webview (implementación)

- **`layout:place`** → `placeTable` en el store: fija la posición aunque la tabla no esté en el
  schema, quita un `hidden` huérfano con ese nombre (si no, la tabla recién creada sería invisible) y
  persiste. Se ignora en solo lectura. `setSchema` no poda `positions` y el auto-placement sólo
  coloca tablas sin posición, así que la tabla aparece donde se hizo click.
- **Undo** (spec 11): `SchemaEditCommand { id, label }`; ver allí el eco de `setSchema` que evita
  vaciar la pila cuando el cambio de tablas lo causó la propia edición.
- **`diagram:focusTable`** (`render/focusTable.ts`): `fitToBbox` con zoom máximo 100 % (una tabla
  sola no se agranda más) y la selecciona. Miembro de grupo colapsado → encuadra el nodo del grupo
  sin seleccionar. Tabla oculta → aviso "X is hidden." y, si su grupo está expandido y visible,
  encuadra el contenedor; si no, la cámara no se mueve. Tabla ausente del schema (buffer sin
  guardar) → aviso, sin mover la cámara. Los avisos usan la nota transitoria del webview (spec 13).

## Modelo de datos / tipos afectados

- `WebviewToHost`: `schema:addTable { x, y, group? }`, `schema:addField { table }`,
  `schema:addRef { from: {table, column}, to: {table, column}, op }`,
  `schema:delete { kind: 'table' | 'field' | 'ref', … }`, `command:revealColumn { table, column }`.
- `HostToWebview`: `layout:place { table, x, y }`, `diagram:focusTable { table }`.
- Forma exacta implementada (`src/shared/types.ts`):
  ```ts
  type RefOp = '>' | '<' | '-' | '<>';
  interface ColumnRef { table: QualifiedName; column: string }
  type SchemaDeleteTarget =
    | { kind: 'table'; table: QualifiedName }
    | { kind: 'field'; table: QualifiedName; column: string }
    | { kind: 'ref'; refId: string };            // Ref.id
  // WebviewToHost
  | { type: 'schema:addTable'; payload: { x: number; y: number; group?: string } }
  | { type: 'schema:addField'; payload: { table: QualifiedName } }
  | { type: 'schema:addRef'; payload: { from: ColumnRef; to: ColumnRef; op: RefOp } }
  | { type: 'schema:delete'; payload: SchemaDeleteTarget }
  | { type: 'schema:undo'; payload: { id: string } }
  | { type: 'schema:redo'; payload: { id: string } }
  | { type: 'command:revealColumn'; payload: ColumnRef }
  // HostToWebview
  | { type: 'layout:place'; payload: { table: QualifiedName; x: number; y: number } }
  | { type: 'diagram:focusTable'; payload: { table: QualifiedName } }
  | { type: 'schema:applied'; payload: { id: string; label: string } }
  | { type: 'schema:discarded'; payload: { id: string } }
  ```
- Worker (`parseClient.ts` `ParseOps`): ops nuevas `locateColumn`, `tableLinks`, `schemaEdit`
  (además de `parse` y `locate`); un solo despachador `parseOps.ts` lo usan el worker y
  `testing/parseSetup.ts`. Las ediciones son offsets UTF-16 (`textEdits.ts`, puro, lo importan
  host y worker); el host las convierte con `document.positionAt`.
- Store: `positions` acepta claves de tablas aún no presentes en el schema (ya es un `Map` por
  nombre); `setSchema` no las poda.
- Sidecar: sin cambios.

## Puntos de extensión / integración

`src/extension/tableLocation.ts` (rangos por tokens), `dbmlModel.ts` (vista tipada del modelo de
`@dbml/core`), `dbmlScan.ts` (léxico mínimo para separadores y miembros de grupo que los tokens del
parser no cubren), `schemaEditor.ts` (host: cola, gate, versión, undo) y nuevo `src/extension/schemaEdits.ts` (puro:
fuente + intención → `TextEdit[]`, testeable sin VS Code). **Ambos corren dentro del worker de
parse** (`parseWorker.ts`): cada consulta de posiciones o cálculo de edición es un op nuevo de
`ParseRequest` (`parseClient.ts` + `parseWorker.ts` + `testing/parseSetup.ts`); el host nunca importa
`@dbml/core` (el bundle del host no lo contiene y un parse síncrono lo bloquearía, spec 18). El host
solo aplica el `WorkspaceEdit` resultante, `panel.ts` (handlers + gate),
`extension.ts` (`DocumentLinkProvider`, comando `dddbml.revealInDiagram`), `webview/render/
contextMenu.tsx` y `tableNode.tsx` (menús), `drag/dragController.ts` (arrastre de FK, distinto del
drag de tabla), `render/viewport.ts` (`fitToBbox` para el foco).

## Anti-goals / fuera de alcance

Selector de tipos, enums en el diagrama, autocompletado/hover en el editor, renombrar tablas o
campos desde el diagrama, edición de notas, indexes o settings distintos de `ref`, soporte de
`!include` (las ediciones solo tocan el archivo del panel).

## Fallos conocidos / casos límite

- Nombres que requieren comillas (espacios, Unicode no identificador) se escriben entre `"…"`.
- Si el texto cambió entre el parse y el `applyEdit`, se reintenta una vez y luego se avisa.
- Una FK hacia una tabla de un grupo colapsado no se puede soltar sobre un campo (el grupo no
  muestra filas); expandir primero.

## Error handling

Toda intención rechazada (solo lectura, buffer que no parsea, nombre inválido, versión cambiada)
muestra un `showWarningMessage` con el motivo y no toca ningún archivo.

## Performance budget

Las intenciones son eventos discretos; el costo es un parse del archivo (~1 s en `huge.dbml`, ver
el worker de parse de la sesión records/deps). Ningún cambio en el camino de pan/zoom/drag.

Medido (worker en proceso, `huge.dbml`, 5000 tablas, máquina cargada): una intención cuesta **dos**
parses — el de la fuente y el de verificación del resultado — ~3.7 s en total para borrar una
tabla; los links de un archivo de 1 MB, ~25 ms (escaneo léxico, sin parse). Un borrado reusa el
cálculo que se confirmó si el documento no cambió mientras el modal estaba abierto.

## Test plan

- `schemaEdits.test.ts`: cada intención sobre fixtures con comentarios, comillas, schemas, refs
  inline y `Ref:`; el texto fuera del rango tocado queda byte-idéntico; el resultado parsea.
- Host (`panelHarness`): gate de solo lectura, versión cambiada, buffer sin parsear, orden
  `layout:place` antes del guardado.
- Manual en el Extension Development Host: Ctrl+click en `Table x` enfoca la tabla; crear tabla
  en un punto y dentro de un grupo; arrastrar FK; borrar tabla con refs y deshacer.

## Documentos relacionados

- [`02-dbml-ast-mapping.md`](02-dbml-ast-mapping.md) — tokens y nombres calificados.
- [`03-layout-file-schema.md`](03-layout-file-schema.md) — huérfanos y `Prune orphans`.
- [`11-action-history.md`](11-action-history.md) — historial del diagrama.
- [`16-git-integration.md`](16-git-integration.md) — gate de solo lectura.
