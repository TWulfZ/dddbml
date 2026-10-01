import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../vscode', () => ({ postToHost: vi.fn() }));
vi.mock('../../persistence', () => ({ schedulePersist: vi.fn() }));

import { store } from '../../state/store';
import { parseDbml } from '../../../extension/parser';
import { edgeKeyedRefs } from '../../render/edgeKey';
import { countResettableSelectionEdges, resetSelectedEdges, runEdgeOrdering } from './runner';

const DBML = `
  Table users { id int [pk] }
  Table orders { id int [pk]
    user_id int [ref: > users.id] }
  Table items { id int [pk]
    order_id int [ref: > orders.id] }
`;

function load() {
  const r = parseDbml(DBML);
  if (!r.schema) throw new Error(r.error.message);
  store.getState().setSchema(r.schema, null);
  store.getState().setLayout({
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    tables: {
      'public.users': { x: 0, y: 0 },
      'public.orders': { x: 600, y: 300 },
      'public.items': { x: 1200, y: 0 },
    },
    groups: {},
    edges: {},
  });
  return r.schema;
}

const renderedKeys = (schema: ReturnType<typeof load>) =>
  new Set(edgeKeyedRefs(schema.refs, (t) => t).refs.map((r) => r.id));

describe('runner — edge layouts keyed like the renderer (audit F07)', () => {
  beforeEach(() => store.getState().clearHistory());

  it('Order edges writes only keys the edge layer looks up', async () => {
    const schema = load();
    await runEdgeOrdering({ preserveManual: false });
    const keys = [...store.getState().edgeLayouts.keys()];
    expect(keys.length).toBe(2);
    for (const k of keys) expect(renderedKeys(schema).has(k)).toBe(true);
  });

  it('Reset relations sees manual shapes stored under rendered keys', () => {
    const schema = load();
    const [key] = renderedKeys(schema);
    store.getState().applyEdgeLayouts([[key!, { waypoints: [{ x: 10, y: 10 }] }]]);
    store.getState().setSelection(new Set(['public.users', 'public.orders', 'public.items']));
    expect(countResettableSelectionEdges()).toBe(1);
    resetSelectedEdges();
    expect(store.getState().edgeLayouts.has(key!)).toBe(false);
  });

  it('setLayout drops entries persisted under parser Ref.id by earlier versions', () => {
    load();
    store.getState().setLayout({
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      tables: {},
      groups: {},
      edges: {
        'public.orders(user_id)->public.users(id)': { sourceSide: 'top', targetSide: 'bottom' },
        'public.orders::user_id|public.users::id': { color: '#abc' },
      },
    });
    expect([...store.getState().edgeLayouts.keys()]).toEqual(['public.orders::user_id|public.users::id']);
  });
});
