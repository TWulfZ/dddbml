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
    return m ? new Uri(m[1]!, m[2]!, m[3] ?? '') : Uri.file(s);
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

export const fake = {
  panels: [] as WebviewPanelImpl[],
  messages: [] as Array<{ level: 'info' | 'warning' | 'error'; text: string }>,
  /** Answer returned by the next modal/choice message (e.g. a confirmation button label). */
  nextChoice: undefined as string | undefined,
  activeEditorUri: null as Uri | null,
  shownDocuments: [] as Array<{ doc: unknown; line: number | undefined }>,
  reset(): void {
    this.panels = [];
    this.messages = [];
    this.shownDocuments = [];
    this.nextChoice = undefined;
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
    fake.messages.push({ level, text });
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
    fake.shownDocuments.push({ doc, line: options?.selection?.start.line });
    return Promise.resolve(undefined);
  },
  showSaveDialog: () => Promise.resolve(undefined),
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
    const text = arg instanceof Uri ? await fsp.readFile(arg.fsPath, 'utf8') : arg.content;
    return { getText: () => text, uri: arg instanceof Uri ? arg : Uri.parse('untitled://export') };
  },
  getConfiguration: () => ({ get: () => undefined, update: () => Promise.resolve() }),
  onDidChangeConfiguration: noopEvent,
  workspaceFolders: undefined,
};
