/**
 * 定位 image.js 在合并页面里初始化时的报错点
 * 通过 CDP 抓取异常的堆栈行号。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const BASE = (process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1] : 'http://127.0.0.1:8788');
const PORT = 9356;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.join(os.tmpdir(), `wb-diag-${Date.now()}`);
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--no-proxy-server', '--disable-extensions',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1400,900', 'about:blank',
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
      setTimeout(() => { if (this.waiting.delete(id)) rej(new Error(`超时 ${method}`)); }, 120000);
    });
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
await cdp.send('Runtime.enable');
await cdp.send('Log.enable').catch(() => {});

cdp.on('Runtime.exceptionThrown', (p) => {
  const d = p.exceptionDetails || {};
  const desc = d.exception?.description || d.text || '';
  console.log('\n【异常】', desc.split('\n')[0]);
  console.log('  位置:', (d.url || '?').replace(/^.*\/static\//, '/static/'),
    '行', d.lineNumber + 1, '列', d.columnNumber + 1);
  const frames = (d.stackTrace?.callFrames || []).slice(0, 6);
  frames.forEach((f, i) => {
    console.log(`  #${i} ${f.functionName || '(匿名)'}  ${(f.url || '').replace(/^.*\/static\//, '/static/')}:${f.lineNumber + 1}`);
  });
});
cdp.on('Log.entryAdded', (p) => {
  if (p.entry.level === 'error') console.log('【控制台】', String(p.entry.text).slice(0, 200));
});

await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: `${BASE}/` });
await sleep(12000);

const st = await cdp.send('Runtime.evaluate', {
  expression: `({
    wbImage: typeof window.WBImage,
    ready: window.WBImage ? window.WBImage.ready : null,
    editVisible: (() => { const e = document.getElementById('viewEdit');
      return !!(e && !e.hidden && getComputedStyle(e).display !== 'none'); })(),
  })`, returnByValue: true,
});
console.log('\n状态：', JSON.stringify(st.result.value));
child.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
