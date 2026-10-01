import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../vscode', () => ({ postToHost: vi.fn() }));
vi.mock('../../persistence', () => ({ schedulePersist: vi.fn() }));

import { store } from '../../state/store';
import { parseDbml } from '../../../extension/parser';
import { edgeKeyedRefs } from '../../render/edgeKey';
import { cancelEdgeOrdering, runEdgeOrdering, runSmartLayout } from './runner';
import type { TableLayout } from '../../../shared/types';

// Enough refs that A* yields to the event loop mid-run (YIELD_EVERY = 16), so a run is in flight.
const N = 40;

function load() {
  const lines = ['Table hub { id int [pk] }'];
  for (let i = 0; i < N; i++) lines.push(`Table t${i} { id int [pk]\n  hub_id int [ref: > hub.id] }`);
  const r = parseDbml(lines.join('\n'));
  if (!r.schema) throw new Error(r.error.message);
  store.getState().setSchema(r.schema, null);
  const tables: Record<string, TableLayout> = { 'public.hub': { x: 0, y: 0 } };
  for (let i = 0; i < N; i++) tables[`public.t${i}`] = { x: (i % 8) * 400, y: 400 + Math.floor(i / 8) * 300 };
  store.getState().setLayout({ version: 1, viewport: { x: 0, y: 0, zoom: 1 }, tables, groups: {}, edges: {} });
  store.getState().clearHistory();
  return r.schema;
}

describe('runner — concurrent / stale runs (audit F44, F45)', () => {
  beforeEach(() => {
    cancelEdgeOrdering();
    store.getState().endEdgeOrderProgress();
  });

  it('a superseded run does not hide the new run’s progress or detach its cancel', async () => {
    load();
    const first = runEdgeOrdering({ preserveManual: false });
    const second = runEdgeOrdering({ preserveManual: false });
    await first;
    expect(store.getState().edgeOrderProgress).not.toBeNull();
    cancelEdgeOrdering();
    await second;
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().edgeOrderProgress).toBeNull();
  });

  it('arrange does not overwrite a table moved while A* was running', async () => {
    load();
    const run = runSmartLayout('all');
    store.getState().setTablePos('public.t3', 9000, 9000);
    await run;
    expect(store.getState().positions.get('public.t3')).toEqual({ x: 9000, y: 9000 });
    expect(store.getState().past.every((c) => c.kind !== 'arrange')).toBe(true);
    expect(store.getState().edgeOrderProgress).toBeNull();
  });

  it('order-edges does not drop an edge color set while A* was running', async () => {
    const schema = load();
    const [key] = edgeKeyedRefs(schema.refs, (t) => t).refs.map((r) => r.id);
    const run = runEdgeOrdering({ preserveManual: false });
    store.getState().setEdgeColor(key!, '#123456');
    await run;
    expect(store.getState().edgeLayouts.get(key!)?.color).toBe('#123456');
  });
});
