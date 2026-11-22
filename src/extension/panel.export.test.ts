import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./testing/vscodeFake'));

import * as vscode from 'vscode';
import { DiagramPanel } from './panel';
import { cleanupDirs, openPanel } from './testing/panelHarness';
import { fake } from './testing/vscodeFake';

afterEach(() => {
  vi.restoreAllMocks();
  DiagramPanel.disposeAll();
  cleanupDirs();
  fake.reset();
});

it('offers PostgreSQL export and saves all tables even with a diagram selection', async () => {
  const h = await openPanel({
    dbml: 'Table parent { id int [pk] }\nTable child { parent_id int [ref: > parent.id] }',
  });
  const target = vscode.Uri.file(join(h.dir, 'schema.sql'));
  const save = vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(target);
  expect(h.since('exporters:list')[0]?.payload).toMatchObject({
    exporters: expect.arrayContaining([expect.objectContaining({ id: 'postgres-sql', fullSchemaOnly: true })]),
  });

  await h.web.receive({
    type: 'command:export',
    payload: { formatId: 'postgres-sql', scope: 'selected', selection: ['public.child'], options: {} },
  });

  await vi.waitFor(() => expect(h.since('export:result')[0]?.payload).toMatchObject({ ok: true }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultUri: vscode.Uri.file(join(h.dir, 'd.sql')) }));
  const sql = await readFile(target.fsPath, 'utf8');
  expect(sql).toContain('CREATE TABLE "parent"');
  expect(sql).toContain('CREATE TABLE "child"');
  expect(sql).toContain('FOREIGN KEY ("parent_id") REFERENCES "parent" ("id")');
});
