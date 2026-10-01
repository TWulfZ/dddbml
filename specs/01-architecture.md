# 01 — Architecture

## Runtime topology

```
┌────────────────────────────────────────────────────────────────┐
│  VSCode Process                                                │
│                                                                │
│  ┌──────────────────────┐        ┌──────────────────────────┐ │
│  │ Extension Host       │        │ Webview (Chromium)       │ │
│  │ (Node.js)            │◀──────▶│ (Preact + custom render) │ │
│  │                      │ post   │                          │ │
│  │ - FS watchers        │ Message│ - Spatial index          │ │
│  │ - @dbml/core parser  │        │ - Viewport culling       │ │
│  │ - Layout JSON I/O    │        │ - LOD rendering          │ │
│  │ - Command handlers   │        │ - Drag controller        │ │
│  └──────────────────────┘        └──────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

**Aislamiento**: el extension host corre en Node.js; el webview es un iframe sandboxed sin acceso directo al FS. Toda I/O pasa por `postMessage`.

## Módulos del extension host (`src/extension/`)

| Módulo | Responsabilidad |
|---|---|
| `extension.ts` | `activate()` / `deactivate()`. Registra comandos. |
| `panel.ts` | Ciclo de vida del webview. `DiagramPanel` class (singleton por archivo DBML). |
| `parser.ts` | Wrapper sobre `@dbml/core`. Input: string. Output: modelo interno (`Schema`). Maneja errores de parse. |
| `layoutStore.ts` | Read/write sidecar JSON. Escritura atómica (tmp + rename). Ordering estable. |
| `watcher.ts` | `vscode.workspace.createFileSystemWatcher` para `.dbml` y `.dbml.layout.json`. |
| `protocol.ts` | Tipos TypeScript de mensajes host↔webview. Compartido vía `src/shared/types.ts`. |

## Módulos del webview (`src/webview/`)

| Módulo | Responsabilidad |
|---|---|
| `main.tsx` | Entry point Preact. Listener de `postMessage`. |
| `app.tsx` | Root component. Conecta state → renderer. |
| `render/spatialIndex.ts` | Grid bucketing de 512x512px. `insert/move/remove/query(bbox)`. |
| `render/viewport.ts` | Estado de pan/zoom. Conversión pantalla↔mundo. Query al spatial index. |
| `render/tableNode.tsx` | Componente de una tabla (LOD-aware). |
| `render/edgeLayer.tsx` | SVG overlay único con `<path>` por edge. |
| `render/edgeRouter.ts` | Cálculo de path ortogonal Manhattan. |
| `render/lod.ts` | Determina LOD level según zoom. |
| `drag/dragController.ts` | Handler pointerdown/move/up con mutación DOM directa. |
| `layout/autoLayout.ts` | Wrapper sobre `@dagrejs/dagre`. Top-down, nodesep/ranksep configurables. |
| `groups/groupPanel.tsx` | UI lateral con lista de grupos y toggles. |
| `state/store.ts` | Zustand store. Selectores granulares. |

## Protocolo host↔webview

Mensajes serializados como JSON. Discriminador: campo `type`.

### Host → Webview

```ts
type HostToWebview =
  | { type: 'schema:update'; payload: { schema: Schema; parseError: null | ParseError } }
  | { type: 'layout:loaded'; payload: Layout }
  | { type: 'layout:external-change'; payload: Layout }  // git pull o edición externa
  | { type: 'theme:change'; payload: { kind: 'light' | 'dark' } };
```

### Webview → Host

```ts
type WebviewToHost =
  | { type: 'ready' }
  | { type: 'layout:persist'; payload: Partial<Layout> }  // al instante en cada edición discreta
  | { type: 'viewport:persist'; payload: ViewportLayout }  // cámara, 300 ms tras pan/zoom; sólo view-state
  | { type: 'command:reveal'; payload: { tableName: string } }  // click → go-to-definition
  | { type: 'command:pruneOrphans' }  // comando explícito
  | { type: 'error:log'; payload: { message: string; stack?: string } };
```

## Ciclo de vida de una sesión

1. Usuario abre un `.dbml` en VSC.
2. Ejecuta `dddbml: Open Diagram` (palette o context menu). Desde el explorer / editor
   title se abre el archivo clickeado (el `Uri` que pasa VS Code), no el editor activo; desde
   la palette, el editor activo. Sólo URIs `file:` (`git:`/read-only, p.ej. el lado HEAD de
   un diff, se rechazan con un error).
3. `extension.ts` instancia `DiagramPanel` (reutiliza si ya existe para ese archivo).
4. `DiagramPanel` crea webview en `ViewColumn.Beside`, carga `media/webview.js`.
5. Webview envía `ready`.
6. Host parsea `.dbml` → envía `schema:update`.
7. Host lee `.dbml.layout.json` (crea vacío si no existe) → envía `layout:loaded`.
8. Webview hace auto-layout dagre para tablas sin posición conocida, renderiza.
9. Watchers escuchan cambios en ambos archivos (change + create; el sidecar también delete) →
   un único reload externo con debounce (150 ms) re-parsea el `.dbml` y, si el sidecar cambió,
   postea **primero** `schema:update` y **después** `layout:external-change`. Nunca layout nuevo
   contra schema viejo: en un cambio de rama el auto-layout inventaba posiciones para tablas que
   sólo existían en la revisión anterior y el siguiente persist las escribía. Un sidecar borrado
   recarga un layout vacío; un persist pendiente del host se descarta al recargar. Los nombres
   de archivo se escapan como glob literal (`[`, `]`, `{`, `}`, `*`, `?` → clase de un carácter).
10. Drag en webview → `layout:persist` **inmediato** → host escribe sidecar (debounce de host
    200 ms). Al **ocultar** el panel (el webview se destruye: `retainContextWhenHidden: false`)
    o al **cerrarlo**, el host vuela el persist pendiente en el acto en vez de descartarlo;
    `deactivate()` espera esas escrituras. Antes de escribir, el host re-lee el sidecar: si no es el
    texto que vio por última vez (un `git merge`/`pull` cuyo evento del watcher llega después del
    debounce), no escribe y lanza la recarga externa — si no, renombraba encima de los marcadores
    de conflicto y la recarga tomaba el archivo por su propio eco (F27). Ocultar también marca el panel como no hidratado,
    así los prompts (`export:prompt`, `exportImage:prompt`) esperan al próximo `ready`.
    El webview **no** debouncea ediciones discretas (drag, waypoints, undo/redo, color, ocultar,
    colapsar, auto-layout; F22): un timer muere con el iframe al ocultar/cerrar y un post en
    `pagehide` se pierde al relevarse por un frame que también se destruye. El host coalesce.
    Arrastrar dentro del selector de color nativo **no** es una edición discreta: cada `input`
    sólo actualiza el store (preview) y el color de tabla/grupo se persiste una vez, en el
    `change` del selector o al cerrar el popup (mismo criterio que el color de arista).

## Dependencias externas

Runtime:
- `@dbml/core` — parser oficial DBML.
- `@dagrejs/dagre` — layout DAG.
- `preact` — UI framework (~3kb).
- `zustand` — state management.

Build/dev:
- `typescript` (strict mode).
- `vite` — bundle del webview.
- `@vscode/vsce` — packaging.
- `vitest` — unit tests.
- `@types/vscode` — tipos de la API.

Package manager: **pnpm** (no npm, no yarn). Lockfile: `pnpm-lock.yaml`. Campo `packageManager` en `package.json` lo señaliza a herramientas.

## Decisiones de arquitectura clave

- **Parser corre en host, no webview**: evita bundlear `@dbml/core` en el webview (tamaño), y permite cachear parse result si el DBML no cambia.
- **Un único SVG para todas las edges**: reduce DOM nodes, y permite batchear updates durante drag.
- **No React, Preact**: webview arranca más rápido, menos memoria. API idéntica.
- **Zustand en vez de Context**: selectores evitan re-renders innecesarios; crítico cuando hay 5000 nodos potenciales.
- **Webview no persistente** (`retainContextWhenHidden: false`): ahorra memoria cuando usuario cambia de tab; re-hidrata desde host al volver.
