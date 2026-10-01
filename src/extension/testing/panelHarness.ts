/**
 * Drives a real DiagramPanel (real fs, real parser, real git) through the fake vscode surface.
 * The importing test file must call `vi.mock('vscode', () => import('./testing/vscodeFake'))`.
 */
import { expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fake, Uri, type FakeWebviewPanel } from './vscodeFake';
import { DiagramPanel } from '../panel';
import type { Layout } from '../../shared/types';

export const DBML = `Table a {\n  id int\n}\n\nTable b {\n  id int\n}\n`;

export function sidecarText(tables: Record<string, { x: number; y: number }>): string {
  const keys = Object.keys(tables).sort();
  const rows = keys.map((k, i) => `    ${JSON.stringify(k)}: { "x": ${tables[k]!.x}, "y": ${tables[k]!.y} }${i < keys.length - 1 ? ',' : ''}`);
  return ['{', '  "version": 1,', '  "tables": {', ...rows, '  },', '  "groups": {', '  },', '  "edges": {}', '}', ''].join('\n');
}

export interface Harness {
  dir: string;
  dbml: Uri;
  sidecar: Uri;
  web: FakeWebviewPanel;
  panel: DiagramPanel;
  writeSidecar(text: string): void;
  readSidecar(): string;
  /** Messages of `type` posted since the last `mark()`. */
  since(type: string): Array<{ type: string; payload?: unknown }>;
  mark(): void;
}

const dirs: string[] = [];

export function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dddbml-panel-'));
  dirs.push(dir);
  return dir;
}

/** `reuseDir` reopens an existing diagram (same files, same view-state store) as-is. */
export async function openPanel(opts: { dbml?: string; sidecar?: string | null; reuseDir?: string } = {}): Promise<Harness> {
  const dir = opts.reuseDir ?? newDir();
  if (!opts.reuseDir) {
    writeFileSync(join(dir, 'd.dbml'), opts.dbml ?? DBML);
    if (opts.sidecar !== null) writeFileSync(join(dir, 'd.dbml.layout.json'), opts.sidecar ?? sidecarText({ 'public.a': { x: 0, y: 0 }, 'public.b': { x: 400, y: 0 } }));
  }
  const dbml = Uri.file(join(dir, 'd.dbml'));
  const context = { extensionUri: Uri.file('/ext'), globalStorageUri: Uri.file(join(dir, 'global')) };
  DiagramPanel.createOrShow(context as never, dbml as never);
  const web = fake.panels[fake.panels.length - 1]!;
  const panel = DiagramPanel.get(dbml as never)!;
  let markAt = 0;
  const h: Harness = {
    dir,
    dbml,
    sidecar: Uri.file(join(dir, 'd.dbml.layout.json')),
    web,
    panel,
    writeSidecar: (text) => writeFileSync(join(dir, 'd.dbml.layout.json'), text),
    readSidecar: () => readFileSync(join(dir, 'd.dbml.layout.json'), 'utf8'),
    since: (type) => web.posted.slice(markAt).filter((m) => m.type === type),
    mark: () => { markAt = web.posted.length; },
  };
  await web.receive({ type: 'ready' });
  await vi.waitFor(() => expect(web.posted.some((m) => m.type === 'exporters:list')).toBe(true));
  return h;
}

export function cleanupDirs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function tablesOf(msg: { payload?: unknown } | undefined): Layout['tables'] {
  return msg ? (msg.payload as Layout).tables : {};
}

export type Git = (...args: string[]) => string;

export function gitIn(dir: string): Git {
  const git: Git = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  return git;
}

/** A diagram whose sidecar is mid-merge: `main` moved a to x=111, `other` moved it to x=222. */
export function conflictedRepo(): { dir: string; git: Git } {
  const dir = newDir();
  writeFileSync(join(dir, 'd.dbml'), DBML);
  writeFileSync(join(dir, 'd.dbml.layout.json'), sidecarText({ 'public.a': { x: 0, y: 0 }, 'public.b': { x: 400, y: 0 } }));
  const git = gitIn(dir);
  git('add', '-A'); git('commit', '-q', '-m', 'base'); git('branch', '-M', 'main');
  git('checkout', '-q', '-b', 'other');
  writeFileSync(join(dir, 'd.dbml.layout.json'), sidecarText({ 'public.a': { x: 222, y: 0 }, 'public.b': { x: 400, y: 0 } }));
  git('commit', '-q', '-am', 'other moved a');
  git('checkout', '-q', 'main');
  writeFileSync(join(dir, 'd.dbml.layout.json'), sidecarText({ 'public.a': { x: 111, y: 0 }, 'public.b': { x: 400, y: 0 } }));
  git('commit', '-q', '-am', 'main moved a');
  try { git('merge', '-q', 'other'); } catch { /* the layout conflict is expected */ }
  return { dir, git };
}

export function persistPayload(h: Harness, tables: Layout['tables']): { type: 'layout:persist'; payload: Layout } {
  const loaded = h.web.posted.find((m) => m.type === 'layout:loaded')!;
  return { type: 'layout:persist', payload: { ...(loaded.payload as Layout), tables } };
}

export const settle = (ms = 400): Promise<void> => new Promise((r) => setTimeout(r, ms));
