import { parentPort } from 'node:worker_threads';
import { parseDbml } from './parser';
import { findTableLine } from './tableLocation';
import type { ParseJob, ParseReply } from './parseClient';

// Runs off the extension-host thread: @dbml/core 10.x needs ~1.8 s for 5000 tables (spec 07/18).
parentPort?.on('message', (job: ParseJob) => {
  const reply: ParseReply = job.op === 'parse'
    ? { id: job.id, result: parseDbml(job.source) }
    : { id: job.id, line: findTableLine(job.source, job.table) };
  parentPort?.postMessage(reply);
});
