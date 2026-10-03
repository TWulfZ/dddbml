// Static server for the webview harness: the harness page, the built webview from dist/webview, and
// fixture payloads from .work/. Usage: node serve.mjs [port]  (default 8765).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const K = import.meta.dirname;
const R = join(K, '../../..');
const PORT = Number(process.argv[2] ?? 8765);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ttf': 'font/ttf' };

const resolve = (url) => {
  const p = normalize(decodeURIComponent(new URL(url, 'http://x').pathname)).replace(/^\/+/, '');
  if (p === '' || p === 'harness.html') return join(K, 'harness.html');
  if (p.startsWith('webview/')) return join(R, 'dist', p);
  if (p.endsWith('.json') && !p.includes('/')) return join(K, '.work', p);
  return null;
};

createServer(async (req, res) => {
  const file = resolve(req.url ?? '/');
  if (!file) { res.writeHead(404).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(PORT, '127.0.0.1', () => console.log(`harness on http://127.0.0.1:${PORT}/harness.html`));
