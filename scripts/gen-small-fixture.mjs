// Generates a small DBML file with ~30 tables across 3 bounded contexts.
// Usage: node scripts/gen-small-fixture.mjs > test/fixtures/small.dbml

const CONTEXTS = ['billing', 'catalog', 'identity'];
const TABLES_PER_CONTEXT = 10;
const COLUMNS_PER_TABLE = 8;

const out = [];
out.push('// small.dbml — generated fixture for basic testing (~30 tables)\n');

for (const ctx of CONTEXTS) {
  for (let i = 0; i < TABLES_PER_CONTEXT; i++) {
    const tableName = `${ctx}_t${String(i).padStart(2, '0')}`;
    out.push(`Table ${tableName} {`);
    out.push(`  id int [pk, increment]`);
    for (let c = 0; c < COLUMNS_PER_TABLE - 1; c++) {
      out.push(`  ${pickCol(c)} ${pickType(c)}`);
    }
    out.push(`}`);
    out.push('');
  }
}

for (const ctx of CONTEXTS) {
  for (let i = 1; i < TABLES_PER_CONTEXT; i += 2) {
    const from = `${ctx}_t${String(i).padStart(2, '0')}`;
    const to = `${ctx}_t${String(i - 1).padStart(2, '0')}`;
    out.push(`Ref: ${from}.parent_id > ${to}.id`);
  }
}
out.push('');

for (const ctx of CONTEXTS) {
  out.push(`TableGroup ${ctx} {`);
  for (let i = 0; i < TABLES_PER_CONTEXT; i++) {
    out.push(`  ${ctx}_t${String(i).padStart(2, '0')}`);
  }
  out.push(`}`);
  out.push('');
}

process.stdout.write(out.join('\n'));

function pickCol(i) {
  const names = ['parent_id', 'name', 'description', 'status', 'created_at', 'updated_at', 'amount', 'code'];
  return names[i % names.length];
}
function pickType(i) {
  const types = ['int', 'varchar', 'text', 'varchar', 'timestamp', 'timestamp', 'int', 'varchar'];
  return types[i % types.length];
}
