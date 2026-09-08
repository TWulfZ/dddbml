import { render } from 'preact';
import { App } from './app';
import styleSource from './style.css?inline';
import { store } from './state/store';
import { postToHost } from './vscode';
import { fitToContent, resetView, zoomAtCenter } from './render/viewport';
import { runSmartLayout, runEdgeOrdering } from './layout/smartLayout';
import type { HostToWebview } from '../shared/types';

{
  const s = document.createElement('style');
  s.textContent = styleSource;
  document.head.appendChild(s);
}

window.addEventListener('message', (ev: MessageEvent<HostToWebview>) => {
  const msg = ev.data;
  const state = store.getState();
  switch (msg.type) {
    case 'schema:update':
      state.setSchema(msg.payload.schema, msg.payload.parseError);
      return;
    case 'layout:loaded':
    case 'layout:external-change':
      state.setLayout(msg.payload);
      return;
    case 'theme:change':
      state.setTheme(msg.payload.kind);
      return;
    case 'settings:loaded':
      state.setSettings(msg.payload);
      return;
    case 'exporters:list':
      state.setExporters(msg.payload.exporters);
      return;
    case 'export:prompt':
      state.setExportPromptOpen(true);
      return;
    case 'export:result':
      state.setExportPromptOpen(false);
      return;
    case 'exportImage:prompt':
      state.setExportImagePromptOpen(true);
      return;
    case 'image:result':
      // Only close on success; on failure/cancel keep the dialog open so the user can retry.
      if (msg.payload.ok) state.setExportImagePromptOpen(false);
      return;
    case 'viewport:command': {
      const el = document.querySelector<HTMLElement>('.ddd-viewport');
      if (!el) return;
      const step = state.settings.zoomStep;
      switch (msg.payload.action) {
        case 'zoomIn':       zoomAtCenter(step, el); return;
        case 'zoomOut':      zoomAtCenter(1 / step, el); return;
        case 'resetView':    resetView(); return;
        case 'fitToContent': fitToContent(el); return;
      }
      return;
    }
    case 'command:autoArrange':
      void runSmartLayout(msg.payload.mode, {
        orderEdges: msg.payload.orderEdges,
        preserveManualEdges: msg.payload.preserveManualEdges,
      });
      return;
    case 'command:orderEdges':
      void runEdgeOrdering({ preserveManual: msg.payload.preserveManualEdges });
      return;
    case 'merge:begin':
      state.beginMerge(msg.payload.conflicts);
      return;
    case 'merge:done':
      state.endMerge();
      return;
    case 'git:status':
      state.setGitStatus(msg.payload);
      return;
    case 'git:commitResult':
      state.setGitBusy(false);
      if (msg.payload.ok) state.noteGitCommitOk();
      return;
    case 'git:stashes':
      state.setGitStashes(msg.payload.stashes);
      return;
    case 'git:opResult':
      state.setGitBusy(false);
      return;
    case 'git:commits':
      state.setGitCommits(msg.payload.commits);
      return;
    case 'git:timeTravel:enter':
      // Swap in the past revision's schema + layout, then flip to read-only time-travel mode.
      state.setSchema(msg.payload.schema, null);
      state.setLayout(msg.payload.layout);
      state.enterTimeTravel(msg.payload.rev, msg.payload.label);
      return;
    case 'git:timeTravel:exit':
      // Leave read-only mode; the host re-sends the working schema:update + layout:loaded after this.
      state.exitGitView();
      return;
    case 'git:diff:enter':
      // Keep the current (working) schema on screen; overlay the diff and enter read-only.
      state.enterDiff(msg.payload.baseLabel, msg.payload.headLabel, msg.payload.diff);
      return;
  }
});

window.addEventListener('error', (ev) => {
  postToHost({ type: 'error:log', payload: { message: String(ev.message), stack: ev.error?.stack } });
});

const root = document.getElementById('root');
if (root) render(<App post={postToHost} />, root);

postToHost({ type: 'ready' });
