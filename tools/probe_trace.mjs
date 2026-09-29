/**
 * 前端初始化轨迹追踪
 *
 * 目的：把「谁在 404」「控制台说了什么」按时间顺序打出来。
 * 之前只看到状态栏最后一句文案，看不到它前面发生了什么。
 *
 *   node tools/probe_trace.mjs [--base https://ps.ysw69.dpdns.org] [--select]
 *   --select 会额外模拟「选一张图」，用于排查选图后的流程
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = arg('base', 'https://ps.ysw69.dpdns.org').replace(/\/$/, '');
const PORT = 9349;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!EDGE) { console.error('找不到 Edge'); process.exit(1); }
// --profile <dir>：复用浏览器配置目录，可复现"上次的工作区被自动恢复"后的行为
const fixedProfile = arg('profile', '');
const profile = fixedProfile || path.join(os.tmpdir(), `wb-trace-${Date.now()}`);
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--no-proxy-server', '--disable-extensions',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiting = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.waiting.has(m.id)) {
        const { resolve, reject } = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) {
        (this.listeners.get(m.method) || []).forEach((fn) => fn(m.params));
      }
    });
  }
  on(m, fn) { if (!this.listeners.has(m)) this.listeners.set(m, []); this.listeners.get(m).push(fn); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiting.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.waiting.delete(id)) rej(new Error(`超时 ${method}`)); }, 300000);
    });
  }
  async evaluate(expr, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面执行出错: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
}

let wsUrl = null;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch (_) {}
  await sleep(400);
}
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
const cdp = new CDP(ws);

const t0 = Date.now();
const stamp = () => `[${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(6)}s]`;
const SKIP = /\/(assets|static)\//;   // 静态资源太吵，只看接口与页面

cdp.on('Runtime.consoleAPICalled', (p) => {
  const txt = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
  console.log(`${stamp()} console.${p.type}  ${txt.slice(0, 220)}`);
});
cdp.on('Runtime.exceptionThrown', (p) => {
  console.log(`${stamp()} EXCEPTION  ${String(p.exceptionDetails?.exception?.description ||
    p.exceptionDetails?.text).split('\n')[0]}`);
});
cdp.on('Network.requestWillBeSent', (p) => {
  const u = new URL(p.request.url);
  if (SKIP.test(u.pathname)) return;
  console.log(`${stamp()} → ${p.request.method} ${u.pathname}${u.search}`);
});
cdp.on('Network.responseReceived', (p) => {
  const u = new URL(p.response.url);
  if (SKIP.test(u.pathname)) return;
  const flag = p.response.status >= 400 ? '  ✗' : '';
  console.log(`${stamp()} ← ${p.response.status} ${u.pathname}${flag}`);
});

await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');

console.log(`追踪 ${BASE}/ …\n`);
await cdp.send('Page.navigate', { url: `${BASE}/` });

// 轮询状态，直到引擎就绪或超时
for (let i = 0; i < 200; i++) {
  await sleep(3000);
  let s = null;
  try {
    s = await cdp.evaluate(`({ ready: !!(window.WBLocal && window.WBLocal.ready),
      text: (document.getElementById('statusText')||{}).textContent || '',
      meta: (document.getElementById('statusMeta')||{}).textContent || '' })`);
  } catch (_) { continue; }
  if (i % 3 === 0) console.log(`${stamp()} 状态栏：「${s.text}」${s.meta ? ' · ' + s.meta : ''}  (ready=${s.ready})`);
  if (s.ready) {
    console.log(`${stamp()} 引擎就绪`);
    await sleep(1500);
    break;
  }
}

const fin = await cdp.evaluate(`({ text: (document.getElementById('statusText')||{}).textContent,
  meta: (document.getElementById('statusMeta')||{}).textContent,
  foot: (document.getElementById('footLeft')||{}).textContent,
  fonts: (window.WBLocal && window.WBLocal.ready) ? null : 'not ready' })`);
console.log(`\n最终状态栏：「${fin.text}」 · 「${fin.meta}」\n页脚：「${fin.foot}」`);

if (process.argv.includes('--select')) {
  console.log('\n--- 模拟选图 ---');
  const sample = path.resolve('samples/test_card.png');
  const b64 = fs.readFileSync(sample).toString('base64');
  await cdp.evaluate(`(() => {
    const bin = atob(${JSON.stringify(b64)});
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u8], 'test_card.png', { type: 'image/png' }));
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`, false);

  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const s = await cdp.evaluate(`({ text: (document.getElementById('statusText')||{}).textContent,
      opts: document.querySelectorAll('#selFont option').length,
      items: document.querySelectorAll('.item').length })`).catch(() => null);
    if (!s) continue;
    console.log(`${stamp()} 「${s.text}」 下拉 ${s.opts} 项 · 列表 ${s.items} 行`);
    if (s.opts > 1) { console.log('\n下拉已填充：');
      console.log(await cdp.evaluate(`[...document.querySelectorAll('#selFont option')].slice(0,10).map(o=>o.textContent.trim()).join(' | ')`));
      break; }
  }
}

child.kill();
if (!fixedProfile) {
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
}
