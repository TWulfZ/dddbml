import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../vscode', () => ({ postToHost: vi.fn() }));
vi.mock('../../persistence', () => ({ schedulePersist: vi.fn() }));

import { store } from '../../state/store';
import { parseDbml } from '../../../extension/parser';
import { runSmartLayout } from './runner';

const DBML = `
  Table users { id int [pk] }
  Table orders { id int [pk]
    user_id int [ref: > users.id] }
`;

function load(): void {
  const r = parseDbml(DBML);
  if (!r.schema) throw new Error(r.error.message);
  store.getState().setSchema(r.schema, null);
  store.getState().setLayout({
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    tables: { 'public.users': { x: 0, y: 0 }, 'public.orders': { x: 900, y: 700 } },
    groups: {},
    edges: {},
  });
  store.getState().clearHistory();
}

describe('runner — mode semantics', () => {
  beforeEach(load);

  it("'new' with every table already placed is a no-op: no command, edges untouched (audit F19)", async () => {
    const edgesBefore = store.getState().edgeLayouts;
    await runSmartLayout('new');
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().edgeLayouts).toBe(edgesBefore);
  });
});
