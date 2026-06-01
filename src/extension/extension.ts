import * as vscode from 'vscode';
import { DiagramPanel } from './panel';
import './exporters'; // side-effect: register built-in exporters

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('dddbml.openDiagram', async () => {
      const uri = resolveActiveDbmlUri();
      if (!uri) {
        vscode.window.showErrorMessage('dddbml: open a .dbml file first.');
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
        vscode.window.showErrorMessage('dddbml: open a .dbml file first.');
        return;
      }
      DiagramPanel.createOrShow(context, uri);
      // Defer the prompt until the panel is hydrated; the webview will be ready shortly.
      setTimeout(() => DiagramPanel.get(uri)?.openExportModal(), 250);
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

export function deactivate(): void {
  DiagramPanel.disposeAll();
}

function resolveActiveDbmlUri(): vscode.Uri | null {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.fileName.endsWith('.dbml')) {
    return editor.document.uri;
  }
  return null;
}
