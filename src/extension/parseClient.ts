import type { QualifiedName } from '../shared/types';
import type { parseDbml } from './parser';
import type { SchemaEditIntent, SchemaEditResult } from './schemaEdits';
import type { TableDeclarationRange } from './tableLocation';

export type ParseResult = ReturnType<typeof parseDbml>;

/**
 * Everything that needs `@dbml/core` runs in the worker (spec 18): the parse itself and every source
 * lookup or edit computed from it (go-to-source, document links, spec 19 schema edits).
 */
export interface ParseOps {
  parse: { request: { source: string }; result: ParseResult };
  /** 0-based `Table` declaration line. */
  locate: { request: { source: string; table: QualifiedName }; result: number | null };
  /** 0-based position of a column's name. */
  locateColumn: { request: { source: string; table: QualifiedName; column: string }; result: { line: number; character: number } | null };
  tableLinks: { request: { source: string }; result: TableDeclarationRange[] };
  schemaEdit: { request: { source: string; intent: SchemaEditIntent }; result: SchemaEditResult };
}
export type ParseOp = keyof ParseOps;
export type ParseRequest = { [K in ParseOp]: { op: K } & ParseOps[K]['request'] }[ParseOp];
export type ParseJob = ParseRequest & { id: number };
export type ParseReply = { [K in ParseOp]: { id: number; op: K; value: ParseOps[K]['result'] } }[ParseOp];

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
  /** Any op; `undefined` when superseded. */
  request<K extends ParseOp>(request: Extract<ParseRequest, { op: K }>, channel: ParseChannel): Promise<ParseOps[K]['result'] | undefined>;
  dispose(): void;
}

/** What a request resolves to when the worker dies under it. */
function crashReply(job: Job, message: string): ParseReply {
  const id = job.id;
  switch (job.request.op) {
    case 'parse': return { id, op: 'parse', value: { schema: null, error: { message } } };
    case 'locate': return { id, op: 'locate', value: null };
    case 'locateColumn': return { id, op: 'locateColumn', value: null };
    case 'tableLinks': return { id, op: 'tableLinks', value: [] };
    case 'schemaEdit': return { id, op: 'schemaEdit', value: { ok: false, reason: message } };
  }
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
      if (job) settle(job, crashReply(job, message));
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

  const request = async <K extends ParseOp>(req: Extract<ParseRequest, { op: K }>, channel: ParseChannel): Promise<ParseOps[K]['result'] | undefined> => {
    const reply = await run(req, channel);
    // The worker answers each job with its own op; TS cannot correlate the two unions.
    return reply && reply.op === req.op ? (reply.value as ParseOps[K]['result']) : undefined;
  };

  return {
    async parse(source, channel = 'live') {
      return (await request({ op: 'parse', source }, channel)) ?? null;
    },
    locate(source, table, channel) {
      return request({ op: 'locate', source, table }, channel);
    },
    request,
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
