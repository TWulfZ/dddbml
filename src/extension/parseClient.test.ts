import { describe, expect, it } from 'vitest';
import { createParseClient, type ParseJob, type ParseReply, type WorkerLike } from './parseClient';

type Handler = (arg: never) => void;

class FakeWorker implements WorkerLike {
  jobs: ParseJob[] = [];
  terminated = false;
  private handlers = new Map<string, Handler>();
  postMessage(job: ParseJob): void {
    this.jobs.push(job);
  }
  on(event: string, cb: Handler): this {
    this.handlers.set(event, cb);
    return this;
  }
  terminate(): void {
    this.terminated = true;
  }
  /** Answers the oldest unanswered job with an empty schema tagged by its source. */
  reply(): void {
    const job = this.jobs.shift()!;
    const reply: ParseReply = { id: job.id, result: { schema: { tables: [], refs: [], groups: [] }, error: null } };
    (this.handlers.get('message') as (r: ParseReply) => void)(reply);
  }
  exit(code: number): void {
    (this.handlers.get('exit') as (c: number) => void)(code);
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const client = createParseClient(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
  return { client, workers };
}

describe('createParseClient', () => {
  it('coalesces a burst on one channel: only the newest request is parsed after the in-flight one', async () => {
    const { client, workers } = setup();
    const p1 = client.parse('v1');
    const p2 = client.parse('v2');
    const p3 = client.parse('v3');
    const w = workers[0]!;
    expect(w.jobs.map((j) => j.source)).toEqual(['v1']);
    w.reply();
    expect(w.jobs.map((j) => j.source)).toEqual(['v3']);
    w.reply();
    expect(await p1).toBeNull();
    expect(await p2).toBeNull();
    expect((await p3)?.error).toBeNull();
  });

  it('keeps channels independent so a revision parse never supersedes the live document', async () => {
    const { client, workers } = setup();
    const live = client.parse('live');
    const rev = client.parse('old', 'revision');
    const w = workers[0]!;
    w.reply();
    w.reply();
    expect(await live).not.toBeNull();
    expect(await rev).not.toBeNull();
  });

  it('reports a crash as a parse error and respawns on the next request', async () => {
    const { client, workers } = setup();
    const p = client.parse('boom');
    workers[0]!.exit(1);
    expect((await p)?.error?.message).toMatch(/exited \(code 1\)/);
    const next = client.parse('ok');
    expect(workers).toHaveLength(2);
    workers[1]!.reply();
    expect((await next)?.error).toBeNull();
  });

  it('dispose terminates the worker and releases waiting callers', async () => {
    const { client, workers } = setup();
    const p1 = client.parse('a');
    const p2 = client.parse('b');
    client.dispose();
    expect(workers[0]!.terminated).toBe(true);
    expect(await p1).toBeNull();
    expect(await p2).toBeNull();
  });
});
