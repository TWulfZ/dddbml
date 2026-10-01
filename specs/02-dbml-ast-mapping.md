# 02 — DBML AST Mapping

## Fuente

`@dbml/core` expone `Parser.parse(source, 'dbmlv2')` → retorna un objeto `Database` (clase). Llamando `.export()` obtenemos un shape plano JSON-safe con la estructura:

```
Database.export() = {
  schemas: [
    {
      name, alias, note,
      tables: [{ name, alias, note, headerColor, fields: [...], indexes: [...] }],
      refs: [{ name, onDelete, onUpdate, endpoints: [{ schemaName, tableName, fieldNames, relation }] }],
      tableGroups: [{ name, tables: [{ schemaName, tableName }] }],
      enums: [...]
    }
  ]
}
```

Trabajamos sobre este `export()`, no sobre la clase `Database`, porque:
1. Es plain data → serializable a postMessage sin surgery.
2. API estable; los métodos de la clase cambian entre versiones menores.

## Mapeo al modelo interno

El modelo interno (`src/shared/types.ts`) aplana schemas y colapsa refs al nivel raíz. Razones:

- **Qualified names**: `schemaName.tableName` como key única simplifica todo downstream (layout file, spatial index, edges).
- **Refs globales**: una tabla en `schemaA` puede referenciar una en `schemaB`; mantener refs por schema complicaría el edge lookup.
- **TableGroups globales**: en DBML v2 los groups viven en un schema pero conceptualmente son cross-schema. Los tratamos global-first.

### Tabla resultante: `Schema`

```ts
interface Schema {
  tables: Table[];   // ordenadas por name
  refs: Ref[];
  groups: TableGroup[];  // ordenadas por name
}
```

### Columna (`Field` → `Column`)

| DBML field | Nuestro Column | Nota |
|---|---|---|
| `name` | `name` | directo |
| `type` | `type` | si es objeto, usa `type_name` o `name`; fallback `'unknown'` |
| `pk` | `pk` | `true \| undefined` (omitir si falso para JSON compacto). También `true` para cada columna miembro de un índice `indexes { (a, b) [pk] }` (PK compuesta); los miembros expresión se ignoran |
| `not_null` | `notNull` | idem |
| `unique` | `unique` | idem |
| `increment` | `increment` | idem |
| `dbdefault` | `default` | stringificado si es objeto `{value}` (`[default: null]` queda como `'null'`) |
| `dbdefault.type` | `defaultKind` | `'string' \| 'number' \| 'boolean' \| 'expression' \| 'null'`; omitido si no hay default. Lo consume el exporter; el webview sólo muestra `default` |
| `note` | `note` | `string \| null` |

### Ref (`endpoints[2]` → `Ref`)

DBML permite refs con 2 endpoints. Cada endpoint: `{ schemaName, tableName, fieldNames[], relation }`. Mapeamos a `Ref` con `source` y `target` (orden determinado por orden en DBML — no intentamos inferir dirección por cardinalidad).

**Relation normalization**:
- `*`, `many`, `>` → `'*'`
- resto (incluyendo `1`, `-`, `<`) → `'1'`
- La dirección (`>` vs `<`) se pierde intencionalmente en v1; el orden `source→target` la preserva.

**ID estable**: hash determinista `sourceTable(col1,col2)->targetTable(col3,col4)`, orden canónico (alfabético). Asegura que al re-parsear obtenemos el mismo ID → edges no "saltan" de identidad entre frames.

### TableGroup

```ts
interface TableGroup {
  name: string;
  tables: QualifiedName[];  // ordenadas alfabéticamente
}
```

El schema de origen del group se ignora; el group es global. Si hay colisión de nombres entre schemas, sólo el primero gana (v1; warn en consola en v1.1).

También cada `Table.groupName` apunta al group que la contiene (para lookup rápido en render).

## Fallos conocidos / ignorados en v1

- **Enums**: parseados pero no renderizados. v1.1 candidate.
- **Indexes**: parseados pero no renderizados (sólo labels en tabla podrían mostrarlos). v1.1. Excepción: los índices `[pk]` marcan `pk` en sus columnas (ver tabla de columnas).
- **StickyNotes**: ignorados.
- **Records (seed data)**: ignorados.
- **TablePartials** (DBML v3): ignorados en v1 (los partials se inyectan al parsear, así que sus campos aparecen igual en la tabla final; no hay AST dedicado).
- **Many-to-many refs** (`<>`): tratados como relación bidireccional `'*' '*'`. Render visual no las distingue en v1.

## Error handling

Parser lanza excepción en DBML inválido. El wrapper captura y retorna:

```ts
{ schema: null, error: { message, line?, column? } }
```

El host envía `schema:update` con `schema: previousSchema, parseError: error`. El webview muestra banner de error pero mantiene el último schema válido renderizado (evita "se borra todo" al escribir).

## Test plan

- `test/unit/parser.test.ts`:
  - `tiny.dbml` → snapshot del Schema. Debería tener 5 tablas, 4 refs, 2 groups.
  - DBML inválido (falta cierre de brace) → retorna `error: { message, line, column }`.
  - DBML vacío → retorna `schema: { tables: [], refs: [], groups: [] }`.
  - Tabla sin schema explícito → qualified `public.tablename`.
  - Tabla con schema explícito (`Table foo.bar { ... }`) → `foo.bar`.
