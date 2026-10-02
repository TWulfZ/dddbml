import { parentPort } from 'node:worker_threads';
import { runParseJob } from './parseOps';
import type { ParseJob } from './parseClient';

// Runs off the extension-host thread: @dbml/core 10.x needs ~1.8 s for 5000 tables (spec 07/18).
parentPort?.on('message', (job: ParseJob) => {
  parentPort?.postMessage(runParseJob(job));
});
