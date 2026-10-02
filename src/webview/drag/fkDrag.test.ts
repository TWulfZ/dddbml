import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../vscode', () => ({ postToHost: vi.fn() }));

import { postToHost } from '../vscode';
import { store } from '../state/store';
import { commitRefDraft, isFkDragActive, startFkDrag } from './fkDrag';
import { isGestureActive } from './dragController';

// Node test env: just enough DOM for the gesture — window listeners, a body class list, a draft
// path, and `elementFromPoint` resolving to a column row of a table node.
type Listener = (ev: Event) => void;
const listeners = new Map<string, Listener>();
vi.stubGlobal('window', {
  addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
  removeEventListener: (type: string) => listeners.delete(type),
});
const draftAttrs = new Map<string, string>();
let underPointer: { table: string; column: string } | null = null;
vi.stubGlobal('document', {
  body: { classList: { add: () => undefined, remove: () => undefined } },
  querySelector: () => ({ setAttribute: (k: string, v: string) => draftAttrs.set(k, v) }),
  elementFromPoint: () => {
    if (!underPointer) return null;
    const { table, column } = underPointer;
    const tableEl = { dataset: { id: table } };
    const row = { dataset: { col: column }, classList: { add: () => undefined, remove: () => undefined }, closest: () => tableEl };
    return { closest: () => row };
  },
});
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
vi.stubGlobal('cancelAnimationFrame', () => undefined);

const port = {
  closest: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
  getBoundingClientRect: () => ({ left: 100, top: 40, width: 8, height: 8 }),
  setPointerCapture: () => undefined,
  releasePointerCapture: () => undefined,
} as unknown as HTMLElement;

const press = (): PointerEvent => ({ button: 0, clientX: 104, clientY: 44, pointerId: 1, stopPropagation: () => undefined, preventDefault: () => undefined }) as unknown as PointerEvent;
const at = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 1 }) as unknown as Event;
const FROM = { table: 'public.orders', column: 'user_id' };

beforeEach(() => {
  listeners.clear();
  draftAttrs.clear();
  underPointer = null;
  store.getState().exitGitView();
  store.getState().endMerge();
  store.getState().setRefDraft(null);
  store.getState().setViewport({ x: 0, y: 0, zoom: 1 });
  vi.mocked(postToHost).mockClear();
});

describe('FK drag (spec 19 §Crear FK)', () => {
  it('drops on another column, then the cardinality pick posts schema:addRef', () => {
    startFkDrag(press(), FROM, port);
    expect(isGestureActive()).toBe(true);
    underPointer = { table: 'public.users', column: 'id' };
    listeners.get('pointermove')!(at(400, 300));
    expect(draftAttrs.get('d')).toBe('M 104 44 L 400 300');
    listeners.get('pointerup')!(at(400, 300));
    expect(isFkDragActive()).toBe(false);
    expect(draftAttrs.get('d')).toBe('');
    expect(store.getState().refDraft).toEqual({ from: FROM, to: { table: 'public.users', column: 'id' }, x: 400, y: 300 });

    const notice = store.getState().notice;
    commitRefDraft('>');
    expect(postToHost).toHaveBeenCalledWith({ type: 'schema:addRef', payload: { from: FROM, to: { table: 'public.users', column: 'id' }, op: '>' } });
    expect(store.getState().refDraft).toBeNull();
    expect(store.getState().notice).toBe(notice);
  });

  it('allows a self reference to another column of the same table without a notice (drawn as a loop)', () => {
    startFkDrag(press(), FROM, port);
    underPointer = { table: 'public.orders', column: 'id' };
    listeners.get('pointerup')!(at(10, 10));
    expect(store.getState().refDraft?.to).toEqual({ table: 'public.orders', column: 'id' });
    const notice = store.getState().notice;
    commitRefDraft('>');
    expect(postToHost).toHaveBeenCalledWith({ type: 'schema:addRef', payload: { from: FROM, to: { table: 'public.orders', column: 'id' }, op: '>' } });
    expect(store.getState().notice).toBe(notice);
  });

  it('drops on its own column or on empty canvas do nothing', () => {
    startFkDrag(press(), FROM, port);
    underPointer = FROM;
    listeners.get('pointerup')!(at(10, 10));
    startFkDrag(press(), FROM, port);
    underPointer = null;
    listeners.get('pointerup')!(at(10, 10));
    expect(store.getState().refDraft).toBeNull();
  });

  it('Escape cancels the drag', () => {
    startFkDrag(press(), FROM, port);
    listeners.get('keydown')!({ key: 'Escape', preventDefault: () => undefined } as unknown as Event);
    expect(isFkDragActive()).toBe(false);
    expect(listeners.has('pointerup')).toBe(false);
  });

  it('does not start on a read-only canvas, and a pick made read-only posts nothing', () => {
    store.getState().enterTimeTravel('abc', 'v0');
    startFkDrag(press(), FROM, port);
    expect(isFkDragActive()).toBe(false);

    store.getState().exitGitView();
    store.getState().setRefDraft({ from: FROM, to: { table: 'public.users', column: 'id' }, x: 0, y: 0 });
    store.getState().beginMerge([]);
    commitRefDraft('-');
    expect(postToHost).not.toHaveBeenCalled();
  });
});
