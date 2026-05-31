# 00 — Overview

## Propósito

`dddbml` es una extensión de VSCode que renderiza archivos DBML como diagramas interactivos, con persistencia Git-friendly de posiciones por tabla y soporte para contextos DDD vía `TableGroup`.

El editor de texto es VSCode mismo. La extensión sólo **lee** el `.dbml`, renderiza el diagrama en un panel webview al lado, y permite al usuario reposicionar tablas con drag. Las posiciones se guardan en un archivo sidecar `<nombre>.dbml.layout.json` versionable.

## Problema que resuelve

- Las herramientas SaaS de diagramas ERD no tienen versionado Git nativo del layout.
- Extensiones VSCode existentes (bocovo, peaktech, liger, rizkykurniawan) renderizan el diagrama pero **no persisten posiciones** entre sesiones ni las versionan.
- Ninguna soporta **colapso por TableGroup**, crítico para navegar proyectos DDD con decenas de bounded contexts.
- Ninguna está diseñada para **5000+ tablas** (típico de monolitos legacy o ERPs grandes).

## Diferenciadores vs extensiones existentes

| Feature | Otras | dddbml |
|---|---|---|
| Diagrama visual | ✓ | ✓ |
| Posición persistente por tabla | ✗ | **✓** |
| Git-friendly (sidecar ordenado) | ✗ | **✓** |
| TableGroup collapse a nodo único | ✗ | **✓** |
| Viewport culling >1000 tablas | ✗ | **✓** |
| LOD rendering (3 niveles por zoom) | ✗ | **✓** |
| Edge routing ortogonal con offset de puerto | parcial | **✓** |

## Usuario target

Equipos que:
- Mantienen el schema de DB como código DBML en el mismo repo del producto.
- Hacen code review de cambios de schema y quieren que el diagrama también sea revisable (diff del layout).
- Trabajan en proyectos DDD con bounded contexts explícitos que mapean a `TableGroup`.
- Tienen DBs medianas a grandes (100-5000 tablas).

## Anti-goals (v1)

- No editar DBML desde la app (VSC editor nativo cubre esto).
- No multi-archivo DBML por proyecto (un `.dbml` = un diagrama).
- No export a SQL/Prisma/PNG (v2+).
- No colaboración en tiempo real (Git async suficiente).
- No syntax highlighting (la extensión `matt-meyers.vscode-dbml` ya lo hace; somos complementarios).
- No tematización custom más allá de respetar VSC light/dark.

## Criterios de éxito v1

1. Abrir DBML de 5000 tablas y navegar a 60fps sostenidos.
2. Mover 10 tablas, cerrar VSC, reabrir → posiciones preservadas.
3. `git diff` del layout file tras un drag = sólo las líneas de las tablas movidas.
4. Colapsar grupo DDD reduce visualmente complejidad del diagrama.
5. Editar DBML externamente (agregar tabla) → diagrama se actualiza sin perder posiciones existentes.

## Documentos relacionados

- `01-architecture.md` — protocolo host↔webview, módulos.
- `02-dbml-ast-mapping.md` — mapeo `@dbml/core` AST → modelo interno.
- `03-layout-file-schema.md` — schema del sidecar JSON.
- `04-render-pipeline.md` — spatial index, culling, LOD, drag.
- `05-edge-routing.md` — algoritmo Manhattan ortogonal.
- `06-tablegroups.md` — visibility + collapse semantics.
- `07-performance-budgets.md` — targets y budgets.
- `08-roadmap.md` — v1 scope + futuro.
