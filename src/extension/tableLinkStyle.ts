import * as vscode from 'vscode';

export interface TableLinkRange {
  table: string;
  range: vscode.Range;
}

const FLASH_MS = 600;

/**
 * Presentation of the `Table` block links (spec 19, issue #4): VS Code underlines every
 * DocumentLink permanently and offers no hover/Ctrl events, so the underline is masked with a
 * decoration and Ctrl+click feedback is a short background flash on the revealed block.
 */
export class TableLinkStyle implements vscode.Disposable {
  // `.monaco-editor .ced-*` out-specifies VS Code's `.detected-link { text-decoration: underline }`.
  private readonly mask = vscode.window.createTextEditorDecorationType({ textDecoration: 'none' });
  private readonly flash = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.hoverHighlightBackground'),
    isWholeLine: true,
  });
  private readonly links = new Map<string, { version: number; ranges: TableLinkRange[] }>();
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private flashed: vscode.TextEditor[] = [];
  private readonly subscriptions: vscode.Disposable[] = [
    // Decorations die with a hidden editor, and the re-shown editor may ask for links before the
    // extension host lists it as visible: re-apply from the cache instead of waiting for an edit.
    vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((e) => this.applyMask(e))),
    vscode.workspace.onDidCloseTextDocument((doc) => this.links.delete(doc.uri.toString())),
  ];

  /** `version` is the document version the ranges were computed from. */
  setLinks(uri: vscode.Uri, version: number, ranges: TableLinkRange[]): void {
    this.links.set(uri.toString(), { version, ranges });
    for (const editor of this.editorsOf(uri)) this.applyMask(editor);
  }

  flashTable(uri: vscode.Uri, table: string): void {
    this.clearFlash();
    this.flashed = this.editorsOf(uri);
    for (const editor of this.flashed) {
      const range = this.current(editor)?.find((l) => l.table === table)?.range;
      editor.setDecorations(this.flash, range ? [range] : []);
    }
    this.flashTimer = setTimeout(() => this.clearFlash(), FLASH_MS);
  }

  dispose(): void {
    clearTimeout(this.flashTimer);
    this.mask.dispose();
    this.flash.dispose();
    this.subscriptions.forEach((s) => s.dispose());
  }

  private clearFlash(): void {
    clearTimeout(this.flashTimer);
    this.flashed.forEach((e) => e.setDecorations(this.flash, []));
    this.flashed = [];
  }

  private applyMask(editor: vscode.TextEditor): void {
    const ranges = this.current(editor);
    if (ranges) editor.setDecorations(this.mask, ranges.map((l) => l.range));
  }

  /** Ranges only while the buffer is still the text they were computed from. */
  private current(editor: vscode.TextEditor): TableLinkRange[] | undefined {
    const cached = this.links.get(editor.document.uri.toString());
    return cached?.version === editor.document.version ? cached.ranges : undefined;
  }

  private editorsOf(uri: vscode.Uri): vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === uri.toString());
  }
}
