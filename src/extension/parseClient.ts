import type { parseDbml } from './parser';

export type ParseResult = ReturnType<typeof parseDbml>;

export interface ParseJob {
  id: number;
  source: string;
}

export interface ParseReply {
  id: number;
  result: ParseResult;
}

/** The subset of `node:worker_threads` Worker the client needs; injectable for tests. */
export interface WorkerLike {
  postMessage(job: ParseJob): void;
  on(event: 'message', cb: (reply: ParseReply) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'exit', cb: (code: number) => void): unknown;
  terminate(): unknown;
}

/**
 * Independent latest-wins lanes: a time-travel parse of an old revision must not supersede the
 * live document parse (or vice versa).
 */
export type ParseChannel = 'live' | 'revision' | 'base';

export interface ParseClient {
  /** Resolves `null` when a newer request on the same channel superseded this one. */
  parse(source: string, channel?: ParseChannel): Promise<ParseResult | null>;
  dispose(): void;
}

interface Job {
  id: number;
  channel: ParseChannel;
  source: string;
  resolve: (r: ParseResult | null) => void;
}

/**
 * Serializes parses through one persistent worker. Only the newest pending request per channel is
 * kept, so a burst of saves costs at most one in-flight parse plus one queued parse instead of N.
 */
export function createParseClient(spawn: () => WorkerLike): ParseClient {
  let worker: WorkerLike | null = null;
  let inFlight: Job | null = null;
  const pending = new Map<ParseChannel, Job>();
  const latestId = new Map<ParseChannel, number>();
  let nextId = 1;
  let disposed = false;

  const settle = (job: Job, result: ParseResult): void => {
    job.resolve(latestId.get(job.channel) === job.id ? result : null);
  };

  const ensureWorker = (): WorkerLike => {
    if (worker) return worker;
    const w = spawn();
    const crash = (message: string): void => {
      if (worker !== w) return;
      worker = null;
      const job = inFlight;
      inFlight = null;
      if (job) settle(job, { schema: null, error: { message } });
      pump();
    };
    w.on('message', (reply) => {
      if (worker !== w || !inFlight || reply.id !== inFlight.id) return;
      const job = inFlight;
      inFlight = null;
      settle(job, reply.result);
      pump();
    });
    w.on('error', (err) => crash(`dddbml parser worker failed: ${err.message}`));
    w.on('exit', (code) => crash(`dddbml parser worker exited (code ${code})`));
    worker = w;
    return w;
  };

  const pump = (): void => {
    if (disposed || inFlight) return;
    const next = pending.values().next();
    if (next.done) return;
    const job = next.value;
    pending.delete(job.channel);
    inFlight = job;
    ensureWorker().postMessage({ id: job.id, source: job.source });
  };

  return {
    parse(source, channel = 'live') {
      if (disposed) return Promise.resolve(null);
      return new Promise((resolve) => {
        const id = nextId++;
        latestId.set(channel, id);
        pending.get(channel)?.resolve(null);
        pending.set(channel, { id, channel, source, resolve });
        pump();
      });
    },
    dispose() {
      disposed = true;
      for (const job of pending.values()) job.resolve(null);
      pending.clear();
      inFlight?.resolve(null);
      inFlight = null;
      const w = worker;
      worker = null;
      w?.terminate();
    },
  };
}
