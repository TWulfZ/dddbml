// Line-based driver for the webview harness: node drive.mjs <fixture> [port] < script
// One command per line; '#' lines are comments. Screenshots land in .work/shots/.
import { chromium } from 'playwright-core';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import { join } from 'node:path';

const fixture = process.argv[2] || 'small';
const port = process.argv[3] || '8765';
const SHOTS = join(import.meta.dirname, '.work', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}/harness.html?fixture=${fixture}`);
await page.waitForFunction(() => window.__hydrated === true, null, { timeout: 30000 });
await page.waitForFunction(() => document.querySelectorAll('.ddd-table').length > 0, null, { timeout: 60000 });
console.log(`first tables painted after ${Date.now() - t0} ms`);
await page.waitForTimeout(500);

const withMods = async (mods, fn) => {
  const keys = mods.split('+').filter(Boolean);
  for (const k of keys) await page.keyboard.down(k);
  await fn();
  for (const k of keys) await page.keyboard.up(k);
};

const C = {
  ss: async (n) => { await page.screenshot({ path: join(SHOTS, n + '.png') }); console.log('shot', join(SHOTS, n + '.png')); },
  wait: async (ms) => page.waitForTimeout(Number(ms)),
  eval: async (...js) => console.log(JSON.stringify(await page.evaluate(js.join(' ')))),
  click: async (x, y) => page.mouse.click(+x, +y),
  dbl: async (x, y) => page.mouse.dblclick(+x, +y),
  rclick: async (x, y) => page.mouse.click(+x, +y, { button: 'right' }),
  move: async (x, y) => page.mouse.move(+x, +y),
  mv: async (x, y, steps = 10) => page.mouse.move(+x, +y, { steps: +steps }),
  down: async () => page.mouse.down(),
  up: async () => page.mouse.up(),
  drag: async (x1, y1, x2, y2, steps = 20, mods = '') => withMods(mods, async () => {
    await page.mouse.move(+x1, +y1); await page.mouse.down();
    await page.mouse.move(+x2, +y2, { steps: +steps }); await page.mouse.up();
  }),
  wheel: async (x, y, dx, dy, n = 1) => {
    await page.mouse.move(+x, +y);
    for (let i = 0; i < +n; i++) { await page.mouse.wheel(+dx, +dy); await page.waitForTimeout(16); }
  },
  key: async (k) => page.keyboard.press(k),
  clicktext: async (...t) => page.getByText(t.join(' '), { exact: true }).first().click(),
  deliver: async (...json) => page.evaluate((m) => window.__deliver(m), JSON.parse(json.join(' '))),
  posted: async (prefix) => console.log(JSON.stringify((await page.evaluate(() => window.__posted))
    .filter((m) => !prefix || m.type.startsWith(prefix)).map((m) => ({ type: m.type, payload: m.payload })).slice(-8))),
  clearposted: async () => page.evaluate(() => { window.__posted.length = 0; }),
  bbox: async (...sel) => console.log(JSON.stringify(await page.evaluate((s) => [...document.querySelectorAll(s)].slice(0, 12).map((e) => {
    const r = e.getBoundingClientRect();
    return { id: e.dataset?.id ?? e.dataset?.col, t: (e.textContent || '').trim().slice(0, 30), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }), sel.join(' ')))),
  edges: async () => console.log(JSON.stringify(await page.evaluate(() =>
    [...document.querySelectorAll('path.ddd-edge')].map((p) => p.getAttribute('d'))))),
  framesStart: async () => page.evaluate(() => {
    window.__frames = []; window.__stopFrames = false;
    let last = performance.now();
    const loop = (t) => { window.__frames.push(t - last); last = t; if (!window.__stopFrames) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }),
  framesStop: async () => console.log(JSON.stringify(await page.evaluate(() => {
    window.__stopFrames = true;
    const f = window.__frames.slice(2).sort((a, b) => a - b);
    const q = (p) => f[Math.min(f.length - 1, Math.floor(p * f.length))];
    return { n: f.length, mean: +(f.reduce((a, b) => a + b, 0) / f.length).toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +f[f.length - 1].toFixed(2), over33: f.filter((x) => x > 33.4).length };
  }))),
  errors: async () => console.log('errors:', errors.length ? errors.join('\n') : 'none'),
};

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const l = line.trim();
  if (!l || l.startsWith('#')) continue;
  const [cmd, ...args] = l.split(/\s+/);
  if (!C[cmd]) { console.log('unknown command', cmd); continue; }
  try { await C[cmd](...args); } catch (e) { console.log('ERR', cmd, e.message.split('\n')[0]); }
}
await browser.close();
