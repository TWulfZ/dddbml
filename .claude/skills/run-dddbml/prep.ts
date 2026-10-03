// Parses a .dbml (and its sidecar, if any) with the extension's own parser and writes the payload
// the harness host replays into the webview: { schema, layout, settings }.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseDbml } from '../../../src/extension/parser';
import { parseLayout, emptyLayout } from '../../../src/extension/layoutStore';
import { defaultSettings } from '../../../src/shared/types';

const [, , dbml, out] = process.argv;
if (!dbml || !out) throw new Error('usage: prep <file.dbml> <out.json>');
const r = parseDbml(readFileSync(dbml, 'utf8'));
if (!r.schema) { console.error(r.error); process.exit(1); }
const sidecar = dbml + '.layout.json';
const layout = existsSync(sidecar) ? parseLayout(readFileSync(sidecar, 'utf8')) : emptyLayout();
writeFileSync(out, JSON.stringify({ schema: r.schema, layout, settings: defaultSettings() }));
console.log(`${out}: ${r.schema.tables.length} tables, ${r.schema.refs.length} refs`);
