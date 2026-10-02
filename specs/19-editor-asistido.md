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
  rechazar con aviso).
- [ ] **Contenido de una tabla nueva.** Default propuesto: `id int [pk]`. *No bloqueante.*


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

### Navegación

- **Código → diagrama:** `DocumentLinkProvider` para `.dbml` que marca el nombre de cada
  declaración `Table` con un link `command:dddbml.revealInDiagram?<qualifiedName>` (tooltip
  "Show in diagram"). Ctrl+click abre el panel si no está abierto, centra la cámara en la tabla
  (`fitToBbox`) y la selecciona. Una tabla oculta o dentro de un grupo colapsado enfoca su grupo.
- **Diagrama → código:** doble click en una tabla abre su línea (ya existe); doble click en un
  campo abre la línea de ese campo (`findColumnLine`, extensión de `tableLocation.ts`).

### Crear tabla (click derecho en el canvas vacío)

1. Menú "New table here" → el host pide el nombre (`showInputBox`, valida identificador, permite
   `schema.tabla`, rechaza duplicados).
2. Host → webview `layout:place { table, x, y }` (coords world del click, snap a grilla si está
   activo). El webview guarda la posición aunque la tabla aún no exista en el schema.
3. Host inserta al final del archivo `Table <nombre> {\n  id int [pk]\n}`; si el click cayó dentro
   del contenedor de un grupo expandido, agrega también el nombre al bloque `TableGroup`.
4. Guarda, abre el editor con el cursor en una línea nueva dentro del bloque, listo para escribir
   campos. Al llegar el schema, la tabla aparece donde se hizo click (no se auto-coloca).

### Agregar campo

Click derecho en una tabla → "Add field" → el host abre el editor, inserta una línea vacía con la
indentación del bloque antes del `}` y coloca el cursor. No escribe nada más: el usuario teclea y
guarda; el diagrama se actualiza al guardar.

### Crear FK (arrastre campo → campo)

Arrastrar desde el puerto de un campo (fila visible en LOD `full`) hasta un campo de otra tabla.
Al soltar, un popup elige la cardinalidad (`>`, `<`, `-`, `<>`). El host agrega `ref: <op>
schema.tabla.campo` a los settings del campo origen (dentro del `[...]` existente, o creando
`[ref: ...]`). Las refs a la misma tabla (self-ref) se permiten. Respeta el gate de solo lectura.

### Borrar (tabla, campo, FK)

Desde el menú contextual de la tabla, del campo o del edge, con confirmación modal en el host
(muestra qué refs se borran también). Tabla: su bloque, las refs inline o `Ref:` que la mencionan y
su línea en cada `TableGroup`; la entrada del sidecar queda huérfana (spec 03: `Prune orphans` la
limpia; así un undo recupera la posición). Campo: su línea y las refs que lo usan. FK: el `ref:`
inline (y el `[]` si queda vacío) o la sentencia `Ref:`.

### Escritura y autoguardado

`applyEdit` + `document.save()` en cada intención. Si la configuración `files.autoSave` es `off`,
la primera intención de la sesión muestra un `showWarningMessage` no modal: "dddbml writes your
.dbml from the diagram; enable Auto Save to keep both in sync" con acción "Enable Auto Save"
(`workbench.action.toggleAutoSave`) y "Don't show again" (memento global).

### Undo

Cada intención aplicada produce un `SchemaEditCommand` en el historial del diagrama (spec 11) con
un id; el host guarda `{ id, uri, versionAfter, inverse: TextEdit[], placed?: tabla }`. Ctrl+Z en el
diagrama envía `schema:undo { id }`: el host aplica `inverse` si `document.version === versionAfter`
y guarda; si no, avisa ("the .dbml changed since; use Undo in the editor") y descarta el comando.
Redo análogo con la edición directa. Deshacer "crear tabla" no borra su posición del sidecar
(queda huérfana, spec 03), así un redo la vuelve a colocar en el mismo punto.

## Modelo de datos / tipos afectados

- `WebviewToHost`: `schema:addTable { x, y, group? }`, `schema:addField { table }`,
  `schema:addRef { from: {table, column}, to: {table, column}, op }`,
  `schema:delete { kind: 'table' | 'field' | 'ref', … }`, `command:revealColumn { table, column }`.
- `HostToWebview`: `layout:place { table, x, y }`, `diagram:focusTable { table }`.
- Store: `positions` acepta claves de tablas aún no presentes en el schema (ya es un `Map` por
  nombre); `setSchema` no las poda.
- Sidecar: sin cambios.

## Puntos de extensión / integración

`src/extension/tableLocation.ts` (rangos por tokens) y nuevo `src/extension/schemaEdits.ts` (puro:
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
