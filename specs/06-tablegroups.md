# 06 — TableGroups (Visibility + Collapse)

## Propósito

`TableGroup` en DBML agrupa tablas lógicamente. Para proyectos DDD mapea a **bounded contexts**: un group por módulo. `dddbml` usa esto para:

1. **Ocultar** grupos → enfocarse sólo en el contexto relevante.
2. **Colapsar** grupos → nodo resumen único en lugar de N tablas internas.

El estado (hidden / collapsed / color) persiste en el sidecar layout file, no en el DBML (el DBML no tiene esas semánticas).

## Estados

Cada group tiene 3 campos opcionales en `groups` del layout file:

| Campo | Tipo | Default | Efecto |
|---|---|---|---|
| `hidden` | boolean | false | Tablas del group y sus edges incidentes se omiten del render. |
| `collapsed` | boolean | false | Tablas del group se reemplazan por un único nodo-caja; edges se reenrutan al nodo. |
| `color` | string | auto hash | Color del swatch + del collapsed node + (futuro) del borde superior de las tablas. |

**Hidden domina sobre collapsed**: si `hidden: true`, el grupo no se renderiza, collapsed se ignora.

## Collapsed: semántica de edges

Cuando un group está collapsed, todas sus tablas se sustituyen por el nodo-caja (virtual id `__group__:{name}`). Edges incidentes se transforman:

- **ambos endpoints en el mismo group colapsado** → edge omitido (self-loop visual).
- **un endpoint en group colapsado, otro en tabla visible** → edge conecta group-box ↔ tabla.
- **ambos endpoints en groups colapsados distintos** → edge conecta las dos cajas.
- **endpoint en group hidden** → edge omitido.
- **endpoints duplicados tras colapsar** (e.g., 5 refs del mismo group origen al mismo group destino) → deduplicados por `(src, tgt, columns)`.

## Collapsed: posición y tamaño

- **Posición**: centroide (promedio) de los centros de las tablas miembro. Recomputa en cada render (cheap).
- **Tamaño**: fijo 220x80. No hay layout dedicado; el group "flota" sobre sus miembros invisibles.
- **Drag**: NO soportado en v1. Para mover un group, expandir → arrastrar tablas → colapsar.
- **Double-click** en el group-box → expande (toggle collapsed off).

## UI: Diagram Views panel

Panel flotante top-right dentro del viewport (título **"Diagram Views"**), colapsable a un handle
"Views". Contiene, de arriba a abajo:

- **Header**: título + acciones de header (hide-all / collapse-all — solo si hay groups — y cerrar),
  como botones solo-ícono `size="tool"` con `Tooltip` (ver spec 12).
- **View options**: toggles de vista globales. Hoy: **PK/FK columns only** (`showOnlyPkFk`). Es una
  opción de *vista* (no de grupo), por eso vive aquí y no en la barra de acciones.
- **Search**: input con ícono; filtra groups y tablas por nombre. Expone `inputRef` para enfoque
  imperativo.
- **Lista**: groups en orden alfabético, cada fila con swatch de color, nombre + count, y botones
  solo-ícono (`size="icon"`, filas densas) de toggle hidden / collapsed / configurar color.

Toggles disparan `schedulePersist()` para guardar estado en el layout file.

**Cambios de comportamiento (UI polish):**
- El panel **se renderiza siempre que el diagrama esté listo**, no solo cuando hay groups — porque
  ahora aloja View options globales y el buscador. Sin groups, la lista muestra "No groups defined".
- El estado **abierto/cerrado vive en el store** (`viewsPanelOpen`), no local al componente, para
  que el **botón Search de la barra de acciones** pueda abrir el panel y enfocar su buscador
  (`openViewsAndFocusSearch()` → set `viewsPanelOpen=true` + bump `viewsSearchFocusNonce`; el panel
  observa el nonce y enfoca vía `inputRef`).

## Color default

Hash del nombre a `hsl(hue, 55%, 60%)`. Determinista por nombre → mismo grupo siempre mismo color entre sesiones aunque `color` no esté en layout file.

## Interacción con auto-layout (dagre)

Dagre corre sobre el DBML completo independientemente de estado de groups. Posiciones de tablas miembro se preservan aunque su group esté collapsed → al expandir no hay salto.

Alternativa futura (v1.1): layout por group cuando están collapsed, para que al expandir el group encaje ajustadamente en su bbox.

## Persistencia

Estado groups forma parte de `layout.groups` y viaja en `layout:persist` al host. Reglas de Git-friendly serialization (ver spec 03):
- campos default (`collapsed: false`, `hidden: false`) se omiten
- color default (auto-hash) no se escribe, sólo colores custom

## Limitaciones v1 conocidas

1. **Collapsed group no se puede arrastrar directamente**. User debe expandir primero.
2. **Edges entre colapsados pueden solaparse** si hay múltiples groups apilados cerca. v2: offsetting.
3. **Groups cross-schema** no soportados: un group no puede tener tablas de schemas distintos en v1 si colisionan nombres. (DBML nativo tampoco lo soporta limpio).
4. **No hay "solo este group"** helper. Para aislar un contexto DDD hay que ocultar todos los demás manualmente. Feature v1.1.

## Test plan

`test/unit/groups.test.ts`:
- Group collapsed con 0 miembros → no renderiza nodo.
- Group collapsed con 3 miembros → centroide = promedio de centros.
- Ref entre 2 miembros del mismo group colapsado → omitido.
- Ref de group colapsado a tabla externa → edge existe, id dedupe-able.
- Double-click en group-box → toggle collapsed = false.
