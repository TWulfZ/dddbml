# 08 — Roadmap

Este roadmap lista **features futuras** (backlog priorizado), **sin números de
versión**. Las versiones y todo lo ya entregado viven en `CHANGELOG.md`; los
criterios de éxito y anti-goals del producto, en `00-overview.md`. Mantenerlo
sin versiones evita atar una feature a un número concreto y los malentendidos
de salto de versión (p.ej. 0.2.0 → 0.2.2).

> **Ya entregado:** render + culling/LOD, persistencia sidecar Git-friendly,
> auto-layout dagre, edición de aristas (dos niveles: slide + notch fantasma
> ¼/¾, tolerancia de disolución, flow circular con bloom), TableGroups, export
> TypeORM, settings, undo/redo y design system con tokens + densidades.
> El detalle por release está en `CHANGELOG.md`.

## Próximas features (priorizadas por valor esperado)

1. **Minimap**: panel flotante con vista aérea, viewport indicator draggable. Crítico para nav de >500 tablas.
2. **Search & go-to-table**: Ctrl+P dentro del diagrama, centra viewport en la tabla.
3. **Select tabla → highlight edges**: hover/click en tabla resalta sus relaciones.
4. **Export PNG/SVG** del viewport actual.
5. **Export to Prisma**: `src/extension/exporters/prisma/` + 1 línea de registro. Arquitectura ya lista.
6. **Más action types en history**: `SetGroupColor`, `SetTableColor`, `ToggleHidden`. Mismo stack, extensible vía `kind`.
7. **Rename layout entry** command.
8. **JSON schema publicado**: endpoint estable para `$schema` del layout file.
9. **Multi-archivo DBML con `!include`**: soporta split de schemas grandes.
10. **Light / High-Contrast themes** para el design system.

### Polish incremental (no-blocker, misma arquitectura)

- **TypeORM**: `enums` DBML → `@Column({ type: 'enum', enum: ... })`.
- **TypeORM**: `indexes` DBML → `@Index([...])`.
- **TypeORM**: dialects MySQL, SQLite, MSSQL (extensibles sin tocar dispatch).
- **Edge**: marcadores de flecha para distinguir cardinalidad (1:*, *:*).
- **Edge**: fix de self-loops (path degenerado).

## Exploratorias (largo plazo, sin compromiso)

- **Dangling edges**: edges a grupos hidden se dibujan como punteados hacia borde con label.
- **Mini-layouts por grupo**: cada `TableGroup` con sub-layout auto-optimizado propio.
- **Diff visual de schema**: dado `git diff` del `.dbml`, resaltar tablas/columnas cambiadas (verde/rojo).
- **Better edge routing**: A* con obstacle avoidance (edges no cruzan tablas).
- **Export a Mermaid / PlantUML / SQL DDL**: nuevos exporters bajo `src/extension/exporters/`.
- **DDD stereotypes**: aggregate-root con borde superior grueso, value-object con borde punteado, declarados vía DBML notes.
- **Coalescing temporal de drags**: drags consecutivos sobre la misma tabla dentro de N ms se mergean en un solo command de history.
- **Collaborative cursors** vía Live Share API de VSC.

## No-goals permanentes

- **Editor visual de DBML** (arrastra tabla desde palette → se escribe DBML): anti-goal porque compite con la idea de "source of truth es el texto".
- **Sync con DBs reales**: fuera de scope; Prisma/ORM tools hacen esto mejor.
- **Cloud/SaaS**: la extensión es local-first por diseño.
- **Syntax highlighting**: ya existe en `matt-meyers.vscode-dbml`.
