import type { QualifiedName } from '../shared/types';
import type { parseDbml } from './parser';

export type ParseResult = ReturnType<typeof parseDbml>;

/** `locate` finds a table's declaration line (go-to-source) with the same parser, off-thread too. */
export type ParseRequest = { op: 'parse'; source: string } | { op: 'locate'; source: string; table: QualifiedName };
export type ParseJob = ParseRequest & { id: number };
export type ParseReply = { id: number; result: ParseResult } | { id: number; line: number | null };

/** The subset of `node:worker_threads` Worker the client needs; injectable for tests. */
export interface WorkerLike {
  postMessage(job: ParseJob): void;
  on(event: 'message', cb: (reply: ParseReply) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'exit', cb: (code: number) => void): unknown;
  terminate(): unknown;
}

/**
 * Independent latest-wins lanes, e.g. `live:<uri>` per open diagram: a time-travel parse of an old
 * revision must not supersede the live document parse, nor one panel's parse another panel's.
 */
export type ParseChannel = string;

export interface ParseClient {
  /** Resolves `null` when a newer request on the same channel superseded this one. */
  parse(source: string, channel?: ParseChannel): Promise<ParseResult | null>;
  /** 0-based declaration line, `null` if absent, `undefined` when superseded. */
  locate(source: string, table: QualifiedName, channel: ParseChannel): Promise<number | null | undefined>;
  dispose(): void;
}

interface Job {
  id: number;
  channel: ParseChannel;
  request: ParseRequest;
  resolve: (r: ParseReply | null) => void;
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

  const settle = (job: Job, reply: ParseReply): void => {
    job.resolve(latestId.get(job.channel) === job.id ? reply : null);
  };

  const ensureWorker = (): WorkerLike => {
    if (worker) return worker;
    const w = spawn();
    const crash = (message: string): void => {
      if (worker !== w) return;
      worker = null;
      const job = inFlight;
      inFlight = null;
      if (job) {
        settle(job, job.request.op === 'parse' ? { id: job.id, result: { schema: null, error: { message } } } : { id: job.id, line: null });
      }
      pump();
    };
    w.on('message', (reply) => {
      if (worker !== w || !inFlight || reply.id !== inFlight.id) return;
      const job = inFlight;
      inFlight = null;
      settle(job, reply);
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
    ensureWorker().postMessage({ ...job.request, id: job.id });
  };

  const run = (request: ParseRequest, channel: ParseChannel): Promise<ParseReply | null> => {
    if (disposed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = nextId++;
      latestId.set(channel, id);
      pending.get(channel)?.resolve(null);
      pending.set(channel, { id, channel, request, resolve });
      pump();
    });
  };

  return {
    async parse(source, channel = 'live') {
      const reply = await run({ op: 'parse', source }, channel);
      return reply && 'result' in reply ? reply.result : null;
    },
    async locate(source, table, channel) {
      const reply = await run({ op: 'locate', source, table }, channel);
      return reply && 'line' in reply ? reply.line : undefined;
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
