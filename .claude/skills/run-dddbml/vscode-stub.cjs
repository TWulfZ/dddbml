// prep.ts imports host modules that import 'vscode'; it only needs their pure parse helpers.
module.exports = { Uri: { joinPath: () => ({}), file: (p) => ({ fsPath: p }) }, workspace: {}, window: {} };
