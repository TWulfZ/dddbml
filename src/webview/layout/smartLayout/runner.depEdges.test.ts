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

describe('runner — dep: edge layouts are never touched (spec 18)', () => {
  const before = () => new Map([[USERS_ORDERS, depShape], [ORDERS_MART, { waypoints: [{ x: 1400, y: 900 }] }]]);

  it('arranging every table keeps dep waypoints, even with both endpoints moved', async () => {
    await runSmartLayout('all', { orderEdges: false });
    expect(store.getState().positions.get('public.orders')).not.toEqual({ x: 900, y: 700 });
    expect(depLayouts()).toEqual(before());
  });

  it('arrange + A* ordering writes ref keys only', async () => {
    await runSmartLayout('all', { orderEdges: true, preserveManualEdges: false });
    expect(depLayouts()).toEqual(before());
    for (const [k, v] of store.getState().edgeLayouts) if (v.auto) expect(k.startsWith('dep:')).toBe(false);
  });

  it('"Order edges" leaves deps alone', async () => {
    await runEdgeOrdering({ preserveManual: false });
    expect([...store.getState().edgeLayouts.keys()].some((k) => !k.startsWith('dep:'))).toBe(true);
    expect(depLayouts()).toEqual(before());
  });

  it('"Reset relations" over the dep endpoints keeps their waypoints', () => {
    const ref = [...store.getState().edgeLayouts.keys()].length;
    resetSelectedEdges();
    expect(store.getState().edgeLayouts.size).toBe(ref);
    expect(depLayouts()).toEqual(before());
  });
});
