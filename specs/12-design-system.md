# 12 — Design System

## Propósito

Centralizar todas las decisiones visuales del webview en una capa de tokens y una arquitectura `@layer`, de modo que cada superficie (tablas, edges, panels, modales, tooltips, popups) lea de la misma fuente. El objetivo es soportar diagramas masivos (500+ tablas) con jerarquía visual legible, una densidad ajustable por el usuario, y un lenguaje cromático coherente para Bounded Contexts en proyectos DDD.

VSCode sigue siendo dueño del tema (colores base, contraste de focus, hover). El sistema de diseño consume `--vscode-*` y expone una capa semántica `--ddd-*` encima.

## Goals

1. Una **única fuente de tokens** (`@layer tokens`) para spacing, radii, tipografía, sombras, motion y semántica cromática. Cero magic numbers en el CSS de componentes.
2. **Cascada por capas** (`@layer reset, tokens, base, surfaces, components, state, utilities`) que permita extender o sobreescribir sin pelear con la especificidad.
3. **Tres modos de densidad** (`compact | cozy | comfortable`) seleccionables vía `data-density` en la raíz; persistidos como setting de VSCode `dddbml.ui.density`.
4. **Paleta Bounded Context** curada de 12 colores, color-blind safe y tuneada para modo oscuro, sustituye al `hsl(hash, 55%, 60%)` actual.
5. **Churn de JSX acotado**: las clases `ddd-*` existentes se preservan a nivel CSS. *Actualizado*: se introduce una capa de **primitivos Preact** en `src/webview/ui/` que encapsula esas clases tras componentes tipados (`<Button>`); los call sites migran su markup pero el lenguaje visual no cambia — ver [Capa de componentes](#capa-de-componentes--primitivos-preact).
6. **Reduced motion**: `prefers-reduced-motion: reduce` neutraliza las animaciones de UI.
7. **Spec-first**: este documento es la fuente de verdad. Cualquier cambio futuro a colores, tamaños o sombras se documenta aquí antes de tocar el CSS.

## Non-goals

- Light theme y High-Contrast themes (deferred — la mayoría de usuarios DDD usan tema oscuro; ver Roadmap).
- ~~Tailwind o un framework de utilidades (rompería la coherencia con `--vscode-*`)~~ →
  **REVISADO** (ver [Integración Tailwind v4](#integración-tailwind-v4--trial-incremental)).
  La objeción técnica original resultó parcialmente desactualizada: el CSP del panel ya
  permite estilos (`style-src … 'unsafe-inline'`) y Tailwind v4 enlaza variables de tema
  en vivo vía `@theme inline`. Se adopta Tailwind v4 de forma **incremental y reversible**;
  `--ddd-*` sigue siendo la fuente de verdad semántica y las utilidades solo referencian
  esos tokens (valores arbitrarios), no los reemplazan.
- Per-file theming (mismo `.dbml` no debe tener diseño distinto por carpeta).
- Stereotypes DDD (aggregate-root border, value-object dashed, etc.) — segundo round.
- Splitting de `style.css` en archivos por componente — la arquitectura `@layer` cubre la separación lógica sin un build extra.

---

## Layered architecture

```
@layer reset, tokens, base, surfaces, components, state, utilities;
```

| Capa | Responsabilidad |
|---|---|
| `reset` | Box-sizing universal. Nada más. |
| `tokens` | `:root` con todos los tokens; selectores `[data-density='…']` y `@media (prefers-reduced-motion)` viven aquí. |
| `base` | Elementos globales: `html`, `body`, scrollbars, `::selection`, `:focus-visible`, `.ddd-icon`. |
| `surfaces` | Contenedores del lienzo: `.ddd-viewport`, `.ddd-world`, `.ddd-edges`, `.ddd-marquee`, `.ddd-banner`, `.ddd-empty`, `.ddd-statusbar`. |
| `components` | Una sección por componente UI (tabla, edge, tooltip, modal, etc.) leyendo **solo** de tokens. |
| `state` | Modificadores `.is-*`, `:hover`, `:focus-visible`, `body.ddd-is-dragging`. |
| `utilities` | Helpers atómicos (`.ddd-stack`, `.ddd-row`, `.ddd-truncate`, `.ddd-visually-hidden`). |

`reset` carga primero, `utilities` último — el orden de declaración lo fija la cabecera `@layer reset, tokens, base, surfaces, components, state, utilities;`.

---

## Tokens

### Spacing (escala 4pt)

| Token | Valor | Uso |
|---|---|---|
| `--ddd-space-0` | `0` | reset / inline gaps |
| `--ddd-space-1` | `2px` | hairline, alineación de iconos |
| `--ddd-space-2` | `4px` | gap interno de chips, badge padding |
| `--ddd-space-3` | `6px` | inline padding chico |
| `--ddd-space-4` | `8px` | inline padding default |
| `--ddd-space-5` | `12px` | section gap |
| `--ddd-space-6` | `16px` | modal padding |
| `--ddd-space-7` | `24px` | modal section gap |
| `--ddd-space-8` | `32px` | hero/empty state |

### Radii

| Token | Valor | Uso |
|---|---|---|
| `--ddd-radius-xs` | `2px` | badges, swatches |
| `--ddd-radius-sm` | `3px` | inputs, chips |
| `--ddd-radius-md` | `6px` | cards, tablas, tooltips |
| `--ddd-radius-lg` | `10px` | group containers |
| `--ddd-radius-full` | `9999px` | edge waypoints |

### Typography

| Token | Valor | Uso |
|---|---|---|
| `--ddd-font-sans` | `var(--vscode-font-family)` | UI general |
| `--ddd-font-mono` | `var(--vscode-editor-font-family, ui-monospace, monospace)` | tipos SQL en tooltips |
| `--ddd-text-xs` | `10px` | flags, swatches |
| `--ddd-text-sm` | `11px` | badges, hints |
| `--ddd-text-base` | `12px` | body default |
| `--ddd-text-md` | `13px` | títulos modal |
| `--ddd-text-lg` | `14px` | títulos de empty state |
| `--ddd-leading-tight` | `1.2` | títulos |
| `--ddd-leading-normal` | `1.4` | body |
| `--ddd-weight-regular` | `400` | body |
| `--ddd-weight-medium` | `500` | labels |
| `--ddd-weight-semibold` | `600` | títulos, énfasis |

### Shadows (dark-mode tuned)

| Token | Valor | Uso |
|---|---|---|
| `--ddd-shadow-sm` | `0 1px 2px rgba(0,0,0,0.45)` | tabla, banner |
| `--ddd-shadow-md` | `0 4px 12px rgba(0,0,0,0.5)` | popups, group panel |
| `--ddd-shadow-lg` | `0 12px 32px rgba(0,0,0,0.6)` | modales |
| `--ddd-shadow-focus` | `0 0 0 2px var(--ddd-accent)` | focus rings |

### Motion

| Token | Valor | Uso |
|---|---|---|
| `--ddd-duration-instant` | `80ms` | press feedback |
| `--ddd-duration-fast` | `150ms` | hover, fade |
| `--ddd-duration-medium` | `220ms` | modal enter |
| `--ddd-duration-slow` | `320ms` | panel slide |
| `--ddd-ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | entrar |
| `--ddd-ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | salir |
| `--ddd-ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | feedback de pulsación |

Bajo `@media (prefers-reduced-motion: reduce)`, las tres `duration-{fast,medium,slow}` se ajustan a `0ms`.

### Semantic (surfaces / fg / borders / accents)

| Token | Mapeo | Uso |
|---|---|---|
| `--ddd-surface-canvas` | `--vscode-editor-background` | fondo del viewport |
| `--ddd-surface-raised` | `--vscode-editorWidget-background` | tabla, panel, popup |
| `--ddd-surface-overlay` | `--vscode-menu-background` | tooltip, context menu, color popup |
| `--ddd-surface-hover` | `rgba(255,255,255,0.06)` | hover unificado |
| `--ddd-surface-active` | `rgba(255,255,255,0.10)` | press feedback |
| `--ddd-surface-selected` | `rgba(0, 122, 204, 0.18)` | marquee / row selected |
| `--ddd-fg` | `--vscode-foreground` | texto default |
| `--ddd-fg-strong` | `--vscode-editor-foreground` | títulos |
| `--ddd-fg-muted` | `--vscode-descriptionForeground` | texto secundario |
| `--ddd-fg-subtle` | `rgba(204,204,204,0.6)` | hints |
| `--ddd-fg-on-accent` | `#ffffff` | texto sobre fondo accent |
| `--ddd-border` | `--vscode-panel-border` | borde default |
| `--ddd-border-strong` | `--vscode-contrastBorder` | bordes a11y HC |
| `--ddd-border-subtle` | `rgba(255,255,255,0.08)` | divisores internos |
| `--ddd-accent` | `--vscode-focusBorder` | selección, focus |
| `--ddd-accent-hover` | `--vscode-button-hoverBackground` | botones primarios |
| `--ddd-danger` | `--vscode-errorForeground` | borrar, error |
| `--ddd-warning` | `--vscode-editorWarning-foreground` | note icon |
| `--ddd-success` | `#4ec9b0` | confirmación |
| `--ddd-edge` | `--vscode-charts-blue` | relación FK |
| `--ddd-edge-hover` | `--vscode-charts-foreground` | edge highlight |
| `--ddd-edge-selected` | `--vscode-focusBorder` | edge selected |
| `--ddd-edge-handle` | `--ddd-fg-muted` | borde sutil del handle de segmento (slide) |
| `--ddd-edge-ghost-r` / `-hover` | `4` / `7` | radio del nodo fantasma ¼/¾ y su crecimiento en hover (sin cambio de color) |
| `--ddd-edge-flow-width` | `3.9` | diámetro del punto del flujo; con `stroke-dasharray: 0 gap` + cap redondo, cada punto es un círculo de este diámetro → subirlo agranda sin volverse rectángulo ni tocar el espaciado (+30% = ×1.3) |
| `--ddd-edge-flow-gap` | `42` | espaciado centro-a-centro del flujo = período del dash; el offset del `@keyframes` debe = `-gap` (literal, el keyframe no admite `var`) |
| `--ddd-edge-flow-duration` | `1.4s` | duración de un loop (menor = más rápido) |
| `--ddd-edge-bloom-flow` / `-selected` | drop-shadow ×2 / ×1 | glow del flujo (pronunciado) y de la línea seleccionada (sutil) |

---

## Density system

Atributo: `data-density='compact' | 'cozy' | 'comfortable'` en el contenedor raíz (`.ddd-viewport`'s parent o `body`). Cozy es default.

| Token | compact | cozy | comfortable | Uso |
|---|---|---|---|---|
| `--ddd-table-w` | `200px` | `240px` | `280px` | ancho de tabla |
| `--ddd-table-row-h` | `16px` | `20px` | `26px` | alto de fila |
| `--ddd-table-pad-x` | `6px` | `10px` | `12px` | padding horizontal de fila |
| `--ddd-table-pad-y` | `1px` | `3px` | `5px` | padding vertical de fila |
| `--ddd-table-header-h` | `22px` | `28px` | `34px` | alto de header |
| `--ddd-text-table` | `10px` | `12px` | `13px` | font-size en filas |

Contrato: el componente `TableNode` lee estos tokens vía CSS. El JSX no inspecciona la densidad — solo aplica `data-density` en el árbol. `estimateSize()` (utilizado para auto-layout) debe consultar los mismos números — para no romper, leemos del DOM en runtime, o mantenemos un mirror en TS (`densityMetrics(density)`) que el spec mantiene en sincronía.

**Decisión**: TS mirror en `src/webview/layout/density.ts` exportando `densityMetrics('compact'|'cozy'|'comfortable')`. Es el único lugar fuera del CSS donde aparecen estos números. `estimateSize()` lo consume.

---

## Bounded-context palette

12 colores tuneados para tema oscuro VSCode, sin pares rojo/verde adyacentes (color-blind safer), contraste mínimo AA del texto blanco sobre la variante surface.

| Idx | Archetype | `surface` (fill ~12%) | `border` (label/stripe) |
|---|---|---|---|
| 1 | Steel | `#1e3a5f` | `#5b9be8` |
| 2 | Teal | `#1e4a3a` | `#5ec99b` |
| 3 | Terracotta | `#4a2a1e` | `#e09b6e` |
| 4 | Amethyst | `#3a1e4a` | `#b888e0` |
| 5 | Mustard | `#4a3a1e` | `#e0c878` |
| 6 | Cyan | `#1e4a4a` | `#6fdada` |
| 7 | Rose | `#4a1e3a` | `#e07eb0` |
| 8 | Olive | `#2a3a1e` | `#9bdc70` |
| 9 | Periwinkle | `#1e2a4a` | `#849ce0` |
| 10 | Slate | `#3a3a3a` | `#b0b0b0` |
| 11 | Clay | `#4a1e1e` | `#e07e7e` |
| 12 | Moss | `#2a4a1e` | `#8ee070` |

Tokens expuestos: `--ddd-bc-{1..12}-surface`, `--ddd-bc-{1..12}-border`.

### Hash → index

```ts
function bcIndex(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return (Math.abs(h) % 12) + 1;
}
```

`colorForGroup(name)` devuelve `var(--ddd-bc-${bcIndex(name)}-border)` para la "stripe" del header de tabla y el label del group container. La capa de container/tableNode usa `color-mix(in srgb, var(--ddd-bc-N-surface) ALPHA%, transparent)` para el fill suave, lo que reemplaza el truco `hsl→hsla` actual.

### Legacy fallback

Si `layout.json` ya tiene un hex (`#abcdef`) escrito por el usuario en versiones previas, se respeta tal cual (`color-mix` acepta hex). La paleta solo gobierna **defaults auto-generados**.

---

## VSCode integration

Cascada de fallback: cada token semántico apunta a un `--vscode-*` con un fallback literal final.

```css
--ddd-surface-raised: var(--vscode-editorWidget-background, #252526);
--ddd-fg: var(--vscode-foreground, #cccccc);
--ddd-accent: var(--vscode-focusBorder, #007acc);
```

Si VSCode cambia el tema, las variables `--vscode-*` se actualizan automáticamente y los tokens `--ddd-*` rebotan sin reload. Nada en el webview debe leer hex literales — todo pasa por la capa semántica.

---

## State conventions

Inventario de modificadores `.is-*`. Cada uno se aplica en `@layer state` con reglas pequeñas y sin duplicar estilos base.

| Clase | Aplica a | Efecto |
|---|---|---|
| `.is-selected` | `.ddd-table`, edges | `outline: 2px solid var(--ddd-accent)` |
| `.is-dragging` (body) | `body` | cursor grabbing global |
| `.is-panning` | `.ddd-viewport` | cursor grabbing |
| `.is-fk` | `.ddd-table__col` | alineación + sin background extra |
| `.is-pk` | `.ddd-table__col-name`, `.ddd-col-icon` | color accent, weight 600 |
| `.is-active` | `.ddd-actions-btn`, color chip | bg accent / outline accent |
| `.is-danger` | `.ddd-context-menu__item` | color `--ddd-danger` |
| `.is-open` / `.is-closed` | panels | layout abierto vs collapsed |
| `:focus-visible` | todos los focusables | `box-shadow: var(--ddd-shadow-focus)` |

---

## Motion conventions

- **Tooltips, context menus, color popup, modal overlay**: fade-in `var(--ddd-duration-fast) var(--ddd-ease-out)`.
- **Modal panel**: fade + translateY(8px) → 0, `var(--ddd-duration-medium)`.
- **Group panel slide**: ancho/altura `var(--ddd-duration-slow) var(--ddd-ease-out)`.
- **Botones**: transición conjunta `color/background/border/scale var(--ddd-duration-instant) var(--ddd-ease-out)` en la clase base; press = `active:scale-[0.97]` (cierra el drift previo: el spec lo documentaba pero solo `secondary`/`primary` lo tenían — ahora **todas** las variantes). La geometría del scale usa la propiedad CSS `scale` (no `transform`), independiente de las animaciones de entrada que animan `transform`.
- **Tip de botón** (`ui/Tooltip`): fade + rise `translateY(4px)→0` (`ddd-tip-in`, `var(--ddd-duration-fast) var(--ddd-ease-out)`). El elemento externo posiciona (`translate(-50%, …)`); el interno anima — separación de propiedades para no colisionar el transform.
- **Barra de acciones (entrada escalonada)**: al expandir, cada tool entra con `ddd-tool-in` (fade + `translateY(6px)→0`, `var(--ddd-duration-medium) var(--ddd-ease-out)`) con `animation-delay` por `nth-child` (25ms de paso). `backwards` mantiene el estado inicial antes del delay.

Nada que afecte `width`/`height`/`top`/`left` directo dentro del viewport (el render usa `transform`, ya cumple).

Reduce-motion (`@media (prefers-reduced-motion: reduce)`): `--ddd-duration-fast/medium/slow` → `0ms` **y** `animation-delay: 0ms !important` (para que la entrada escalonada no secuencie). No se desactivan las animaciones del drag (son interacciones directas, no decorativas).

---

## Migration map

Cada magic value en `style.css` actual → su reemplazo.

| Antes (literal) | Después (token) | Locación original |
|---|---|---|
| `width: 240px` (tabla) | `var(--ddd-table-w)` | `.ddd-table` (l.29) |
| `height: 20px` (col) | `var(--ddd-table-row-h)` | `.ddd-table__col` (l.91) |
| `padding: 0 10px` (col) | `0 var(--ddd-table-pad-x)` | `.ddd-table__col` (l.90) |
| `height: 28px` (header) | `var(--ddd-table-header-h)` | `.ddd-table__header` (l.53) |
| `font-size: 12px` | `var(--ddd-text-base)` | múltiples |
| `border-radius: 4px` | `var(--ddd-radius-md)` | múltiples |
| `border-radius: 3px` | `var(--ddd-radius-sm)` | múltiples |
| `box-shadow: 0 1px 3px …` | `var(--ddd-shadow-sm)` | `.ddd-table` (l.38) |
| `box-shadow: 0 3px 10px …` | `var(--ddd-shadow-md)` | `.ddd-tooltip` (l.149) |
| `box-shadow: 0 4px 14px …` | `var(--ddd-shadow-md)` | `.ddd-color-popup` (l.184) |
| `box-shadow: 0 12px 32px …` | `var(--ddd-shadow-lg)` | `.ddd-modal` (l.742) |
| `box-shadow: 0 1px 4px …` | `var(--ddd-shadow-sm)` | `.ddd-group-panel` (l.531) |
| `box-shadow: 0 2px 8px …` | `var(--ddd-shadow-md)` | `.ddd-context-menu` (l.324) |
| `rgba(255,255,255,0.04)` | `var(--ddd-surface-hover)` | hover varios |
| `rgba(255,255,255,0.06)` | `var(--ddd-surface-hover)` | hover varios |
| `color: #fff` | `var(--ddd-fg-on-accent)` | group label/node (l.686, 702) |
| `color: #ccc` | `var(--ddd-fg-muted)` | statusbar (l.371) |
| `rgba(0,0,0,0.3)` (chip border) | `var(--ddd-border-subtle)` | `.ddd-color-chip` (l.197) |
| `hsl(hash, 55%, 60%)` | `var(--ddd-bc-N-border)` | `colorForGroup` (groupPanel.tsx:221) |
| `hsla(..., alpha)` fill | `color-mix(in srgb, var(--ddd-bc-N-surface), transparent ALPHA)` | `groupContainer.tsx:53-58`, `tableNode.tsx:219-220` |

---

## Test plan

### Build / typecheck
- `pnpm typecheck` clean.
- `pnpm build` (extension + webview) sin warnings de CSS.

### Smoke manual (tema oscuro: Default Dark Modern, Monokai, Dracula)
1. Toggle de densidad `compact → cozy → comfortable` desde el panel de Settings; el ancho de tabla, alto de fila, padding y font-size se ajustan; `layout.json` no cambia.
2. Fixture `test/fixtures/huge.dbml` (500+ tablas) en densidad `compact` con zoom default: nombres y tipos legibles, sin overflow.
3. Tres TableGroups distintos → tres colores BC distintos asignados automáticamente; reload → mismos colores.
4. Color popup → seleccionar chip de paleta BC → header de tabla se actualiza sin flicker; reset → vuelve al color del group.
5. Estados visualmente distintos: hover de fila, selección de tabla (`outline` accent), columna PK (color accent), columna FK (sin fondo extra, alineación correcta), drag en curso (cursor grabbing global), context menu danger item (color danger).
6. DevTools → Rendering → `prefers-reduced-motion: reduce`: el modal aparece sin transición, los tooltips no hacen fade.
7. LOD: zoom-out hasta `lowThreshold` → tabla en modo `rect` muestra fill del BC surface; entre `low` y `medium` → modo `header` mantiene la franja superior con el border BC.
8. Color popup muestra los 12 chips BC + input hex custom.

### Visual baselines
Capturar antes/después en `docs/screenshots/` para README:
- `screenshot-overview.png` — diagrama de fixture pequeño con 3 grupos coloreados.
- `screenshot-density-compact.png` — fixture huge en `compact`.
- `screenshot-modal-settings.png` — modal de Settings con sección UI/Density.

### Spec sync
Este spec debe actualizarse en el mismo PR que cualquier cambio futuro a tokens, paleta BC, o densidad — siguiendo la regla del README.

---

## Capa de componentes — primitivos Preact

Antes existían **7 familias de clases de botón** (`.ddd-btn`/`--primary`, `.ddd-icon-btn`,
`.ddd-actions-btn`, `.ddd-hist-btn`, `.ddd-group-btn`, `.ddd-zoom__btn`,
`.ddd-edge-toolbar__btn`) y cada call site elegía a mano el string de clase + uniones ad-hoc
de estado (`${hidden ? 'is-off' : ''}`). Esto no permitía expresar una variante (p. ej.
`ghost`, sin borde) como prop reutilizable.

Solución: una capa de primitivos en `src/webview/ui/`, siguiendo el **patrón shadcn**
(config de variantes co-localizada en el componente, exportada como `buttonVariants`):

- `Button.tsx` — único primitivo de botón, basado en `JSX.IntrinsicElements['button']` (hereda
  todos los atributos nativos: `onClick`, `title`, `disabled`, `aria-*`; `type` por defecto
  `"button"`). La config de variantes vive **dentro del componente** vía `cva()`
  (class-variance-authority), exportada como `buttonVariants`. API: `variant` ×
  `size: sm | md | icon | tool` + props de toggle `active` / `off`. Las **7 variantes mapean 1:1 a las
  7 familias legacy**: `ghost`→`.ddd-icon-btn`, `secondary`→`.ddd-btn`,
  `primary`→`.ddd-btn--primary`, `action`→`.ddd-actions-btn`, `history`→`.ddd-hist-btn`,
  `zoom`→`.ddd-zoom__btn`, `toolbar`→`.ddd-edge-toolbar__btn`. `size="icon"` = cuadrado
  solo-ícono. Hay además una variante **nueva sin equivalente legacy**: `subtle` = botón
  solo-ícono **sin borde** (a diferencia de `ghost`, que muestra borde en hover; `subtle` solo
  cambia el fondo en hover). La usa el panel DiagramView (`groupPanel`). Son utilidades Tailwind
  de valor arbitrario sobre `--ddd-*` / `--vscode-*`. **Punto de reversión:** para volver a CSS
  plano se cambia cada string de variante por su clase `.ddd-*` legacy — la API de `<Button>` no
  cambia.
- **Estados de toggle sin conflicto:** `active`/`off` son variantes booleanas (= legacy
  `.is-on`/`.is-active`/`.is-off`). Para las variantes que togglean (`ghost`/`action`/`history`)
  los colores bg/text/border en reposo viven en `compoundVariants` keyed por `active` — así idle
  y active **nunca** fijan la misma propiedad a la vez. Esto evita overrides dependientes del
  orden (Tailwind no tiene control de especificidad) **sin** necesitar `tailwind-merge`.
- `cn.ts` — helper de clases (shadcn `cn`), aquí = solo `clsx` (sin `tailwind-merge`).
  **Decisión:** se evaluó `tailwind-merge` (lo usa shadcn para deduplicar utilidades en
  conflicto) pero añadía **~15.8 KB gzip** al bundle — desproporcionado (el CSS a mano son
  6.9 KB) y solo para deduplicar strings. Al autorear las variantes libres de conflicto, `clsx`
  basta. Deps añadidas: `class-variance-authority` + `clsx` (~3 KB raw); **no** `tailwind-merge`.

**Estado de migración:** los 6 call sites están migrados a `<Button>` (`groupPanel`,
`actionsPanel`, `zoomButtons`, `exportModal`, `settingsPanel`, `edgeLayer`). Se dejan como
markup nativo los controles que **no** son de la familia botón: `.ddd-group-chevron`,
`.ddd-group-panel__handle`, `.ddd-actions-panel__handle` (estructurales, uso único) y
`.ddd-radio-group__option` (es un radiogroup, no un botón). Las **7 familias `.ddd-*-btn`
legacy fueron retiradas** de `style.css` (confirmado el look por el owner) — incluida
`.ddd-group-btn`, que ya estaba huérfana. El trial Tailwind queda **adoptado**; revertir a
CSS plano ya no es un swap de strings sino un `git revert` de este cambio.

### Primitivos adicionales (Modal, formularios, búsqueda)

Más allá de `<Button>`, `ui/` añade primitivos para superficies con **duplicación
real** (≥2 call sites):

- **`Modal.tsx`** — `<dialog>` nativo. `open` dispara `showModal()`/`close()` vía
  ref+effect; gratis: trampa de foco, **Esc para cerrar**, top-layer (escapa
  z-index/overflow) y scrim `::backdrop` (reemplaza el div `.ddd-modal-overlay`).
  API: `<Modal open onClose title wide footer>`. Migrados: `exportModal`,
  `settingsPanel`.
- **`Field.tsx`** — familia de formulario: `Field` (wrapper label+hint+control) +
  `TextField` / `NumberField` / `SelectField` / `Checkbox`. Reemplaza los `Row*`
  (settingsPanel) y `FieldEditor` (exportModal) que cada archivo reimplementaba.
- **`RadioGroup.tsx`** — control segmentado (`.ddd-radio-group`), genérico
  `<T extends string>`. Migrado: densidad en settingsPanel.
- **`Search.tsx`** — input con ícono (`.ddd-search`). Migrado: groupPanel. Acepta
  `inputRef` opcional para enfocar el input imperativamente (lo usa el botón Search de la barra).
- **`Tooltip.tsx`** — tip ligero para botones solo-ícono (distinto del tooltip rico de
  canvas en `render/tooltip.tsx`). **Clona** su único hijo para inyectarle los handlers
  hover/focus + `aria-label`/`aria-describedby` (la metadata a11y cae en el `<button>` real y
  se elimina el `title` nativo → sin doble tooltip del SO). Se muestra en **hover y focus de
  teclado**, con delay de apertura (~400ms) y cierre instantáneo; se descarta con Escape.
  Portaleado a `<body>` (escapa `overflow`), posicionado desde el rect del trigger. API:
  `<Tooltip label shortcut? placement?>`. Migrado: barra de acciones, zoom, header de Diagram
  Views, edge toolbar. **Las filas densas (group/table rows) siguen con `title` nativo** — son
  listas, no menús; evita el coste de un wrapper por fila.

Se dejan nativos: los radios clásicos de *Scope* en exportModal (`.ddd-radio` con
contadores + disabled, uso único) y los controles estructurales ya citados.

### Estrategia de estilo (dos tiers, ambos leen `--ddd-*`)

- **Micro-componentes simples y stateful** (Button) → **utilidades Tailwind** vía
  `cva`; su CSS legacy se retira.
- **Primitivos estructurales/animados** (Modal, Field, RadioGroup, Search) →
  **envuelven las clases `.ddd-*` existentes** del `@layer` (vía `cn`). Su CSS
  (animaciones `@keyframes`, `::backdrop`, `focus-within`, anchos `min()/calc()`,
  layout) **se queda** — convertirlo a utilidades sería verboso, frágil y sin
  valor; `.ddd-field*` / `.ddd-radio*` / `.ddd-search*` / `.ddd-modal*` son la
  implementación de estos primitivos, no se retiran.

Regla: utilidades cuando son más limpias; envuelve la clase cuando el CSS es
pesado en layout/animación. En ambos casos el componente tipado es la API y
`--ddd-*` la fuente de verdad.

Contrato de rendimiento: los primitivos emiten clases **estáticas**; el estado visual por nodo
(selección/hover/LOD a 5000 tablas) sigue en `data-*` + variables CSS + una sola clase estática,
nunca alternando muchas clases por frame. La capa de culling/LOD y el presupuesto no se tocan.

## Integración Tailwind v4 — trial incremental

Adopción **experimental y reversible** (decisión del owner): se validó sobre `groupPanel.tsx`
primero (confirmado idéntico) y luego se migraron los 6 call sites. Si en algún momento no
convence, se revierte cambiando los strings de variante en `buttonVariants` (`Button.tsx`) por
las clases `.ddd-*` legacy — sin perder el componente `<Button>` ni tocar los call sites.

Setup (verificado, build OK):

- `@tailwindcss/vite` en `vite.config.mts` (el config se renombró de `.ts` a `.mts` porque el
  plugin es ESM-only y el proyecto es CommonJS).
- En `style.css`, **solo** se importan las capas `theme` + `utilities` (preflight **omitido** a
  propósito: pisaría `@layer reset`/`base` y la herencia de `--vscode-*`):
  ```css
  @layer theme, reset, tokens, base, surfaces, components, state, utilities;
  @import 'tailwindcss/theme.css' layer(theme);
  @import 'tailwindcss/utilities.css' layer(utilities);
  ```
- Las utilidades usan **valores arbitrarios** sobre los tokens existentes
  (`bg-[var(--ddd-surface-hover)]`, `text-[var(--ddd-fg)]`, `w-[24px]`…). No se registra un
  `@theme` de colores ni se reemplaza `--ddd-*`: Tailwind solo referencia la capa semántica.
- Inyección CSS: `main.tsx` hace `import styleSource from './style.css?inline'` e inyecta un
  `<style>`. **Verificado** que `@tailwindcss/vite` transforma ese import `?inline` (las
  utilidades y los marcadores `--tw-*` aparecen en `dist/webview/webview.js`). Por eso **no** se
  necesitó el fallback de emitir CSS como asset + `<link asWebviewUri>` (el CSP ya lo permitiría
  si hiciera falta). Costo de bundle observado: +13 KB sin minify (247 → 260 KB; gzip 57.9 KB).

## Botón de ícono canónico + barra de acciones flotante (UI polish)

Pase de pulido de UI ("componentes premium"): la barra de acciones se sentía **anclada** al
borde y mezclaba botones ícono / ícono+texto / solo-texto de ancho variable. Decisiones tomadas
con el owner (ver plan):

- **Geometría en `size`, color/estado en `variant`.** Las variantes solo-ícono (`history`,
  `zoom`, `toolbar`) **ya no traen ancho/alto**; la geometría vive en `size`. Se añade
  `size="tool"` = **un único cuadrado fijo (28×28, `--ddd-radius-sm`)** para todos los botones de
  barra/menú flotante (barra de acciones, zoom, header de Diagram Views, edge toolbar). Las filas
  densas conservan `size="icon"` (24×22). Regla: *un* botón de ícono para los menús, consistente.
  Como Tailwind no controla especificidad, separar geometría (size) de color (variant) mantiene
  las utilidades **libres de conflicto** sin `tailwind-merge`.
- **Barra de acciones flotante y colapsable** (`render/actionsPanel.tsx`, `.ddd-actions-bar`):
  despega del borde (`bottom: var(--ddd-space-4)`), con borde completo + `--ddd-shadow-md` +
  `--ddd-radius-md` en ambos estados (se elimina el look anclado `border-bottom:none`/sombra
  removida). Colapsada = un solo handle (chevron). Expandida = una fila de botones solo-ícono
  (Auto-arrange · Grid/snap · Search · Export · Settings) con entrada escalonada. Auto-arrange
  abre un **popover** reusando `ContextMenu` (`render/contextMenu.tsx`) con sus 3 ámbitos
  (all/new/selection).
- **Reubicaciones:** Undo/Redo → el cluster de **zoom** (la navegación de historial acompaña a la
  de viewport; `.ddd-zoom__divider` los separa). El filtro **PK/FK** → **Diagram Views** como
  *View options* (es una opción de vista). El botón Search de la barra abre y enfoca el buscador
  de Diagram Views (`openViewsAndFocusSearch` en el store).
- **Diferido:** "Seleccionar todas las relaciones" requiere un modelo de selección **multi-edge**
  (hoy solo existe `selectedEdgeId: string | null`); queda como comando futuro.

State conventions nuevas: `.ddd-actions-bar.is-collapsed` / `.is-expanded`.

## Preguntas abiertas (Open Questions)

5. ~~Pulido de UI: barra flotante + botones solo-ícono + tooltips~~ **RESUELTO** (este cambio):
   barra colapsable flotante, `size="tool"` canónico (geometría en size, color en variant),
   primitivo `Tooltip` reutilizable (hover + focus, a11y, reduced-motion), reubicación de
   undo/redo → zoom y PK/FK → Diagram Views, motion con tokens existentes. "Select all relations"
   diferido (necesita selección multi-edge).

1. ~~Validación visual + decisión continuar/revertir~~ **RESUELTO**: el owner confirmó el look,
   se migraron los 6 call sites, se adoptó el patrón shadcn (`cva` co-localizado) y se retiraron
   las 7 familias `.ddd-*-btn` legacy. Tailwind v4 queda adoptado para la capa de botones.
2. ~~¿`clsx` vs `cx()` local? ¿CVA?~~ **RESUELTO**: se adoptó el patrón shadcn → `cva` +
   `clsx` (config co-localizada en `Button.tsx`). Se **descartó `tailwind-merge`** por peso
   (~15.8 KB gzip) autorando las variantes libres de conflicto. Se eliminó el test de strings
   `variants.test.ts` (verificaba que el config se repite a sí mismo — bajo valor; lo cubren el
   typecheck de las uniones + el build + la verificación visual).
3. **¿Activar `minify` en el build del webview?** Hoy `minify: false` (260 KB). Es la mayor
   reducción de tamaño disponible y es ortogonal a esta decisión. *No bloqueante.*
4. **Light / High-Contrast**: sigue diferido. La auditoría de fallbacks `--vscode-*` (mapear
   `surface-hover/active/selected`, `--ddd-success`, `--ddd-fg-on-accent`) se hace de forma
   perezosa al tocar cada superficie; la paleta BC y las sombras permanecen literales.

## Roadmap (deferred)

- Light/HC themes: implica re-derivar `--ddd-shadow-*` con bordes en vez de drop shadows, y validar contraste de la paleta BC sobre fondos claros.
- Stereotype DDD opcionales: aggregate-root con `border-top-width: 4px`, value-object con `border-style: dashed`, declarados vía DBML notes.
- Tema "high-density print" para exportar la vista completa a PNG/SVG con tipografía y bordes optimizados para impresión.
