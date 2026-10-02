import { describe, expect, it, vi } from 'vitest';

vi.mock('../../vscode', () => ({ postToHost: vi.fn() }));
vi.mock('../../persistence', () => ({ schedulePersist: vi.fn() }));

import { store } from '../../state/store';
import { parseDbml } from '../../../extension/parser';
import { runSmartLayout } from './runner';

describe("runSmartLayout('selection') with nothing selected (spec 13, F89)", () => {
  it('moves nothing, records nothing and says why', async () => {
    const r = parseDbml('Table a { id int [pk] }\nTable b { id int [pk]\n  a_id int [ref: > a.id] }');
    if (!r.schema) throw new Error(r.error.message);
    store.getState().setSchema(r.schema, null);
    store.getState().setLayout({ version: 1, viewport: { x: 0, y: 0, zoom: 1 }, tables: { 'public.a': { x: 900, y: 900 }, 'public.b': { x: -900, y: 40 } }, groups: {}, edges: {} });
    store.getState().clearSelection();
    const positions = store.getState().positions;

    await runSmartLayout('selection', { orderEdges: false });

    expect(store.getState().positions).toBe(positions);
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().notice?.text).toBe('Select tables first');
  });
});
