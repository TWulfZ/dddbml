import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { QualifiedName } from '../shared/types';
import { createParseClient, type ParseChannel, type ParseClient, type ParseOp, type ParseOps, type ParseRequest, type ParseResult, type WorkerLike } from './parseClient';

/** Sits next to extension.js in dist (second esbuild entry, spec 18 §Parse en worker). */
function spawnWorker(): WorkerLike {
  const w = new Worker(join(__dirname, 'parseWorker.js'));
  return {
    postMessage: (job) => w.postMessage(job),
    on: (event: 'message' | 'error' | 'exit', cb: (arg: never) => void) => w.on(event, cb as (arg: unknown) => void),
    terminate: () => w.terminate(),
  };
}

let spawn: () => WorkerLike = spawnWorker;
let client: ParseClient | null = null;

/** One worker for the whole extension host; parses never block the host thread. */
export function parseAsync(source: string, channel: ParseChannel): Promise<ParseResult | null> {
  client ??= createParseClient(spawn);
  return client.parse(source, channel);
}

export function locateTableAsync(source: string, table: QualifiedName, channel: ParseChannel): Promise<number | null | undefined> {
  client ??= createParseClient(spawn);
  return client.locate(source, table, channel);
}

export function parseRequest<K extends ParseOp>(request: Extract<ParseRequest, { op: K }>, channel: ParseChannel): Promise<ParseOps[K]['result'] | undefined> {
  client ??= createParseClient(spawn);
  return client.request(request, channel);
}

export function disposeParseService(): void {
  client?.dispose();
  client = null;
}

/** Tests run without a built worker bundle; they inject an in-process stand-in. */
export function setParseWorkerFactory(factory: () => WorkerLike): void {
  disposeParseService();
  spawn = factory;
}
