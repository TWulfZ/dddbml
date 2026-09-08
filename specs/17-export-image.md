# 17 — Exportar imagen del diagrama

## Propósito

Permitir exportar el diagrama como **imagen** (PNG / SVG / portapapeles) desde el
menú de la aplicación, eligiendo el alcance: **todo el diagrama**, **solo la vista
actual** (lo que se ve en pantalla) o **la selección actual**. Pensado para
documentar y compartir el esquema fuera de VS Code.

## Contexto / Problema

dddbml no tenía forma de obtener una imagen del diagrama. El render es **DOM HTML
(tablas) + una capa SVG (edges)**, no canvas, y está **culled**: solo se montan en
el DOM las tablas que intersecan el viewport (`visibleNames = spatialIndex.query(...)`
en `app.tsx`). Por eso **rasterizar el elemento `.ddd-world`** no puede producir un
export del diagrama completo — las tablas fuera de pantalla no existen en el DOM.

La solución es **generar un documento SVG a partir del modelo del store** (tablas,
columnas, grupos, edges), no del DOM. El SVG se rasteriza a PNG en un `<canvas>`
dentro del webview. **Cero dependencias nuevas** (presupuesto de bundle, spec 07).

## Preguntas abiertas (Open Questions)

- [x] **"Embed scene" (como Excalidraw, JSON re-importable).** No existe round-trip
  imagen→diagrama. **Decisión:** omitir en v1 (acordado con el usuario, 2026-06-01).
- [x] **Alcances ofrecidos.** **Decisión:** Todo / Vista actual / Selección
  (Selección se oculta cuando no hay nada seleccionado) (usuario, 2026-06-01).
- [x] **Tema claro/oscuro del export.** El SVG es autónomo (sin `--vscode-*` vivos).
  **Decisión:** sin toggle claro/oscuro; se **hornea un único paletón = snapshot de
  los tokens computados actuales** al exportar (usuario, 2026-06-01).
- [x] **¿Respetar el filtro PK/FK (`showOnlyPkFk`)?** **Decisión:** no — el export
  siempre incluye todas las columnas (un export debe ser completo).
- [x] **Iconos de columna (codicon).** El CSP no permite `font-src data:`, y el
  codicon no viaja en un SVG autónomo. **Decisión:** PK se indica con **texto en
  color de acento + negrita** (sin glifo de llave); NN/U como sufijo de texto.

## Diseño

### Módulos (webview, puros)

- `src/webview/export/imageExport.ts`
  - `snapshotTheme` (vía `buildImageSvg`): resuelve los tokens `--ddd-*` / `--vscode-*`
    a literales con un elemento *probe* (`getComputedStyle`) → realiza "tema actual".
  - `buildExportModel(source, opts) → ExportModel | null`: elige el conjunto de
    tablas/grupos/edges según el alcance y calcula los `bounds`. **Puro, sin DOM.**
  - `renderSvg(model, theme, resolve) → { svg, width, height }`: emite el SVG
    autónomo. **Puro** (la resolución de color se inyecta).
  - `buildImageSvg(source, opts)`: entrada de navegador (crea el probe, compone los
    tres anteriores).
- `src/webview/export/raster.ts`
  - `fitScale(w, h, desired)`: limita la escala para no superar `MAX_DIM=16384` /
    `MAX_AREA≈256MP`; devuelve `{ scale, clamped }`. **Pura.**
  - `svgToPng(svg, w, h, scale)`: SVG → `data:` URL → `Image` → `<canvas>` →
    `toBlob('image/png')`. Espera `document.fonts.ready` antes de dibujar.
  - `blobToBase64(blob)`: bytes en base64 para cruzar `postMessage`.

### Reuso (no se reinventa)

- Geometría: `densityMetrics()`, `estimateSize()`, `columnCenterY()` (fuente de
  verdad del layout) — nunca se mide el DOM.
- Edges: `routeRefs(effectiveRefs, bboxOf, columnY, layoutResolver)` (`edgeRouter.ts`).
  Las cadenas `d` se usan **verbatim**; los 4 `<marker>` crow's-foot se copian de
  `edgeLayer.tsx`. Los closures `bboxOf`/`columnY` replican los de la capa de edges.
- `derived` (containers, collapsedNodes, effectiveRefs) se pasa **como prop** desde
  `app.tsx` (donde ya está memoizado) — el export refleja exactamente lo de pantalla.

### Fidelidad respecto a `tableNode.tsx`

El SVG reproduce: rect redondeado (fill = `surface-raised`, borde = `border`), franja
de acento superior (color de tabla/grupo o `accent`), banda de cabecera con esquinas
superiores redondeadas (tint = `rgba(color, 0.22)` cuando hay color de tabla; si no,
`titleBar-activeBackground`), título (`schema.` atenuado + nombre), filas de columna
(nombre a la izquierda — PK en acento/negrita — y `tipo + NN/U` a la derecha en mono
atenuado). Truncado aproximado por ancho de carácter (sin medir el DOM). Contenedores
de grupo (rect punteado + etiqueta) y nodos colapsados (rect sólido + nombre + conteo).
Los edges se dibujan a opacidad completa (sin el fade de hover del canvas).

### Alcances

- **Todo**: todas las tablas renderizadas (no ocultas/colapsadas, con posición) +
  nodos colapsados + contenedores. `bounds` = unión + padding.
- **Vista**: rect del viewport en coords de mundo (`{-vp.x/zoom, …, w/zoom, h/zoom}`),
  leído del `.ddd-viewport` al exportar; se incluye lo que interseca y el `viewBox`
  recorta el resto.
- **Selección**: solo las tablas en `selection`; edges con **ambos** extremos dentro.

## Modelo de datos / tipos afectados

- `src/webview/state/store.ts`: nuevo `exportImagePromptOpen: boolean` +
  `setExportImagePromptOpen(open)` (efímero, no historial; espejo de
  `exportPromptOpen`/`setExportPromptOpen`).
- Tipos nuevos en `imageExport.ts`: `ExportScope`, `ExportOptions`, `ExportSource`,
  `ExportDerived`, `ExportModel`, `ThemeTokens`. El schema/layout no cambia.

## Puntos de extensión / integración

- UI: `ui/{Modal,Button,RadioGroup,Field}` (modal `render/exportImageModal.tsx`,
  modelo: `render/exportModal.tsx`). Ítem "Export image…" en `render/appMenu.tsx`.
- Montaje: `<ExportImageModal derived={derived} />` en `app.tsx`.
- Comando `dddbml.exportImage` (`package.json` + `extension.ts`), espejo de
  `dddbml.exportSchema` → abre el modal vía `exportImage:prompt`.

## Protocolo host↔webview

- `WebviewToHost`: `{ type: 'command:saveImage'; payload: { dataBase64; mime:
  'image/png' | 'image/svg+xml'; suggestedName } }`.
- `HostToWebview`: `{ type: 'exportImage:prompt' }` (abre el modal desde la paleta) y
  `{ type: 'image:result'; payload: { ok; path?; message? } }`.
- Host (`panel.ts` `saveImage`): `vscode.window.showSaveDialog` (defaultUri junto al
  `.dbml`, filtro PNG/SVG) → `workspace.fs.writeFile(Buffer.from(base64,'base64'))` →
  `image:result`. Cancelar el diálogo = `ok:false` sin error (el modal queda abierto).
- **Copiar**: en el webview vía `navigator.clipboard.write([ClipboardItem])`; si falla
  (no soportado/bloqueado) cae al guardado por host.

## Anti-goals / fuera de alcance

- No "Embed scene" / re-importar imagen → diagrama.
- No toggle claro/oscuro (un único paletón = tema actual).
- No glifos codicon en el SVG (CSP `font-src` sin `data:`).
- No medir el DOM ni rasterizar `.ddd-world` (incompatible con culling).

## Fallos conocidos / casos límite

- **Deriva de fidelidad**: el SVG reimplementa `tableNode.tsx` a mano; cambios de CSS
  no se propagan solos → mitigado con geometría desde `densityMetrics()` y tests de
  snapshot estructural.
- **Tamaño de canvas**: un diagrama enorme a 3× supera el tope del navegador →
  `fitScale` reduce la escala y el modal avisa; **SVG** es vectorial e ileso
  (recomendado para diagramas grandes).
- **Fuentes**: stack de sistema; se espera `document.fonts.ready` antes de rasterizar.
- **Tamaño de `postMessage`**: el SVG viaja como texto (pequeño); el PNG queda acotado
  por el clamp.

## Error handling

`buildExportModel` devuelve `null` cuando el alcance no tiene nada (selección vacía,
sin tablas) → el modal muestra un aviso y no envía nada. Fallos de raster/escritura se
muestran como aviso en el modal o `showErrorMessage` en el host; el portapapeles cae a
guardado por host.

## Performance budget (spec 07)

El export es **on-demand** (un clic), fuera del render path; no afecta el presupuesto
por frame. No se añaden dependencias al bundle (solo código propio).

## Test plan

- `src/webview/export/imageExport.test.ts`: filtrado por alcance (all/view/selection),
  `bounds` (== viewRect en 'view'; encierra todo + padding en 'all'), inclusión de
  edges por extremos, y `renderSvg` sin `var(` con markers crow's-foot presentes.
- `src/webview/export/raster.test.ts`: lógica pura de `fitScale` (sin clamp / clamp por
  dimensión / clamp por área / tamaños degenerados).
- Manual (Extension Development Host): menú → "Export image…"; con la mayoría de tablas
  fuera de pantalla, "Todo" produce un archivo con **todas** las tablas (prueba que es
  por modelo, no por DOM culled); "Vista actual" recorta a lo visible; "Selección" solo
  las seleccionadas; PNG a 1×/2×/3×; Background off → PNG transparente; el SVG abre en
  un navegador con layout/edges/markers/colores correctos y **sin** `var(--…)`.

## Documentos relacionados

- `specs/04-render-pipeline.md` (culling — por qué SVG desde modelo).
- `specs/05-edge-routing.md` (`routeRefs`, markers).
- `specs/12-design-system.md` (tokens `--ddd-*`, paleta BC, densidad).
- `specs/15-app-menu.md` (menú de la aplicación).
- `specs/01-architecture.md` (protocolo host↔webview).
