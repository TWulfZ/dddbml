import { store, isCanvasReadOnly } from '../state/store';
import { screenToWorld, type Point } from '../render/viewport';
import { postToHost } from '../vscode';
import type { ColumnRef, RefOp } from '../../shared/types';

/**
 * FK drag (spec 19 §Crear FK): from a column's port to a column of any table, then a cardinality
 * pick posts `schema:addRef`. Separate from the table and edge gestures: it moves nothing, only
 * draws a draft line into the shared overlay SVG (`.ddd-fk-draft`) imperatively, per frame.
 */

let active = false;

export function isFkDragActive(): boolean {
  return active;
}

const ROW = '.ddd-table__col[data-col]';
const TARGET_CLASS = 'is-fk-target';
const BODY_CLASS = 'ddd-is-fk-dragging';

function rowAt(clientX: number, clientY: number): HTMLElement | null {
  return document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(ROW) ?? null;
}

/** The live column row under a client point; diff-ghost rows carry no `data-col`. */
export function columnAt(clientX: number, clientY: number): ColumnRef | null {
  const row = rowAt(clientX, clientY);
  const table = row?.closest<HTMLElement>('.ddd-table[data-id]')?.dataset.id;
  const column = row?.dataset.col;
  return table !== undefined && column !== undefined ? { table, column } : null;
}

export function startFkDrag(e: PointerEvent, from: ColumnRef, port: HTMLElement): void {
  if (active || e.button !== 0) return;
  const s = store.getState();
  if (isCanvasReadOnly(s)) return;
  // Pan tool: let the press bubble to the viewport, as a table press does.
  if (s.panMode || s.spacePan) return;
  active = true;
  e.stopPropagation();
  e.preventDefault();

  const vpRect = port.closest('.ddd-viewport')?.getBoundingClientRect();
  const toWorld = (clientX: number, clientY: number): Point =>
    screenToWorld({ x: clientX - (vpRect?.left ?? 0), y: clientY - (vpRect?.top ?? 0) });
  const portRect = port.getBoundingClientRect();
  const start = toWorld(portRect.left + portRect.width / 2, portRect.top + portRect.height / 2);
  const draft = document.querySelector<SVGPathElement>('.ddd-fk-draft');
  let last = { x: e.clientX, y: e.clientY };
  let target: HTMLElement | null = null;
  let frame: number | null = null;

  try { port.setPointerCapture(e.pointerId); } catch { /* noop */ }
  document.body.classList.add(BODY_CLASS);

  const draw = () => {
    frame = null;
    const end = toWorld(last.x, last.y);
    draft?.setAttribute('d', `M ${start.x} ${start.y} L ${end.x} ${end.y}`);
    const row = rowAt(last.x, last.y);
    if (row === target) return;
    target?.classList.remove(TARGET_CLASS);
    target = row;
    target?.classList.add(TARGET_CLASS);
  };
  const schedule = () => {
    if (frame === null) frame = requestAnimationFrame(draw);
  };
  const onMove = (ev: PointerEvent) => {
    last = { x: ev.clientX, y: ev.clientY };
    schedule();
  };
  // A wheel zoom mid-drag moves the pointer's world point without a pointermove.
  const unsubViewport = store.subscribe((n, p) => {
    if (n.viewport !== p.viewport) schedule();
  });

  const finish = () => {
    active = false;
    unsubViewport();
    if (frame !== null) cancelAnimationFrame(frame);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    draft?.setAttribute('d', '');
    target?.classList.remove(TARGET_CLASS);
    document.body.classList.remove(BODY_CLASS);
    try { port.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };
  const onUp = (ev: PointerEvent) => {
    finish();
    const to = columnAt(ev.clientX, ev.clientY);
    if (!to || (to.table === from.table && to.column === from.column)) return;
    // A merge or git peek may have locked the canvas mid-gesture.
    if (isCanvasReadOnly(store.getState())) return;
    store.getState().setRefDraft({ from, to, x: ev.clientX, y: ev.clientY });
  };
  const onCancel = () => finish();
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    finish();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey, true);
}

/** The cardinality pick: posts the pending FK and closes the prompt. */
export function commitRefDraft(op: RefOp): void {
  const s = store.getState();
  const draft = s.refDraft;
  s.setRefDraft(null);
  if (!draft || isCanvasReadOnly(s)) return;
  postToHost({ type: 'schema:addRef', payload: { from: draft.from, to: draft.to, op } });
}
