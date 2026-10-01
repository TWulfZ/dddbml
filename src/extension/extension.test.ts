import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('vscode', () => import('./testing/vscodeFake'));

import { commands, fake, Uri } from './testing/vscodeFake';
import { activate } from './extension';
import { DiagramPanel } from './panel';

let dir = '';
const context = () => ({ subscriptions: [] as unknown[], extensionUri: Uri.file('/ext'), globalStorageUri: Uri.file(join(dir, 'global')) });

beforeEach(() => {
  fake.reset();
  dir = mkdtempSync(join(tmpdir(), 'dddbml-ext-'));
  writeFileSync(join(dir, 'a.dbml'), 'Table a {\n  id int\n}\n');
  writeFileSync(join(dir, 'b.dbml'), 'Table b {\n  id int\n}\n');
  activate(context() as never);
});
afterEach(() => {
  DiagramPanel.disposeAll();
  rmSync(dir, { recursive: true, force: true });
});

describe('dddbml.openDiagram', () => {
  it('opens the file clicked in the explorer, not the active editor (F12)', async () => {
    fake.activeEditorUri = Uri.file(join(dir, 'a.dbml'));
    const clicked = Uri.file(join(dir, 'b.dbml'));
    await commands.executeCommand('dddbml.openDiagram', clicked);
    expect(DiagramPanel.get(clicked as never)).toBeDefined();
    expect(DiagramPanel.get(fake.activeEditorUri as never)).toBeUndefined();
  });

  it('opens from the explorer with no editor open (F12)', async () => {
    const clicked = Uri.file(join(dir, 'b.dbml'));
    await commands.executeCommand('dddbml.openDiagram', clicked);
    expect(DiagramPanel.get(clicked as never)).toBeDefined();
  });

  it('refuses a read-only git: view of the file instead of opening a bogus diagram (F69)', async () => {
    const path = join(dir, 'a.dbml');
    fake.activeEditorUri = Uri.parse(`git://${path}?${JSON.stringify({ path, ref: 'HEAD' })}`);
    await commands.executeCommand('dddbml.openDiagram');
    expect(fake.panels).toHaveLength(0);
    expect(fake.messages.some((m) => m.level === 'error')).toBe(true);
  });
});
