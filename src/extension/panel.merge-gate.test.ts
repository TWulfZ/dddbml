import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('vscode', () => import('./testing/vscodeFake'));

import { fake } from './testing/vscodeFake';
import { DiagramPanel } from './panel';
import { cleanupDirs, conflictedRepo, openPanel, persistPayload, settle, sidecarText, tablesOf } from './testing/panelHarness';
import type { SerializableMergeConflict } from '../shared/types';

/** Host half of the two-layer read-only gate while a sidecar merge is pending (spec 16, spec 14). */

const MARKER = '<<<<<<<';
type MergeBegin = { conflicts: SerializableMergeConflict[]; error: string | null };

beforeEach(() => fake.reset());
afterEach(() => {
  DiagramPanel.disposeAll();
  cleanupDirs();
});

describe('pending merge: the host refuses shared writes', () => {
  it('re-posts merge:begin to a webview that reloads mid-merge (F02)', async () => {
    const { dir } = conflictedRepo();
    const h = await openPanel({ reuseDir: dir });
    expect(h.web.posted.filter((m) => m.type === 'merge:begin')).toHaveLength(1);
    await h.web.setVisible(false);
    h.mark();
    await h.web.setVisible(true);
    await h.web.receive({ type: 'ready' });
    await vi.waitFor(() => expect(h.since('exporters:list')).toHaveLength(1));
    expect(h.since('merge:begin')).toHaveLength(1);
  });

  it('drops layout:persist while the merge is pending, keeping the conflict markers (F02/F71)', async () => {
    const { dir } = conflictedRepo();
    const h = await openPanel({ reuseDir: dir });
    await h.web.receive(persistPayload(h, { 'public.a': { x: 5, y: 5 }, 'public.b': { x: 400, y: 0 } }));
    await settle();
    await DiagramPanel.settle();
    expect(h.readSidecar()).toContain(MARKER);
  });

  it('refuses Reset Layout and Prune Orphans with a notice (F71)', async () => {
    const { dir } = conflictedRepo();
    const h = await openPanel({ reuseDir: dir });
    h.mark();
    fake.nextChoice = 'Prune';
    await h.panel.resetLayout();
    await h.panel.pruneOrphans();
    expect(h.readSidecar()).toContain(MARKER);
    expect(h.since('layout:loaded')).toHaveLength(0);
    expect(fake.messages.filter((m) => m.level === 'warning' && m.text.includes('merge'))).toHaveLength(2);
  });

  it('stays read-only with a visible error when the conflict cannot be read from git (F04)', async () => {
    const { dir, git } = conflictedRepo();
    git('add', '-A'); // markers staged: no unmerged stages left to read
    const h = await openPanel({ reuseDir: dir });
    const begin = h.web.posted.find((m) => m.type === 'merge:begin');
    expect((begin?.payload as MergeBegin | undefined)?.error).toEqual(expect.any(String));
    await h.web.receive(persistPayload(h, { 'public.a': { x: 5, y: 5 }, 'public.b': { x: 400, y: 0 } }));
    await settle();
    await DiagramPanel.settle();
    expect(h.readSidecar()).toContain(MARKER);
  });
});

describe('pending merge: changes made outside the diagram', () => {
  it('ends merge mode and reloads when the merge is aborted in a terminal (F03)', async () => {
    const { dir, git } = conflictedRepo();
    const h = await openPanel({ reuseDir: dir });
    h.mark();
    git('merge', '--abort');
    await fake.fireFsEvent('change', h.sidecar);
    await vi.waitFor(() => expect(h.since('merge:done')).toHaveLength(1));
    expect(tablesOf(h.since('layout:external-change').at(-1))['public.a']?.x).toBe(111);
  });

  it('answers a stale Apply with merge:done instead of leaving the webview on "Applying…" (F03)', async () => {
    const h = await openPanel();
    h.mark();
    await h.web.receive({ type: 'merge:resolve', payload: { decisions: {} } });
    await vi.waitFor(() => expect(h.since('merge:done')).toHaveLength(1));
  });

  it('re-posts a conflict whose keys are unchanged but whose sides changed', async () => {
    const { dir, git } = conflictedRepo();
    const h = await openPanel({ reuseDir: dir });
    git('merge', '--abort');
    git('checkout', '-q', 'other');
    h.writeSidecar(sidecarText({ 'public.a': { x: 333, y: 0 }, 'public.b': { x: 400, y: 0 } }));
    git('commit', '-q', '-am', 'other moved a again');
    git('checkout', '-q', 'main');
    try { git('merge', '-q', 'other'); } catch { /* conflict expected */ }
    h.mark();
    await fake.fireFsEvent('change', h.sidecar);
    await vi.waitFor(() => expect(h.since('merge:begin')).toHaveLength(1));
    const [c] = (h.since('merge:begin')[0]!.payload as MergeBegin).conflicts;
    expect(c?.id).toBe('tables::public.a');
    expect((c?.theirs as { x: number }).x).toBe(333);
  });

  it('saves later edits after Apply resolved a merge whose sidecar had become invalid JSON (F30)', async () => {
    const { dir } = conflictedRepo();
    const h = await openPanel({ reuseDir: dir });
    h.writeSidecar('{ "version": 1, "tables": {'); // "Accept both" in the text editor
    await fake.fireFsEvent('change', h.sidecar);
    await vi.waitFor(() => expect(fake.messages.some((m) => m.text.includes('not valid JSON'))).toBe(true));
    h.mark();
    await h.web.receive({ type: 'merge:resolve', payload: { decisions: { 'tables::public.a': 'theirs' } } });
    await vi.waitFor(() => expect(h.since('merge:done')).toHaveLength(1));
    await fake.fireFsEvent('change', h.sidecar); // our own write's echo
    await settle(200);
    await h.web.receive(persistPayload(h, { 'public.a': { x: 777, y: 0 }, 'public.b': { x: 400, y: 0 } }));
    await vi.waitFor(() => expect(JSON.parse(h.readSidecar()).tables['public.a'].x).toBe(777));
  });

  it('keeps the webview decisions when the Apply write fails (F73)', async () => {
    const { dir } = conflictedRepo();
    const h = await openPanel({ reuseDir: dir });
    h.mark();
    chmodSync(dir, 0o555); // temp file + rename cannot be created
    try {
      await h.web.receive({ type: 'merge:resolve', payload: { decisions: { 'tables::public.a': 'theirs' } } });
      await vi.waitFor(() => expect(fake.messages.some((m) => m.level === 'error' && m.text.includes('failed to write'))).toBe(true));
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(h.since('merge:applyFailed')).toHaveLength(1);
    expect(h.since('merge:begin')).toHaveLength(0);
    expect(h.readSidecar()).toContain(MARKER);
  });
});

describe('pending merge: git ops on the diagram files are refused (F31)', () => {
  const unmerged = (git: (...a: string[]) => string) => git('ls-files', '-u', '--', 'd.dbml.layout.json');

  it('does not commit, stash or revert the marker-laden sidecar', async () => {
    const { dir, git } = conflictedRepo();
    writeFileSync(join(dir, 'd.dbml'), `${'Table z {\n  id int\n}\n'}`); // something else dirty too
    const h = await openPanel({ reuseDir: dir });
    h.mark();
    await h.web.receive({ type: 'git:commit', payload: { message: 'oops' } });
    await vi.waitFor(() => expect(h.since('git:commitResult')).toHaveLength(1));
    await h.web.receive({ type: 'git:stashPush', payload: {} });
    await vi.waitFor(() => expect(h.since('git:opResult')).toHaveLength(1));
    await h.web.receive({ type: 'git:restore' });
    await vi.waitFor(() => expect(h.since('git:opResult')).toHaveLength(2));
    expect((h.since('git:commitResult')[0]?.payload as { ok: boolean }).ok).toBe(false);
    expect(h.since('git:opResult').map((m) => (m.payload as { ok: boolean }).ok)).toEqual([false, false]);
    expect(unmerged(git)).not.toBe('');
    expect(h.readSidecar()).toContain(MARKER);
  });
});
