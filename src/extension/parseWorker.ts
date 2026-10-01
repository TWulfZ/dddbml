import { parentPort } from 'node:worker_threads';
import { parseDbml } from './parser';
import type { ParseJob, ParseReply } from './parseClient';

// Runs off the extension-host thread: @dbml/core 10.x needs ~1.8 s for 5000 tables (spec 07/18).
parentPort?.on('message', (job: ParseJob) => {
  const reply: ParseReply = { id: job.id, result: parseDbml(job.source) };
  parentPort?.postMessage(reply);
});
