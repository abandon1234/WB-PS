/**
 * 量化"页间切换"的开销
 *
 * 分别测三种情况，看时间花在哪：
 *   1. 首次进 /（无缓存）
 *   2. / → /image 的切换
 *   3. /image → / 的切换（回切）
 *
 *   node tools/probe_nav.mjs [--base https://ps.ysw69.dpdns.org] [--profile <dir>]
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
const fixedProfile = arg('profile', '');
const PORT = 9354;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async waitFor(expr, timeout = 120000, label = expr) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await this.evaluate(expr)) return true; } catch (_) {}
      await sleep(200);
    }
    throw new Error(`等待超时：${label}`);
  }
}

const profile = fixedProfile || path.join(os.tmpdir(), `wb-nav-${Date.now()}`);
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--no-proxy-server', '--disable-extensions',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch (_) {}
  await sleep(400);
}
if (!wsUrl) { child.kill(); console.error('浏览器未就绪'); process.exit(1); }
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
const cdp = new CDP(ws);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');

// 记录每个跳转阶段的事件时间
let navStart = 0;
let firstPaint = 0;
let domReady = 0;
let loadDone = 0;
let apiCalls = [];

cdp.on('Page.frameNavigated', () => { if (!navStart) navStart = Date.now(); });
cdp.on('Page.domContentEventFired', () => { if (navStart && !domReady) domReady = Date.now(); });
cdp.on('Page.loadEventFired', () => { if (navStart && !loadDone) loadDone = Date.now(); });
cdp.on('Page.lifecycleEvent', (p) => {
  if (p.name === 'firstContentfulPaint' && navStart && !firstPaint) firstPaint = Date.now();
});
cdp.on('Network.requestWillBeSent', (p) => {
  const u = new URL(p.request.url);
  if (u.pathname.startsWith('/static/') || u.pathname.startsWith('/api/')) {
    apiCalls.push({ t: Date.now(), url: u.pathname, type: p.type });
  }
});

async function measure(url, label, readyExpr) {
  navStart = firstPaint = domReady = loadDone = 0;
  apiCalls = [];
  const t0 = Date.now();
  await cdp.send('Page.navigate', { url });
  await cdp.waitFor(readyExpr, 180000, `${label} 就绪`);
  const ready = Date.now() - t0;
  await sleep(400);

  const rel = (t) => (t ? ((t - t0) / 1000).toFixed(2) + 's' : '—');
  const statics = apiCalls.filter((c) => c.url.startsWith('/static/'));
  const apis = apiCalls.filter((c) => c.url.startsWith('/api/'));
  console.log(`\n【${label}】${url}`);
  console.log(`  首帧 ${rel(firstPaint)} · DOM就绪 ${rel(domReady)} · load ${rel(loadDone)} · 功能可用 ${(ready / 1000).toFixed(2)}s`);
  console.log(`  静态请求 ${statics.length} 个 · 接口请求 ${apis.length} 个${apis.length ? '（' + apis.map((a) => a.url).join(', ') + '）' : ''}`);
  return ready;
}

try {
  const tA = await measure(`${BASE}/`, '① 首次进无痕改字',
    "document.getElementById('statusText') && /就绪|已恢复/.test(document.getElementById('statusText').textContent)");
  const tB = await measure(`${BASE}/image#create`, '② 切到自由生成',
    "!!document.getElementById('btnGenerate')");
  const tC = await measure(`${BASE}/`, '③ 切回无痕改字',
    "document.getElementById('statusText') && /就绪|已恢复/.test(document.getElementById('statusText').textContent)");
  const tD = await measure(`${BASE}/image#projects`, '④ 切到作品库',
    "!!document.getElementById('btnGenerate')");

  console.log('\n' + '='.repeat(66));
  console.log('汇总：');
  console.log(`  首次进无痕改字     ${(tA / 1000).toFixed(2)}s（含模型下载/初始化）`);
  console.log(`  → 自由生成         ${(tB / 1000).toFixed(2)}s`);
  console.log(`  → 切回无痕改字     ${(tC / 1000).toFixed(2)}s`);
  console.log(`  → 作品库           ${(tD / 1000).toFixed(2)}s`);
  console.log('='.repeat(66));
} catch (err) {
  console.error('失败：', err.message);
  process.exitCode = 1;
} finally {
  child.kill();
  if (!fixedProfile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} }
}
