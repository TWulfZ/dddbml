import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('vscode', () => import('./testing/vscodeFake'));

import { fake, workspace, type Uri } from './testing/vscodeFake';
import { DiagramPanel } from './panel';
import { parseDbml } from './parser';
import { findTableLine } from './tableLocation';
import { setParseWorkerFactory } from './parseService';
import type { ParseJob, ParseReply, WorkerLike } from './parseClient';
import { cleanupDirs, DBML, gitIn, openPanel, sidecarText } from './testing/panelHarness';

/**
 * A superseded live parse waits for the newer send (spec 18), but that send may skip (unchanged
 * payload) or abort (overlay entered, F21). A caller that must post — an overlay exit — cannot be
 * left without its schema:update.
 */

// In-process worker whose replies can be held, so the test decides which parse supersedes which.
let holding = false;
const held: ParseJob[] = [];
let reply: ((r: ParseReply) => void) | null = null;
const answer = (job: ParseJob) => reply?.(
  job.op === 'parse' ? { id: job.id, result: parseDbml(job.source) } : { id: job.id, line: findTableLine(job.source, job.table) },
);
setParseWorkerFactory((): WorkerLike => ({
  postMessage(job: ParseJob) {
    if (holding) held.push(job);
    else setImmediate(() => answer(job));
  },
  on(event: string, cb: (arg: never) => void) {
    if (event === 'message') reply = cb as (r: ParseReply) => void;
    return this;
  },
  terminate() {
    reply = null;
  },
} as WorkerLike));

beforeEach(() => {
  fake.reset();
  holding = false;
  held.length = 0;
});
afterEach(() => {
  DiagramPanel.disposeAll();
  cleanupDirs();
});

describe('sendSchema — a superseded must-post send', () => {
  it('a time-travel exit still posts the working schema when a no-op reload overtakes its parse', async () => {
    const h = await openPanel();
    const git = gitIn(h.dir);
    writeFileSync(join(h.dir, 'd.dbml'), 'Table old_only {\n  id int\n}\n');
    git('add', '-A'); git('commit', '-q', '-m', 'v0');
    const oldSha = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(h.dir, 'd.dbml'), DBML);
    h.writeSidecar(sidecarText({ 'public.a': { x: 0, y: 0 }, 'public.b': { x: 400, y: 0 } }));
    git('commit', '-q', '-am', 'v1');
    await vi.waitFor(() => expect(h.web.posted.some((m) => m.type === 'schema:update')).toBe(true));

    await h.web.receive({ type: 'git:timeTravel:enter', payload: { sha: oldSha, label: 'v0' } });
    await vi.waitFor(() => expect(h.web.posted.some((m) => m.type === 'git:timeTravel:enter')).toBe(true));

    let dbmlReads = 0;
    const read = workspace.fs.readFile;
    vi.spyOn(workspace.fs, 'readFile').mockImplementation(async (uri: Uri) => {
      const bytes = await read(uri);
      if (uri.path === h.dbml.path) dbmlReads++;
      return bytes;
    });
    holding = true;
    const start = h.web.posted.length;
    void h.web.receive({ type: 'git:timeTravel:exit' });
    await vi.waitFor(() => expect(held).toHaveLength(1)); // the exit's live parse is in flight
    // A sidecar-only event reloads the unchanged .dbml: its send skips as "already posted".
    await fake.fireFsEvent('change', h.sidecar);
    await vi.waitFor(() => expect(dbmlReads).toBe(2));
    await new Promise((r) => setImmediate(r));
    holding = false;
    for (const job of held.splice(0)) answer(job);

    await vi.waitFor(() => expect(h.web.posted.slice(start).some((m) => m.type === 'git:timeTravel:exit')).toBe(true));
    const flow = h.web.posted.slice(start).map((m) => m.type).filter((t) => t === 'schema:update' || t === 'git:timeTravel:exit');
    expect(flow).toEqual(['schema:update', 'git:timeTravel:exit']);
  });
});
