import * as vscode from 'vscode';
import { DiagramPanel } from './panel';
import './exporters'; // side-effect: register built-in exporters

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    // Explorer context menu and editor/title pass the clicked resource; the palette passes nothing.
    vscode.commands.registerCommand('dddbml.openDiagram', async (arg?: unknown) => {
      const uri = arg instanceof vscode.Uri && isWorkingDbml(arg) ? arg : resolveActiveDbmlUri();
      if (!uri) {
        vscode.window.showErrorMessage(NO_DBML_MESSAGE);
        return;
      }
      DiagramPanel.createOrShow(context, uri);
    }),

    vscode.commands.registerCommand('dddbml.resetLayout', async () => {
      const active = DiagramPanel.getActive();
      if (active) return active.resetLayout();
      const uri = resolveActiveDbmlUri();
      if (uri) DiagramPanel.get(uri)?.resetLayout();
    }),

    vscode.commands.registerCommand('dddbml.pruneOrphans', () => {
      const active = DiagramPanel.getActive();
      if (active) return active.pruneOrphans();
      const uri = resolveActiveDbmlUri();
      if (uri) DiagramPanel.get(uri)?.pruneOrphans();
    }),

    vscode.commands.registerCommand('dddbml.exportSchema', async () => {
      const active = DiagramPanel.getActive();
      if (active) {
        active.openExportModal();
        return;
      }
      const uri = resolveActiveDbmlUri();
      if (!uri) {
        vscode.window.showErrorMessage(NO_DBML_MESSAGE);
        return;
      }
      DiagramPanel.createOrShow(context, uri);
      DiagramPanel.get(uri)?.openExportModal(); // queued by the panel until the webview is hydrated
    }),

    vscode.commands.registerCommand('dddbml.exportImage', async () => {
      const active = DiagramPanel.getActive();
      if (active) {
        active.openExportImageModal();
        return;
      }
      const uri = resolveActiveDbmlUri();
      if (!uri) {
        vscode.window.showErrorMessage(NO_DBML_MESSAGE);
        return;
      }
      DiagramPanel.createOrShow(context, uri);
      DiagramPanel.get(uri)?.openExportImageModal();
    }),

    vscode.commands.registerCommand('dddbml.autoArrange', async () => {
      const active = DiagramPanel.getActive();
      if (!active) {
        vscode.window.showErrorMessage('dddbml: open the diagram first (dddbml: Open Diagram).');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Re-arrange all', description: 'Lay out every table, then order edges', mode: 'all' as const },
          { label: 'Place new tables only', description: 'Keep existing positions, place un-positioned tables', mode: 'new' as const },
          { label: 'Re-arrange selection', description: 'Move only the selected tables', mode: 'selection' as const },
          { label: 'Order edges only', description: 'Route edges around tables; tables stay fixed', mode: 'orderOnly' as const },
        ],
        { placeHolder: 'Smart auto-layout — choose what to arrange' },
      );
      if (!pick) return;
      if (pick.mode === 'orderOnly') active.sendEdgeOrderOnly();
      else active.sendAutoArrange(pick.mode);
    }),

    vscode.commands.registerCommand('dddbml.zoomIn',       () => DiagramPanel.getActive()?.sendViewportCommand('zoomIn')),
    vscode.commands.registerCommand('dddbml.zoomOut',      () => DiagramPanel.getActive()?.sendViewportCommand('zoomOut')),
    vscode.commands.registerCommand('dddbml.resetView',    () => DiagramPanel.getActive()?.sendViewportCommand('resetView')),
    vscode.commands.registerCommand('dddbml.fitToContent', () => DiagramPanel.getActive()?.sendViewportCommand('fitToContent')),
  );
}

/** Returning the promise makes VS Code wait (briefly) for edits flushed on close to reach disk. */
export function deactivate(): Promise<void> {
  DiagramPanel.disposeAll();
  return DiagramPanel.settle();
}

const NO_DBML_MESSAGE = 'dddbml: open a working-tree .dbml file first (git/read-only views are not supported).';

/** Only real files: a git:/readonly view (e.g. the HEAD side of a diff) would derive a bogus
 *  sidecar URI and run git ops against the working tree. Remote hosts still see file: URIs. */
function isWorkingDbml(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && uri.path.toLowerCase().endsWith('.dbml');
}

function resolveActiveDbmlUri(): vscode.Uri | null {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri && isWorkingDbml(uri) ? uri : null;
}
