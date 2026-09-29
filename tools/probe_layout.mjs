/**
 * 检查合并后各视图的实际可见性与尺寸
 *
 *   node tools/probe_layout.mjs [--base https://ps.ysw69.dpdns.org] [--profile <dir>]
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
const BASE = arg('base', 'http://127.0.0.1:8788').replace(/\/$/, '');
const fixedProfile = arg('profile', '');
const PORT = 9362;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiting = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.waiting.has(m.id)) {
        const { resolve, reject } = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiting.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.waiting.delete(id)) rej(new Error(`超时 ${method}`)); }, 120000);
    });
  }
  async evaluate(expr, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

const profile = fixedProfile || path.join(os.tmpdir(), `wb-lay-${Date.now()}`);
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

const probe = () => cdp.evaluate(`(() => {
  const ids = ['viewEdit', 'viewImages', 'viewGenerate', 'viewProjects', 'stage', 'appSidebar'];
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) { out[id] = '不存在'; continue; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out[id] = {
      hidden: el.hidden,
      display: cs.display,
      visible: !el.hidden && cs.display !== 'none',
      size: Math.round(r.width) + '×' + Math.round(r.height),
    };
  }
  return out;
})()`);

try {
  for (const [label, url] of [
    ['改字视图（/）', `${BASE}/`],
    ['生成视图（/#create）', `${BASE}/#create`],
    ['作品库（/#projects）', `${BASE}/#projects`],
  ]) {
    await cdp.send('Page.navigate', { url });
    await sleep(9000);
    const r = await probe();
    console.log(`\n【${label}】`);
    for (const [k, v] of Object.entries(r)) {
      if (v === '不存在') { console.log(`  ${k.padEnd(14)} 不存在`); continue; }
      const mark = v.visible ? '✓' : '✗';
      console.log(`  ${mark} ${k.padEnd(14)} display=${String(v.display).padEnd(10)} size=${String(v.size).padEnd(11)} hidden=${v.hidden}`);
    }
  }
} catch (err) {
  console.error('失败：', err.message);
} finally {
  child.kill();
  if (!fixedProfile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} }
}
