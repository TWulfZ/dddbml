# 05 — Edge Routing

## Algoritmo (v1, M4)

Manhattan ortogonal con 2-elbow máximo. Pasos:

### 1. Elegir lados

Para cada ref, dado bbox source y bbox target:

```
dx = targetCenter.x - sourceCenter.x
dy = targetCenter.y - sourceCenter.y

if |dx| >= |dy|:   # horizontal dominant
  if dx >= 0: source→right, target→left
  else:       source→left,  target→right
else:              # vertical dominant
  if dy >= 0: source→bottom, target→top
  else:       source→top,    target→bottom
```

Esto garantiza que el edge "apunta hacia" el target desde el lado correcto, y viceversa.

### 2. Distribuir ports en cada lado

Múltiples edges compartiendo un lado de una tabla causarían solapamiento si todos usaran el centro. Solución:

- Agrupar edges por `(tableName, side)` (source y target independientes → un edge participa en dos grupos).
- Sortar cada grupo por el "otro extremo": para lado horizontal sortar por y del otro extremo; para lado vertical sortar por x. Esto reduce cruces.
- Asignar `ratio = (i + 1) / (n + 1)` para i=0..n-1 → ports equidistantes que nunca tocan las esquinas.

### 3. Computar path

Dado `a = portPoint(src, sourceSide, sourceRatio)` y `b = portPoint(tgt, targetSide, targetRatio)`:

| source H? | target H? | Path |
|---|---|---|
| Sí (left/right) | Sí | `M a H midX V b.y H b.x` (H→V→H, 2 elbows) |
| No (top/bottom) | No | `M a V midY H b.x V b.y` (V→H→V, 2 elbows) |
| Sí | No | `M a H b.x V b.y` (H→V, 1 elbow) |
| No | Sí | `M a V b.y H b.x` (V→H, 1 elbow) |

`midX = (a.x + b.x) / 2`, `midY = (a.y + b.y) / 2`.

### 4. Port ratio clamp

Clamp a `[0.05, 0.95]` para evitar que el port toque la esquina (artefactos visuales).

## Ruteo con waypoints

Cuando un edge tiene `EdgeLayout.waypoints = [w0, w1, …, wN-1]` (coords world-space), el router rutea por esos puntos en lugar del H-V-H simple. Algoritmo:

```
Input:
  a = source port (world)
  b = target port (world)
  W = [w0, w1, …, wN-1]

  P := [a]; cur := a; lastAxis := 'h'  // forced horizontal exit
  for w in W:
    if lastAxis == 'h':
      if w.x != cur.x: P.push({x:w.x, y:cur.y}); lastAxis := 'h'
      if w.y != cur.y: P.push({x:w.x, y:w.y});   lastAxis := 'v'
    else:
      if w.y != cur.y: P.push({x:cur.x, y:w.y}); lastAxis := 'v'
      if w.x != cur.x: P.push({x:w.x,  y:w.y});  lastAxis := 'h'
    cur := w

  // tramo final hacia b (debe entrar horizontal por la fila de columna)
  if lastAxis == 'h':
    midX = round((cur.x + b.x) / 2)
    P.push({x:midX, y:cur.y}); P.push({x:midX, y:b.y}); P.push({x:b.x, y:b.y})
  else:
    P.push({x:cur.x, y:b.y}); P.push({x:b.x, y:b.y})

  collapseColinear(P)
```

Garantías:

- Con `W = []`, la salida es pixel-idéntica al H-V-H original (back-compat total).
- Cada segmento es horizontal o vertical (alternancia estricta).
- Corners colineales (tres puntos sobre el mismo eje) se colapsan en un solo segmento — los waypoints sobreviven porque rompen el eje alternado.

### Insertar waypoint en una arista

UX (DBDiagram-style): hover sobre cualquier segmento muestra un círculo fantasma proyectado al pixel más cercano sobre ese segmento. Click + drag inserta el waypoint en el índice correcto (entre vecinos existentes según el segmento clickeado) y arrastra a la posición final en el mismo evento de puntero.

### Migración legacy `dx`/`dy`

El router prefiere `waypoints` sobre `dx`. Si `waypoints` está vacío y `dx` está presente, el midX original se desplaza por `dx` (comportamiento legado). El primer waypoint que el usuario agrega sobrescribe esta lógica y el siguiente persist suelta `dx`/`dy`.

## Limitaciones conocidas v1

1. **No evita tablas en el camino**. Si hay una tabla entre source y target, el edge la atraviesa. Algoritmo A* con obstacle avoidance llega en v2.
2. **Choice de lado binario**. Tabla a 45° exactamente elige horizontal por tie-breaker `>=`. Aceptable.
3. **Distribución de ports desconoce self-loops**. Refs de una tabla a sí misma (raro en DBML pero legal) producirían path degenerado. No crash pero visual feo. Fix en v1.1.
4. **Sin curvatura en elbows**. 90° rígidos. v1.1 puede añadir `stroke-linejoin: round` o corners redondeados.

## Caching y recomputación

`routeRefs()` se llama dentro del componente `EdgeLayer` en cada render. Como `EdgeLayer` recibe `refs` ya filtrados por visibilidad (del `app.tsx`), el trabajo por frame escala con edges visibles, no con total.

Optimización futura si se nota jank: memoizar routes por `(schema, positions)` con useMemo. En v1, recomputar en cada viewport change es aceptable para <500 visibles.

## Flechas / direccionalidad

v1 no dibuja flechas. El orden `source→target` en el path es suficiente semánticamente; visualmente todos los edges se ven iguales. Agregar marcadores `<marker>` SVG en v1.1 para distinguir `1:*` vs `*:*` etc.

## Test plan

`test/unit/edgeRouter.test.ts`:
- Dos tablas en misma fila, target a la derecha → source=right, target=left, path H-V-H.
- Dos tablas en misma columna, target abajo → source=bottom, target=top, path V-H-V.
- Target arriba-derecha → horizontal gana (45° tiebreak).
- 3 edges al mismo lado derecho de una tabla → ratios 0.25, 0.5, 0.75.
- Edge con bbox faltante → omitido del output (no crash).
