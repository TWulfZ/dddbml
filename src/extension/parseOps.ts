import type { ParseJob, ParseReply } from './parseClient';
import { parseDbml } from './parser';
import { computeSchemaEdit } from './schemaEdits';
import { findColumnLocation, findTableLine, findTableNameRanges } from './tableLocation';

/** The worker's dispatcher; also run in-process by the test setup, which has no worker bundle. */
export function runParseJob(job: ParseJob): ParseReply {
  const id = job.id;
  switch (job.op) {
    case 'parse': return { id, op: 'parse', value: parseDbml(job.source) };
    case 'locate': return { id, op: 'locate', value: findTableLine(job.source, job.table) };
    case 'locateColumn': return { id, op: 'locateColumn', value: findColumnLocation(job.source, job.table, job.column) };
    case 'tableLinks': return { id, op: 'tableLinks', value: findTableNameRanges(job.source) };
    case 'schemaEdit': return { id, op: 'schemaEdit', value: computeSchemaEdit(job.source, job.intent) };
  }
}
