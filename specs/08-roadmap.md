# 08 — Roadmap

## v0.1.0 (MVP)

Scope congelado. Ver `00-overview.md` para criterios de éxito.

**Features incluidas:**
- Webview con diagrama renderizado al lado del `.dbml`.
- Parse de DBML vía `@dbml/core`, re-parse en save.
- Render HTML divs + SVG edges con viewport culling + LOD.
- Drag fluido a 60fps hasta 5000 tablas.
- Persistencia en sidecar `<nombre>.dbml.layout.json` Git-friendly.
- Auto-layout inicial dagre top-down.
- Edge routing ortogonal Manhattan con offset de puerto.
- `TableGroup`: toggle visibility + toggle collapse a nodo caja.
- Comandos: `Open Diagram`, `Prune orphan layout entries`, `Reset layout` (re-run dagre).
- Respeto de tema VSC light/dark.

**Features explícitamente excluidas:**
- Editor DBML dentro de la app.
- Multi-archivo `.dbml` con `!include`.
- Export a SQL, Prisma, ERD PNG/SVG.
- Colaboración en tiempo real.
- Syntax highlighting (ya existe en `matt-meyers.vscode-dbml`).

## v0.2.0

Scope congelado. Construcción sobre v1.0; todos los ítems a continuación están implementados.

**Export TypeORM** (`specs/09-exporters.md`):
- Genera entities TypeScript desde schema completo o selección de tablas.
- Arquitectura registry+strategy: agregar Prisma = 1 archivo + 1 línea de registro.
- Dialect strategy interna: PostgreSQL implementado; MySQL/SQLite/MSSQL extensibles sin tocar dispatch.
- Mapeo completo de tipos DBML→TS con decorators `@Column`, `@PrimaryColumn`, `@PrimaryGeneratedColumn`.
- Relaciones completas: `@OneToOne`, `@OneToMany`, `@ManyToOne`, `@ManyToMany` con `@JoinColumn`/`@JoinTable`.
- FK compuesto: `@JoinColumn([{ name: 'a' }, { name: 'b' }])`.
- Singularización inglesa con irregulares (`children→Child`, `people→Person`, etc.).
- Modal UI en webview: selector de formato, scope all/selected, opciones dinámicas.
- Resultado: documento untitled de VSC.

**Settings** (`specs/10-settings.md`):
- `contributes.configuration` con 10 keys bajo `dddbml.*`.
- Zoom step/min/max configurables; elimina hardcodes en viewport y zoom buttons.
- LOD thresholds `lod.mediumThreshold` / `lod.lowThreshold` configurables.
- Defaults de export por formato (`defaultFormat`, `typeorm.*`).
- Propagación reactiva vía `onDidChangeConfiguration` → `settings:loaded` sin reload.
- Settings panel en webview con inputs, toggles, selects y botón Reset to defaults.

**Edge waypoints** (`specs/05-edge-routing.md`):
- Waypoints arrastrables sobre cualquier segmento de arista.
- Click en segmento → círculo fantasma → drag inserta waypoint en índice correcto.
- Doble-click sobre waypoint → eliminar. Context menu "Reset edge waypoints".
- Waypoints persisten en `EdgeLayout.waypoints[]` dentro del sidecar JSON.
- Back-compat total: `W = []` produce path pixel-idéntico al H-V-H original.
- Migración legacy `dx`/`dy`: el primer waypoint del usuario sobrescribe la lógica antigua.

**Undo / Redo** (`specs/11-action-history.md`):
- `Ctrl+Z` / `Cmd+Z` → undo. `Ctrl+Shift+Z` y `Ctrl+Y` → redo.
- `MoveCommand`: drag de tabla suelta y batch marquee; no-op si desplazamiento neto = 0.
- `WaypointCommand`: ops `move`, `add`, `remove`, `clear`; snapshots `from`/`to` deterministas.
- Stack `past`/`future` en store Zustand, capacidad 200 (FIFO drop del head).
- Botones Undo/Redo en ActionsPanel con estado disabled cuando stacks vacíos.
- History se limpia en `setLayout` y en `setSchema` con cambio de conjunto de tablas.
- Separación store (pure state) / persistencia (side effect explícito vía `schedulePersist()`).

**Design system** (`specs/12-design-system.md`):
- Arquitectura CSS `@layer reset, tokens, base, surfaces, components, state, utilities`.
- Tokens completos: spacing 4pt, radii, tipografía, sombras dark-tuned, motion con easings.
- Tres modos de densidad (`compact | cozy | comfortable`) vía `data-density`; mirror TS en `layout/density.ts`.
- Paleta Bounded Context de 12 colores color-blind safe (`--ddd-bc-{1..12}-surface/border`).
- `bcIndex(name)` hash deterministico reemplaza el `hsl(hash, 55%, 60%)` anterior.
- Tokens semánticos `--ddd-*` sobre `--vscode-*` con fallbacks literales.
- `prefers-reduced-motion`: duraciones de animación → `0ms`.
- Cero magic numbers en CSS de componentes.

**Pendiente dentro de v2.0** (no-blocker, próximas iteraciones):
- TypeORM: `enums` DBML → `@Column({ type: 'enum', enum: ... })`.
- TypeORM: `indexes` DBML → `@Index([...])`.
- TypeORM: dialects MySQL, SQLite, MSSQL.
- Edge: marcadores de flecha para distinguir cardinalidad (1:*, *:*).
- Edge: fix de self-loops (path degenerado).
- Edge: curvatura en elbows (`stroke-linejoin: round`).

## v2.1 (candidatos, ordenados por expected value)

1. **Minimap**: panel flotante con vista aérea, viewport indicator draggable. Crítico para nav de >500 tablas.
2. **Search & go-to-table**: Ctrl+P dentro del diagrama, centra viewport en la tabla.
3. **Select tabla → highlight edges**: hover/click en tabla resalta sus relaciones.
4. **Export PNG/SVG** del viewport actual.
5. **Export to Prisma**: `src/extension/exporters/prisma/` + 1 línea de registro. Arquitectura ya lista.
6. **Más action types en history**: `SetGroupColor`, `SetTableColor`, `ToggleHidden`. Mismo stack, extensible vía `kind`.
7. **Rename layout entry** command.
8. **JSON schema publicado**: endpoint estable para `$schema` del layout file.
9. **Multi-archivo DBML con `!include`**: soporta split de schemas grandes.
10. **Light / High-Contrast themes** para design system.

## v3 (speculative)

- **Dangling edges**: edges a grupos hidden se dibujan como punteados hacia borde con label.
- **Mini-layouts por grupo**: cada `TableGroup` con sub-layout auto-optimizado propio.
- **Diff visual de schema**: dado `git diff` del `.dbml`, resaltar tablas/columnas cambiadas (verde/rojo).
- **Better edge routing**: A* con obstacle avoidance (edges no cruzan tablas).
- **Export a Mermaid/PlantUML / SQL DDL**: nuevos exporters bajo `src/extension/exporters/`.
- **DDD stereotypes**: aggregate-root con borde superior grueso, value-object con borde punteado, declarados vía DBML notes.
- **Coalescing temporal de drags**: drags consecutivos sobre la misma tabla dentro de N ms se mergean en un solo command de history.
- **Collaborative cursors** vía Live Share API de VSC.

## No-goals permanentes

- **Editor visual de DBML** (arrastra tabla desde palette → se escribe DBML): anti-goal porque compite con la idea de "source of truth es el texto".
- **Sync con DBs reales**: fuera de scope; Prisma/dbdiagram/etc hacen esto mejor.
- **Cloud/SaaS**: la extensión es local-first por diseño.

## Cadencia

- v0.1.0: MVP. ~10-12 días de trabajo enfocado.
- v0.2.0: export, settings, waypoints, undo/redo, design system.
- v0.2.1: post-feedback de usuarios; priorizar Minimap y Search por impacto en nav.
- v0.3: evaluar cuando v0.2.1 esté estable y tengamos base de usuarios.
