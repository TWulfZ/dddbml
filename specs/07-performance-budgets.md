# 07 — Performance Budgets

## Objetivo maestro

DBML de 5000 tablas abierto en una laptop decente (Chromium webview, sin WebGL), navegación fluida a 60fps sostenidos durante pan/zoom, sin frames individuales por debajo de 30fps.

## Fixtures

| Fixture | Tablas | Refs | Uso |
|---|---|---|---|
| `test/fixtures/small.dbml` (+ sidecar) | 30 | — | Smoke test; `node scripts/gen-fixtures.mjs small` |
| `test/fixtures/isga.generated.dbml` (+ sidecar) | ~real | ~real | Esquema real de tamaño medio; regresión día a día |
| `test/fixtures/huge.dbml` | 5000 | 1000 | Stress test (20 grupos, 8 col/tabla); `node scripts/gen-fixtures.mjs huge` |

> `tiny.dbml` / `medium.dbml` / `gen-huge-fixture.mjs` ya no existen; el generador único es
> `scripts/gen-fixtures.mjs` (`small` | `huge` | `merge <n>`).

## Budgets numéricos (medir en M3 y regresar en M5, M6, M7)

| Métrica | Budget | Cómo medir |
|---|---|---|
| Parse DBML 5000 tablas | < 2000ms | `performance.now()` alrededor de `Parser.parse()` en host |
| Auto-layout dagre 5000 tablas | < 3000ms | `performance.now()` alrededor de `autoLayout()` |
| Postmessage payload 5000 tablas | < 10MB | `JSON.stringify(schema).length` |
| Webview idle memory | < 200MB | Task Manager de VSC |
| FPS pan continuo 10s | >= 55 avg, >= 30 p99 | DevTools Performance tab + `requestAnimationFrame` timing |
| FPS zoom continuo | >= 55 avg | idem |
| Drag single table | < 16.7ms por frame (60fps) | DevTools Performance, M5 |
| Write layout file | < 50ms | `performance.now()` alrededor del fs.write |

## Cómo medir FPS en webview

`Developer: Open Webview Developer Tools` → Performance tab → Record → pan continuo 10s → Stop → ver "Frames" track.

Alternativa programática (agregar en debug build):

```ts
let frames = 0;
let lastTick = performance.now();
function tick() {
  frames++;
  const now = performance.now();
  if (now - lastTick >= 1000) {
    console.log('fps', frames);
    frames = 0;
    lastTick = now;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
```

## Bundle size budget

| Artefacto | Budget | Actual |
|---|---|---|
| `dist/webview/webview.js` (gzipped) | < 40kb (objetivo histórico) | ~29kb post-M2 · ~88kb (dagre) · **~95kb** (+ router A* edge-ordering, spec 05 §9) |
| `dist/webview/webview.js` (uncompressed) | < 200kb (objetivo histórico) | ~106kb post-M2 · ~441kb |
| `dist/extension/**` (uncompressed) | < 50kb | tbd |

> **ELK eliminado — motor de layout = dagre dos niveles (v0.3.x, 2026-05-31).** El smart
> auto-layout usaba `elkjs` (compound) como motor de geometría. `elkjs` pesaba ~468kb gz (~71%
> del webview). Se **eliminó** y se reemplazó por un motor **dagre de dos niveles** (dagre interno
> por clúster + dagre externo sobre los clústeres como meta-nodos; ver `specs/13`). `dagre` ya
> estaba en el bundle (fallback `autoLayout()`), así que el nuevo motor **no agrega bytes**. El
> cerebro de BD (classify/cluster/radial/columnAlign/collisionGuard) es agnóstico del motor y se
> conservó intacto. Motivo: ELK sólo daba ~10% más de compacidad sobre dagre dos-niveles en
> esquemas agrupados (verificado por el usuario) — no justifica 468kb. La densidad vs ELK es un
> factor constante en las separaciones, ahora **configurable por el usuario** (`spacing`, ver
> `specs/13` y `specs/10`). Esto revierte la "excepción consciente de bundle (ELK)" anterior.
> *(Intentos intermedios descartados en la misma sesión: lazy-load de ELK como asset aparte —
> innecesario una vez que el motor se reemplaza.)*

Librerías pesadas (cuidado):
- `@dbml/core` corre sólo en host → no afecta webview.
- `@dagrejs/dagre` corre en webview (fallback `autoLayout()`) → ~30kb gzipped, bundleado (se usa siempre).
- `elkjs` corre en webview (smart auto-layout) → ~468kb gzipped, **lazy asset aparte** (arriba), fuera del parse inicial. Layout medido en huge.dbml ~2.57s < 3s. Si se nota jank, mover a Web Worker (v1.1, `elkjs` worker build + `worker-src` en CSP).

## Regresiones conocidas a vigilar

- **Re-render en cada pan frame**: síntoma = FPS cae a <30 durante pan y, en esquemas grandes, el chrome flotante desaparece/se parte (ocurrió en 2026-09). Check: `App` **no** debe seleccionar `s.viewport` (sólo `lodForZoom(...)`); el transform de `.ddd-world` se aplica imperativo; `useVisibleNames` devuelve la misma instancia si la membresía no cambió; ningún selector devuelve objeto nuevo (`preact/devtools` Profiler para confirmar). Ver spec 04 "Cámara fuera de Preact".
- **Spatial index rebuild en pan**: `useEffect` deps incluye `viewport` por error. Check: effect de `idx.clear()` debe depender sólo de `schema` y `positions`, nunca viewport.
- **Edge overlay sin culling**: si se dibujan 1000 paths SVG innecesarios, perf cae. Check: refs visibles (`visibleRefIds`) en statusbar con diagrama grande.
- **Routing de aristas en el render path**: síntoma = FPS cae al panear con muchas relaciones. Check: `routeRefs` debe estar memoizado por geometría (`useMemo`), nunca llamado en el cuerpo del render; pan/zoom y hover/selección no deben invalidar el memo (ver spec 05 §8).
- **Overlay de aristas con hit-DOM por segmento**: si cada arista visible monta `<line>` hit por segmento, el conteo de nodos explota. Check: sólo la arista **seleccionada** monta handles por-segmento; el resto, un único `path.ddd-edge-hit`.
- **Dagre call en render path**: auto-layout sólo en effect post-schema-change, nunca en render puro.
- **Un layer GPU por tabla**: síntoma = zoom lento con muchas tablas visibles y chrome que desaparece/se parte. Check: DevTools → Layers debe mostrar **un** layer para `.ddd-world` (más el nodo en drag), no uno por tabla; `grep translate3d src/webview` debe devolver 0. Ver spec 04 "Capas compositadas".

## Notas de ingeniería

- Las transformaciones CSS de world container (`translate + scale`) se componen en GPU y no re-layout los hijos.
- Texto dentro de tablas cambia calidad al cambiar zoom — esto es esperado por el resample de Chrome. A zoom < 0.3 el texto es ilegible y por eso LOD='rect' no lo renderiza.
- ResizeObserver del viewport puede disparar con throughput alto; debounce si se ve problema (no observado aún).
