import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('vscode', () => import('./testing/vscodeFake'));

import { fake, Uri, type FakeWebviewPanel } from './testing/vscodeFake';
import { DiagramPanel } from './panel';
import type { Layout } from '../shared/types';

/** Drives a real DiagramPanel (real fs, real parser) through the fake vscode surface. */

const DBML = `Table a {\n  id int\n}\n\nTable b {\n  id int\n}\n`;

function sidecarText(tables: Record<string, { x: number; y: number }>): string {
  const keys = Object.keys(tables).sort();
  const rows = keys.map((k, i) => `    ${JSON.stringify(k)}: { "x": ${tables[k]!.x}, "y": ${tables[k]!.y} }${i < keys.length - 1 ? ',' : ''}`);
  return ['{', '  "version": 1,', '  "tables": {', ...rows, '  },', '  "groups": {', '  },', '  "edges": {}', '}', ''].join('\n');
}

interface Harness {
  dir: string;
  dbml: Uri;
  sidecar: Uri;
  web: FakeWebviewPanel;
  panel: DiagramPanel;
  writeSidecar(text: string): void;
  readSidecar(): string;
  /** Messages of `type` posted since the last `mark()`. */
  since(type: string): Array<{ type: string; payload?: unknown }>;
  mark(): void;
}

const dirs: string[] = [];

async function open(opts: { dbml?: string; sidecar?: string | null } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'dddbml-panel-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'd.dbml'), opts.dbml ?? DBML);
  if (opts.sidecar !== null) writeFileSync(join(dir, 'd.dbml.layout.json'), opts.sidecar ?? sidecarText({ 'public.a': { x: 0, y: 0 }, 'public.b': { x: 400, y: 0 } }));
  const dbml = Uri.file(join(dir, 'd.dbml'));
  const context = { extensionUri: Uri.file('/ext'), globalStorageUri: Uri.file(join(dir, 'global')) };
  DiagramPanel.createOrShow(context as never, dbml as never);
  const web = fake.panels[fake.panels.length - 1]!;
  const panel = DiagramPanel.get(dbml as never)!;
  let markAt = 0;
  const h: Harness = {
    dir,
    dbml,
    sidecar: Uri.file(join(dir, 'd.dbml.layout.json')),
    web,
    panel,
    writeSidecar: (text) => writeFileSync(join(dir, 'd.dbml.layout.json'), text),
    readSidecar: () => readFileSync(join(dir, 'd.dbml.layout.json'), 'utf8'),
    since: (type) => web.posted.slice(markAt).filter((m) => m.type === type),
    mark: () => { markAt = web.posted.length; },
  };
  await web.receive({ type: 'ready' });
  await vi.waitFor(() => expect(web.posted.some((m) => m.type === 'exporters:list')).toBe(true));
  return h;
}

function tablesOf(msg: { payload?: unknown } | undefined): Layout['tables'] {
  return msg ? (msg.payload as Layout).tables : {};
}

beforeEach(() => fake.reset());
afterEach(() => {
  DiagramPanel.disposeAll();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('sidecar watcher echo guard (F01)', () => {
  it('reloads when the disk returns to the content the panel itself last wrote', async () => {
    const h = await open();
    const loaded = h.web.posted.find((m) => m.type === 'layout:loaded')!;
    await h.web.receive({ type: 'layout:persist', payload: { ...(loaded.payload as Layout), tables: { 'public.a': { x: 100, y: 0 }, 'public.b': { x: 400, y: 0 } } } });
    await vi.waitFor(() => expect(h.readSidecar()).toContain('"x": 100'));
    const selfWritten = h.readSidecar();

    // `git checkout feat`: another branch's layout lands on disk.
    h.writeSidecar(sidecarText({ 'public.a': { x: 999, y: 0 }, 'public.b': { x: 400, y: 0 } }));
    h.mark();
    await fake.fireFsEvent('change', h.sidecar);
    await vi.waitFor(() => expect(tablesOf(h.since('layout:external-change').at(-1))['public.a']?.x).toBe(999));

    // `git checkout main`: back to exactly what the panel wrote earlier.
    h.writeSidecar(selfWritten);
    h.mark();
    await fake.fireFsEvent('change', h.sidecar);
    await vi.waitFor(() => expect(tablesOf(h.since('layout:external-change').at(-1))['public.a']?.x).toBe(100));
  });

  it('still ignores the event its own write triggers', async () => {
    const h = await open();
    const loaded = h.web.posted.find((m) => m.type === 'layout:loaded')!;
    await h.web.receive({ type: 'layout:persist', payload: { ...(loaded.payload as Layout), tables: { 'public.a': { x: 100, y: 0 }, 'public.b': { x: 400, y: 0 } } } });
    await vi.waitFor(() => expect(h.readSidecar()).toContain('"x": 100'));
    h.mark();
    await fake.fireFsEvent('change', h.sidecar);
    await new Promise((r) => setTimeout(r, 400));
    expect(h.since('layout:external-change')).toHaveLength(0);
  });
});

describe('external reloads (watchers)', () => {
  const DBML_AC = `Table a {\n  id int\n}\n\nTable c {\n  id int\n}\n`;

  it('posts the new schema before the new layout when both files change (branch switch)', async () => {
    const h = await open();
    h.mark();
    writeFileSync(join(h.dir, 'd.dbml'), DBML_AC);
    h.writeSidecar(sidecarText({ 'public.a': { x: 5, y: 5 }, 'public.c': { x: 900, y: 400 } }));
    await fake.fireFsEvent('change', h.sidecar);
    await fake.fireFsEvent('change', h.dbml);
    await vi.waitFor(() => expect(h.since('layout:external-change')).toHaveLength(1));
    await vi.waitFor(() => expect(h.since('schema:update')).toHaveLength(1));
    const order = h.web.posted.filter((m) => m.type === 'schema:update' || m.type === 'layout:external-change').slice(-2).map((m) => m.type);
    expect(order).toEqual(['schema:update', 'layout:external-change']);
  });

  it('reloads an empty layout when the sidecar is deleted', async () => {
    const h = await open();
    h.mark();
    rmSync(join(h.dir, 'd.dbml.layout.json'));
    await fake.fireFsEvent('delete', h.sidecar);
    await vi.waitFor(() => expect(h.since('layout:external-change')).toHaveLength(1));
    expect(tablesOf(h.since('layout:external-change')[0])).toEqual({});
  });

  it('refreshes the schema when the .dbml is replaced (create event)', async () => {
    const h = await open();
    h.mark();
    writeFileSync(join(h.dir, 'd.dbml'), DBML_AC);
    await fake.fireFsEvent('create', h.dbml);
    await vi.waitFor(() => expect(h.since('schema:update')).toHaveLength(1));
  });

  it('drops a pending persist that an external change supersedes', async () => {
    const h = await open();
    const loaded = h.web.posted.find((m) => m.type === 'layout:loaded')!;
    await h.web.receive({ type: 'layout:persist', payload: { ...(loaded.payload as Layout), tables: { 'public.a': { x: 100, y: 0 }, 'public.b': { x: 400, y: 0 } } } });
    const external = sidecarText({ 'public.a': { x: 777, y: 0 }, 'public.b': { x: 400, y: 0 } });
    h.writeSidecar(external);
    await fake.fireFsEvent('change', h.sidecar);
    await new Promise((r) => setTimeout(r, 500));
    expect(h.readSidecar()).toBe(external);
  });
});
