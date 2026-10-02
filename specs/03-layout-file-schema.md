# 03 — Layout File Schema

## Ubicación y naming

Sidecar en la misma carpeta que el `.dbml`:

```
my-project/
├── schema.dbml
└── schema.dbml.layout.json   ← este archivo
```

Convención: `<nombre>.dbml` → `<nombre>.dbml.layout.json`.

Razón de naming visible en lugar de carpeta oculta: usuario explicitó querer ver los cambios de layout en `git status` y code review sin filtros especiales.

> **El sidecar versionado guarda SÓLO diseño compartido** (posiciones, colores,
> ruteo de aristas). El estado de vista personal y efímero —`viewport`,
> grupos `hidden`/`collapsed`, tablas `hidden`— **NO se versiona**: vive en un
> archivo local fuera del repo (ver *Estado de vista local* abajo). Esto evita
> los conflictos de merge garantizados en cada commit que generaba mezclar
> ambas cosas. La fusión de conflictos reales del sidecar se documenta en
> `specs/14-collaborative-merge.md`.

## Schema (sidecar versionado — sólo diseño compartido)

```json
{
  "$schema": "./dddbml-layout.schema.json",
  "version": 1,
  "tables": {
    "public.orders": { "x": 480, "y": 80 },
    "public.users":  { "x": 120, "y": 80, "color": "#D0E8FF" }
  },
  "groups": {
    "billing": { "color": "#D0E8FF" }
  },
  "edges": {}
}
```

`viewport`, `groups.*.collapsed`, `groups.*.hidden` y `tables.*.hidden` **ya no se
escriben aquí**. Un grupo sin `color` no produce entrada (no hay nada compartido
que guardar). El lector sigue tolerando archivos viejos que aún los contengan:
`toViewport(undefined)` rinde `{0,0,1}` y los flags se ignoran al cargar (se
re-derivan del estado de vista local: `applyViewState` toma de las tablas sólo
`x/y/color` y de los grupos sólo `color`), y al siguiente persist con cambio compartido
se "soft-strip". **Única excepción (migración ≤ v0.2.2):** si el usuario todavía no tiene
archivo de view-state (`readViewState` → `null`), en la carga en vivo se siembra una vez
desde los flags del sidecar y el siguiente persist lo guarda. Time-travel nunca siembra.

### Campos

| Campo | Tipo | Default | Notas |
|---|---|---|---|
| `$schema` | string | opcional | Referencia a JSON schema formal (publicar en v1.1). |
| `version` | integer | `1` | Bump en breaking changes. Host rechaza versiones mayores a la soportada. **No se bumpeará por sacar el view-state** (rompería equipos con versiones mixtas: una extensión vieja rechazaría v2). |
| ~~`viewport.*`~~ | — | — | **Movido a estado de vista local** (no versionado). Ver sección abajo. |
| `tables` | object | `{}` | Keys = nombre qualified (`schema.tableName`). |
| `tables.*.x` | integer | — | Requerido. Coord de mundo (enteros para evitar ruido subpixel). |
| `tables.*.y` | integer | — | Requerido. |
| `tables.*.color` | string | opcional | Color custom por tabla. Compartido. |
| ~~`tables.*.hidden`~~ | — | — | **Movido a estado de vista local** (visibilidad personal). |
| `groups` | object | `{}` | Keys = nombre del `TableGroup` en DBML. Sólo entradas con `color`. |
| ~~`groups.*.collapsed`~~ | — | — | **Movido a estado de vista local** (colapso personal). |
| ~~`groups.*.hidden`~~ | — | — | **Movido a estado de vista local** (ocultamiento personal). |
| `groups.*.color` | string | opcional | CSS color hex. Si ausente, se usa color derivado del nombre (hash estable). Único campo compartido del grupo. |
| `edges` | object | `{}` | Keys = ref id (`<srcTable>::<srcCols>\|<tgtTable>::<tgtCols>`). |
| `edges.*.waypoints` | array | opcional | Lista ordenada de puntos `{ x, y }` en coords absolutas world-space por los que pasa la línea (ruteo Manhattan multi-segmento, ver spec 05). |
| `edges.*.color` | string | opcional | Color de trazo por arista (valor de paleta BC o hex custom). Ausente = color de tema. Ver spec 05 §5. |
| `edges.*.sourceSide` | string | opcional | `"left"` \| `"right"`. Override del lado de puerto origen elegido por `chooseSides`. Ver spec 05 §4. |
| `edges.*.targetSide` | string | opcional | `"left"` \| `"right"`. Override del lado de puerto destino. Ver spec 05 §4. |
| `edges.*.auto` | boolean | opcional | Sólo `true`. La forma (`waypoints` / lados) la escribió el ordenamiento A\* (spec 05 §9, F20), no el usuario: no cuenta como manual y se descarta al mover un extremo. Cualquier edición del usuario de la forma lo borra; el color no. Se omite si no hay forma. Aditivo: un sidecar sin él carga igual (todo cuenta como manual, como antes). Nunca en una clave `dep:` (spec 18): se ignora al leer y no se escribe. |
| `edges.*.dx` | integer | opcional | **Legacy v1.** Offset del midX para H-V-H simple. Soft-migrate a `waypoints` en el siguiente persist. |
| `edges.*.dy` | integer | opcional | **Legacy v1.** Ver `dx`. |

### Ejemplo de `edges` con waypoints

```json
"edges": {
  "public.orders::user_id|public.users::id": {
    "waypoints": [
      { "x": 320, "y": 180 },
      { "x": 320, "y": 420 }
    ]
  }
}
```

Reglas:

- Cada waypoint en su propia línea, claves alfabéticas (`x` antes que `y`), enteros.
- Si `waypoints` está presente y no vacío, `dx`/`dy` se omiten (los waypoints son la fuente de verdad).
- Si `waypoints` está vacío o ausente y `dx`/`dy` están presentes, se preservan tal cual (legacy).
- Entrada `edges[id]` se omite por completo si no tiene ningún campo con datos: ni `waypoints`, `color`, `sourceSide`, `targetSide`, `dx`, ni `dy` (`auto` no cuenta como dato).
- `"auto": true` se escribe primero entre los escalares (orden alfabético: `auto`, `color`, `sourceSide`, `targetSide`), sólo si hay `waypoints` o lados; cualquier valor distinto de `true` se ignora al leer.
- La clave es siempre la compuesta (`render/edgeKey.ts`), nunca el `Ref.id` estable del parser. Versiones ≤0.2.8 del ordenamiento A* / reset de relaciones escribían entradas bajo `Ref.id` (`a(cols)->b(cols)`) que ninguna arista resolvía; al cargar se descartan las claves sin `::`, y el siguiente persist las elimina del sidecar.

### Claves `dep:` (spec 18)

Las aristas DBML `Dep` comparten `edges` con las refs bajo el namespace `dep:` + la misma clave compuesta (`dep:public.a::x|public.b::y`). Sus `waypoints` son puntos **libres** por los que pasa la curva (no esquinas ortogonales) y usan la misma serialización (enteros, claves ordenadas). `color` sólo se escribe si el usuario lo cambia desde la UI; el `color` del bloque `Dep` y el `headercolor` de tablas del `.dbml` son fallback de display y **nunca** se escriben aquí (precedencia: sidecar > DBML > token).

## Reglas de serialización Git-friendly

Objetivo: `git diff` después de mover 3 tablas muestra sólo 3 líneas cambiadas (más delimitadores), no reescribe el archivo entero.

El writer del sidecar es **`serializeSharedLayout`** (`layoutStore.ts`): misma forma
git-friendly que `serializeLayout` pero **omite todo view-state** (sin `viewport`,
sin `hidden`/`collapsed`, sin grupos color-less). El host además aplica un
**churn-guard**: en `flushPersist` no reescribe el sidecar si la serialización
compartida no cambió respecto de lo que hay en disco (`diskSharedSerialized`: la forma
canónica del último archivo leído o escrito), de modo que un pan/zoom (que sólo toca el
view-state local) nunca ensucia el archivo versionado, ni siquiera el primero tras abrir.

**Guard de eco del watcher**: el host guarda el texto exacto del sidecar que conoce en
disco (`diskSidecarText`), actualizado tanto en cada **lectura** (apertura, watcher,
recarga tras op git, también el texto en conflicto o corrupto) como en cada escritura
propia. Un evento del watcher cuyo archivo coincide con ese texto es un eco o un no-op;
cualquier otro contenido es externo y recarga. Comparar sólo contra la última escritura
propia ignoraba un `git checkout` que devolvía el archivo a ese contenido después de
haber cargado el layout de otra rama (F01).

Reglas del writer:

1. **Keys ordenadas por code unit** (comparación `<`, nunca `localeCompare`) en tablas, grupos y aristas. Orden determinista e independiente del locale de cada colaborador = diffs mínimos.
2. **Indent 2 spaces**, no tabs.
3. **Line endings LF** (no CRLF), incluso en Windows.
4. **Trailing newline** al final del archivo (convención POSIX, evita "No newline at end of file" en Git).
5. **Enteros, no floats** para coords. Redondeo con `Math.round()` al persistir. Zoom redondeado a 3 decimales.
6. **Omitir keys con valor default**:
   - `color: null` o no definido → no se escribe.
   - `collapsed`/`hidden` (tabla y grupo) **nunca** se escriben en el sidecar: son
     view-state local (ver sección abajo).
   - Una entrada de grupo sin `color` se omite por completo (no hay nada compartido).
7. **Objetos inline en una sola línea** cuando caben < 80 chars (JSON pretty-print tiene modo compacto para hojas; implementar custom serializer o usar `json-stringify-pretty-compact`).
8. **No comentarios** (JSON puro; si el usuario quiere anotaciones, va en otro archivo).

## Estado de vista local (no versionado)

El estado de vista personal vive **fuera del repo**, en
`context.globalStorageUri/view-state/<sha256(dbmlUri)>.json` (`viewStateStore.ts`).
Escritura atómica (temp + rename) igual que el sidecar; formato libre (no es
git-friendly porque nadie lo diffea).

```json
{
  "source": "file:///…/schema.dbml",
  "viewport": { "x": -120, "y": -80, "zoom": 0.75 },
  "tables": { "public.users": { "hidden": true } },
  "groups": { "identity": { "hidden": true }, "catalog": { "collapsed": true } }
}
```

Flujo host (`panel.ts`):

- **Carga** (`loadFullLayout`): lee el sidecar compartido + el view-state local y
  reconstruye el `Layout` completo (`applyViewState`) antes de postear al webview.
  El webview **no cambia**: sigue recibiendo y enviando un `Layout` completo.
- **Persist** (`flushPersist`): parte el `Layout` entrante en dos destinos —
  `writeSharedLayout` (git, con churn-guard) y `writeViewState`
  (`extractViewState` → archivo local). El view-state **no se reemplaza entero**: el host
  guarda el view-state que le dio al webview en la última carga/escritura
  (`viewStateBaseline`) y escribe sólo el delta (`mergeViewStateChange`) sobre una lectura
  fresca del archivo; sin delta no escribe. El archivo lo comparten todas las ventanas de la
  máquina (`globalStorage`) y un panel sólo conoce los flags de las entradas que se le
  mostraron: reemplazarlo borraba hide/collapse/cámara de otra ventana y el `hidden` de
  tablas sin entrada en el sidecar (p.ej. sidecar corrupto al abrir).
- **Ocultas sin posición (F66).** Una tabla oculta en el view-state que no tiene entrada en el
  sidecar (nunca arrastrada, sidecar corrupto o ausente) viaja al webview en
  `Layout.hiddenUnplaced` (marcador sin posición; nunca se serializa al sidecar). `setLayout` la
  agrega a `hiddenTables` sin posición, el auto-layout la ubica y desde ahí persiste como
  `hidden: true` en su entrada. Hasta entonces el webview devuelve el marcador en cada
  `layout:persist` (va con `tables`), así des-ocultarla o no tocarla nunca se confunden.
- **Cámara (decisión 2026-10-01, F26).** El webview persiste el `viewport` al terminar un
  pan/zoom (debounced) y solo va al view-state local, nunca al sidecar. Un push de layout del
  host (watcher, merge aplicado, salida de overlay) no reemplaza la cámara actual; el viewport
  guardado solo se aplica en la carga inicial del panel. Las escrituras de view-state del host van
  encadenadas y leen el layout vigente **al ejecutarse**: un flush que tomó su snapshot antes de un
  pan/zoom (mientras escribía el sidecar) ya no pisa la cámara más nueva.
- Keyed por `sha256(dbmlUri.toString())`. Archivos huérfanos (al renombrar/borrar el
  `.dbml`) se acumulan; GC diferido (ver Preguntas abiertas).

## Seguridad ante marcadores de conflicto

`readLayout` detecta marcadores git (`<<<<<<<`/`=======`/`>>>>>>>`/`|||||||`) **antes**
de `JSON.parse` y lanza `LayoutConflictError` en vez de devolver `emptyLayout()`
(que **borraba el layout en silencio** — bug corregido). El caller enruta a la
fusión 3-way de `specs/14-collaborative-merge.md`.

## Merge de persistencia parcial (host)

El webview envía `layout:persist` con un **`Partial<Layout>`**. El host hace
merge contra `currentLayout` con la regla **"payload gana, si no se conserva el
actual"** (`mergeLayout` en `layoutStore.ts`), nunca un reemplazo total.

- Cada top-level key (`viewport`, `tables`, `groups`, `edges`) se reemplaza si
  viene en el payload; si se omite, **se conserva la del layout actual**.
- Invariante crítico: **omitir una key no debe borrar su sub-objeto.** Olvidar
  `edges` en el merge fue la causa de que waypoints/colores/sides se vaciaran a
  `"edges": {}` en cada persist (regresión cubierta por `layoutStore.merge.test.ts`).
- El merge es por-key, no deep-merge: el payload de `tables`/`edges` es el set
  completo de esa key (el webview serializa todo su estado, no un delta).

## Escritura atómica

Evitar corrupción si VSC crashea a mitad de escritura:

```
1. Escribe a <nombre>.dbml.layout.json.tmp
2. fsync (ensure disk write)
3. rename .tmp → <nombre>.dbml.layout.json (atomic en POSIX y NTFS)
```

Si la operación falla entre 1 y 3, el archivo original permanece intacto.

## Reglas de consistencia DBML↔Layout

Matriz de casos:

| Estado DBML | Estado Layout | Acción |
|---|---|---|
| Tabla existe | Entrada existe | Usar posición del layout. |
| Tabla existe | Sin entrada | Auto-layout dagre. Persistir sólo al primer drag manual. |
| Tabla no existe | Entrada existe (huérfana) | Mantener entrada en archivo. Comando `dddbml: Prune orphans` las limpia explícitamente. Razón: si el usuario renombra tabla y luego hace undo, no perdemos la posición. |
| Tabla renombrada | Entrada con nombre viejo | Tratada como "huérfana + nueva". El usuario decide: drag manual crea entrada nueva; o `dddbml: Rename layout entry` (comando utility v1.1). |
| Group existe en DBML | Entrada existe | Usar config del layout. |
| Group existe en DBML | Sin entrada | Defaults: `collapsed: false`, `hidden: false`, color hash. |
| Group no existe en DBML | Entrada huérfana | Igual que tabla: persiste, `Prune orphans` limpia. |

**`dddbml: Reset Layout` (decisión 2026-10-01, F24).** Recalcula todas las posiciones y limpia
la forma de cada edge (`waypoints`, `sourceSide`/`targetSide`, `dx`/`dy`), porque los waypoints
absolutos quedarían sueltos al mover las tablas. **Conserva** colores (de tablas, grupos y
edges) y el view-state personal (tablas ocultas, grupos ocultos/colapsados). Es **deshacible** con
un Ctrl+Z (un solo `ArrangeCommand` con posiciones y formas de aristas previas) y por eso no
pide confirmación (decisión 2026-10-01).
Corre en el webview (`layout/resetLayout.ts`): el host sólo valida el gate y postea
`command:resetLayout`; el webview recalcula con el auto-layout de la primera apertura (dagre),
limpia la forma de **todas** las aristas, vacía el historial (sin undo: memento futuro, spec 11)
y persiste por el `layout:persist` normal. Las entradas huérfanas (tabla fuera del schema)
conservan posición y color: limpiarlas es trabajo de `Prune orphans`. Antes el host escribía
`tables: {}`, que borraba colores y flags ocultos y dejaba los waypoints absolutos colgando.

`Prune orphans` se **niega** (aviso) mientras el `.dbml` no parsea en su última lectura o el
layout aún no se cargó: contra un schema vacío o viejo toda entrada parece huérfana y se
borraba el sidecar entero (posiciones y colores). Si hay algo que podar pide confirmación
modal con los conteos (no tiene undo); sin huérfanas sólo informa y no escribe.

## Migración de versiones

Cuando `version` cambie:
- Lector intenta migración in-memory si es posible (añadir campos con defaults).
- Si no se puede, emite error en status bar y abre archivo en modo read-only.
- Migración escrita como función pura `migrate(v1, v2)` en `layoutStore.ts`.

## Ejemplo completo (proyecto e-commerce DDD)

Sidecar versionado (`schema.dbml.layout.json`) — sólo diseño compartido:

```json
{
  "version": 1,
  "tables": {
    "billing.invoices":      { "x": 1200, "y": 400 },
    "billing.payments":      { "x": 1200, "y": 640 },
    "catalog.categories":    { "x": 120,  "y": 400 },
    "catalog.products":      { "x": 120,  "y": 640 },
    "identity.sessions":     { "x": 600,  "y": 80  },
    "identity.users":        { "x": 600,  "y": 320 },
    "orders.order_items":    { "x": 1800, "y": 640 },
    "orders.orders":         { "x": 1800, "y": 400 }
  },
  "groups": {
    "billing":  { "color": "#D0E8FF" },
    "catalog":  { "color": "#E8F5D0" },
    "identity": { "color": "#FFE4A0" },
    "orders":   { "color": "#FFD4E4" }
  },
  "edges": {}
}
```

View-state local (en `globalStorage`, **no** en el repo) — del mismo proyecto:

```json
{
  "source": "file:///…/schema.dbml",
  "viewport": { "x": -120, "y": -80, "zoom": 0.75 },
  "tables": {},
  "groups": { "catalog": { "collapsed": true }, "identity": { "hidden": true } }
}
```

Observaciones:
- `identity.hidden: true` y `catalog.collapsed: true` son **decisiones de vista
  personales** → viven en el archivo local; el compañero puede tener otras sin
  generar diff.
- `billing` y `orders` con color custom en el sidecar → diseño compartido, sí
  versionado.

## Test de roundtrip

```ts
// test/unit/layoutStore.test.ts
it('roundtrip preserves byte-identical output', () => {
  const original = readFileSync('fixtures/sample.layout.json', 'utf8');
  const parsed = parseLayout(original);
  const written = serializeLayout(parsed);
  expect(written).toBe(original);
});
```

Este test es crítico: garantiza que re-guardar un archivo sin cambios no produce diff en Git.

> Tras el split, el roundtrip relevante para el sidecar usa `serializeSharedLayout`:
> `serializeSharedLayout(parseLayout(x)) === serializeSharedLayout(parseLayout(serializeSharedLayout(parseLayout(x))))`.
> El test byte-stable existente sobre `serializeLayout` (forma completa) sigue válido
> sin cambios.

## Preguntas abiertas

- **GC de view-state huérfano.** Archivos en `globalStorage` keyed por hash del URI
  se acumulan al renombrar/borrar el `.dbml`. ¿Comando `dddbml: Prune view-state` vs
  barrido en `activate` por `lastSeen`? Diferido; severidad baja (JSON minúsculos).
- **Decisión bloqueada:** `viewport` se omite **por completo** del sidecar (no línea
  congelada) — el lector ya defaultea `{0,0,1}` y el viewport real sale del archivo
  local.
