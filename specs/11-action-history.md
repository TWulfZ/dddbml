# 11 — Action History (Undo / Redo)

## Propósito

Permitir `Ctrl+Z` / `Ctrl+Shift+Z` (también `Ctrl+Y`) sobre cambios de **posición de tabla** dentro del diagrama. Cubre tanto drag suelto como batch (marquee). Sin atajos antes de esta feature, un drag accidental quedaba persistido en el sidecar sin forma de revertir más allá de `git checkout` manual.

## Scope v1

**Incluye:**

- Drag de una tabla suelta (`MoveTable`).
- Drag batch vía marquee selection (`BatchMove`, mismo `MoveCommand` con múltiples entries).
- Edición de waypoints de arista (`WaypointCommand` con ops: `move`, `add`, `remove`, `clear`).
- Atajos teclado `Ctrl/Cmd+Z` (undo), `Ctrl+Shift+Z` y `Ctrl+Y` (redo).
- Dos botones en `actionsPanel` con estado disabled cuando los stacks están vacíos.

**Excluye explícitamente (v2+):**

- Undo de cambios en `groups` (collapse, hidden, color).
- Undo de `tableColors`, `hiddenTables`.
- Undo de viewport (pan, zoom). Convención: navegación no es edición.
- Undo de `Reset Layout` y `Prune Orphans` (operaciones masivas que requieren memento).
- Persistencia del historial entre sesiones (history vive en memoria del webview; reload o cierre = limpio).
- Coalescing temporal de drags consecutivos sobre la misma tabla/waypoint.
- Restaurar selection junto con posiciones.
- Auto-pan al undo de tabla off-viewport.

## Decisión arquitectónica

**Command Pattern + stack en memoria, dentro del store Zustand del webview.**

Alternativas descartadas:

| Opción | Razón de descarte |
|---|---|
| Git diffs sobre el sidecar | Granularidad mismatch (commit vs acción), latencia de `git` >> 16ms frame budget, no funciona en repos sin Git, conflicto con escritura atómica del sidecar (`spec 03`). |
| Memento (snapshot completo de `positions`) | Inverso de move es trivial; snapshot inflaría memoria 100x sin beneficio. Memento queda reservado para operaciones masivas (Reset Layout) en v2. |
| Undo dentro de VSC (registrar como text edit) | Webview no es text editor; `vscode.workspace.applyEdit` no aplica. Atajos Ctrl+Z se manejan localmente. |

## Modelo de datos

```ts
// src/webview/state/history.ts
interface MoveCommand {
  kind: 'move';
  from: Array<[QualifiedName, { x: number; y: number }]>;
  to:   Array<[QualifiedName, { x: number; y: number }]>;
  label: string;          // "Move public.users" | "Move 4 tables"
  timestamp: number;
}

interface WaypointCommand {
  kind: 'waypoint';
  refId: string;
  from: Waypoint[];       // snapshot pre-operación
  to:   Waypoint[];       // snapshot post-operación
  label: string;          // "Move waypoint" | "Add waypoint" | "Remove waypoint" | "Reset edge waypoints"
  timestamp: number;
}

type EditCommand = MoveCommand | WaypointCommand;
```

`from`/`to` son snapshots al momento de push — undo→edit→redo es determinista (redo aplica el target original, no el state actual).

Slice en el store:

```ts
past: EditCommand[];        // tail = más reciente
future: EditCommand[];      // tail = más recientemente deshecho
historyCapacity: number;    // = 200
```

Discriminator `kind` permite agregar nuevas variantes (próximos: `SetTableColor`, `ToggleHidden`) sin cambiar la API de push/undo/redo. `undo()`/`redo()` despachan por `cmd.kind` y aplican el slice correspondiente.

## Ciclo de vida

| Evento | Efecto sobre `past`/`future` |
|---|---|
| `pointerup` de drag con desplazamiento neto > 0 | Push `MoveCommand` a `past`; `future` limpio. Si `past.length > capacity`, FIFO drop del head. |
| `pointerup` de drag sin desplazamiento (click sostenido) | No-op. `buildMoveCommand` retorna `null`. |
| `pointerup` de waypoint drag con cambio neto en `waypoints[]` | Push `WaypointCommand` con `op = 'move'` (o `'remove'` si la operación colapsó a un vecino). |
| `pointerup` de click-en-segmento (agregar) | Push `WaypointCommand` con `op = 'add'`. |
| `dblclick` sobre círculo de waypoint | Remueve waypoint, push `WaypointCommand` con `op = 'remove'`. |
| Context menu "Reset edge waypoints" | Limpia el array, push `WaypointCommand` con `op = 'clear'` y `to: []`. |
| Llamada `undo()` con `past` no vacío | Pop tail. Switch por `cmd.kind`: `'move'` → restaura `positions`; `'waypoint'` → restaura `edgeLayouts[refId].waypoints`. Push cmd a `future`. Llamador dispara `schedulePersist()`. |
| Llamada `redo()` con `future` no vacío | Simétrico. |
| `undo()` / `redo()` con stack vacío | No-op silencioso. |
| `setLayout` (load inicial o `layout:external-change`) | `past = [], future = []`. |
| `setSchema` con set de nombres de tabla **distinto** al anterior | `past = [], future = []`. Previene undo a tabla que ya no existe. |
| `setSchema` con mismo set de tablas (solo columnas cambiaron) | History preservado. |

## Contrato de persistencia

`undo()` y `redo()` son **pure state transitions** dentro del store. El llamador (botones en `actionsPanel`, keyboard handler en `app.tsx`) dispara `schedulePersist()` desde `src/webview/persistence.ts` después de invocarlos.

Razón de separar: el store es data layer pure, sin acoplamiento a `postMessage`. `schedulePersist()` es side effect explícito. Esta separación evita el ciclo `store ↔ persistence` y mantiene undo/redo testables sin mock de `postToHost`.

Round-trip:

```
Usuario Ctrl+Z
  → app.tsx onKeyDown
  → store.undo()           (state update síncrono)
  → schedulePersist()       (debounce 300ms)
  → postToHost('layout:persist', { tables, … })
  → host onLayoutPersist    (merge + debounce 200ms)
  → fsync atómico al sidecar JSON
```

`vscode.workspace` watcher detecta cambio del sidecar → reenvía `layout:external-change` al webview → `setLayout` limpia history. **Esto es esperado**: undo emite escritura, escritura dispara watcher, watcher invalida history. El usuario percibe el undo aplicado; el reload del layout es transparente porque las posiciones ya coinciden con disco.

Edge case: si llega `layout:external-change` por edición externa real (git pull, otro editor), history se limpia. Documentado como comportamiento intencional.

## Surface UI

### Botones en `actionsPanel`

Dos botones nuevos al inicio del `__body` del panel:

- **Undo** — `IconUndo`, `disabled` cuando `past.length === 0`, tooltip `Undo (Ctrl+Z)`.
- **Redo** — `IconRedo`, `disabled` cuando `future.length === 0`, tooltip `Redo (Ctrl+Shift+Z)`.

Ambos invocan `store.undo()` / `store.redo()` seguido de `schedulePersist()`.

### Atajos teclado

Listener global en `window` desde `app.tsx:319` (extensión del handler de `Escape` existente):

| Combo | Acción |
|---|---|
| `Ctrl+Z` (Linux/Windows), `Cmd+Z` (Mac) | undo |
| `Ctrl+Shift+Z`, `Ctrl+Y` | redo |

Guard: ignora el evento si `e.target` es `INPUT`, `TEXTAREA`, o `contentEditable` (defensivo contra futuros inputs inline como rename).

El listener funciona aunque el panel esté colapsado (es global, no del DOM del panel).

## Edge cases

1. **No-op drag**: drag sin desplazamiento real (mismo from/to en todas las tablas) → `buildMoveCommand` retorna `null` → no se agrega entrada.
2. **Schema reload con tabla removida**: si una tabla en `past`/`future` ya no existe tras `setSchema`, el diff de table set dispara `clearHistory`. Sin esto, `undo` intentaría restaurar una posición de tabla que no se renderiza.
3. **Drag durante undo en curso**: `active = true` en `dragController` previene drags concurrentes; `undo()` es síncrono y no toca `active`. Un drag iniciado inmediatamente tras undo es seguro.
4. **Spam de Ctrl+Z**: cada undo schedule un persist debounced 300ms. Solo el último gana. Disco lag hasta 300ms tras último undo. Aceptable.
5. **Selection no se restaura**: undo solo mueve posiciones; `selection`/`tooltip` quedan como estaban. Documentado como intencional v1.
6. **Tabla hidden + undo**: undo aplica posición a `positions` Map independiente de `hiddenTables`. No requiere lógica especial.

## Performance budget

- **Build de MoveCommand**: iteración sobre `origins` (típicamente 1-50 tablas). O(n), <0.1ms.
- **Push a `past`**: clone array + slice si capacity excedido. O(capacity) = O(200) worst case, <1ms.
- **Undo de batch de 5000 tablas** (marquee select del schema completo): clone positions Map + apply N positions. Estimado <16ms (frame budget). Test stress en `huge.dbml`.
- **Memoria del stack a capacity 200**: ~80 bytes por single-table command, ~4KB por batch de 50 tablas. Total worst case <1MB. Trivial.

## Testing

### Unit (Vitest)

- `src/webview/state/history.test.ts` — `buildMoveCommand` (delta puro, delta cero, label single/batch, tabla ausente).
- `src/webview/state/store.history.test.ts` — push capacity FIFO, push limpia future, undo/redo apply, no-ops, `setLayout` reset, `setSchema` reset condicional.

### Manual

1. Drag tabla A → Ctrl+Z → posición vuelve → `git diff` del sidecar refleja restore.
2. Marquee select 3 tablas → drag batch → Ctrl+Z restaura las 3 en una sola acción.
3. Drag A, drag B, Ctrl+Z → solo B revierte.
4. Drag A, Ctrl+Z, drag C → botón Redo gris, future limpio.
5. Click sostenido sin mover → no se agrega entrada al history.
6. Editar `.dbml` externamente para eliminar tabla → botones grises.
7. Editar `.dbml` para solo cambiar columna → history preservado.
8. Spam 250 drags → solo últimos 200 undoables.
9. Cmd+Z (Mac), Ctrl+Z (Linux/Windows), Ctrl+Y y Ctrl+Shift+Z ambos redo.
10. Panel colapsado → atajos teclado siguen funcionando.

## Future iterations (v2+)

- **Más action types**: `SetGroupColor`, `SetTableColor`, `ToggleHidden`, `SetEdgeOffset`. Mismo stack, polimórfico vía `kind` discriminator.
- **Memento commands** para `ResetLayoutCommand` y `PruneOrphansCommand` (inverso caro = snapshot del map).
- **Coalescing temporal**: drags consecutivos sobre la misma tabla dentro de N ms se mergean en un solo command. Tipo Excalidraw.
- **Persistencia por archivo**: history en `vscode.Memento` (workspaceState) si feedback de usuarios lo justifica. Nunca en sidecar (rompe Git-friendly).
- **UI badge con contador**: `"12 undos available"` en el panel.
- **Auto-pan al undo**: si la tabla restaurada queda off-viewport, animar pan para centrarla.
- **Restaurar selection** junto con posiciones.
