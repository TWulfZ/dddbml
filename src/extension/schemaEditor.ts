import * as vscode from 'vscode';
import type { ColumnRef, HostToWebview, QualifiedName, RefOp, SchemaDeleteTarget } from '../shared/types';
import { parseRequest } from './parseService';
import type { CursorLine, SchemaEditIntent, SchemaEditResult } from './schemaEdits';
import { parseTableNameInput } from './tableNameInput';
import { applyEdits, diffEdit, growOverInsertion, invertEdits, type OffsetEdit } from './textEdits';

/** What the editor needs from its panel. */
export interface SchemaEditorHost {
  readonly uri: vscode.Uri;
  readonly globalState: vscode.Memento;
  /** Warns and returns true while the canvas is read-only (spec 16, host half of the gate). */
  refuseWhileReadOnly(action: string): boolean;
  post(msg: HostToWebview): void;
  tableNames(): readonly QualifiedName[];
}

type Applicable = Extract<SchemaEditResult, { ok: true }>;

interface Computed {
  doc: vscode.TextDocument;
  version: number;
  source: string;
  result: Applicable;
}

/**
 * A diagram edit the webview may undo/redo (spec 19 §Undo). `pending` are the edits the next
 * transition applies — the inverse while applied, the redo while undone — valid only while the
 * document is still at `version`.
 */
interface HistoryEntry {
  label: string;
  state: 'applied' | 'undone';
  pending: OffsetEdit[];
  version: number;
}

/** Same as the webview history capacity (spec 11): older entries can no longer be asked for. */
const HISTORY_CAP = 200;
export const AUTO_SAVE_DISMISSED_KEY = 'dddbml.autoSaveWarningDismissed';
/** Once per extension-host session, keyed by the extension's memento. */
const autoSaveWarned = new WeakSet<vscode.Memento>();

/**
 * Host side of spec 19: turns diagram intents into minimal edits of the `.dbml` buffer. The edits
 * are computed in the parse worker against a fresh read of the buffer and applied only if the
 * document did not change meanwhile; the file is the single source of truth and the host its only
 * writer. Intents run one at a time.
 */
export class SchemaEditor {
  private queue: Promise<void> = Promise.resolve();
  private readonly history = new Map<string, HistoryEntry>();
  private nextId = 1;

  constructor(private readonly host: SchemaEditorHost) {}

  addTable(at: { x: number; y: number; group?: string }): Promise<void> {
    return this.serialize(async () => {
      const action = 'New table';
      if (this.host.refuseWhileReadOnly(action)) return;
      const existing = new Set(this.host.tableNames());
      const input = await vscode.window.showInputBox({
        prompt: at.group ? `New table in group ${at.group}` : 'New table',
        placeHolder: 'table or schema.table',
        validateInput: (v) => {
          const r = parseTableNameInput(v, existing);
          return typeof r === 'string' ? r : null;
        },
      });
      if (input === undefined) return;
      // A merge or git peek may have locked the canvas while the box was open.
      if (this.host.refuseWhileReadOnly(action)) return;
      const name = parseTableNameInput(input, existing);
      if (typeof name === 'string') return;
      const intent: SchemaEditIntent = { kind: 'addTable', schema: name.schema, table: name.table, ...(at.group !== undefined ? { group: at.group } : {}) };
      let placed = false;
      const applied = await this.apply(intent, action, {
        // The webview must hold the position before the table reaches it, or it auto-places it.
        beforeApply: (r) => {
          if (placed || !r.table) return;
          placed = true;
          this.host.post({ type: 'layout:place', payload: { table: r.table, x: at.x, y: at.y } });
        },
      });
      if (applied) await this.record(applied, { revealCursor: true });
    });
  }

  addField(table: QualifiedName): Promise<void> {
    return this.serialize(async () => {
      const action = 'Add field';
      if (this.host.refuseWhileReadOnly(action)) return;
      for (let attempt = 0; attempt < 2; attempt++) {
        const c = await this.compute({ kind: 'addField', table }, action);
        if (!c?.result.cursorLine) return;
        if (c.doc.version !== c.version) continue;
        await this.insertCursorLine(c.doc, c.result.cursorLine);
        return;
      }
      this.warnChanging(action);
    });
  }

  addRef(from: ColumnRef, to: ColumnRef, op: RefOp): Promise<void> {
    return this.serialize(async () => {
      const action = 'Add reference';
      if (this.host.refuseWhileReadOnly(action)) return;
      const applied = await this.apply({ kind: 'addRef', from, to, op }, action);
      if (applied) await this.record(applied);
    });
  }

  delete(target: SchemaDeleteTarget): Promise<void> {
    return this.serialize(async () => {
      const action = 'Delete';
      if (this.host.refuseWhileReadOnly(action)) return;
      const applied = await this.apply({ kind: 'delete', target }, action, { confirm: (r) => this.confirmDelete(r) });
      if (applied) await this.record(applied);
    });
  }

  async revealColumn(c: ColumnRef): Promise<void> {
    try {
      // The buffer, not the disk: line numbers must match what the editor displays.
      const source = (await vscode.workspace.openTextDocument(this.host.uri)).getText();
      const loc = await parseRequest({ op: 'locateColumn', source, table: c.table, column: c.column }, `locate:${this.host.uri.toString()}`);
      if (loc === undefined) return;
      if (loc === null) {
        void vscode.window.showWarningMessage(`dddbml: could not find "${c.table}.${c.column}" in source.`);
        return;
      }
      const pos = new vscode.Position(loc.line, loc.character);
      await vscode.window.showTextDocument(this.host.uri, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, selection: new vscode.Range(pos, pos) });
    } catch (err) {
      void vscode.window.showErrorMessage(`dddbml: reveal failed — ${errorText(err)}`);
    }
  }

  undo(id: string): Promise<void> {
    return this.serialize(() => this.transition(id, 'applied', 'undone'));
  }

  redo(id: string): Promise<void> {
    return this.serialize(() => this.transition(id, 'undone', 'applied'));
  }

  private serialize(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work);
    this.queue = run.catch((err: unknown) => {
      void vscode.window.showErrorMessage(`dddbml: the .dbml edit failed — ${errorText(err)}`);
    });
    return this.queue;
  }

  private async compute(intent: SchemaEditIntent, action: string): Promise<Computed | null> {
    const doc = await vscode.workspace.openTextDocument(this.host.uri);
    const version = doc.version;
    const source = doc.getText();
    const result = await parseRequest({ op: 'schemaEdit', source, intent }, `edit:${this.host.uri.toString()}`);
    if (result === undefined) return null;
    if (!result.ok) {
      void vscode.window.showWarningMessage(`dddbml: ${action} refused — ${result.reason}.`);
      return null;
    }
    return { doc, version, source, result };
  }

  /**
   * Fresh read → worker edit → apply only if the document is still at the version the edit was
   * computed against (one retry), then save: the diagram mirrors the saved file.
   */
  private async apply(
    intent: SchemaEditIntent,
    action: string,
    hooks: { confirm?: (r: Applicable) => Promise<boolean>; beforeApply?: (r: Applicable) => void } = {},
  ): Promise<Computed | null> {
    let confirmed: string[] | null = null;
    // Each compute is two worker parses (~2 s apiece on 5000 tables): reuse the confirmed one.
    let reuse: Computed | null = null;
    if (hooks.confirm) {
      const first = await this.compute(intent, action);
      if (!first || !(await hooks.confirm(first.result))) return null;
      // The modal may have been open across a merge or a git peek.
      if (this.host.refuseWhileReadOnly(action)) return null;
      confirmed = first.result.cascade;
      reuse = first;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const c = reuse ?? await this.compute(intent, action);
      reuse = null;
      if (!c) return null;
      if (confirmed && confirmed.join('\n') !== c.result.cascade.join('\n')) {
        void vscode.window.showWarningMessage(`dddbml: ${c.result.label} was not applied — the .dbml changed while you confirmed; try again.`);
        return null;
      }
      hooks.beforeApply?.(c.result);
      if (c.doc.version !== c.version) continue;
      if (!(await this.applyOffsetEdits(c.doc, c.result.edits))) {
        void vscode.window.showWarningMessage(`dddbml: ${c.result.label} was not applied — VS Code rejected the edit.`);
        return null;
      }
      if (!(await c.doc.save())) {
        void vscode.window.showWarningMessage(`dddbml: ${c.result.label} is in the editor but was not saved; the diagram updates when the file is saved.`);
      }
      this.maybeWarnAutoSave();
      return c;
    }
    this.warnChanging(action);
    return null;
  }

  private warnChanging(action: string): void {
    void vscode.window.showWarningMessage(`dddbml: ${action} was not applied — the .dbml kept changing; try again.`);
  }

  private applyOffsetEdits(doc: vscode.TextDocument, edits: readonly OffsetEdit[]): Thenable<boolean> {
    const we = new vscode.WorkspaceEdit();
    for (const e of edits) we.replace(doc.uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.newText);
    return vscode.workspace.applyEdit(we);
  }

  private async insertCursorLine(doc: vscode.TextDocument, line: CursorLine): Promise<boolean> {
    const we = new vscode.WorkspaceEdit();
    we.insert(doc.uri, doc.positionAt(line.offset), line.text);
    if (!(await vscode.workspace.applyEdit(we))) return false;
    const pos = doc.positionAt(line.offset + line.cursor);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, selection: new vscode.Range(pos, pos) });
    return true;
  }

  /** Stores the applied edit's undo and tells the webview to push a SchemaEditCommand. */
  private async record(c: Computed, opts: { revealCursor?: boolean } = {}): Promise<void> {
    const expected = applyEdits(c.source, c.result.edits);
    let current = c.doc.getText();
    // A save participant (format, trim whitespace) may have rewritten more than our edit.
    let hint: OffsetEdit[] | null = current === expected ? c.result.inverse : null;
    const line = c.result.cursorLine;
    if (opts.revealCursor && line && hint && (await this.insertCursorLine(c.doc, line))) {
      hint = growOverInsertion(hint, line.offset, line.text.length);
      current = c.doc.getText();
    } else if (opts.revealCursor) {
      await vscode.window.showTextDocument(c.doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
    }
    const inverse = hint && applyEdits(current, hint) === c.source ? hint : diffEdit(current, c.source);
    const id = `e${this.nextId++}`;
    this.history.set(id, { label: c.result.label, state: 'applied', pending: inverse, version: c.doc.version });
    if (this.history.size > HISTORY_CAP) this.history.delete(this.history.keys().next().value!);
    this.host.post({ type: 'schema:applied', payload: { id, label: c.result.label } });
  }

  private async transition(id: string, from: HistoryEntry['state'], to: HistoryEntry['state']): Promise<void> {
    const entry = this.history.get(id);
    const action = from === 'applied' ? 'Undo' : 'Redo';
    if (!entry || entry.state !== from || this.host.refuseWhileReadOnly(action)) {
      this.discard(id);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(this.host.uri);
    if (doc.version !== entry.version) {
      void vscode.window.showWarningMessage(`dddbml: the .dbml changed since "${entry.label}"; use ${action} in the editor.`);
      this.discard(id);
      return;
    }
    const before = doc.getText();
    if (!(await this.applyOffsetEdits(doc, entry.pending))) {
      void vscode.window.showWarningMessage(`dddbml: ${action} of "${entry.label}" was not applied — VS Code rejected the edit.`);
      this.discard(id);
      return;
    }
    await doc.save();
    const after = doc.getText();
    const hint = invertEdits(before, entry.pending);
    entry.pending = applyEdits(after, hint) === before ? hint : diffEdit(after, before);
    entry.state = to;
    entry.version = doc.version;
  }

  private discard(id: string): void {
    this.history.delete(id);
    this.host.post({ type: 'schema:discarded', payload: { id } });
  }

  private async confirmDelete(r: Applicable): Promise<boolean> {
    const detail = r.cascade.length > 0 ? `This also removes:\n${r.cascade.map((c) => `• ${c}`).join('\n')}` : undefined;
    const choice = await vscode.window.showWarningMessage(`dddbml: ${r.label}?`, { modal: true, detail }, 'Delete');
    return choice === 'Delete';
  }

  /** Spec 19: the diagram reflects the saved file, so edits made by hand only show after a save. */
  private maybeWarnAutoSave(): void {
    const memento = this.host.globalState;
    if (autoSaveWarned.has(memento) || memento.get<boolean>(AUTO_SAVE_DISMISSED_KEY) === true) return;
    if (vscode.workspace.getConfiguration('files').get<string>('autoSave') !== 'off') return;
    autoSaveWarned.add(memento);
    void vscode.window.showWarningMessage(
      'dddbml writes your .dbml from the diagram; enable Auto Save to keep both in sync.',
      'Enable Auto Save',
      "Don't show again",
    ).then((choice) => {
      if (choice === 'Enable Auto Save') void vscode.commands.executeCommand('workbench.action.toggleAutoSave');
      else if (choice === "Don't show again") void memento.update(AUTO_SAVE_DISMISSED_KEY, true);
    });
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
