import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const pexec = promisify(execFile);

/** Stage numbers in git's merge index: 1 = base/ancestor, 2 = ours, 3 = theirs. */
export type MergeStage = 1 | 2 | 3;

/** Working-tree status of a single diagram file, as surfaced to the webview Git panel. */
export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';

export interface GitPathStatus {
  /** Repo-relative, forward-slash path. */
  relpath: string;
  status: GitFileStatus;
}

/** One commit touching the diagram files, machine-parsed from `git log`. */
export interface GitCommitMeta {
  sha: string;
  shortSha: string;
  author: string;
  /** ISO short date (YYYY-MM-DD). */
  date: string;
  subject: string;
}

/** One stash entry. `ref` is the addressable name (`stash@{N}`); `index` is N. */
export interface GitStashEntry {
  ref: string;
  index: number;
  message: string;
}

/** Low-level git runner. Captures stdout; throws on non-zero exit. */
export async function runGit(args: string[], cwd: string): Promise<string> {
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

/** Contents of `relpath` at an arbitrary revision (`HEAD`, a sha, a branch, or `:N` for a stage),
 *  or null if the path is absent at that rev. The read-only primitive behind virtual time-travel and
 *  diff: it never touches the working tree. */
export async function showBlob(repoRoot: string, rev: string, relpath: string): Promise<string | null> {
  try {
    return await runGit(['show', `${rev}:${relpath}`], repoRoot);
  } catch {
    return null;
  }
}

/** Raw bytes of a given merge stage, or null if that stage is absent (e.g. add/add has no base). */
export async function showStage(repoRoot: string, stage: MergeStage, relpath: string): Promise<string | null> {
  return showBlob(repoRoot, `:${stage}`, relpath);
}

/** Stage the resolved file to mark the conflict resolved. Sidecar path only — never `add -A`. */
export async function gitAdd(repoRoot: string, relpath: string): Promise<void> {
  await runGit(['add', '--', relpath], repoRoot);
}

/** Current branch name, or null when detached / not a repo. */
export async function getCurrentBranch(repoRoot: string): Promise<string | null> {
  try {
    const out = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot)).trim();
    return out && out !== 'HEAD' ? out : null;
  } catch {
    return null;
  }
}

/** Porcelain working-tree status for the given paths. Only CHANGED paths are returned (a clean file
 *  has no entry), so the caller treats a non-empty result as "dirty". Best-effort: [] on error. */
export async function gitStatusPorcelain(repoRoot: string, relpaths: string[]): Promise<GitPathStatus[]> {
  if (relpaths.length === 0) return [];
  try {
    const out = await runGit(['status', '--porcelain=v1', '--', ...relpaths], repoRoot);
    const result: GitPathStatus[] = [];
    for (const line of out.split('\n')) {
      if (line.length < 4) continue;
      const code = line.slice(0, 2);
      const relpath = line.slice(3).trim();
      result.push({ relpath, status: classifyPorcelain(code) });
    }
    return result;
  } catch {
    return [];
  }
}

function classifyPorcelain(code: string): GitFileStatus {
  if (code === '??') return 'untracked';
  if (code.includes('R')) return 'renamed';
  if (code.includes('A')) return 'added';
  if (code.includes('D')) return 'deleted';
  return 'modified';
}

/** Commits touching the given paths, newest first. Best-effort: [] on error. */
export async function gitLog(repoRoot: string, relpaths: string[], limit = 50): Promise<GitCommitMeta[]> {
  if (relpaths.length === 0) return [];
  try {
    // \x1f (unit separator) between fields — robust against spaces/pipes in subjects.
    const fmt = ['%H', '%h', '%an', '%ad', '%s'].join('%x1f');
    const out = await runGit(
      ['log', `--max-count=${limit}`, '--date=short', `--pretty=format:${fmt}`, '--', ...relpaths],
      repoRoot,
    );
    const commits: GitCommitMeta[] = [];
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [sha, shortSha, author, date, ...rest] = line.split('\x1f');
      if (!sha) continue;
      commits.push({ sha, shortSha: shortSha ?? sha.slice(0, 7), author: author ?? '', date: date ?? '', subject: rest.join('\x1f') });
    }
    return commits;
  } catch {
    return [];
  }
}

/** Stage + commit ONLY the given paths (working-tree content), leaving any other staged changes
 *  untouched. Scoped by design — never `add -A` / `commit -a`. Throws on git failure so the caller
 *  can surface the message (e.g. "nothing to commit", missing identity). */
export async function gitCommit(repoRoot: string, relpaths: string[], message: string): Promise<void> {
  if (relpaths.length === 0) throw new Error('no paths to commit');
  await runGit(['add', '--', ...relpaths], repoRoot);
  await runGit(['commit', '-m', message, '--', ...relpaths], repoRoot);
}

/** Discard working-tree changes to the given (tracked) paths, restoring them to HEAD. DESTRUCTIVE —
 *  uncommitted edits are lost. Untracked paths have no HEAD version; the caller filters those out.
 *  Throws on git failure. */
export async function gitRestore(repoRoot: string, relpaths: string[]): Promise<void> {
  if (relpaths.length === 0) throw new Error('no paths to restore');
  await runGit(['checkout', 'HEAD', '--', ...relpaths], repoRoot);
}

/** Stash the working-tree changes to the given paths (scoped — never the whole repo). Throws on
 *  git failure. With no matching changes git is a no-op (exit 0). */
export async function gitStashPush(repoRoot: string, relpaths: string[], message?: string): Promise<void> {
  if (relpaths.length === 0) throw new Error('no paths to stash');
  const msgArgs = message && message.trim() ? ['-m', message.trim()] : [];
  await runGit(['stash', 'push', ...msgArgs, '--', ...relpaths], repoRoot);
}

/** All stash entries, newest first. Best-effort: [] on error. (Stashes are repo-global, not per-file.) */
export async function gitStashList(repoRoot: string): Promise<GitStashEntry[]> {
  try {
    const out = await runGit(['stash', 'list', '--pretty=format:%gd%x1f%s'], repoRoot);
    const entries: GitStashEntry[] = [];
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [ref, ...rest] = line.split('\x1f');
      if (!ref) continue;
      const m = /stash@\{(\d+)\}/.exec(ref);
      entries.push({ ref, index: m ? Number(m[1]) : entries.length, message: rest.join('\x1f') });
    }
    return entries;
  } catch {
    return [];
  }
}

/** Re-apply a stash, keeping it in the stash list. May conflict (markers) — handled downstream. */
export async function gitStashApply(repoRoot: string, ref: string): Promise<void> {
  await runGit(['stash', 'apply', ref], repoRoot);
}

/** Re-apply a stash and drop it from the list. May conflict (markers) — handled downstream. */
export async function gitStashPop(repoRoot: string, ref: string): Promise<void> {
  await runGit(['stash', 'pop', ref], repoRoot);
}
