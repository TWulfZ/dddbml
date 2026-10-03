// Runs INSIDE a real VS Code extension host (via run-vscode.mjs). Opens a .dbml, opens the diagram,
// checks the Ctrl+click links (served by the parse worker), runs revealInDiagram, then edits + saves the
// .dbml so the watcher → worker parse path runs. Writes .work/vscode-smoke.txt.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const lines = [];
const out = (k, v) => lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async () => {
  try {
    const dbml = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'model.dbml');
    const doc = await vscode.workspace.openTextDocument(dbml);
    await vscode.window.showTextDocument(doc);
    out('languageId', doc.languageId);
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'dddbml');
    out('extension', ext ? ext.id : 'NOT FOUND');
    await vscode.commands.executeCommand('dddbml.openDiagram', dbml);
    await sleep(4000);
    out('active', Boolean(ext && ext.isActive));
    out('tabs', vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label));
    const links = (await vscode.commands.executeCommand('vscode.executeLinkProvider', dbml)) || [];
    out('links', links.map((l) => `L${l.range.start.line}:${l.range.start.character}-${l.range.end.character}`));
    if (links[0] && links[0].target) {
      const t = links[0].target;
      await vscode.commands.executeCommand(t.path, ...JSON.parse(decodeURIComponent(t.query)));
      out('revealInDiagram', 'ok');
    }
    const edit = new vscode.WorkspaceEdit();
    edit.insert(dbml, new vscode.Position(doc.lineCount, 0), '\nTable smoke_added {\n  id int [pk]\n}\n');
    out('applyEdit', await vscode.workspace.applyEdit(edit));
    out('save', await doc.save());
    await sleep(3000);
  } catch (e) {
    out('ERROR', (e && e.stack) || String(e));
  }
  fs.writeFileSync(path.join(__dirname, '..', '.work', 'vscode-smoke.txt'), lines.join('\n') + '\n');
};
