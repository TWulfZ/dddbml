import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../vscode', () => ({ postToHost: vi.fn() }));

import { store } from '../state/store';
import { handleHostMessage } from '../hostMessages';
import { parseDbml } from '../../extension/parser';
import { resolveFocusTarget } from './focusTable';
import { screenToWorld } from './viewport';

const W = 1000;
const H = 600;
// Reduced motion: the camera jumps, so the test reads the final viewport synchronously.
vi.stubGlobal('matchMedia', () => ({ matches: true }));
vi.stubGlobal('document', { querySelector: () => ({ getBoundingClientRect: () => ({ width: W, height: H }) }) });

const DBML = `
  Table a { id int }
  Table b { id int }
  Table c { id int }
  Table d { id int }
  TableGroup g1 {
    b
  }
  TableGroup g2 {
    c
    d
  }
`;

beforeEach(() => {
  const r = parseDbml(DBML);
  if (!r.schema) throw new Error(r.error.message);
  store.getState().exitGitView();
  store.getState().endMerge();
  store.getState().setSchema(r.schema, null);
  store.getState().setLayout({
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    tables: { 'public.a': { x: 3000, y: 2000 }, 'public.b': { x: 0, y: 0, hidden: true }, 'public.c': { x: 500, y: 0 }, 'public.d': { x: 900, y: 0 } },
    groups: {},
  });
  store.getState().clearSelection();
});

describe('diagram:focusTable (spec 19 §Navegación)', () => {
  it('centres a visible table at reading zoom and selects it', () => {
    handleHostMessage({ type: 'diagram:focusTable', payload: { table: 'public.a' } });
    const s = store.getState();
    expect(s.viewport.zoom).toBe(1);
    const centre = screenToWorld({ x: W / 2, y: H / 2 });
    expect(centre.x).toBeGreaterThan(3000);
    expect(centre.y).toBeGreaterThan(2000);
    expect([...s.selection]).toEqual(['public.a']);
  });

  it('frames the collapsed group of a member and selects nothing', () => {
    store.getState().setGroup('g2', { collapsed: true });
    expect(resolveFocusTarget(store.getState(), 'public.c').kind).toBe('group');
    handleHostMessage({ type: 'diagram:focusTable', payload: { table: 'public.c' } });
    expect(store.getState().selection.size).toBe(0);
  });

  it('a hidden table only explains itself when its group shows no box', () => {
    const before = store.getState().viewport;
    handleHostMessage({ type: 'diagram:focusTable', payload: { table: 'public.b' } });
    expect(store.getState().viewport).toBe(before);
    expect(store.getState().notice?.text).toBe('public.b is hidden.');
  });

  it('a table the diagram does not have yet leaves the camera alone with a notice', () => {
    const before = store.getState().viewport;
    handleHostMessage({ type: 'diagram:focusTable', payload: { table: 'public.zzz' } });
    expect(store.getState().viewport).toBe(before);
    expect(store.getState().notice?.text).toContain('public.zzz');
  });
});
