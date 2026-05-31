import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getCurrentBranch,
  getRepoRoot,
  gitCommit,
  gitLog,
  gitRestore,
  gitStashList,
  gitStashPop,
  gitStashPush,
  gitStatusPorcelain,
  showBlob,
} from './gitStages';

/**
 * Integration check of the Phase-1/2/3 git harness against a REAL repo (temp dir). Verifies the
 * diagram-files-only scoping (a commit touches only the named paths), blob reads at a rev,
 * porcelain status parsing, log parsing, stash round-trip, and restore. Skipped when git is absent.
 */

const DBML = 'schema.dbml';
const SIDE = 'schema.dbml.layout.json';

function hasGit(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function newRepo(): { repo: string; git: (...a: string[]) => string } {
  const repo = mkdtempSync(join(tmpdir(), 'dddbml-git-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 'tester');
  git('checkout', '-q', '-b', 'main');
  return { repo, git };
}

const repos: string[] = [];
afterAll(() => { for (const r of repos) rmSync(r, { recursive: true, force: true }); });

const suite = hasGit() ? describe : describe.skip;

suite('git harness (real repo)', () => {
  it('reports branch, scoped status, scoped commit, and log', async () => {
    const { repo, git } = newRepo();
    repos.push(repo);
    writeFileSync(join(repo, DBML), 'Table users { id int }\n');
    writeFileSync(join(repo, SIDE), '{"version":1,"tables":{}}\n');
    writeFileSync(join(repo, 'OTHER.txt'), 'unrelated\n');
    git('add', 'OTHER.txt'); git('commit', '-q', '-m', 'seed other');

    const root = (await getRepoRoot(join(repo, DBML)))!;
    expect(root).toBeTruthy();
    expect(await getCurrentBranch(root)).toBe('main');

    // Both diagram files are untracked; OTHER.txt change must NOT appear in scoped status.
    writeFileSync(join(repo, 'OTHER.txt'), 'changed\n');
    const status = await gitStatusPorcelain(root, [DBML, SIDE]);
    const names = status.map((s) => s.relpath).sort();
    expect(names).toEqual([DBML, SIDE]);
    expect(status.every((s) => s.status === 'untracked')).toBe(true);

    // Scoped commit: only the diagram files land; OTHER.txt stays modified (uncommitted).
    await gitCommit(root, [DBML, SIDE], 'add diagram');
    const after = await gitStatusPorcelain(root, [DBML, SIDE]);
    expect(after).toHaveLength(0); // diagram clean
    expect(git('status', '--porcelain')).toContain('OTHER.txt'); // still dirty

    const log = await gitLog(root, [DBML, SIDE]);
    expect(log[0]?.subject).toBe('add diagram');
    expect(log[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reads a blob at HEAD and restores working changes', async () => {
    const { repo, git } = newRepo();
    repos.push(repo);
    writeFileSync(join(repo, DBML), 'Table a { id int }\n');
    git('add', DBML); git('commit', '-q', '-m', 'v1');

    expect(await showBlob(repo, 'HEAD', DBML)).toBe('Table a { id int }\n');
    expect(await showBlob(repo, 'HEAD', 'missing.dbml')).toBeNull();

    writeFileSync(join(repo, DBML), 'Table a { id int\n name varchar }\n');
    await gitRestore(repo, [DBML]);
    expect(readFileSync(join(repo, DBML), 'utf8')).toBe('Table a { id int }\n');
  });

  it('stashes scoped changes and pops them back', async () => {
    const { repo, git } = newRepo();
    repos.push(repo);
    writeFileSync(join(repo, DBML), 'Table a { id int }\n');
    git('add', DBML); git('commit', '-q', '-m', 'v1');

    writeFileSync(join(repo, DBML), 'Table a { id int\n email varchar }\n');
    await gitStashPush(repo, [DBML], 'wip');
    // After stashing, the file is back to HEAD.
    expect(readFileSync(join(repo, DBML), 'utf8')).toBe('Table a { id int }\n');

    const list = await gitStashList(repo);
    expect(list).toHaveLength(1);
    expect(list[0]?.ref).toMatch(/stash@\{0\}/);

    await gitStashPop(repo, list[0]!.ref);
    expect(readFileSync(join(repo, DBML), 'utf8')).toContain('email varchar');
    expect(await gitStashList(repo)).toHaveLength(0);
  });
});
