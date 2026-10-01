import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../vscode', () => ({ postToHost: vi.fn() }));

import { postToHost } from '../vscode';
import { store } from '../state/store';
import { parseDbml } from '../../extension/parser';
import { resetLayout } from './resetLayout';
import type { Layout } from '../../shared/types';

const DBML = `
  Table users { id int [pk] }
  Table orders { id int [pk]
    user_id int [ref: > users.id] }
  Table audit { id int [pk] }
`;
const EDGE = 'public.orders::user_id|public.users::id';

function load(): void {
  const r = parseDbml(DBML);
  if (!r.schema) throw new Error(r.error.message);
  store.getState().exitGitView();
  store.getState().endMerge();
  store.getState().setSchema(r.schema, null);
  store.getState().setLayout({
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    tables: {
      'public.users': { x: 5000, y: 5000, color: '#ff0000' },
      'public.orders': { x: -3000, y: 70 },
      'public.audit': { x: 9000, y: 0, hidden: true },
      'public.gone': { x: 1, y: 2, color: '#00ff00' },
    },
    groups: {},
    edges: { [EDGE]: { waypoints: [{ x: 4000, y: 4000 }], sourceSide: 'top', targetSide: 'bottom', color: '#0000ff' } },
  });
  vi.mocked(postToHost).mockClear();
}

const lastPersist = (): Layout => {
  const call = vi.mocked(postToHost).mock.calls.filter(([m]) => m.type === 'layout:persist').at(-1);
  if (!call || call[0].type !== 'layout:persist') throw new Error('no layout:persist posted');
  return call[0].payload as Layout;
};

describe('Reset Layout (spec 03, F24)', () => {
  beforeEach(load);

  it('re-places every table and clears edge shapes, keeping colors and personal hidden flags', () => {
    resetLayout();
    const s = store.getState();
    expect(s.positions.get('public.users')).not.toEqual({ x: 5000, y: 5000 });
    expect(s.positions.get('public.orders')).not.toEqual({ x: -3000, y: 70 });
    expect(s.tableColors.get('public.users')).toBe('#ff0000');
    expect(s.hiddenTables.has('public.audit')).toBe(true);
    expect(s.edgeLayouts.get(EDGE)).toEqual({ color: '#0000ff' });

    const persisted = lastPersist();
    expect(persisted.tables['public.users']).toMatchObject({ color: '#ff0000' });
    expect(persisted.tables['public.audit']).toMatchObject({ hidden: true });
    // An orphan entry is Prune Orphans' job: its position and color stay.
    expect(persisted.tables['public.gone']).toEqual({ x: 1, y: 2, color: '#00ff00' });
    expect(persisted.edges).toEqual({ [EDGE]: { color: '#0000ff' } });
  });

  it('does nothing while the canvas is read-only', () => {
    store.getState().enterTimeTravel('abc', 'abc');
    const before = store.getState().positions;
    resetLayout();
    expect(store.getState().positions).toBe(before);
    expect(vi.mocked(postToHost)).not.toHaveBeenCalled();
  });
});
