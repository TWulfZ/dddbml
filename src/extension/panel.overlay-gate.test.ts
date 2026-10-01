import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('vscode', () => import('./testing/vscodeFake'));

import { fake } from './testing/vscodeFake';
import { DiagramPanel } from './panel';
import { cleanupDirs, DBML, gitIn, openPanel, persistPayload, settle, sidecarText, type Git, type Harness } from './testing/panelHarness';
import type { Schema } from '../shared/types';

/** Host half of the read-only gate during the git overlays: time travel and diff (spec 16). */

const OLD_DBML = `Table old_only {\n  id int\n}\n`;
const WORKING_SIDECAR = sidecarText({ 'public.a': { x: 0, y: 0 }, 'public.b': { x: 400, y: 0 } });

beforeEach(() => fake.reset());
afterEach(() => {
  DiagramPanel.disposeAll();
  cleanupDirs();
});

/** A diagram whose HEAD~ is `old_only` and whose working tree (= HEAD) has tables a and b. */
async function withHistory(): Promise<{ h: Harness; git: Git; oldSha: string }> {
  const h = await openPanel();
  const git = gitIn(h.dir);
  writeFileSync(join(h.dir, 'd.dbml'), OLD_DBML);
  h.writeSidecar(sidecarText({ 'public.old_only': { x: 5, y: 5 } }));
  git('add', '-A'); git('commit', '-q', '-m', 'v0'); git('branch', '-M', 'main');
  const oldSha = git('rev-parse', 'HEAD').trim();
  writeFileSync(join(h.dir, 'd.dbml'), DBML);
  h.writeSidecar(WORKING_SIDECAR);
  git('commit', '-q', '-am', 'v1');
  return { h, git, oldSha };
}

async function enterTimeTravel(h: Harness, sha: string): Promise<void> {
  h.mark();
  await h.web.receive({ type: 'git:timeTravel:enter', payload: { sha, label: 'v0' } });
  await vi.waitFor(() => expect(h.since('git:timeTravel:enter')).toHaveLength(1));
}

const tableNames = (m: { payload?: unknown } | undefined) => ((m?.payload as { schema: Schema } | undefined)?.schema.tables ?? []).map((t) => t.name);
const flow = (h: Harness, types: string[]) => flowFrom(h, 0, types);
const flowFrom = (h: Harness, start: number, types: string[]) => h.web.posted.slice(start).filter((m) => types.includes(m.type)).map((m) => m.type);

describe('time travel', () => {
  it('drops layout:persist and refuses Reset Layout while a past revision is on screen', async () => {
    const { h, oldSha } = await withHistory();
    await enterTimeTravel(h, oldSha);
    await h.web.receive(persistPayload(h, { 'public.old_only': { x: 5, y: 5 }, 'public.a': { x: 999, y: 0 } }));
    await h.panel.resetLayout();
    await settle();
    await DiagramPanel.settle();
    expect(h.readSidecar()).toBe(WORKING_SIDECAR);
  });

  it('posts the exit only after the working schema and layout, so the canvas never unlocks on the past (F27)', async () => {
    const { h, oldSha } = await withHistory();
    await enterTimeTravel(h, oldSha);
    h.mark();
    await h.web.receive({ type: 'git:timeTravel:exit' });
    await vi.waitFor(() => expect(h.since('git:timeTravel:exit')).toHaveLength(1));
    expect(flow(h, ['schema:update', 'layout:loaded', 'git:timeTravel:exit']).slice(-3)).toEqual(['schema:update', 'layout:loaded', 'git:timeTravel:exit']);
  });

  it('defers watcher pushes until exit instead of replacing the revision under its banner (F21)', async () => {
    const { h, oldSha } = await withHistory();
    await enterTimeTravel(h, oldSha);
    writeFileSync(join(h.dir, 'd.dbml'), `${DBML}\nTable c {\n  id int\n}\n`);
    await fake.fireFsEvent('change', h.dbml);
    await settle();
    expect(h.since('schema:update')).toHaveLength(0);
    await h.web.receive({ type: 'git:timeTravel:exit' });
    await vi.waitFor(() => expect(h.since('git:timeTravel:exit')).toHaveLength(1));
    expect(tableNames(h.since('schema:update').at(-1))).toContain('public.c');
  });

  it('marks the exit layout as an external change only when the sidecar changed during the peek (F76)', async () => {
    const { h, oldSha } = await withHistory();
    await enterTimeTravel(h, oldSha);
    h.writeSidecar(sidecarText({ 'public.a': { x: 777, y: 0 }, 'public.b': { x: 400, y: 0 } }));
    await fake.fireFsEvent('change', h.sidecar);
    await settle();
    await h.web.receive({ type: 'git:timeTravel:exit' });
    await vi.waitFor(() => expect(h.since('git:timeTravel:exit')).toHaveLength(1));
    expect(h.since('layout:loaded')).toHaveLength(0);
    expect(h.since('layout:external-change')).toHaveLength(1);
  });

  it('re-posts the time-travel view to a webview that reloads (F02 sibling)', async () => {
    const { h, oldSha } = await withHistory();
    await enterTimeTravel(h, oldSha);
    await h.web.setVisible(false);
    h.mark();
    await h.web.setVisible(true);
    await h.web.receive({ type: 'ready' });
    await vi.waitFor(() => expect(h.since('git:timeTravel:enter')).toHaveLength(1));
  });

  it('opens a merge that arrived during time travel only after restoring the working schema', async () => {
    const { h, git, oldSha } = await withHistory();
    await enterTimeTravel(h, oldSha);
    git('checkout', '-q', '-b', 'other');
    h.writeSidecar(sidecarText({ 'public.a': { x: 222, y: 0 }, 'public.b': { x: 400, y: 0 } }));
    git('commit', '-q', '-am', 'other moved a');
    git('checkout', '-q', 'main');
    h.writeSidecar(sidecarText({ 'public.a': { x: 111, y: 0 }, 'public.b': { x: 400, y: 0 } }));
    git('commit', '-q', '-am', 'main moved a');
    try { git('merge', '-q', 'other'); } catch { /* conflict expected */ }
    await fake.fireFsEvent('change', h.sidecar);
    await settle();
    expect(h.since('merge:begin')).toHaveLength(0);
    h.mark();
    await h.web.receive({ type: 'git:timeTravel:exit' });
    await vi.waitFor(() => expect(h.since('git:timeTravel:exit')).toHaveLength(1));
    expect(flow(h, ['schema:update', 'layout:external-change', 'merge:begin', 'git:timeTravel:exit']).slice(-4))
      .toEqual(['schema:update', 'layout:external-change', 'merge:begin', 'git:timeTravel:exit']);
    expect(tableNames(h.since('schema:update').at(-1))).toEqual(['public.a', 'public.b']);
  });
});

describe('diff against HEAD', () => {
  it('restores the working state before overlaying a diff opened from time travel (F05)', async () => {
    const { h, oldSha } = await withHistory();
    writeFileSync(join(h.dir, 'd.dbml'), `${DBML}\nTable c {\n  id int\n}\n`); // a working change to diff
    await enterTimeTravel(h, oldSha);
    h.mark();
    await h.web.receive({ type: 'git:diff:enter' });
    await vi.waitFor(() => expect(h.since('git:diff:enter')).toHaveLength(1));
    // `layout:loaded`, not external-change: nothing changed on disk, so the webview keeps its stashed undo history (F76).
    expect(flow(h, ['schema:update', 'layout:loaded', 'layout:external-change', 'git:diff:enter']).slice(-3)).toEqual(['schema:update', 'layout:loaded', 'git:diff:enter']);
    expect(tableNames(h.since('schema:update').at(-1))).toContain('public.c');
  });

  it('re-posts a recomputed diff to a webview that reloads', async () => {
    const { h } = await withHistory();
    writeFileSync(join(h.dir, 'd.dbml'), `${DBML}\nTable c {\n  id int\n}\n`);
    await h.web.receive({ type: 'git:diff:enter' });
    await vi.waitFor(() => expect(h.web.posted.some((m) => m.type === 'git:diff:enter')).toBe(true));
    await h.web.setVisible(false);
    h.mark();
    await h.web.setVisible(true);
    await h.web.receive({ type: 'ready' });
    await vi.waitFor(() => expect(h.since('git:diff:enter')).toHaveLength(1));
  });

  it('is a host round trip: persists are dropped until the host confirms the exit', async () => {
    const { h } = await withHistory();
    writeFileSync(join(h.dir, 'd.dbml'), `${DBML}\nTable c {\n  id int\n}\n`);
    h.mark();
    await h.web.receive({ type: 'git:diff:enter' });
    await vi.waitFor(() => expect(h.since('git:diff:enter')).toHaveLength(1));
    await h.web.receive(persistPayload(h, { 'public.a': { x: 999, y: 0 }, 'public.b': { x: 400, y: 0 } }));
    await settle();
    expect(h.readSidecar()).toBe(WORKING_SIDECAR);
    await h.web.receive({ type: 'git:diff:exit' });
    await vi.waitFor(() => expect(h.since('git:diff:exit')).toHaveLength(1));
    await h.web.receive(persistPayload(h, { 'public.a': { x: 999, y: 0 }, 'public.b': { x: 400, y: 0 } }));
    await vi.waitFor(() => expect(JSON.parse(h.readSidecar()).tables['public.a'].x).toBe(999));
  });
});

describe('overlay transitions are serialized', () => {
  it('a second Exit click does not unlock the webview on the past revision', async () => {
    const { h, oldSha } = await withHistory();
    await enterTimeTravel(h, oldSha);
    const start = h.web.posted.length;
    const exit = { type: 'git:timeTravel:exit' };
    void h.web.receive(exit);
    void h.web.receive(exit);
    void h.web.receive(persistPayload(h, { 'public.old_only': { x: 50, y: 50 } }));
    await vi.waitFor(() => expect(h.since('git:timeTravel:exit').length).toBeGreaterThan(0));
    await settle();
    await DiagramPanel.settle();
    expect(flowFrom(h, start, ['schema:update', 'layout:loaded', 'git:timeTravel:exit'])).toEqual(['schema:update', 'layout:loaded', 'git:timeTravel:exit']);
    expect(h.readSidecar()).toBe(WORKING_SIDECAR);
  });

  it('a second diff Exit does not unlock the stale working state over a deferred reload', async () => {
    const { h } = await withHistory();
    writeFileSync(join(h.dir, 'd.dbml'), `${DBML}\nTable c {\n  id int\n}\n`);
    await h.web.receive({ type: 'git:diff:enter' });
    await vi.waitFor(() => expect(h.web.posted.some((m) => m.type === 'git:diff:enter')).toBe(true));
    const external = sidecarText({ 'public.a': { x: 777, y: 0 }, 'public.b': { x: 400, y: 0 } });
    h.writeSidecar(external);
    await fake.fireFsEvent('change', h.sidecar);
    await settle();
    const start = h.web.posted.length;
    const exit = { type: 'git:diff:exit' };
    void h.web.receive(exit);
    void h.web.receive(exit);
    void h.web.receive(persistPayload(h, { 'public.a': { x: 0, y: 0 }, 'public.b': { x: 400, y: 0 } }));
    await vi.waitFor(() => expect(h.since('git:diff:exit').length).toBeGreaterThan(0));
    await settle();
    await DiagramPanel.settle();
    expect(flowFrom(h, start, ['layout:external-change', 'git:diff:exit'])).toEqual(['layout:external-change', 'git:diff:exit']);
    expect(h.readSidecar()).toBe(external);
  });
});

