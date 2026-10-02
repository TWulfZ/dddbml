/**
 * Minimal runtime stand-in for the `vscode` module, for host tests that drive a real DiagramPanel
 * against the real filesystem. Only the API surface panel.ts and its imports touch is modelled;
 * file watchers do not watch anything — tests fire their events explicitly via `fireFsEvent`.
 *
 * Usage: `vi.mock('vscode', () => import('./testing/vscodeFake'))`, then `fake` for the knobs.
 */
import { promises as fsp } from 'node:fs';
import * as posix from 'node:path/posix';

type Listener<T> = (e: T) => unknown;

class Emitter<T> {
  private listeners: Array<Listener<T>> = [];
  readonly event = (fn: Listener<T>, thisArg?: unknown, disposables?: Array<{ dispose(): void }>) => {
    const bound: Listener<T> = thisArg ? fn.bind(thisArg) : fn;
    this.listeners.push(bound);
    const d = { dispose: () => { this.listeners = this.listeners.filter((l) => l !== bound); } };
    disposables?.push(d);
    return d;
  };
  async fire(e: T): Promise<void> {
    for (const l of [...this.listeners]) await l(e);
  }
}

export class Uri {
  private constructor(readonly scheme: string, readonly path: string, readonly query: string) {}
  static file(p: string): Uri { return new Uri('file', p, ''); }
  static parse(s: string): Uri {
    const m = /^([a-z-]+):\/\/([^?]*)(?:\?(.*))?$/.exec(s);
    if (m) return new Uri(m[1]!, m[2]!, m[3] ?? '');
    // `command:` links have no authority; real Uri.parse percent-decodes the query.
    const opaque = /^([a-z]{2,}):([^/?][^?]*)(?:\?(.*))?$/.exec(s);
    return opaque ? new Uri(opaque[1]!, opaque[2]!, decodeURIComponent(opaque[3] ?? '')) : Uri.file(s);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, posix.join(base.path, ...segments), base.query);
  }
  get fsPath(): string { return this.path; }
  with(change: { scheme?: string; path?: string; query?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.path ?? this.path, change.query ?? this.query);
  }
  toString(): string { return `${this.scheme}://${this.path}${this.query ? `?${this.query}` : ''}`; }
}

export class RelativePattern {
  constructor(readonly base: Uri, readonly pattern: string) {}
}
export class Position { constructor(readonly line: number, readonly character: number) {} }
export class Range { constructor(readonly start: Position, readonly end: Position) {} }

/** An open editor buffer: `getText()` can differ from disk until `save()`. */
export class FakeTextDocument {
  version = 1;
  isDirty = false;
  constructor(readonly uri: Uri, public text: string) {}
  getText(): string { return this.text; }
  offsetAt(p: Position): number {
    const lines = this.text.split('\n');
    let off = 0;
    for (let i = 0; i < p.line && i < lines.length; i++) off += lines[i]!.length + 1;
    return Math.min(off + p.character, this.text.length);
  }
  positionAt(offset: number): Position {
    const before = this.text.slice(0, offset).split('\n');
    return new Position(before.length - 1, before[before.length - 1]!.length);
  }
  /** Simulates a keystroke-level change in the editor (not saved). */
  edit(next: string): void {
    this.text = next;
    this.version++;
    this.isDirty = true;
  }
  async save(): Promise<boolean> {
    fake.events.push('save');
    const hook = fake.onSave;
    if (hook) {
      const changed = hook(this.text);
      if (changed !== this.text) { this.text = changed; this.version++; }
    }
    await fsp.writeFile(this.uri.fsPath, this.text);
    this.isDirty = false;
    return true;
  }
}

export class WorkspaceEdit {
  readonly entries: Array<{ uri: Uri; range: Range; newText: string }> = [];
  replace(uri: Uri, range: Range, newText: string): void { this.entries.push({ uri, range, newText }); }
  insert(uri: Uri, position: Position, newText: string): void { this.entries.push({ uri, range: new Range(position, position), newText }); }
}

/** `ExtensionContext.globalState` stand-in. */
export class FakeMemento {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  update(key: string, value: unknown): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  keys(): readonly string[] { return [...this.values.keys()]; }
}

export class DocumentLink {
  tooltip?: string;
  constructor(readonly range: Range, readonly target?: Uri) {}
}
export const ViewColumn = { Active: -1, Beside: -2, One: 1 } as const;
export const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3 } as const;
export const ConfigurationTarget = { Global: 1, Workspace: 2 } as const;

type FsEventKind = 'change' | 'create' | 'delete';

interface FakeWatcher {
  pattern: RelativePattern;
  emitters: Record<FsEventKind, Emitter<Uri>>;
}

export interface FakeWebviewPanel {
  posted: Array<{ type: string; payload?: unknown }>;
  visible: boolean;
  active: boolean;
  /** Deliver a message from the webview to the host and let the handler settle. */
  receive(msg: unknown): Promise<void>;
  setVisible(visible: boolean): Promise<void>;
  disposed: boolean;
}

class WebviewPanelImpl implements FakeWebviewPanel {
  posted: Array<{ type: string; payload?: unknown }> = [];
  visible = true;
  active = true;
  disposed = false;
  private readonly messages = new Emitter<unknown>();
  private readonly viewState = new Emitter<{ webviewPanel: WebviewPanelImpl }>();
  private readonly disposeEmitter = new Emitter<void>();
  readonly onDidChangeViewState = this.viewState.event;
  readonly onDidDispose = this.disposeEmitter.event;
  readonly webview = {
    html: '',
    cspSource: 'vscode-resource:',
    asWebviewUri: (u: Uri) => u,
    postMessage: (msg: { type: string; payload?: unknown }) => {
      if (this.disposed) throw new Error('Webview is disposed');
      this.posted.push(msg);
      fake.events.push(`post:${msg.type}`);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: this.messages.event,
  };
  async receive(msg: unknown): Promise<void> { await this.messages.fire(msg); }
  async setVisible(visible: boolean): Promise<void> {
    this.visible = visible;
    await this.viewState.fire({ webviewPanel: this });
  }
  reveal(): void { /* visibility is driven by the test via setVisible */ }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.disposeEmitter.fire();
  }
}

const watchers: FakeWatcher[] = [];

interface InputBoxOptions {
  prompt?: string;
  placeHolder?: string;
  validateInput?: (value: string) => string | undefined | null;
}

const documents = new Map<string, FakeTextDocument>();

async function documentFor(uri: Uri): Promise<FakeTextDocument> {
  const disk = await fsp.readFile(uri.fsPath, 'utf8');
  const doc = documents.get(uri.toString());
  if (!doc) {
    const fresh = new FakeTextDocument(uri, disk);
    documents.set(uri.toString(), fresh);
    return fresh;
  }
  // VS Code reloads a clean buffer when the file changes on disk.
  if (!doc.isDirty && doc.text !== disk) { doc.text = disk; doc.version++; }
  return doc;
}

export const fake = {
  panels: [] as WebviewPanelImpl[],
  messages: [] as Array<{ level: 'info' | 'warning' | 'error'; text: string; detail?: string; modal?: boolean }>,
  /** Ordered host-side effects (`post:<type>`, `applyEdit`, `save`) for ordering assertions. */
  events: [] as string[],
  /** Answer of the next `showInputBox` (validated like the real box: invalid input never resolves). */
  nextInput: undefined as string | undefined,
  inputBoxes: [] as InputBoxOptions[],
  /** While set, `showInputBox` answers only once it resolves (the user is still typing). */
  inputBoxHold: null as Promise<void> | null,
  /** Runs inside `save()`, like a save participant (e.g. trim trailing whitespace). */
  onSave: null as ((text: string) => string) | null,
  /** Runs right before `applyEdit` applies, to simulate a concurrent change. */
  beforeApplyEdit: null as (() => void) | null,
  config: {} as Record<string, unknown>,
  executed: [] as string[],
  linkProviders: [] as Array<{ selector: unknown; provider: { provideDocumentLinks(doc: FakeTextDocument): Promise<DocumentLink[]> | DocumentLink[] } }>,
  async document(uri: Uri): Promise<FakeTextDocument> { return documentFor(uri); },
  /** An already-open buffer, synchronously (for edits that must land between two awaits). */
  openDocument(uri: Uri): FakeTextDocument {
    const doc = documents.get(uri.toString());
    if (!doc) throw new Error(`not open: ${uri.toString()}`);
    return doc;
  },
  /** VS Code disposing an unreferenced clean model: the next open builds a new one at version 1. */
  closeDocument(uri: Uri): void {
    documents.delete(uri.toString());
  },
  /** Answer returned by the next modal/choice message (e.g. a confirmation button label). */
  nextChoice: undefined as string | undefined,
  activeEditorUri: null as Uri | null,
  shownDocuments: [] as Array<{ doc: unknown; line: number | undefined; character?: number }>,
  /** Item lists offered by `showQuickPick`, which always resolves as dismissed. */
  quickPicks: [] as Array<Array<{ label: string }>>,
  reset(): void {
    this.panels = [];
    this.messages = [];
    this.shownDocuments = [];
    this.quickPicks = [];
    this.nextChoice = undefined;
    this.events = [];
    this.nextInput = undefined;
    this.inputBoxes = [];
    this.inputBoxHold = null;
    this.onSave = null;
    this.beforeApplyEdit = null;
    this.config = {};
    this.executed = [];
    this.linkProviders = [];
    documents.clear();
    this.activeEditorUri = null;
    watchers.length = 0;
  },
  /** Deliver a file-system event to every watcher whose base folder contains `uri`. */
  async fireFsEvent(kind: FsEventKind, uri: Uri): Promise<void> {
    for (const w of [...watchers]) {
      if (posix.dirname(uri.path) === w.pattern.base.path) await w.emitters[kind].fire(uri);
    }
  },
  watcherPatterns(): string[] {
    return watchers.map((w) => w.pattern.pattern);
  },
};

function message(level: 'info' | 'warning' | 'error') {
  return (text: string, ...rest: unknown[]): Promise<string | undefined> => {
    const opts = rest[0] !== null && typeof rest[0] === 'object' ? rest[0] as { modal?: boolean; detail?: string } : undefined;
    fake.messages.push({ level, text, detail: opts?.detail, modal: opts?.modal });
    const choice = fake.nextChoice;
    fake.nextChoice = undefined;
    const offered = rest.filter((r): r is string => typeof r === 'string');
    return Promise.resolve(choice !== undefined && offered.includes(choice) ? choice : undefined);
  };
}

const noopEvent = () => ({ dispose: () => undefined });

export const window = {
  createWebviewPanel: () => {
    const p = new WebviewPanelImpl();
    fake.panels.push(p);
    return p;
  },
  onDidChangeActiveColorTheme: noopEvent,
  activeColorTheme: { kind: ColorThemeKind.Dark },
  get activeTextEditor() {
    const uri = fake.activeEditorUri;
    return uri ? { document: { uri, fileName: uri.fsPath } } : undefined;
  },
  showInformationMessage: message('info'),
  showWarningMessage: message('warning'),
  showErrorMessage: message('error'),
  showTextDocument: (doc: unknown, options?: { selection?: Range }) => {
    fake.shownDocuments.push({ doc, line: options?.selection?.start.line, character: options?.selection?.start.character });
    return Promise.resolve(undefined);
  },
  showInputBox: (options: InputBoxOptions) => {
    fake.inputBoxes.push(options);
    const answer = fake.nextInput;
    fake.nextInput = undefined;
    const result = answer === undefined || options.validateInput?.(answer) ? undefined : answer;
    return (fake.inputBoxHold ?? Promise.resolve()).then(() => result);
  },
  showSaveDialog: () => Promise.resolve(undefined),
  showQuickPick: (items: Array<{ label: string }>) => {
    fake.quickPicks.push(items);
    return Promise.resolve(undefined);
  },
};

export const commands = {
  registered: new Map<string, (...args: unknown[]) => unknown>(),
  registerCommand(id: string, fn: (...args: unknown[]) => unknown) {
    commands.registered.set(id, fn);
    return { dispose: () => commands.registered.delete(id) };
  },
  executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    fake.executed.push(id);
    return Promise.resolve(commands.registered.get(id)?.(...args));
  },
};

export const languages = {
  registerDocumentLinkProvider(selector: unknown, provider: (typeof fake.linkProviders)[number]['provider']) {
    fake.linkProviders.push({ selector, provider });
    return { dispose: () => undefined };
  },
};

export const workspace = {
  fs: {
    readFile: async (uri: Uri) => new Uint8Array(await fsp.readFile(uri.fsPath)),
    writeFile: (uri: Uri, bytes: Uint8Array) => fsp.writeFile(uri.fsPath, bytes),
    rename: (from: Uri, to: Uri) => fsp.rename(from.fsPath, to.fsPath),
    createDirectory: (uri: Uri) => fsp.mkdir(uri.fsPath, { recursive: true }).then(() => undefined),
  },
  createFileSystemWatcher: (pattern: RelativePattern) => {
    const w: FakeWatcher = {
      pattern,
      emitters: { change: new Emitter<Uri>(), create: new Emitter<Uri>(), delete: new Emitter<Uri>() },
    };
    watchers.push(w);
    return {
      onDidChange: w.emitters.change.event,
      onDidCreate: w.emitters.create.event,
      onDidDelete: w.emitters.delete.event,
      dispose: () => { const i = watchers.indexOf(w); if (i >= 0) watchers.splice(i, 1); },
    };
  },
  openTextDocument: async (arg: Uri | { content: string; language?: string }) => {
    if (arg instanceof Uri) return documentFor(arg);
    return new FakeTextDocument(Uri.parse('untitled://export'), arg.content);
  },
  applyEdit: async (edit: WorkspaceEdit): Promise<boolean> => {
    fake.beforeApplyEdit?.();
    fake.events.push('applyEdit');
    const byDoc = new Map<FakeTextDocument, Array<{ start: number; end: number; newText: string }>>();
    for (const e of edit.entries) {
      const doc = await documentFor(e.uri);
      byDoc.set(doc, [...(byDoc.get(doc) ?? []), { start: doc.offsetAt(e.range.start), end: doc.offsetAt(e.range.end), newText: e.newText }]);
    }
    for (const [doc, edits] of byDoc) {
      let text = doc.text;
      for (const e of [...edits].sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.newText + text.slice(e.end);
      doc.edit(text);
    }
    return true;
  },
  getConfiguration: (section?: string) => ({
    get: (key: string) => fake.config[section ? `${section}.${key}` : key],
    update: () => Promise.resolve(),
  }),
  onDidChangeConfiguration: noopEvent,
  workspaceFolders: undefined,
};
