import { store } from './store';
import { schedulePersist } from '../persistence';
import { postToHost } from '../vscode';
import type { EditCommand } from './history';

/**
 * Undo/redo with their side effect (spec 11 §Contrato de persistencia): a layout command persists
 * the sidecar; a `.dbml` edit (spec 19) asks the host, which owns the text and its inverse.
 */
export function undoLatest(): void {
  const cmd = store.getState().past.at(-1);
  if (!cmd) return;
  store.getState().undo();
  if (store.getState().future.at(-1) !== cmd) return; // refused (read-only)
  sync(cmd, 'schema:undo');
}

export function redoLatest(): void {
  const cmd = store.getState().future.at(-1);
  if (!cmd) return;
  store.getState().redo();
  if (store.getState().past.at(-1) !== cmd) return;
  sync(cmd, 'schema:redo');
}

function sync(cmd: EditCommand, type: 'schema:undo' | 'schema:redo'): void {
  if (cmd.kind === 'schema') postToHost({ type, payload: { id: cmd.id } });
  else schedulePersist();
}
