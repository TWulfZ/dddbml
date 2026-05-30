import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRepoRoot, getUnmergedStages, showStage } from './gitStages';
import { mergeThreeWay } from './mergeThreeWay';
import type { Layout } from '../shared/types';

/**
 * End-to-end check of the merge engine against a REAL git merge index (not marker text): builds a
 * temp repo where both branches move the same N tables to different spots, merges → conflict, then
 * runs the same path the extension does (gitStages → mergeThreeWay) and asserts exactly N conflicts
 * surface (the untouched tables auto-merge). Mirrors `scripts/gen-fixtures.mjs merge <N>`.
 */

const RELPATH = 'schema.dbml.layout.json';
const TABLES = 25;
const names = Array.from({ length: TABLES }, (_, i) => `public.t${String(i).padStart(2, '0')}`);

function hasGit(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function layout(posFor: (i: number) => { x: number; y: number }): string {
  const tables: Record<string, { x: number; y: number }> = {};
  names.forEach((n, i) => { tables[n] = posFor(i); });
  return JSON.stringify({ version: 1, tables, groups: {}, edges: {} }, null, 2) + '\n';
}

function buildConflictRepo(count: number): string {
  const repo = mkdtempSync(join(tmpdir(), 'dddbml-merge-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  const file = join(repo, RELPATH);
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(file, layout((i) => ({ x: i * 10, y: 0 })));
  git('add', '-A'); git('commit', '-q', '-m', 'base'); git('branch', '-M', 'main');
  git('checkout', '-q', '-b', 'ours');
  writeFileSync(file, layout((i) => (i < count ? { x: 1000 + i, y: 0 } : { x: i * 10, y: 0 })));
  git('commit', '-q', '-am', 'ours');
  git('checkout', '-q', 'main'); git('checkout', '-q', '-b', 'theirs');
  writeFileSync(file, layout((i) => (i < count ? { x: 0, y: 1000 + i } : { x: i * 10, y: 0 })));
  git('commit', '-q', '-am', 'theirs');
  git('checkout', '-q', 'ours');
  try { git('merge', '-q', 'theirs'); } catch { /* the layout conflict is expected */ }
  return repo;
}

const repos: string[] = [];
afterAll(() => { for (const r of repos) rmSync(r, { recursive: true, force: true }); });

const suite = hasGit() ? describe : describe.skip;
suite('merge conflict detection (real git merge index)', () => {
  for (const count of [3, 20]) {
    it(`surfaces exactly ${count} table conflicts; the rest auto-merge`, async () => {
      const repo = buildConflictRepo(count);
      repos.push(repo);
      const root = await getRepoRoot(join(repo, RELPATH));
      expect(root).toBeTruthy();
      const stages = await getUnmergedStages(root!, RELPATH);
      expect([...stages].sort((a, b) => a - b)).toEqual([1, 2, 3]);
      const read = async (n: 1 | 2 | 3) => JSON.parse((await showStage(root!, n, RELPATH)) ?? '{}') as Layout;
      const { conflicts } = mergeThreeWay(await read(1), await read(2), await read(3));
      expect(conflicts).toHaveLength(count);
      expect(conflicts.every((c) => c.section === 'tables')).toBe(true);
    });
  }
});
