import { runParseJob } from '../parseOps';
import type { ParseJob, ParseReply, WorkerLike } from '../parseClient';
import { setParseWorkerFactory } from '../parseService';

// Vitest setup: the panel parses through a worker built by esbuild, which tests don't have.
setParseWorkerFactory((): WorkerLike => {
  let onMessage: ((r: ParseReply) => void) | null = null;
  return {
    postMessage(job: ParseJob) {
      setImmediate(() => onMessage?.(runParseJob(job)));
    },
    on(event: string, cb: (arg: never) => void) {
      if (event === 'message') onMessage = cb as (r: ParseReply) => void;
      return this;
    },
    terminate() {
      onMessage = null;
    },
  } as WorkerLike;
});
