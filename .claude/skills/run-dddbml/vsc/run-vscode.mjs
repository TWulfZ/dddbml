// Downloads (once, into ../.vscode-test) and launches a real VS Code with this repo as the extension
// under development, then runs smoke.cjs inside its extension host. Needs a display (WSLg/X) or xvfb-run.
// Usage: node vsc/run-vscode.mjs [file.dbml]   (default: ../selfloop.dbml)
import { runTests } from '@vscode/test-electron';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const K = join(import.meta.dirname, '..');
const R = join(K, '../../..');
const ws = join(K, '.work', 'vscode-ws');
rmSync(ws, { recursive: true, force: true });
mkdirSync(ws, { recursive: true });
cpSync(process.argv[2] ?? join(K, 'selfloop.dbml'), join(ws, 'model.dbml'));

try {
  await runTests({
    cachePath: join(K, '.vscode-test'),
    extensionDevelopmentPath: R,
    extensionTestsPath: join(import.meta.dirname, 'smoke.cjs'),
    launchArgs: [ws, '--disable-extensions', '--disable-gpu', '--no-sandbox', '--user-data-dir', join(K, '.work', 'vscode-ud')],
  });
} catch (e) {
  console.error('VS Code run failed:', e);
  process.exitCode = 1;
}
console.log(readFileSync(join(K, '.work', 'vscode-smoke.txt'), 'utf8'));
