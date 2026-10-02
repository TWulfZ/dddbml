import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('vscode', () => import('./testing/vscodeFake'));

import { commands, fake, FakeMemento, Uri } from './testing/vscodeFake';
import { activate } from './extension';
import { DiagramPanel } from './panel';

let dir = '';
const context = () => ({ subscriptions: [] as unknown[], extensionUri: Uri.file('/ext'), globalStorageUri: Uri.file(join(dir, 'global')), globalState: new FakeMemento() });

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

describe('dddbml.autoArrange', () => {
  it('offers no "place new tables" scope: new tables are placed as soon as they appear (F19b)', async () => {
    const uri = Uri.file(join(dir, 'a.dbml'));
    await commands.executeCommand('dddbml.openDiagram', uri);
    await commands.executeCommand('dddbml.autoArrange');
    expect(fake.quickPicks).toHaveLength(1);
    expect(fake.quickPicks[0]!.map((i) => i.label)).toEqual(['Re-arrange all', 'Re-arrange selection', 'Order edges only']);
  });
});

describe('code → diagram links (spec 19)', () => {
  it('links each Table declaration name to dddbml.revealInDiagram', async () => {
    writeFileSync(join(dir, 'c.dbml'), '// Table ghost\nTable "auth"."users" {\n  id int\n}\n');
    const doc = await fake.document(Uri.file(join(dir, 'c.dbml')));
    expect(fake.linkProviders).toHaveLength(1);
    const links = await fake.linkProviders[0]!.provider.provideDocumentLinks(doc);
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link.range.start).toMatchObject({ line: 1, character: 6 });
    expect(link.range.end).toMatchObject({ line: 1, character: 20 });
    expect(link.tooltip).toBe('Show in diagram');
    expect(link.target?.scheme).toBe('command');
    expect(link.target?.path).toBe('dddbml.revealInDiagram');
    expect(JSON.parse(link.target!.query)).toEqual([doc.uri.toString(), 'auth.users']);
  });

  it('opens the diagram for that file and focuses the table once the webview is ready', async () => {
    const uri = Uri.file(join(dir, 'a.dbml'));
    await commands.executeCommand('dddbml.revealInDiagram', uri.toString(), 'public.a');
    const web = fake.panels[0]!;
    expect(web.posted.some((m) => m.type === 'diagram:focusTable')).toBe(false);
    await web.receive({ type: 'ready' });
    await vi.waitFor(() => expect(web.posted.find((m) => m.type === 'diagram:focusTable')?.payload).toEqual({ table: 'public.a' }));
    expect(web.posted.findIndex((m) => m.type === 'schema:update')).toBeLessThan(web.posted.findIndex((m) => m.type === 'diagram:focusTable'));
  });
});
