# 15 — Menú de aplicación (esquina superior-izquierda)

## Propósito

Un único punto de entrada para acciones a nivel de **app/documento** —
Configuración, Exportación y (más adelante) **integración Git** (nuevos commits,
diff contra el commit anterior). Cerrado por defecto: un trigger ícono en la
esquina superior-izquierda que abre un popover al hacer click, estilo Excalidraw.

## Contexto / Problema

Hoy las acciones de app están dispersas: Settings y Export viven solo como botones
ícono en el `ActionsPanel` (inferior-centro) y Git no tiene hogar. La esquina
sup-izq está libre (solo la usa, condicionalmente, el banner de error de parseo);
la sup-der ya la ocupa el `GroupPanel` ("Diagram Views"). Separar **tiers de
navegación** —derecha = controles de *contenido* del canvas; sup-izq = acciones de
*app*— sigue la convención de Excalidraw/Figma/VS Code y reserva un hogar estable
para el futuro panel Git, que es una feature pesada y no cabe en el rail derecho.

Esta entrega **solo posicionó y andamió** el menú. La integración Git ya aterrizó
en [`16-git-integration.md`](16-git-integration.md): la fila *Git* abre el
`GitPanel` (commit, revertir, stash, explorar versiones, ver diff).

## Preguntas abiertas (Open Questions)

- [x] **¿Dónde va el menú?** — **Decisión:** esquina sup-izq, popover desplegable
  anclado al trigger (no sección del rail derecho, no drawer). El rail derecho
  queda solo para contenido del canvas. (Acordado con el owner, 2026-05-30.)
- [x] **¿Qué contiene ahora?** — **Decisión:** mínimo — *Settings*, *Export…* y
  *Git* deshabilitado. (Acordado con el owner, 2026-05-30.)
- [x] **¿Tipo de superficie?** — **Decisión:** popover (idiom de `contextMenu.tsx`),
  no modal ni drawer. (Acordado, 2026-05-30.)
- [ ] **Colisión banner ↔ trigger:** hoy el banner de error se desplaza a la
  derecha del trigger (offset `left` con tokens). Alternativa: mover el banner a
  sup-centro. Default actual: offset. *No bloqueante.*
- [ ] **Glifo del trigger:** `codicon-menu` (hamburguesa, default) vs un logo de
  app/DB. *No bloqueante.*
- [ ] **Navegación con flechas dentro del popover:** se entrega Esc + click; el
  roving focus ↑/↓ entre `menuitem` queda como follow-up. *No bloqueante.*
- [x] **Afordancia del slot Git:** fila con chevron derecho que abre el `GitPanel`
  (modal de dos paneles, no submenú anidado). **Resuelto** al aterrizar
  [`16-git-integration.md`](16-git-integration.md).

## Diseño

### Componente — `src/webview/render/appMenu.tsx`

Popover modelado sobre `render/contextMenu.tsx` **sin mutarlo** (ContextMenu se
ancla a coords de click, es label-only y lo comparte el scope-menu de ActionsPanel).

- **Trigger:** `<Button variant="toolbar" size="tool">` con `IconMenu`, envuelto en
  `<Tooltip label="Menu">` (el Tooltip clona el hijo e inyecta el `aria-label`, así
  el botón solo-ícono tiene nombre accesible). El botón lleva
  `aria-haspopup="menu"` + `aria-expanded`. La superficie del trigger (`.ddd-app-menu`)
  está siempre visible, anclada `position:absolute; top/left: var(--ddd-space-4);
  z-index:5`, con el look de chrome de `.ddd-zoom`.
- **Popover:** reusa el idiom de dismiss de ContextMenu — listeners de `mousedown`
  + `Escape` adjuntados con `setTimeout(0)` (para que el click de apertura no lo
  cierre), `createPortal(..., document.body)` para escapar `overflow`. Se ancla bajo
  el trigger vía `wrapRef.getBoundingClientRect()` (el primitivo `<Button>` no
  reenvía ref → se mide el `<div>` contenedor) y se clampa con `clampMenuAnchor()`.
  `role="menu"`; las filas son `<button role="menuitem">` con **ícono + label**. Al
  cerrar con Esc, devuelve foco al trigger.
- **Filas (mínimo):**
  - `IconSettings` "Settings" → cerrar menú + `setSettingsPanelOpen(true)`.
  - `IconExport` "Export…" → cerrar menú + `setExportPromptOpen(true)`.
  - separador.
  - `IconGit` "Git" → abre el `GitPanel` (`setGitPanelOpen(true)`) con chevron
    derecho como afordancia del panel (ver [`16-git-integration.md`](16-git-integration.md)).

Las filas **re-disparan los modales existentes** (`SettingsPanel`, `ExportModal`):
no se duplica su lógica, es un segundo trigger.

### Render / motion / CSS (`style.css`, `@layer components`)

- `.ddd-app-menu` (superficie del trigger), `.ddd-app-menu__popover` (z-index 30,
  `position:fixed`), `.ddd-app-menu__item` / `__label` / `__chevron` / `__separator`.
  **Solo tokens** `--ddd-*` (sin px/hex mágicos).
- Motion: `@keyframes ddd-menu-in` (fade + `translateY(-4px → 0)`) en
  `var(--ddd-duration-fast) var(--ddd-ease-out)`. Reduced-motion se respeta por la
  regla CSS global que pone las duraciones de animación a 0 (igual que ContextMenu
  y el modal).
- **Colisión banner:** `.ddd-banner` desplaza su `left` a
  `calc(var(--ddd-space-4) + var(--ddd-space-8) + var(--ddd-space-4))` para empezar a
  la derecha del trigger.

## Modelo de datos / tipos afectados

Solo store (sin cambios en `shared/types.ts` ni en el schema de layout):
- `AppState`: `appMenuOpen: boolean` (inicial `false`).
- `AppActions`: `setAppMenuOpen(open: boolean): void` → `set({ appMenuOpen: open })`.
Sigue el patrón de flags de visibilidad existentes (`settingsPanelOpen`,
`exportPromptOpen`, `viewsPanelOpen`).

## Puntos de extensión / integración

- Idiom de dismiss/portal + `clampMenuAnchor()` → `render/contextMenu.tsx`.
- Trigger → primitivo `<Button>` + `<Tooltip>`.
- Estado open/close → patrón de flag booleano del store.
- Modales destino ya existen → `SettingsPanel` / `ExportModal`.
- Íconos → `IconMenu` (`menu`) + `IconGit` (`source-control`) añadidos a `icons.tsx`.
- Montaje → `<AppMenu />` como hermano de `<GroupPanel />` en `app.tsx`, gated por
  `ready`.

## Anti-goals / fuera de alcance

- La integración Git real (commit/diff/branch) vive en su propia spec
  [`16-git-integration.md`](16-git-integration.md); aquí solo está el slot que la abre.
- Sin submenús anidados, sin command-palette, sin toggles inline (theme/density).
- No se toca el `GroupPanel`/rail derecho ni el `ActionsPanel` (Settings/Export
  siguen ahí: acceso multi-punto deliberado).

## Fallos conocidos / casos límite

- Si la ventana se redimensiona con el menú abierto, el popover no se reposiciona
  (igual que ContextMenu); se cierra al click fuera. Aceptado.
- El trigger (~`space-8` de ancho) y el banner coexisten solo cuando hay error de
  parseo; el offset del banner cubre ese caso. El popover (left alineado al trigger)
  abre por debajo del banner sin solaparse.

## Error handling

N/A — no hay I/O ni input de usuario; las filas solo togglean flags de store y
abren modales ya validados.

## Performance budget (si aplica)

Irrelevante para el render path de 5000 tablas: el menú es chrome estático, no
re-renderiza por frame, y el popover solo existe en el DOM mientras está abierto
(suscripción granular `useAppStore(s => s.appMenuOpen)`).

## Test plan

Andamiaje sin lógica testeable por unidad; verificación manual en el Extension
Development Host:
- Trigger sup-izq; click abre el popover anclado debajo.
- Click fuera y `Escape` cierran; Esc devuelve foco al trigger.
- *Settings* abre el modal de Settings; *Export…* abre el de Export; *Git* visible
  pero deshabilitada.
- Con error de parseo, el banner no solapa el trigger.
- `prefers-reduced-motion: reduce` → aparece sin el translate.
- Temas claro/oscuro de VS Code: trigger/popover legibles vía `--vscode-*`/`--ddd-*`;
  el trigger solo-ícono expone nombre accesible ("Menu").

Cuando aterrice la lógica Git, añadir tests Vitest a esa entrega (no a ésta).

## Documentos relacionados

- `specs/12-design-system.md` — primitivos (`Button`, `Tooltip`, `HoverCard`) y el
  idiom de menú/popover; `AppMenu` documentado como contraparte interactiva de
  `HoverCard`.
- `specs/10-settings.md` — Settings ahora con segundo trigger desde este menú.
- `specs/09-exporters.md` — el modal de Export que dispara la fila *Export…*.
