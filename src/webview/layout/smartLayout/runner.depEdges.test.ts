import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../vscode', () => ({ postToHost: vi.fn() }));
vi.mock('../../persistence', () => ({ schedulePersist: vi.fn() }));

import { store } from '../../state/store';
import { parseDbml } from '../../../extension/parser';
import { depKey } from '../../render/edgeKey';
import { resetSelectedEdges, runEdgeOrdering, runSmartLayout } from './runner';
import type { EdgeLayout } from '../../../shared/types';

// Deps are render + waypoints only (spec 18): arrange, A* ordering and "Reset relations" work on refs.
const DBML = `
  Table users { id int [pk] }
  Table orders { id int [pk]
    user_id int [ref: > users.id] }
  Table mart { id int [pk] }
  Dep: users -> orders
  Dep: orders.id -> mart.id
`;
const USERS_ORDERS = depKey('public.users', [], 'public.orders', []);
const ORDERS_MART = depKey('public.orders', ['id'], 'public.mart', ['id']);
const depShape: EdgeLayout = { waypoints: [{ x: 300, y: -200 }, { x: 700, y: -150 }], color: '#3b82f6' };

beforeEach(() => {
  const r = parseDbml(DBML);
  if (!r.schema) throw new Error(r.error.message);
  store.getState().setSchema(r.schema, null);
  store.getState().setLayout({
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    tables: { 'public.users': { x: 0, y: 0 }, 'public.orders': { x: 900, y: 700 }, 'public.mart': { x: 1800, y: 0 } },
    groups: {},
    edges: { [USERS_ORDERS]: depShape, [ORDERS_MART]: { waypoints: [{ x: 1400, y: 900 }] } },
  });
  store.setState({ selection: new Set(['public.users', 'public.orders', 'public.mart']), gitView: null, mergeConflicts: null, past: [], future: [] });
});

const depLayouts = () => {
  const out = new Map<string, EdgeLayout>();
  for (const [k, v] of store.getState().edgeLayouts) if (k.startsWith('dep:')) out.set(k, v);
  return out;
};

describe('runner — stranded dep waypoints (spec 18, decided 2026-10-01)', () => {
  it('arranging every table drops dep waypoints whose both endpoints moved, keeping color', async () => {
    await runSmartLayout('all', { orderEdges: false });
    expect(store.getState().positions.get('public.orders')).not.toEqual({ x: 900, y: 700 });
    expect(depLayouts()).toEqual(new Map([[USERS_ORDERS, { color: '#3b82f6' }]]));
  });

  it('restores the dropped dep waypoints and the positions with ONE undo', async () => {
    await runSmartLayout('all', { orderEdges: false });
    expect(store.getState().past).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().positions.get('public.orders')).toEqual({ x: 900, y: 700 });
    expect(depLayouts()).toEqual(new Map([[USERS_ORDERS, depShape], [ORDERS_MART, { waypoints: [{ x: 1400, y: 900 }] }]]));
  });

  it('keeps a dep whose other endpoint stayed put', async () => {
    store.setState({ selection: new Set(['public.users']) });
    await runSmartLayout('selection', { orderEdges: false });
    expect(depLayouts().get(ORDERS_MART)).toEqual({ waypoints: [{ x: 1400, y: 900 }] });
  });

  it('arrange + A* ordering never marks a dep key auto', async () => {
    await runSmartLayout('all', { orderEdges: true, preserveManualEdges: false });
    for (const [k, v] of store.getState().edgeLayouts) if (v.auto) expect(k.startsWith('dep:')).toBe(false);
  });

  it('"Order edges" moves no table, so deps keep their waypoints', async () => {
    const before = depLayouts();
    await runEdgeOrdering({ preserveManual: false });
    expect(depLayouts()).toEqual(before);
  });

  it('"Reset relations" also straightens the deps touching the selection', () => {
    store.setState({ selection: new Set(['public.mart']) });
    resetSelectedEdges();
    expect(depLayouts()).toEqual(new Map([[USERS_ORDERS, depShape]]));
  });
});
