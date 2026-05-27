# 08 — Roadmap

## v1.0 (MVP)

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

## v1.1 (siguiente iteración, post-feedback)

Implementado:

- **Export to TypeORM** (`specs/09-exporters.md`): genera entities TS desde schema completo o selección. Arquitectura registry+strategy soporta Prisma/SQL/Mermaid sin tocar dispatch.
- **Settings** (`specs/10-settings.md`): zoom step/min/max, LOD thresholds y defaults de export configurables vía VSC `contributes.configuration`.

Candidatos restantes (ordenados por expected value):

1. **Minimap**: panel flotante con vista aérea, viewport indicator draggable. Crítico para nav de >500 tablas.
2. **Search & go-to-table**: Ctrl+P dentro del diagrama, centra viewport en la tabla.
3. **Select tabla → highlight edges**: hover/click en tabla resalta sus relaciones.
4. **Export PNG/SVG** del viewport actual (útil para docs).
5. **Export to Prisma**: nuevo módulo en `src/extension/exporters/prisma/` + 1 línea de registro. Arquitectura ya lista.
6. **Rename layout entry** command: facilita cuando usuario renombra tabla en DBML.
7. **JSON schema publicado**: endpoint estable para `$schema` del layout file.
8. **Multi-archivo DBML con `!include`**: soporta split de schemas grandes.

## v2 (speculative)

- **Dangling edges**: edges que apuntan a grupos hidden se dibujan como punteados hacia borde con label.
- **Mini-layouts por grupo**: cada `TableGroup` puede tener su propio sub-layout auto-optimizado.
- **Diff visual de schema**: dado `git diff` de `.dbml`, resaltar en el diagrama qué tablas/columnas cambiaron (verde/rojo).
- **Export a Mermaid/PlantUML / SQL DDL**: nuevos exporters bajo `src/extension/exporters/` siguiendo el contract en `09-exporters.md`.
- **Better edge routing**: algoritmo basado en A* con obstacle avoidance (edges no cruzan tablas).
- **Collaborative cursors** vía Live Share API de VSC.

## No-goals permanentes

- **Editor visual de DBML** (arrastra tabla desde palette → se escribe DBML): anti-goal porque compite con la idea de "source of truth es el texto".
- **Sync con DBs reales**: fuera de scope; Prisma/dbdiagram/etc hacen esto mejor.
- **Cloud/SaaS**: la extensión es local-first por diseño.

## Cadencia

- v1.0: ~10-12 días de trabajo enfocado. Target: 2-3 semanas calendario.
- v1.1: post primer mes en Marketplace, priorizar según feedback de usuarios.
- v2: evaluar cuando v1.1 esté estable y tengamos base de usuarios.
