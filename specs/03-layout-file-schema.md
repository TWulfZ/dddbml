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

## Schema

```json
{
  "$schema": "./dddbml-layout.schema.json",
  "version": 1,
  "viewport": { "x": 0, "y": 0, "zoom": 1.0 },
  "tables": {
    "public.orders": { "x": 480, "y": 80 },
    "public.users":  { "x": 120, "y": 80 }
  },
  "groups": {
    "billing":  { "collapsed": false, "hidden": false, "color": "#D0E8FF" },
    "identity": { "collapsed": true,  "hidden": false }
  }
}
```

### Campos

| Campo | Tipo | Default | Notas |
|---|---|---|---|
| `$schema` | string | opcional | Referencia a JSON schema formal (publicar en v1.1). |
| `version` | integer | `1` | Bump en breaking changes. Host rechaza versiones mayores a la soportada. |
| `viewport.x` | integer | `0` | Desplazamiento en X en coords de mundo. |
| `viewport.y` | integer | `0` | Desplazamiento en Y. |
| `viewport.zoom` | number | `1.0` | Factor de zoom. Redondeado a 3 decimales al persistir. |
| `tables` | object | `{}` | Keys = nombre qualified (`schema.tableName`). |
| `tables.*.x` | integer | — | Requerido. Coord de mundo (enteros para evitar ruido subpixel). |
| `tables.*.y` | integer | — | Requerido. |
| `groups` | object | `{}` | Keys = nombre del `TableGroup` en DBML. |
| `groups.*.collapsed` | boolean | `false` | Si `true`, renderiza como nodo caja único. |
| `groups.*.hidden` | boolean | `false` | Si `true`, tablas del grupo no se renderizan. |
| `groups.*.color` | string | opcional | CSS color hex. Si ausente, se usa color derivado del nombre (hash estable). |
| `edges` | object | `{}` | Keys = ref id (`<srcTable>::<srcCols>\|<tgtTable>::<tgtCols>`). |
| `edges.*.waypoints` | array | opcional | Lista ordenada de puntos `{ x, y }` en coords absolutas world-space por los que pasa la línea (ruteo Manhattan multi-segmento, ver spec 05). |
| `edges.*.color` | string | opcional | Color de trazo por arista (valor de paleta BC o hex custom). Ausente = color de tema. Ver spec 05 §5. |
| `edges.*.sourceSide` | string | opcional | `"left"` \| `"right"`. Override del lado de puerto origen elegido por `chooseSides`. Ver spec 05 §4. |
| `edges.*.targetSide` | string | opcional | `"left"` \| `"right"`. Override del lado de puerto destino. Ver spec 05 §4. |
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
- Entrada `edges[id]` se omite por completo si no tiene ningún campo con datos: ni `waypoints`, `color`, `sourceSide`, `targetSide`, `dx`, ni `dy`.

## Reglas de serialización Git-friendly

Objetivo: `git diff` después de mover 3 tablas muestra sólo 3 líneas cambiadas (más delimitadores), no reescribe el archivo entero.

Reglas del writer:

1. **Keys alfabéticamente ordenadas** en ambos niveles (tablas y grupos). Orden determinista = diffs mínimos.
2. **Indent 2 spaces**, no tabs.
3. **Line endings LF** (no CRLF), incluso en Windows.
4. **Trailing newline** al final del archivo (convención POSIX, evita "No newline at end of file" en Git).
5. **Enteros, no floats** para coords. Redondeo con `Math.round()` al persistir. Zoom redondeado a 3 decimales.
6. **Omitir keys con valor default**:
   - `color: null` o no definido → no se escribe.
   - `collapsed: false`, `hidden: false` → se escriben explícitos sólo si alguna vez fueron `true` (para preservar intención); el writer los omite si nunca se tocaron.
7. **Objetos inline en una sola línea** cuando caben < 80 chars (JSON pretty-print tiene modo compacto para hojas; implementar custom serializer o usar `json-stringify-pretty-compact`).
8. **No comentarios** (JSON puro; si el usuario quiere anotaciones, va en otro archivo).

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

## Migración de versiones

Cuando `version` cambie:
- Lector intenta migración in-memory si es posible (añadir campos con defaults).
- Si no se puede, emite error en status bar y abre archivo en modo read-only.
- Migración escrita como función pura `migrate(v1, v2)` en `layoutStore.ts`.

## Ejemplo completo (proyecto e-commerce DDD)

```json
{
  "version": 1,
  "viewport": { "x": -120, "y": -80, "zoom": 0.75 },
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
    "billing":  { "collapsed": false, "hidden": false, "color": "#D0E8FF" },
    "catalog":  { "collapsed": true,                    "color": "#E8F5D0" },
    "identity": { "collapsed": false, "hidden": true,   "color": "#FFE4A0" },
    "orders":   { "collapsed": false, "hidden": false, "color": "#FFD4E4" }
  }
}
```

Observaciones:
- `identity.hidden: true` → sus tablas no se renderizan; edges a/desde otros grupos se omiten (v1) o se dibujan como "dangling" (futuro).
- `catalog.collapsed: true` → se renderiza como nodo caja "catalog (2 tablas)" en la posición promedio de sus tablas; edges se agregan al grupo.
- `billing` y `orders` visibles normalmente con color custom.

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
