import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../vscode', () => ({ postToHost: vi.fn() }));
vi.mock('../../persistence', () => ({ schedulePersist: vi.fn() }));

import { store } from '../../state/store';
import { parseDbml } from '../../../extension/parser';
import { runSmartLayout } from './runner';
import type { EdgeLayout } from '../../../shared/types';
import { rawLayoutRefs } from './edgeReset';

const DBML = `
  Table users { id int [pk] }
  Table orders { id int [pk]
    user_id int [ref: > users.id] }
  Table audit { id int [pk] }
`;
let KEY = '';
const autoShape: EdgeLayout = { waypoints: [{ x: 450, y: 900 }], sourceSide: 'top', targetSide: 'bottom', color: '#abc', auto: true };

beforeEach(() => {
  const r = parseDbml(DBML);
  if (!r.schema) throw new Error(r.error.message);
  store.getState().setSchema(r.schema, null);
  KEY = rawLayoutRefs(r.schema.refs)[0]!.id;
  store.setState({
    positions: new Map([['public.users', { x: 0, y: 0 }], ['public.orders', { x: 900, y: 700 }], ['public.audit', { x: 3000, y: 0 }]]),
    edgeLayouts: new Map([[KEY, autoShape]]),
    selection: new Set(['public.orders']),
    gitView: null,
    mergeConflicts: null,
    past: [],
    future: [],
  });
});

describe('runner — stale A* shapes (F20)', () => {
  it('an arrange that moves one endpoint of an auto edge discards its shape; undo restores it', async () => {
    await runSmartLayout('selection', { orderEdges: false });
    const s = store.getState();
    expect(s.positions.get('public.users')).toEqual({ x: 0, y: 0 });
    expect(s.positions.get('public.orders')).not.toEqual({ x: 900, y: 700 });
    expect(s.edgeLayouts.get(KEY)).toEqual({ color: '#abc' });
    store.getState().undo();
    expect(store.getState().edgeLayouts.get(KEY)).toEqual(autoShape);
  });
});
