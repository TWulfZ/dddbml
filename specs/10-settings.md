# 10 — Settings

## Propósito

Exponer knobs configurables al usuario en vez de constantes hardcodeadas. Cubre comportamiento del viewport (zoom step, límites), thresholds de LOD, y defaults de exporters.

## Goals

1. Settings nativos de VSC vía `contributes.configuration` — aparecen en el Settings UI de VSC, sincronizables con Settings Sync.
2. Host lee con `vscode.workspace.getConfiguration('dddbml')`; cambios se propagan al webview vía `settings:loaded`.
3. Webview lee del store; cambios reactivos (LOD threshold cambia y el render lo respeta de inmediato).
4. Opcionalmente, un panel UI dentro del webview que escribe a la workspace config sin abrir el JSON de VSC.

## Non-goals

- Per-file settings (mismo `.dbml` no debería tener settings distintos según carpeta — workspace scope basta).
- Migración de versiones anteriores (no había settings antes; introducción limpia).

---

## Configuration keys (`package.json#contributes.configuration`)

| Key | Type | Default | Descripción |
|---|---|---|---|
| `dddbml.zoomStep` | number | `1.2` | Factor multiplicativo por click del botón zoom o `Ctrl++`. Wheel-zoom usa una curva separada. |
| `dddbml.zoomMin` | number | `0.08` | Zoom mínimo permitido. |
| `dddbml.zoomMax` | number | `4` | Zoom máximo permitido. |
| `dddbml.lod.mediumThreshold` | number | `0.6` | Por debajo de este zoom, tablas se renderizan en LOD `header` (solo nombre). |
| `dddbml.lod.lowThreshold` | number | `0.3` | Por debajo de este zoom, tablas se renderizan en LOD `rect` (sin texto). |
| `dddbml.ui.density` | enum | `"cozy"` | Densidad visual de tablas/filas. Choices: `compact`, `cozy`, `comfortable`. Ver spec 12. |
| `dddbml.ui.snapToGrid` | boolean | `false` | Modo imán: snappea posiciones de tabla y bends de edge al grid; muestra fondo punteado. |
| `dddbml.ui.gridSize` | number | `16` | Espaciado (unidades-mundo) del grid de snap cuando `ui.snapToGrid` está activo. Min 2, max 128. |
| `dddbml.export.defaultFormat` | string | `"typeorm"` | Formato pre-seleccionado en el modal de export. |
| `dddbml.export.typeorm.dialect` | enum | `"postgres"` | Dialect SQL para mapeo de tipos. Choices: `postgres`. |
| `dddbml.export.typeorm.singularize` | boolean | `true` | Singularizar nombres de clase (heurística inglesa). |
| `dddbml.export.typeorm.includeImports` | boolean | `true` | Emitir línea `import { Entity, ... } from 'typeorm'`. |
| `dddbml.export.typeorm.emitNullableExplicit` | boolean | `true` | Emitir `nullable: true/false` explícito en cada columna no-PK. |

Cada entrada en `package.json` debe incluir `description` para que aparezca en el Settings UI.

## In-memory shape (`AppSettings` en `src/shared/types.ts`)

Espejo plano-anidado de las keys de VSC, ya tipado:

```ts
export interface AppSettings {
  zoomStep: number;
  zoomMin: number;
  zoomMax: number;
  lod: { mediumThreshold: number; lowThreshold: number };
  ui: { density: UiDensity; snapToGrid: boolean; gridSize: number };
  export: {
    defaultFormat: string;
    typeorm: {
      dialect: string;
      singularize: boolean;
      includeImports: boolean;
      emitNullableExplicit: boolean;
    };
  };
}
```

`defaultSettings()` devuelve esta shape con los defaults declarados arriba. `loadSettings()` lee `vscode.workspace.getConfiguration('dddbml')` y reemplaza key por key (fallback a default si la entrada está mal tipada). `flattenSettings(s)` aplana la shape anidada al `FlatSettingsPatch` de claves punteadas que consume `settings:update` — lo usa el panel para restaurar defaults (todo, o un slice por sección).

## Propagation

1. **Boot**: `panel.hydrate()` → `post({ type: 'settings:loaded', payload: loadSettings() })`.
2. **Cambio externo (Settings UI / settings.json)**: `vscode.workspace.onDidChangeConfiguration('dddbml')` → `post({ type: 'settings:loaded', payload: loadSettings() })`.
3. **Cambio interno (Settings panel webview)**: webview envía `settings:update` con partial → host hace `vscode.workspace.getConfiguration('dddbml').update(key, value, ConfigurationTarget.Workspace)` para cada key del partial. El `onDidChangeConfiguration` re-pushea (no necesitamos write-back manual).

## Store integration

`src/webview/state/store.ts`:

```ts
interface AppState {
  // ...
  settings: AppSettings;
}
interface AppActions {
  // ...
  setSettings(s: AppSettings): void;
}
```

Default inicial = `defaultSettings()` para que el render funcione antes de que `settings:loaded` llegue.

## Lugares que dejan de hardcodear

| Archivo / símbolo | Antes | Después |
|---|---|---|
| `src/webview/render/viewport.ts:zoomAt`, `zoomAtCenter`, `fitToContent` | `0.08`, `4`, `1.2` | `store.getState().settings.{zoomMin,zoomMax,zoomStep}` |
| `src/webview/render/zoomButtons.tsx` | `1.2`, `0.08`, `4` | idem |
| `src/webview/render/lod.ts` | `0.3`, `0.6` | `store.getState().settings.lod.{lowThreshold,mediumThreshold}` |
| `src/webview/main.tsx:viewport:command` `zoomIn/Out` | `1.2` | settings.zoomStep |

`lodForZoom` cambia de función pura a función que recibe thresholds (o se lee del store inline en el componente — preferimos pasar como parámetro para no acoplar `lod.ts` al store).

## UI del Settings panel (implementado)

Botón gear en `ActionsPanel` → `setSettingsPanelOpen(true)`. Abre un `Modal` (`<dialog>`)
con layout **dos paneles** (`src/webview/render/settingsPanel.tsx`):

- **Rail de categorías** (izquierda, `role="tablist"` vertical) con icono + label:
  **Interface** (`layout`), **Viewport** (`zoom-in`), **Level of Detail** (`eye`),
  **Export** (`export`). El estado activo es `useState` local; cada item es un `<button
  role="tab">` (control estructural nativo, no una variante de `<Button>` — mismo criterio
  que `.ddd-radio-group__option`). Nuevas secciones = una entrada más en `CATEGORIES`.
- **Content panel** (derecha, `role="tabpanel"`) con header `[icono] Título … [info?] [reset
  sección]` y los campos de esa categoría (reusa `RadioGroup` / `NumberField` / `TextField`
  / `Checkbox` de `ui/Field`):
  - *Interface*: Density (RadioGroup), **Snap to grid** (Checkbox, `ui.snapToGrid`), **Grid
    size (px)** (NumberField, `ui.gridSize`, min 2 / max 128). Antes el grid size solo era
    editable por `settings.json`; el toggle imán ya vivía en la barra de acciones.
  - *Viewport*: Zoom step / min / max.
  - *Level of Detail*: Medium / Low threshold **+ icono info con `HoverCard`** que previsualiza
    los 3 modos de LOD (Full / Medium / Low) renderizando el **`TableNode` real** sobre una
    tabla dummy — ver spec 12 (`render/lodPreview.tsx`).
  - *Export*: defaultFormat, typeorm.{dialect, singularize, includeImports, emitNullableExplicit}.

- **Reset (por sección + global).** Cada header de sección tiene un botón reset (`discard`,
  `<Button variant="subtle" size="icon">`) que envía `settings:update` con `patchFor(CATEGORY_KEYS[cat])`
  — solo las claves de esa categoría, tomadas de `flattenSettings(defaultSettings())`. El
  footer del modal tiene **"Reset all to defaults"** (`<Button variant="secondary">`) que
  envía `flattenSettings(defaultSettings())` completo. `onDidChangeConfiguration` re-pushea
  `settings:loaded`, así que el render refleja el reset sin recargar.

## Test plan

- `test/unit/settings.test.ts`:
  - `defaultSettings()` devuelve la shape esperada.
  - `loadSettings()` con config mock leyendo overrides correctos.
  - `loadSettings()` con tipos inválidos → fallback a defaults sin tirar.

- Smoke manual:
  - Cambiar `dddbml.lod.mediumThreshold` a `0.9` en `settings.json`; el diagrama cambia a `header` LOD a 90% zoom inmediatamente.
  - Botón Reset en panel restaura defaults sin recargar.
