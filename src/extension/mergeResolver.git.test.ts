import { afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('vscode', () => import('./testing/vscodeFake'));

import { Uri } from './testing/vscodeFake';
import { detectSidecarConflict } from './mergeResolver';

function hasGit(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const SIDE = 'd.dbml.layout.json';
const sidecar = (ax: number) =>
  `{\n  "version": 1,\n  "tables": {\n    "public.a": { "x": ${ax}, "y": 0 },\n    "public.b": { "x": 400, "y": 0 }\n  },\n  "groups": {\n  },\n  "edges": {}\n}\n`;

const repos: string[] = [];
afterAll(() => { for (const r of repos) rmSync(r, { recursive: true, force: true }); });

const suite = hasGit() ? describe : describe.skip;

suite('detectSidecarConflict (real git merge index)', () => {
  it('refuses a stage that is not a clean layout instead of treating it as empty', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'dddbml-stage-'));
    repos.push(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(join(repo, 'd.dbml'), 'Table a { id int }\n');
    writeFileSync(join(repo, SIDE), sidecar(0));
    git('add', '-A'); git('commit', '-q', '-m', 'base'); git('branch', '-M', 'main');
    git('checkout', '-q', '-b', 'feat');
    // A sidecar committed with leftover conflict markers: not a layout at all.
    writeFileSync(join(repo, SIDE), sidecar(0).replace('"public.a"', '<<<<<<< HEAD\n"public.a"'));
    git('commit', '-q', '-am', 'broken');
    git('checkout', '-q', 'main');
    writeFileSync(join(repo, SIDE), sidecar(50));
    git('commit', '-q', '-am', 'move a');
    try { git('merge', '-q', 'feat'); } catch { /* conflict expected */ }

    await expect(detectSidecarConflict(Uri.file(join(repo, 'd.dbml')) as never)).rejects.toThrow();
  });
});
