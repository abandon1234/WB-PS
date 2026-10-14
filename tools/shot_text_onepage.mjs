/**
 * 一次性的截图脚本：证明「切功能键时左栏的图与缩放不动，只换右栏」。
 * 用打桩引擎跑，不需要模型。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const BASE = 'http://127.0.0.1:8000';
const PORT = 9361;
const OUT = 'C:/Users/35310/.workbuddy/tmp/onepage-shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(OUT, 'profile')}`,
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

let ws;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  try {
    const j = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = j.find((t) => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch (_) { /* 还没起来 */ }
}
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 0; const waiting = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) {
    const { resolve, reject } = waiting.get(m.id);
    waiting.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; waiting.set(i, { resolve: res, reject: rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (waiting.delete(i)) rej(new Error('超时 ' + method)); }, 60000);
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expr, t = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { try { if (await ev(expr)) return; } catch (_) {} await sleep(150); }
  throw new Error('超时 ' + expr);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url: `${BASE}/#text` });
await waitFor('!!window.WBText && window.WBText.ready');

const MOCK = [
  { text: '产品使用说明书', rect: { x: 60, y: 40, w: 300, h: 34 } },
  { text: '联系方式：13800138000', rect: { x: 60, y: 110, w: 330, h: 26 } },
  { text: 'support@example.com', rect: { x: 60, y: 150, w: 260, h: 26 } },
  { text: '深圳市南山区科技园', rect: { x: 60, y: 190, w: 280, h: 26 } },
];

await ev(`(() => {
  const items = ${JSON.stringify(MOCK)};
  window.WBLocal = { ready: true, progress: null, async handle(url) {
    await new Promise((r) => setTimeout(r, 20));
    if (url === '/api/text/detect') return { items, width: 600, height: 400, elapsed_ms: 46 };
    if (url === '/api/analyze') return { session_id: 'shot', items, width: 600, height: 400, elapsed_ms: 52 };
    return {};
  } };
  return true;
})()`);

/* 造一张"文档截图"当素材 */
await ev(`(async () => {
  const cv = document.createElement('canvas');
  cv.width = 600; cv.height = 400;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#f7f8fa'; ctx.fillRect(0, 0, 600, 400);
  ctx.fillStyle = '#fff'; ctx.fillRect(24, 24, 552, 352);
  ctx.fillStyle = '#111'; ctx.font = '600 30px sans-serif';
  ctx.fillText('产品使用说明书', 60, 68);
  ctx.fillStyle = '#333'; ctx.font = '19px sans-serif';
  ctx.fillText('联系方式：13800138000', 60, 130);
  ctx.fillText('support@example.com', 60, 170);
  ctx.fillText('深圳市南山区科技园', 60, 210);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], '文档截图.png', { type: 'image/png' }));
  const inp = document.getElementById('twInput');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await waitFor('window.WBText.copy.result && window.WBText.copy.result.count > 0');
await sleep(600);

const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('  →', path.join(OUT, name));
};
const geo = () => ev(`(() => {
  const i = document.getElementById('twImg');
  return i.style.width + 'x' + i.style.height + ' @' + Math.round(i.getBoundingClientRect().top);
})()`);

console.log('取文字：', await geo());
await shot('1-copy.png');

await ev(`document.querySelector('.tw-tab[data-mode="mask"]').click()`);
await waitFor('window.WBText.mask.lines && window.WBText.mask.lines.length');
await sleep(600);
console.log('打码：  ', await geo());
await shot('2-mask.png');

await ev(`document.querySelector('.tw-tab[data-mode="translate"]').click()`);
await waitFor('window.WBText.translate.items && window.WBText.translate.items.length');
await sleep(600);
console.log('翻译：  ', await geo());
await shot('3-translate.png');

try { child.kill(); } catch (_) {}
process.exit(0);
