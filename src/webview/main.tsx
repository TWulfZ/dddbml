import { render } from 'preact';
import { App } from './app';
import styleSource from './style.css?inline';
import { store } from './state/store';
import { postToHost } from './vscode';
import { fitToContent, resetView, zoomAtCenter } from './render/viewport';
import { runSmartLayout } from './layout/smartLayout';
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
      void runSmartLayout(msg.payload.mode);
      return;
    case 'merge:begin':
      state.beginMerge(msg.payload.conflicts);
      return;
    case 'merge:done':
      state.endMerge();
      return;
  }
});

window.addEventListener('error', (ev) => {
  postToHost({ type: 'error:log', payload: { message: String(ev.message), stack: ev.error?.stack } });
});

const root = document.getElementById('root');
if (root) render(<App post={postToHost} />, root);

postToHost({ type: 'ready' });
