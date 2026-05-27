# 09 — Exporters

## Propósito

Convertir el modelo interno `Schema` a otros formatos de salida (TypeORM entities, Prisma schema, SQL DDL, Mermaid, etc.) desde el diagrama, con **una arquitectura registry+strategy** que permita agregar formatos nuevos sin tocar código existente.

En v1.1 se entrega un único exporter productivo: **TypeORM (TypeScript entities)**. La infraestructura está diseñada para que agregar Prisma sea crear un módulo + 1 línea de registro.

## Goals

1. Exportar el `Schema` completo o sólo las tablas seleccionadas en el diagrama.
2. Resultado: documento untitled de VSC con el código generado (sin escritura a disco; el usuario decide dónde guardar).
3. Cero `if/else` por formato en el dispatch. El registry resuelve por `id`.
4. Cero `switch` por dialecto SQL dentro del exporter. Una `Dialect` strategy resuelve el mapeo de tipos.
5. Disparable desde botón en el diagrama y desde la command palette de VSC.

## Non-goals (v1.1)

- Escritura multi-archivo a carpeta. Sólo untitled doc.
- Round-trip (TypeORM → DBML).
- Templates custom del usuario (Handlebars/EJS).
- Migrations TypeORM, sólo entities.
- Singularización multilingüe; sólo heurística inglesa.

---

## Architecture

### Contract (`src/shared/exporters/types.ts`)

Tipos plain-data, postMessage-safe. La parte declarativa (`ExporterMeta`) cruza al webview; la parte impl (`Exporter.export`) vive sólo en el host.

```ts
export interface ExporterMeta {
  id: string;
  label: string;
  description?: string;
  language: string;                          // VSC languageId del untitled doc
  optionsSchema: ExporterOptionField[];      // drives the export modal form
}

export type ExporterOptionField =
  | { id: string; type: 'boolean'; label: string; default: boolean; description?: string }
  | { id: string; type: 'string';  label: string; default: string;  description?: string }
  | { id: string; type: 'enum';    label: string; default: string;
      choices: Array<{ value: string; label: string }>; description?: string };

export interface ExportInput {
  schema: Schema;                            // already filtered if scope='selected'
  scope: 'all' | 'selected';
  selection: ReadonlyArray<QualifiedName>;
  options: Record<string, unknown>;
}

export interface ExportResult {
  language: string;
  content: string;
  warnings?: string[];
}

export interface Exporter extends ExporterMeta {
  export(input: ExportInput): ExportResult;  // pure, sync, deterministic
}
```

**Por qué pure + sync**: testeable sin mocks, sin promesas, sin acoplar al runtime de VSC. El host envuelve con I/O (open untitled doc, mostrar warnings).

### Registry (`src/extension/exporters/registry.ts`)

```ts
const registry = new Map<string, Exporter>();
export function registerExporter(e: Exporter): void { registry.set(e.id, e); }
export function getExporter(id: string): Exporter | undefined { return registry.get(id); }
export function listExporters(): ExporterMeta[] { /* strip impl, return metas */ }
```

Registro estático en `src/extension/exporters/index.ts`:

```ts
import { registerExporter } from './registry';
import { typeormExporter } from './typeorm';
// import { prismaExporter } from './prisma';   // ← futuro
registerExporter(typeormExporter);
// registerExporter(prismaExporter);
```

**Forward compat**: agregar Prisma = un módulo bajo `src/extension/exporters/prisma/` que exporta un `Exporter`, más una línea en el registro estático. Cero edits en `panel.ts`, `registry.ts`, `exportModal.tsx`.

### Dialect strategy (interna al exporter TypeORM)

El mapeo DBML→tipos depende del SGBD target. Misma técnica registry:

```ts
// src/extension/exporters/typeorm/dialect.ts
export interface Dialect {
  id: string;                                  // 'postgres', 'mysql', 'sqlite'
  label: string;
  mapType(dbmlType: string): TsTypeMapping;
}

export interface TsTypeMapping {
  tsType: string;                              // TS type for the property
  columnOptions: Record<string, unknown>;      // pasado al template como `@Column(<opts>)`
}
```

`dialects/index.ts` registra los Dialect implementados; el exporter consulta por `options.dialect`. Agregar MySQL = nuevo archivo `dialects/mysql.ts` + 1 línea.

---

## Protocol additions (`src/shared/types.ts`)

```ts
// Host → Webview
| { type: 'exporters:list'; payload: { exporters: ExporterMeta[] } }
| { type: 'export:result';  payload: { ok: boolean; warnings?: string[]; message?: string } }

// Webview → Host
| { type: 'command:export'; payload: ExportCommandPayload }

export interface ExportCommandPayload {
  formatId: string;
  scope: 'all' | 'selected';
  selection: QualifiedName[];
  options: Record<string, unknown>;
}
```

`exporters:list` se envía en `hydrate()` después de `schema:update` y `layout:loaded`.

---

## UI flow

1. Usuario clickea **Export** en `ActionsPanel`.
2. Modal aparece con:
   - **Format**: select poblado desde `state.exporters`. Default = `settings.export.defaultFormat`.
   - **Scope**: radio `All / Selected`. Selected disabled si `selection.size === 0`. Counter `(N tables)`.
   - **Options**: formulario generado desde `optionsSchema` del exporter elegido. Pre-rellenado con defaults de `settings.export.<formatId>` cuando coincida la key, si no con `optionsSchema[i].default`.
3. Botón **Export** envía `command:export` con `selection` actual + options + scope.
4. Host:
   - Resuelve `getExporter(formatId)`.
   - Filtra `schema` si `scope='selected'`.
   - Llama `exporter.export(input)` (sync, pure).
   - `vscode.workspace.openTextDocument({ content, language })` → `showTextDocument`.
   - Warnings se muestran con `vscode.window.showInformationMessage` (concatenados).
   - Envía `export:result` (webview cierra modal y muestra toast si quiere).
5. Command palette `dddbml: Export Schema…`:
   - Si hay webview activo, abre el mismo modal en él vía `viewport:command` (extender) o pide al webview que abra el modal con un nuevo mensaje `export:prompt`.
   - Si no hay webview activo, host corre QuickPick + export con defaults sobre `lastValidSchema` global.

**Decisión v1.1**: el comando de palette **siempre** delega al webview si está activo (`DiagramPanel.getActive()?.openExportModal()`). Si no hay webview activo, abre el `.dbml` activo y luego ejecuta. Reduce complejidad de tener dos UIs.

---

## TypeORM mapping rules (Postgres dialect default)

### Types (`dialects/postgres.ts`)

Match case-insensitive, ignorando paréntesis para length/precision:

| DBML type | TS type | columnOptions |
|---|---|---|
| `int`, `integer`, `serial` | `number` | `{ type: 'int' }` |
| `bigint`, `bigserial` | `string` | `{ type: 'bigint' }` (TS string preserves precision >2^53) |
| `smallint` | `number` | `{ type: 'smallint' }` |
| `varchar(N)` | `string` | `{ type: 'varchar', length: N }` |
| `char(N)` | `string` | `{ type: 'char', length: N }` |
| `text` | `string` | `{ type: 'text' }` |
| `uuid` | `string` | `{ type: 'uuid' }` |
| `boolean`, `bool` | `boolean` | `{ type: 'boolean' }` |
| `timestamp`, `timestamptz` | `Date` | `{ type: 'timestamptz' }` (sin tz si type==='timestamp') |
| `date` | `Date` | `{ type: 'date' }` |
| `time`, `timetz` | `string` | `{ type: 'time' }` |
| `numeric(P,S)`, `decimal(P,S)` | `string` | `{ type: 'numeric', precision: P, scale: S }` |
| `real`, `float4` | `number` | `{ type: 'real' }` |
| `double precision`, `float8` | `number` | `{ type: 'double precision' }` |
| `json`, `jsonb` | `Record<string, unknown>` | `{ type: 'jsonb' \| 'json' }` |
| `bytea` | `Buffer` | `{ type: 'bytea' }` |
| desconocido | `string` | `{ type: <raw> }` + warning |

### Column decorators (`template.ts`)

- `pk && increment` + tipo int* → `@PrimaryGeneratedColumn()`.
- `pk && increment` + tipo uuid → `@PrimaryGeneratedColumn('uuid')` (DBML raro pero valido).
- `pk` solo → `@PrimaryColumn(<opts>)` con tipo explícito.
- `unique` (no pk) → opción `{ unique: true }`.
- `notNull` → `{ nullable: false }`. Default TypeORM es `nullable: false` para columnas regulares; emitimos explícito siempre que el DBML diga `notNull`, **y** explícito `nullable: true` cuando no diga `notNull` ni `pk`. (Reduce sorpresas.)
- `default` no-null:
  - String literal con función SQL (`now()`, `gen_random_uuid()`) → `{ default: () => 'now()' }`.
  - Otro string → `{ default: '<value>' }` literal.
  - Numeric/bool → valor literal sin quotes.
  - Heurística: si empieza con `(` o termina con `)` o coincide regex `^[a-z_]+\(`, tratar como expresión SQL.
- `note` → bloque de comentario `/** ... */` sobre la propiedad.

### Relations (`relations.ts`)

DBML `Ref.source.relation` y `Ref.target.relation` ∈ `{ '1', '*' }`. Matriz:

| source | target | source-side decorator | target-side decorator |
|---|---|---|---|
| `1` | `1` | `@OneToOne(() => Target)` + `@JoinColumn({ name: <fk_col> })` | `@OneToOne(() => Source, src => src.<prop>)` |
| `1` | `*` | `@OneToMany(() => Target, tgt => tgt.<prop>)` | `@ManyToOne(() => Source)` + `@JoinColumn({ name: <fk_col> })` |
| `*` | `1` | `@ManyToOne(() => Target)` + `@JoinColumn({ name: <fk_col> })` | `@OneToMany(() => Source, src => src.<prop>)` |
| `*` | `*` | `@ManyToMany(() => Target)` + `@JoinTable()` | `@ManyToMany(() => Source, src => src.<prop>)` |

**Lado dueño (JoinColumn)**: convención DBML — el endpoint que aparece como `source` es el lado que escribió la cláusula `Ref:`. Tratamos `source` como dueño en 1:1 y *:*.

**Property name**:
- En el lado `*` (que apunta a `1` o `*`): `camelCase(otherTableName)` o pluralizado si toggle. Default singular para `ManyToOne`, plural para `OneToMany`/`ManyToMany`.
- En el lado `1` (que apunta a `*`): plural.
- Colisión con otra propiedad de la misma clase → sufija `_<n>`.

**Composite FKs**: si `columns.length > 1`, emite `@JoinColumn` con array de objetos `[{ name }]`. Warning si el dialect no soporta composite (postgres sí).

**Scope='selected', endpoint fuera de selección**: preserva la columna FK (renderiza como propiedad regular con su tipo), omite el decorator de relación, agrega warning `"Relation <Source> ↔ <Target>: <Target> not in selection — emitted FK column only."`.

### Naming (`naming.ts`)

```ts
toPascalCase('order_items')  // 'OrderItems'
toPascalCase('public.users') // 'Users' (schema prefix stripped if 'public')
toPascalCase('billing.invoices') // 'BillingInvoices' (schema preserved for non-public)
```

**Singularize (English heuristic)**, sólo si `options.singularize === true`:

Regla de orden:
1. Tabla irregular conocida → mapeo directo (`children→child`, `people→person`, `men→man`, `women→woman`, `feet→foot`, `geese→goose`, `mice→mouse`, `teeth→tooth`).
2. `(.+)ies$` → `$1y` excepto `series`, `species`.
3. `(.+)ses$` → `$1s` (e.g. `addresses→address`).
4. `(.+s|ch|sh|x|z)es$` → `$1` (e.g. `boxes→box`).
5. `(.+)s$` (no `ss`) → `$1`.
6. Otro caso → unchanged.

Aplicado **después** del PascalCase, sobre el último segmento.

### Imports

Encabezado de archivo (cuando `options.includeImports === true`):

```ts
import { Entity, Column, PrimaryColumn, PrimaryGeneratedColumn, ManyToOne, OneToMany, OneToOne, ManyToMany, JoinColumn, JoinTable } from 'typeorm';
```

Imports filtrados a los decorators efectivamente usados en el archivo.

### Entity ordering

Alfabético por nombre de clase. Estable. Cada entity separada por `\n\n`.

### Schema option

Cuando el qualified name tiene schema distinto de `public`, agrega al decorator `@Entity`:

```ts
@Entity({ name: 'invoices', schema: 'billing' })
```

`public`: `@Entity({ name: 'users' })` (omite schema).

---

## Options esquema del exporter TypeORM

```ts
optionsSchema: [
  { id: 'dialect', type: 'enum', label: 'SQL dialect', default: 'postgres',
    choices: [{ value: 'postgres', label: 'PostgreSQL' }] },
  { id: 'singularize', type: 'boolean', label: 'Singularize class names (English)', default: true },
  { id: 'includeImports', type: 'boolean', label: 'Include typeorm imports', default: true },
  { id: 'emitNullableExplicit', type: 'boolean', label: 'Emit nullable: true/false explicitly', default: true },
]
```

Defaults se sobre-escriben por `settings.export.typeorm.*` cuando hay setting correspondiente.

---

## Open questions / future

- Pluralización inversa (para nombres de propiedad `OneToMany`): por ahora plural se genera con `<className>s` simple; mejorable con misma tabla de irregulares.
- Soporte de `enums` DBML → emitir `@Column({ type: 'enum', enum: ... })`. v1.2.
- Soporte de `indexes` DBML → `@Index([...])` decorator. v1.2.
- Templating custom — agregable como opción `'customTemplate'` con string (Handlebars). v2.
- Más dialects: MySQL, SQLite, MSSQL.

---

## Test plan

- `test/unit/exporters/registry.test.ts`:
  - register + get devuelve mismo objeto.
  - get(unknown) → undefined.
  - listExporters() devuelve metas sin propiedad `export`.

- `test/unit/exporters/typeorm/naming.test.ts`:
  - PascalCase: `order_items` → `OrderItems`, `users` → `Users`, `billing.invoices` → `BillingInvoices`.
  - Singularize: `users→User`, `categories→Category`, `addresses→Address`, `children→Child`, `data→Data` (no cambia), `series→Series` (no cambia).

- `test/unit/exporters/typeorm/dialect.test.ts`:
  - Cada fila de la matriz de tipos Postgres mapea correcto.
  - Tipo `varchar(255)` extrae length=255.
  - Tipo desconocido emite warning y devuelve string + raw type.

- `test/unit/exporters/typeorm/relations.test.ts`:
  - 4 cardinalidades emiten decorators y JoinColumn esperados.
  - Composite FK → `@JoinColumn([{ name: 'a' }, { name: 'b' }])`.
  - Colisión de property names → sufija.

- `test/unit/exporters/typeorm/generate.test.ts`:
  - Snapshot sobre fixture `tiny.dbml` (5 tablas, 4 refs, 2 groups) con defaults.
  - Snapshot scope='selected' subset → warning por refs cortadas; columna FK preservada.

- Smoke manual: pegar output en proyecto TypeORM real, `tsc --noEmit` debe pasar contra `typeorm` instalado.
