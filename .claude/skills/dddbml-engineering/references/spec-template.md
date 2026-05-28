# Spec template

Use this in step 2 when a change adds a feature or alters a pipeline's
design/behavior. Specs are written in **Spanish** to match the existing 13
(`specs/00-overview.md` … `12-*.md`).

The existing specs are **inconsistent in structure and partly stale** — this
template is the *target* shape to converge toward, not a description of what's
already there. When you edit an old spec, upgrade it to this structure (at
minimum add the **Preguntas abiertas** section) rather than copy its old layout.

How to use it:
- Name the file `NN-kebab-title.md` with the next free number (existing run
  `00`–`12`, so a new top-level spec is `13-…`). For an edit, update the
  existing numbered file in place.
- Match the depth of a sibling spec — look at `specs/09-exporters.md` (large
  feature) or `specs/05-edge-routing.md` (algorithm) for tone and detail.
- **`Preguntas abiertas` is mandatory and comes before `Diseño`.** It is where
  you align the real intent with the user instead of shipping a generic guess.
  Resolve blocking questions with the user *before* the design is final; record
  each decision inline. Drop other sections that don't apply, but keep the order.
- Code blocks, type snippets, and small tables are encouraged (the existing
  specs use them heavily).
- Cross-link related specs at the bottom, like `00-overview.md` does.

Copy the skeleton below (it is in Spanish on purpose):

```markdown
# NN — <Título>

## Propósito

<Qué resuelve este cambio, en 1–2 frases. El "qué" y el "para quién".>

## Contexto / Problema

<Estado actual, la limitación que motiva el cambio, y por qué ahora.>

## Preguntas abiertas (Open Questions)

<Toda ambigüedad o decisión que dependa del usuario, como lista de checkboxes.
El objetivo es alinear la idea ANTES de diseñar, no rellenar huecos con un
default genérico. Sé concreto: cada pregunta dice qué falta decidir y por qué
importa (qué cambia el diseño según la respuesta).>

- [ ] <Pregunta 1 — qué decidir y por qué importa.>
- [ ] <Pregunta 2.>
- [x] <Pregunta resuelta — **Decisión:** … (acordado con <quién>, <fecha>).>

> Una spec con preguntas abiertas **bloqueantes** sin resolver NO está lista
> para implementar. Llévalas al usuario, registra la decisión aquí, y recién
> entonces cierra el `Diseño`.

## Diseño

<La solución. Algoritmo, estructura de datos, flujo. Usa subsecciones ###
(p. ej. "### Cálculo", "### Render") y bloques de código cuando aclaren.>

## Modelo de datos / tipos afectados

<Cambios a `src/shared/types.ts`, al store, o al schema del layout. Tipos
nuevos. Si nada cambia, indícalo explícitamente.>

## Puntos de extensión / integración

<Qué seam existente se usa: `registerExporter`, `EditCommand`, el store,
`Dialect`, etc. Lista los archivos que se tocan.>

## Protocolo host↔webview (si aplica)

<Mensajes nuevos o modificados en `HostToWebview` / `WebviewToHost`.>

## Anti-goals / fuera de alcance

<Lo que esta versión NO hace, para acotar expectativas.>

## Fallos conocidos / casos límite

<Degeneraciones aceptadas, edge cases, deuda asumida.>

## Error handling

<Qué ocurre ante input inválido, datos faltantes, o fallo de una dependencia.>

## Performance budget (si aplica)

<Targets relevantes de `specs/07-performance-budgets.md` y cómo este cambio los
respeta.>

## Test plan

<Qué tests Vitest cubren esto (archivos `*.test.ts` colocados), qué fixtures se
usan, y cómo verificarlo a mano en el Extension Development Host.>

## Documentos relacionados

<Enlaces a otros specs relevantes.>
```
