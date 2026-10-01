import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

/** `reuseDir` reopens an existing diagram (same files, same view-state store) as-is. */
async function open(opts: { dbml?: string; sidecar?: string | null; reuseDir?: string } = {}): Promise<Harness> {
  const dir = opts.reuseDir ?? mkdtempSync(join(tmpdir(), 'dddbml-panel-'));
  if (!opts.reuseDir) {
    dirs.push(dir);
    writeFileSync(join(dir, 'd.dbml'), opts.dbml ?? DBML);
    if (opts.sidecar !== null) writeFileSync(join(dir, 'd.dbml.layout.json'), opts.sidecar ?? sidecarText({ 'public.a': { x: 0, y: 0 }, 'public.b': { x: 400, y: 0 } }));
  }
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

function gitIn(dir: string) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  return git;
}

describe('git panel ops', () => {
  it('reverts a modified .dbml even when the sidecar is staged-new, leaving the sidecar untracked', async () => {
    const h = await open();
    const git = gitIn(h.dir);
    git('add', 'd.dbml'); git('commit', '-q', '-m', 'v1');
    git('add', 'd.dbml.layout.json');
    h.writeSidecar(sidecarText({ 'public.a': { x: 1, y: 1 } })); // `AM`: rewritten after staging
    writeFileSync(join(h.dir, 'd.dbml'), `${DBML}\nTable z {\n  id int\n}\n`);
    h.mark();
    await h.web.receive({ type: 'git:restore' });
    await vi.waitFor(() => expect(h.since('git:opResult')).toHaveLength(1));
    expect((h.since('git:opResult')[0]!.payload as { ok: boolean }).ok).toBe(true);
    expect(readFileSync(join(h.dir, 'd.dbml'), 'utf8')).toBe(DBML);
    expect(git('status', '--porcelain', '--', 'd.dbml.layout.json')).toBe('?? d.dbml.layout.json\n');
  });

  it('treats a stash pop that stops on a layout conflict as applied, and opens the merge', async () => {
    const h = await open();
    const git = gitIn(h.dir);
    git('add', '-A'); git('commit', '-q', '-m', 'v1');
    h.writeSidecar(sidecarText({ 'public.a': { x: 100, y: 0 }, 'public.b': { x: 400, y: 0 } }));
    git('stash', 'push', '-q', '--', 'd.dbml.layout.json');
    h.writeSidecar(sidecarText({ 'public.a': { x: 500, y: 0 }, 'public.b': { x: 400, y: 0 } }));
    git('commit', '-q', '-am', 'teammate moved a');
    h.mark();
    await h.web.receive({ type: 'git:stashPop', payload: { ref: 'stash@{0}' } });
    await vi.waitFor(() => expect(h.since('git:opResult')).toHaveLength(1));
    expect((h.since('git:opResult')[0]!.payload as { ok: boolean }).ok).toBe(true);
    expect(h.since('merge:begin')).toHaveLength(1);
    expect(fake.messages.filter((m) => m.level === 'error')).toEqual([]);
  });

  it('refuses View diff while the working .dbml does not parse', async () => {
    const h = await open();
    const git = gitIn(h.dir);
    git('add', '-A'); git('commit', '-q', '-m', 'v1');
    writeFileSync(join(h.dir, 'd.dbml'), 'Table a {\n  id int\n'); // unterminated
    // No watcher event yet: the cached schema is stale but valid; the broken file must still win.
    h.mark();
    await h.web.receive({ type: 'git:diff:enter' });
    await vi.waitFor(() => expect(fake.messages.some((m) => m.level === 'warning' && m.text.includes('does not parse'))).toBe(true));
    expect(h.since('git:diff:enter')).toHaveLength(0);
  });

  it('refuses View diff when the .dbml never parsed since the panel opened', async () => {
    const h = await open({ dbml: 'Table a {\n  id int\n' });
    const git = gitIn(h.dir);
    writeFileSync(join(h.dir, 'd.dbml'), DBML);
    git('add', '-A'); git('commit', '-q', '-m', 'v1');
    writeFileSync(join(h.dir, 'd.dbml'), 'Table a {\n  id int\n');
    h.mark();
    await h.web.receive({ type: 'git:diff:enter' });
    await vi.waitFor(() => expect(fake.messages.some((m) => m.level === 'warning')).toBe(true));
    expect(h.since('git:diff:enter')).toHaveLength(0);
  });
});

describe('panel lifecycle', () => {
  const persistA = async (h: Harness, x: number) => {
    const loaded = h.web.posted.find((m) => m.type === 'layout:loaded')!;
    await h.web.receive({ type: 'layout:persist', payload: { ...(loaded.payload as Layout), tables: { 'public.a': { x, y: 0 }, 'public.b': { x: 400, y: 0 } } } });
  };

  it('flushes a debounced persist when the panel is closed (F22)', async () => {
    const h = await open();
    await persistA(h, 321);
    DiagramPanel.disposeAll();
    await DiagramPanel.settle();
    expect(JSON.parse(h.readSidecar()).tables['public.a'].x).toBe(321);
  });

  it('flushes a debounced persist when the panel is hidden, so the re-shown webview reads it (F22)', async () => {
    const h = await open();
    await persistA(h, 654);
    await h.web.setVisible(false);
    h.mark();
    await h.web.setVisible(true);
    await h.web.receive({ type: 'ready' });
    await vi.waitFor(() => expect(h.since('layout:loaded')).toHaveLength(1));
    expect(tablesOf(h.since('layout:loaded')[0])['public.a']?.x).toBe(654);
  });

  it('queues an export prompt sent while hidden until the reloaded webview is ready (F62)', async () => {
    const h = await open();
    await h.web.setVisible(false);
    h.mark();
    h.panel.openExportModal();
    expect(h.since('export:prompt')).toHaveLength(0);
    await h.web.setVisible(true);
    await h.web.receive({ type: 'ready' });
    await vi.waitFor(() => expect(h.since('export:prompt')).toHaveLength(1));
  });
});

describe('view-state vs legacy sidecar flags (F67)', () => {
  const LEGACY = `{\n  "version": 1,\n  "tables": {\n    "public.a": { "x": 0, "y": 0, "hidden": true },\n    "public.b": { "x": 400, "y": 0 }\n  },\n  "groups": {\n  },\n  "edges": {}\n}\n`;

  it('seeds view-state once from a legacy sidecar and keeps it after the sidecar is stripped', async () => {
    const h = await open({ sidecar: LEGACY });
    const loaded = h.web.posted.find((m) => m.type === 'layout:loaded')!;
    expect(tablesOf(loaded)['public.a']?.hidden).toBe(true);
    // A real edit rewrites the sidecar in shared form (flags stripped).
    await h.web.receive({ type: 'layout:persist', payload: { ...(loaded.payload as Layout), tables: { 'public.a': { x: 0, y: 0, hidden: true }, 'public.b': { x: 410, y: 0 } } } });
    await vi.waitFor(() => expect(h.readSidecar()).toContain('"x": 410'));
    expect(h.readSidecar()).not.toContain('hidden');
    DiagramPanel.disposeAll();
    await DiagramPanel.settle();
    const again = await open({ reuseDir: h.dir });
    expect(tablesOf(again.web.posted.find((m) => m.type === 'layout:loaded'))['public.a']?.hidden).toBe(true);
  });

  it("does not let a teammate's legacy flags override existing local view-state", async () => {
    const h = await open();
    const loaded = h.web.posted.find((m) => m.type === 'layout:loaded')!;
    await h.web.receive({ type: 'layout:persist', payload: { ...(loaded.payload as Layout), tables: { 'public.a': { x: 0, y: 0 }, 'public.b': { x: 410, y: 0 } } } });
    await vi.waitFor(() => expect(h.readSidecar()).toContain('"x": 410'));
    DiagramPanel.disposeAll();
    await DiagramPanel.settle();
    writeFileSync(join(h.dir, 'd.dbml.layout.json'), LEGACY); // pulled from an old release
    const again = await open({ reuseDir: h.dir });
    expect(tablesOf(again.web.posted.find((m) => m.type === 'layout:loaded'))['public.a']?.hidden).toBeUndefined();
  });
});

describe('view-state writes are per-key changes, not whole-file replacement', () => {
  const viewStatePath = (h: Harness) =>
    join(h.dir, 'global', 'view-state', `${createHash('sha256').update(h.dbml.toString()).digest('hex')}.json`);
  const readVs = (h: Harness) => JSON.parse(readFileSync(viewStatePath(h), 'utf8')) as { tables: Record<string, unknown>; groups: Record<string, unknown>; viewport: unknown };

  it("keeps another window's hide/collapse flags when this window persists an unrelated edit", async () => {
    const h = await open();
    const loaded = h.web.posted.find((m) => m.type === 'layout:loaded')!;
    await h.web.receive({ type: 'layout:persist', payload: { ...(loaded.payload as Layout), tables: { 'public.a': { x: 5, y: 0 }, 'public.b': { x: 400, y: 0 } } } });
    await DiagramPanel.settle();
    await vi.waitFor(() => expect(readVs(h)).toBeDefined());
    // Window 1 (another extension host sharing globalStorage) hides b and collapses G.
    writeFileSync(viewStatePath(h), JSON.stringify({ viewport: { x: -500, y: -200, zoom: 0.5 }, tables: { 'public.b': { hidden: true } }, groups: { G: { collapsed: true } } }));
    // Window 2 (this panel) drags a.
    await h.web.receive({ type: 'layout:persist', payload: { ...(loaded.payload as Layout), tables: { 'public.a': { x: 50, y: 0 }, 'public.b': { x: 400, y: 0 } } } });
    await vi.waitFor(() => expect(h.readSidecar()).toContain('"x": 50'));
    await DiagramPanel.settle();
    const vs = readVs(h);
    expect(vs.tables).toEqual({ 'public.b': { hidden: true } });
    expect(vs.groups).toEqual({ G: { collapsed: true } });
    expect(vs.viewport).toEqual({ x: -500, y: -200, zoom: 0.5 });
  });

  it('keeps hidden flags of tables the webview never heard about (corrupt sidecar at open, F66)', async () => {
    const h = await open();
    const loaded = h.web.posted.find((m) => m.type === 'layout:loaded')!;
    await h.web.receive({ type: 'layout:persist', payload: { ...(loaded.payload as Layout), tables: { 'public.a': { x: 0, y: 0, hidden: true }, 'public.b': { x: 400, y: 0 } } } });
    await vi.waitFor(() => expect(readVs(h).tables).toEqual({ 'public.a': { hidden: true } }));
    DiagramPanel.disposeAll();
    await DiagramPanel.settle();
    h.writeSidecar(h.readSidecar().replace('"edges": {}', '"edges": {},')); // trailing comma
    const again = await open({ reuseDir: h.dir });
    const reloaded = again.web.posted.find((m) => m.type === 'layout:loaded')!;
    // The webview auto-places both tables (no entries) and the user moves one.
    await again.web.receive({ type: 'layout:persist', payload: { ...(reloaded.payload as Layout), tables: { 'public.a': { x: 32, y: 32 }, 'public.b': { x: 99, y: 0 } } } });
    await new Promise((r) => setTimeout(r, 300));
    await DiagramPanel.settle();
    expect(readVs(again).tables).toEqual({ 'public.a': { hidden: true } });
  });
});

describe('go to definition (F25)', () => {
  const SRC = `Table "auth"."users"\n{\n  id int\n}\n\nTable usuários as U {\n  id int\n}\n\nTable "plain" {\n  id int\n}\n`;

  for (const [name, line] of [['auth.users', 0], ['public.usuários', 5], ['public.plain', 9]] as const) {
    it(`reveals ${name} at its declaration line`, async () => {
      const h = await open({ dbml: SRC, sidecar: null });
      await h.web.receive({ type: 'command:reveal', payload: { tableName: name } });
      await vi.waitFor(() => expect(fake.shownDocuments).toHaveLength(1));
      expect(fake.shownDocuments[0]!.line).toBe(line);
    });
  }
});

describe('schema export', () => {
  const exportedText = () => (fake.shownDocuments.at(-1)!.doc as { getText(): string }).getText();

  it('keeps refs with one selected endpoint so the cut relation is warned about (F78)', async () => {
    const h = await open({ dbml: `Table users {\n  id int [pk]\n}\n\nTable orders {\n  id int [pk]\n  user_id int [ref: > users.id]\n}\n`, sidecar: null });
    h.mark();
    await h.web.receive({ type: 'command:export', payload: { formatId: 'typeorm', scope: 'selected', selection: ['public.orders'], options: {} } });
    await vi.waitFor(() => expect(h.since('export:result')).toHaveLength(1));
    const result = h.since('export:result')[0]!.payload as { ok: boolean; warnings?: string[] };
    expect(result.ok).toBe(true);
    expect(result.warnings?.some((w) => w.includes('outside the export scope'))).toBe(true);
  });

  it('exports the revision on screen during time travel (F79)', async () => {
    const h = await open();
    const git = gitIn(h.dir);
    writeFileSync(join(h.dir, 'd.dbml'), `Table old_only {\n  id int\n}\n`);
    git('add', '-A'); git('commit', '-q', '-m', 'v0');
    const sha = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(h.dir, 'd.dbml'), DBML);
    await h.web.receive({ type: 'git:timeTravel:enter', payload: { sha, label: 'v0' } });
    await vi.waitFor(() => expect(h.web.posted.some((m) => m.type === 'git:timeTravel:enter')).toBe(true));
    h.mark();
    await h.web.receive({ type: 'command:export', payload: { formatId: 'typeorm', scope: 'all', selection: [], options: {} } });
    await vi.waitFor(() => expect(h.since('export:result')).toHaveLength(1));
    expect(exportedText()).toContain('OldOnly');
    expect(exportedText()).not.toMatch(/class A\b/);
  });
});

describe('Prune orphan layout entries (F23)', () => {
  it('refuses while the .dbml has not parsed, instead of pruning every entry', async () => {
    const h = await open({ dbml: 'Table a {\n  id int\n' });
    const before = h.readSidecar();
    fake.nextChoice = 'Prune';
    await h.panel.pruneOrphans();
    expect(h.readSidecar()).toBe(before);
    expect(fake.messages.some((m) => m.level === 'warning')).toBe(true);
  });

  it('prunes only entries whose table is gone once the schema parses', async () => {
    const h = await open({ sidecar: sidecarText({ 'public.a': { x: 0, y: 0 }, 'public.b': { x: 400, y: 0 }, 'public.gone': { x: 9, y: 9 } }) });
    fake.nextChoice = 'Prune';
    await h.panel.pruneOrphans();
    expect(JSON.parse(h.readSidecar()).tables).toEqual({ 'public.a': { x: 0, y: 0 }, 'public.b': { x: 400, y: 0 } });
  });
});
