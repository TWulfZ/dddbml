import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./testing/vscodeFake'));

// The race needs the shared write held open while the camera arrives; real fs is too fast to hit it.
const gate = vi.hoisted(() => ({ hold: false, started: false, release: (): void => undefined }));
vi.mock('./layoutStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./layoutStore')>();
  return {
    ...actual,
    writeSharedLayout: async (...args: Parameters<typeof actual.writeSharedLayout>) => {
      if (gate.hold) {
        gate.started = true;
        await new Promise<void>((resolve) => { gate.release = resolve; });
      }
      return actual.writeSharedLayout(...args);
    },
  };
});

import { fake, Uri } from './testing/vscodeFake';
import { DiagramPanel } from './panel';
import { readViewState } from './viewStateStore';
import { cleanupDirs, openPanel, persistPayload, settle } from './testing/panelHarness';

beforeEach(() => {
  fake.reset();
  gate.hold = false;
  gate.started = false;
});
afterEach(() => {
  gate.release();
  DiagramPanel.disposeAll();
  cleanupDirs();
});

describe('camera saved while a layout flush is writing the sidecar (spec 03, F26)', () => {
  it('keeps the newer camera instead of the one the flush captured', async () => {
    const h = await openPanel();
    gate.hold = true;
    await h.web.receive(persistPayload(h, { 'public.a': { x: 70, y: 0 }, 'public.b': { x: 400, y: 0 } }));
    await vi.waitFor(() => expect(gate.started).toBe(true));
    await h.web.receive({ type: 'viewport:persist', payload: { x: 123, y: 456, zoom: 2 } });
    await settle(50);
    gate.release();
    await DiagramPanel.settle();
    const context = { globalStorageUri: Uri.file(`${h.dir}/global`) };
    const vs = await readViewState(context as never, h.dbml as never);
    expect(vs?.viewport).toEqual({ x: 123, y: 456, zoom: 2 });
  });
});
