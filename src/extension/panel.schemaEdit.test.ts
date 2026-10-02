import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./testing/vscodeFake'));

import { fake, FakeMemento } from './testing/vscodeFake';
import { DiagramPanel } from './panel';
import { runParseJob } from './parseOps';
import { setParseWorkerFactory } from './parseService';
import type { ParseJob, ParseReply, WorkerLike } from './parseClient';
import { AUTO_SAVE_DISMISSED_KEY } from './schemaEditor';
import { cleanupDirs, conflictedRepo, openPanel, settle, type Harness } from './testing/panelHarness';

/** Host half of spec 19: intents → minimal, version-checked, saved edits of the .dbml. */

// In-process worker with a hook that runs between computing a schema edit and replying, i.e. while
// the host still holds the document version it read.
let duringSchemaEdit: (() => void) | null = null;
setParseWorkerFactory((): WorkerLike => {
  let reply: ((r: ParseReply) => void) | null = null;
  return {
    postMessage(job: ParseJob) {
      setImmediate(() => {
        const answer = runParseJob(job);
        if (job.op === 'schemaEdit') duringSchemaEdit?.();
        reply?.(answer);
      });
    },
    on(event: string, cb: (arg: never) => void) {
      if (event === 'message') reply = cb as (r: ParseReply) => void;
      return this;
    },
    terminate() { reply = null; },
  } as WorkerLike;
});

const DBML = `// orders domain
Table a {
  id int [pk]
}

Table b {
  id int
  a_id int
}

TableGroup g {
  a
}
`;

beforeEach(() => {
  fake.reset();
  duringSchemaEdit = null;
});
afterEach(() => {
  DiagramPanel.disposeAll();
  cleanupDirs();
});

const warnings = (): string[] => fake.messages.filter((m) => m.level === 'warning').map((m) => m.text);
const applied = (h: Harness) => h.since('schema:applied').map((m) => m.payload as { id: string; label: string });

async function addRef(h: Harness): Promise<string> {
  h.mark();
  await h.web.receive({ type: 'schema:addRef', payload: { from: { table: 'public.b', column: 'a_id' }, to: { table: 'public.a', column: 'id' }, op: '>' } });
  await vi.waitFor(() => expect(applied(h)).toHaveLength(1));
  return applied(h)[0]!.id;
}

describe('schema:addTable', () => {
  it('posts layout:place before writing, saves, and leaves the cursor on a new line inside the block', async () => {
    const h = await openPanel({ dbml: DBML });
    fake.nextInput = 'payments';
    await h.web.receive({ type: 'schema:addTable', payload: { x: 120, y: 48, group: 'g' } });
    await vi.waitFor(() => expect(applied(h)).toHaveLength(1));

    expect(h.readDbml()).toBe(DBML.replace('  a\n}', '  a\n  payments\n}') + '\nTable payments {\n  id int [pk]\n}\n');
    const place = h.web.posted.find((m) => m.type === 'layout:place');
    expect(place?.payload).toEqual({ table: 'public.payments', x: 120, y: 48 });
    expect(fake.events.indexOf('post:layout:place')).toBeLessThan(fake.events.indexOf('applyEdit'));
    expect(applied(h)[0]!.label).toBe('Add table payments');

    const doc = await fake.document(h.dbml);
    expect(doc.getText().endsWith('Table payments {\n  id int [pk]\n  \n}\n')).toBe(true);
    const cursor = fake.shownDocuments[fake.shownDocuments.length - 1]!;
    expect(doc.getText().split('\n')[cursor.line!]).toBe('  ');
    expect(cursor.character).toBe(2);
  });

  it('validates the name in the input box (duplicates included) and writes nothing when cancelled', async () => {
    const h = await openPanel({ dbml: DBML });
    await h.web.receive({ type: 'schema:addTable', payload: { x: 0, y: 0 } });
    await vi.waitFor(() => expect(fake.inputBoxes).toHaveLength(1));
    const validate = fake.inputBoxes[0]!.validateInput!;
    expect(validate('a')).toMatch(/already exists/);
    expect(validate('sales.orders')).toBeNull();
    await settle(50);
    expect(h.readDbml()).toBe(DBML);
    expect(h.web.posted.some((m) => m.type === 'layout:place')).toBe(false);
  });
});

describe('the write gate', () => {
  it('refuses every intent while the canvas is read-only, before asking anything (spec 16)', async () => {
    const { dir } = conflictedRepo();
    const h = await openPanel({ reuseDir: dir });
    const before = h.readDbml();
    fake.nextInput = 'x';
    await h.web.receive({ type: 'schema:addTable', payload: { x: 0, y: 0 } });
    await h.web.receive({ type: 'schema:delete', payload: { kind: 'table', table: 'public.a' } });
    await h.web.receive({ type: 'schema:addField', payload: { table: 'public.a' } });
    await vi.waitFor(() => expect(warnings().filter((w) => w.includes('merge'))).toHaveLength(3));
    expect(fake.inputBoxes).toHaveLength(0);
    expect(fake.events).not.toContain('applyEdit');
    expect(h.readDbml()).toBe(before);
  });

  it('refuses when the buffer does not parse, touching no file', async () => {
    const h = await openPanel({ dbml: DBML });
    (await fake.document(h.dbml)).edit('Table a {\n');
    await h.web.receive({ type: 'schema:delete', payload: { kind: 'table', table: 'public.a' } });
    await vi.waitFor(() => expect(warnings().some((w) => w.includes('does not parse'))).toBe(true));
    expect(fake.events).not.toContain('applyEdit');
    expect(h.readDbml()).toBe(DBML);
  });

  it('recomputes once when the document changes between compute and apply, keeping the user edit', async () => {
    const h = await openPanel({ dbml: DBML });
    let typed = false;
    duringSchemaEdit = () => {
      if (typed) return;
      typed = true;
      const d = fake.openDocument(h.dbml);
      d.edit(d.getText().replace('// orders domain', '// orders domain, edited'));
    };
    await addRef(h);
    expect(h.readDbml()).toBe(DBML.replace('// orders domain', '// orders domain, edited').replace('  a_id int\n', '  a_id int [ref: > a.id]\n'));
    expect(fake.events.filter((e) => e === 'applyEdit')).toHaveLength(1);
    expect(typed).toBe(true);
  });

  it('gives up with a notice when the document keeps changing', async () => {
    const h = await openPanel({ dbml: DBML });
    duringSchemaEdit = () => {
      const d = fake.openDocument(h.dbml);
      d.edit(`${d.getText()}// typing\n`);
    };
    await h.web.receive({ type: 'schema:addRef', payload: { from: { table: 'public.b', column: 'a_id' }, to: { table: 'public.a', column: 'id' }, op: '>' } });
    await vi.waitFor(() => expect(warnings().some((w) => w.includes('kept changing'))).toBe(true));
    expect(fake.events).not.toContain('applyEdit');
    expect(h.readDbml()).toBe(DBML);
  });
});

describe('schema:delete', () => {
  it('lists the cascade in a modal and applies only on confirmation', async () => {
    const h = await openPanel({ dbml: DBML.replace('  a_id int\n', '  a_id int [ref: > a.id]\n') });
    await h.web.receive({ type: 'schema:delete', payload: { kind: 'table', table: 'public.a' } });
    await vi.waitFor(() => expect(fake.messages.some((m) => m.modal)).toBe(true));
    const modal = fake.messages.find((m) => m.modal)!;
    expect(modal.text).toBe('dddbml: Delete table a?');
    expect(modal.detail).toContain('reference b.a_id > a.id');
    expect(modal.detail).toContain('membership in TableGroup g');
    await settle(50);
    expect(fake.events).not.toContain('applyEdit');

    h.mark();
    fake.nextChoice = 'Delete';
    await h.web.receive({ type: 'schema:delete', payload: { kind: 'table', table: 'public.a' } });
    await vi.waitFor(() => expect(applied(h)).toHaveLength(1));
    expect(h.readDbml()).toBe('// orders domain\n\nTable b {\n  id int\n  a_id int\n}\n\nTableGroup g {\n}\n');
  });
});

describe('schema:undo / schema:redo', () => {
  it('reverts and re-applies the exact edit, saving each time', async () => {
    const h = await openPanel({ dbml: DBML });
    const id = await addRef(h);
    const edited = h.readDbml();
    await h.web.receive({ type: 'schema:undo', payload: { id } });
    await vi.waitFor(() => expect(h.readDbml()).toBe(DBML));
    await h.web.receive({ type: 'schema:redo', payload: { id } });
    await vi.waitFor(() => expect(h.readDbml()).toBe(edited));
    await h.web.receive({ type: 'schema:undo', payload: { id } });
    await vi.waitFor(() => expect(h.readDbml()).toBe(DBML));
    expect(h.since('schema:discarded')).toHaveLength(0);
  });

  it('undoes a new table including the unsaved cursor line', async () => {
    const h = await openPanel({ dbml: DBML });
    fake.nextInput = 'c';
    h.mark();
    await h.web.receive({ type: 'schema:addTable', payload: { x: 0, y: 0 } });
    await vi.waitFor(() => expect(applied(h)).toHaveLength(1));
    await h.web.receive({ type: 'schema:undo', payload: { id: applied(h)[0]!.id } });
    await vi.waitFor(() => expect(h.readDbml()).toBe(DBML));
    expect((await fake.document(h.dbml)).getText()).toBe(DBML);
  });

  it('refuses and drops the command when the document changed since, pointing at the editor undo', async () => {
    const h = await openPanel({ dbml: DBML });
    const id = await addRef(h);
    const edited = h.readDbml();
    (await fake.document(h.dbml)).edit(`${edited}// more\n`);
    await h.web.receive({ type: 'schema:undo', payload: { id } });
    await vi.waitFor(() => expect(h.since('schema:discarded')).toEqual([{ type: 'schema:discarded', payload: { id } }]));
    expect(warnings().some((w) => w.includes('use Undo in the editor'))).toBe(true);
    expect(h.readDbml()).toBe(edited);
  });

  it('still restores the original text when a save participant rewrote more than the edit', async () => {
    const withTrailing = DBML.replace('Table b {', 'Table b {   ');
    const h = await openPanel({ dbml: withTrailing });
    fake.onSave = (text) => text.replace(/[ \t]+$/gm, '');
    const id = await addRef(h);
    expect(h.readDbml()).toContain('Table b {\n');
    fake.onSave = null;
    await h.web.receive({ type: 'schema:undo', payload: { id } });
    await vi.waitFor(() => expect(h.readDbml()).toBe(withTrailing));
  });
});

describe('schema:addField and command:revealColumn', () => {
  it('adds an unsaved indented line before the closing brace and puts the cursor there', async () => {
    const h = await openPanel({ dbml: DBML });
    await h.web.receive({ type: 'schema:addField', payload: { table: 'public.b' } });
    await vi.waitFor(() => expect(fake.shownDocuments).toHaveLength(1));
    const doc = await fake.document(h.dbml);
    expect(doc.getText()).toBe(DBML.replace('  a_id int\n}', '  a_id int\n  \n}'));
    expect(doc.isDirty).toBe(true);
    expect(h.readDbml()).toBe(DBML);
    expect(fake.shownDocuments[0]).toMatchObject({ line: 8, character: 2 });
    expect(h.web.posted.some((m) => m.type === 'schema:applied')).toBe(false);
  });

  it('opens the column line of a double-clicked field', async () => {
    const h = await openPanel({ dbml: DBML });
    await h.web.receive({ type: 'command:revealColumn', payload: { table: 'public.b', column: 'a_id' } });
    await vi.waitFor(() => expect(fake.shownDocuments).toHaveLength(1));
    expect(fake.shownDocuments[0]).toMatchObject({ line: 7, character: 2 });
  });
});

describe('auto-save warning', () => {
  it('shows once per session when files.autoSave is off; "Don\'t show again" is remembered', async () => {
    fake.config['files.autoSave'] = 'off';
    const memento = new FakeMemento();
    const h = await openPanel({ dbml: DBML, globalState: memento });
    fake.nextChoice = "Don't show again";
    await addRef(h);
    await vi.waitFor(() => expect(memento.get(AUTO_SAVE_DISMISSED_KEY)).toBe(true));
    await h.web.receive({ type: 'schema:delete', payload: { kind: 'ref', refId: 'public.a(id)->public.b(a_id)' } });
    await settle(50);
    expect(warnings().filter((w) => w.includes('Auto Save'))).toHaveLength(1);
  });

  it('offers to turn Auto Save on', async () => {
    fake.config['files.autoSave'] = 'off';
    const h = await openPanel({ dbml: DBML });
    fake.nextChoice = 'Enable Auto Save';
    await addRef(h);
    await vi.waitFor(() => expect(fake.executed).toContain('workbench.action.toggleAutoSave'));
  });

  it('stays silent when Auto Save is on', async () => {
    fake.config['files.autoSave'] = 'afterDelay';
    const h = await openPanel({ dbml: DBML });
    await addRef(h);
    await settle(50);
    expect(warnings().filter((w) => w.includes('Auto Save'))).toHaveLength(0);
  });
});
