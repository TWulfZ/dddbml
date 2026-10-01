import { render } from 'preact';
import { App } from './app';
import styleSource from './style.css?inline';
import { postToHost } from './vscode';
import { handleHostMessage } from './hostMessages';
import type { HostToWebview } from '../shared/types';

{
  const s = document.createElement('style');
  s.textContent = styleSource;
  document.head.appendChild(s);
}

window.addEventListener('message', (ev: MessageEvent<HostToWebview>) => handleHostMessage(ev.data));

window.addEventListener('error', (ev) => {
  postToHost({ type: 'error:log', payload: { message: String(ev.message), stack: ev.error?.stack } });
});

const root = document.getElementById('root');
if (root) render(<App post={postToHost} />, root);

postToHost({ type: 'ready' });
