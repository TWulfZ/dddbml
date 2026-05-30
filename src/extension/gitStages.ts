import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const pexec = promisify(execFile);

/** Stage numbers in git's merge index: 1 = base/ancestor, 2 = ours, 3 = theirs. */
export type MergeStage = 1 | 2 | 3;

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await pexec('git', args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

/** Repo root containing `fsPath`, or null if it is not inside a git work tree. */
export async function getRepoRoot(fsPath: string): Promise<string | null> {
  try {
    const out = await runGit(['rev-parse', '--show-toplevel'], path.dirname(fsPath));
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Git index paths are always forward-slash and relative to the repo root. */
export function toRepoRelative(repoRoot: string, fsPath: string): string {
  return path.relative(repoRoot, fsPath).split(path.sep).join('/');
}

/** Which of stages 1/2/3 exist for `relpath` (empty set = not unmerged). */
export async function getUnmergedStages(repoRoot: string, relpath: string): Promise<Set<MergeStage>> {
  const out = await runGit(['ls-files', '-u', '--', relpath], repoRoot);
  const stages = new Set<MergeStage>();
  for (const line of out.split('\n')) {
    // `<mode> <sha> <stage>\t<path>`
    const m = /^\S+ \S+ ([123])\t/.exec(line);
    if (m) stages.add(Number(m[1]) as MergeStage);
  }
  return stages;
}

/** Raw bytes of a given merge stage, or null if that stage is absent (e.g. add/add has no base). */
export async function showStage(repoRoot: string, stage: MergeStage, relpath: string): Promise<string | null> {
  try {
    return await runGit(['show', `:${stage}:${relpath}`], repoRoot);
  } catch {
    return null;
  }
}

/** Stage the resolved file to mark the conflict resolved. Sidecar path only — never `add -A`. */
export async function gitAdd(repoRoot: string, relpath: string): Promise<void> {
  await runGit(['add', '--', relpath], repoRoot);
}
