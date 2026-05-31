// Unified fixture generator for dddbml.
//
//   node scripts/gen-fixtures.mjs small            > test/fixtures/small.dbml   (~30 tables)
//   node scripts/gen-fixtures.mjs huge             > test/fixtures/huge.dbml    (~5000 tables)
//   node scripts/gen-fixtures.mjs merge <count>                                  (real git conflict)
//
// The `merge` mode builds a REAL git-conflicted layout sidecar under test/fixtures/merge-conflicts/<count>/ so the
// collaborative-merge resolver (spec 14) can be exercised by hand: the engine reads git's merge-index
// stages :1:/:2:/:3:, so static marker text alone won't trigger it — we manufacture an actual merge.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COLUMNS_PER_TABLE = 8;

const SMALL = {
  contexts: ['billing', 'catalog', 'identity'],
  perContext: 10,
  pad: 2,
  refStride: 2,
  header: '// small.dbml — generated fixture for basic testing (~30 tables)\n',
};
const HUGE = {
  contexts: [
    'billing', 'catalog', 'identity', 'orders', 'inventory', 'shipping',
    'payments', 'analytics', 'notifications', 'audit', 'auth', 'reporting',
    'logistics', 'pricing', 'loyalty', 'risk', 'messaging', 'crm',
    'content', 'search',
  ],
  perContext: 250,
  pad: 4,
  refStride: 5,
  header: '// huge.dbml — generated fixture for perf testing (~5000 tables)\n',
};

const COL_NAMES = ['parent_id', 'name', 'description', 'status', 'created_at', 'updated_at', 'amount', 'code'];
const COL_TYPES = ['int', 'varchar', 'text', 'varchar', 'timestamp', 'timestamp', 'int', 'varchar'];

function tableNames({ contexts, perContext, pad }) {
  const names = [];
  for (const ctx of contexts) {
    for (let i = 0; i < perContext; i++) names.push(`${ctx}_t${String(i).padStart(pad, '0')}`);
  }
  return names;
}

function genSchema(cfg) {
  const { contexts, perContext, pad, refStride, header } = cfg;
  const out = [header];
  for (const ctx of contexts) {
    for (let i = 0; i < perContext; i++) {
      out.push(`Table ${ctx}_t${String(i).padStart(pad, '0')} {`);
      out.push(`  id int [pk, increment]`);
      for (let c = 0; c < COLUMNS_PER_TABLE - 1; c++) out.push(`  ${COL_NAMES[c % COL_NAMES.length]} ${COL_TYPES[c % COL_TYPES.length]}`);
      out.push(`}`);
      out.push('');
    }
  }
  for (const ctx of contexts) {
    for (let i = 1; i < perContext; i += refStride) {
      out.push(`Ref: ${ctx}_t${String(i).padStart(pad, '0')}.parent_id > ${ctx}_t${String(i - 1).padStart(pad, '0')}.id`);
    }
  }
  out.push('');
  for (const ctx of contexts) {
    out.push(`TableGroup ${ctx} {`);
    for (let i = 0; i < perContext; i++) out.push(`  ${ctx}_t${String(i).padStart(pad, '0')}`);
    out.push(`}`);
    out.push('');
  }
  return out.join('\n');
}

/** Serialize a layout sidecar (shared form: version, sorted table x/y, empty groups/edges). */
function layoutJson(qualified, posFor) {
  const byName = new Map();
  qualified.forEach((name, i) => byName.set(name, posFor(name, i)));
  const tables = {};
  for (const name of [...byName.keys()].sort()) {
    const p = byName.get(name);
    tables[name] = { x: Math.round(p.x), y: Math.round(p.y) };
  }
  return JSON.stringify({ version: 1, tables, groups: {}, edges: {} }, null, 2) + '\n';
}

// Base = a tidy grid. Conflicting tables are shoved to two clearly-separate staging areas (ours
// top-right, theirs bottom-left) so a diff frames two far-apart ghosts — exercising the camera's
// "fit both, clamped" path. Non-conflicting tables stay on the grid (auto-merged).
const gridPos = (i) => ({ x: (i % 6) * 280, y: Math.floor(i / 6) * 220 });
const oursPos = (i) => ({ x: 1800 + (i % 5) * 260, y: Math.floor(i / 5) * 220 });
const theirsPos = (i) => ({ x: (i % 5) * 260, y: 1800 + Math.floor(i / 5) * 220 });

function genMergeFixture(count) {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const repo = join(projectRoot, 'test', 'fixtures', 'merge-conflicts', String(count));
  const names = tableNames(SMALL).map((n) => `public.${n}`);
  if (count < 1 || count > names.length) {
    console.error(`count must be between 1 and ${names.length} (small.dbml has ${names.length} tables)`);
    process.exit(1);
  }

  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  const layoutPath = join(repo, 'schema.dbml.layout.json');

  git('init', '-q');
  git('config', 'user.email', 'fixture@dddbml.test');
  git('config', 'user.name', 'dddbml fixture');

  writeFileSync(join(repo, 'schema.dbml'), genSchema(SMALL));
  writeFileSync(layoutPath, layoutJson(names, (_n, i) => gridPos(i)));
  git('add', '-A');
  git('commit', '-q', '-m', 'base layout');
  git('branch', '-M', 'main');

  git('checkout', '-q', '-b', 'ours');
  writeFileSync(layoutPath, layoutJson(names, (_n, i) => (i < count ? oursPos(i) : gridPos(i))));
  git('commit', '-q', '-am', `ours: move ${count} table(s)`);

  git('checkout', '-q', 'main');
  git('checkout', '-q', '-b', 'theirs');
  writeFileSync(layoutPath, layoutJson(names, (_n, i) => (i < count ? theirsPos(i) : gridPos(i))));
  git('commit', '-q', '-am', `theirs: move the same ${count} table(s)`);

  git('checkout', '-q', 'ours');
  try { git('merge', '-q', 'theirs'); } catch { /* the layout conflict is expected */ }

  const ls = execFileSync('git', ['ls-files', '-u', '--', 'schema.dbml.layout.json'], { cwd: repo }).toString();
  const stages = new Set([...ls.matchAll(/ ([123])\t/g)].map((m) => m[1]));
  if (stages.size < 3) {
    console.error(`✗ expected merge stages 1/2/3, got {${[...stages].join(',')}} — fixture not conflicted`);
    process.exit(1);
  }

  console.log(`✓ conflicted fixture ready: ${repo}`);
  console.log(`  schema: 30 tables · conflicts: ${count} (the rest auto-merge)`);
  console.log(`  open it: launch the Extension Dev Host (F5), open ${join(repo, 'schema.dbml')}, run "dddbml: Open Diagram"`);
}

const mode = process.argv[2];
if (mode === 'small') process.stdout.write(genSchema(SMALL));
else if (mode === 'huge') process.stdout.write(genSchema(HUGE));
else if (mode === 'merge') genMergeFixture(Number(process.argv[3] ?? 3));
else {
  console.error('usage: node scripts/gen-fixtures.mjs <small|huge|merge> [count]');
  process.exit(1);
}
