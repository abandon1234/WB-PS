/**
 * 域名可达性探针（真实浏览器直连，绕开沙箱代理）
 *
 *   node tools/probe_domain.mjs https://a.example.com https://b.example.com
 *
 * 为什么要用浏览器而不是 curl：沙箱注入了 HTTP_PROXY，curl 的出网是白名单制，
 * 探不出"国内能不能访问"这个真实问题。Edge 以 --no-proxy-server 启动后走本机网络，
 * 它的 ERR_* 就是用户实际会遇到的错误。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = process.argv.slice(2).filter((a) => a.startsWith('http'));
if (!targets.length) {
  console.error('用法：node tools/probe_domain.mjs <url> [url...]');
  process.exit(1);
}

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
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.waiting.delete(id)) reject(new Error(`超时 ${method}`)); }, 60000);
    });
  }
}

const exe = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!exe) { console.error('找不到 Edge'); process.exit(1); }

const profile = path.join(os.tmpdir(), `wb-probe-${Date.now()}`);
const child = spawn(exe, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--no-proxy-server', '--disable-extensions',
  '--remote-debugging-port=9347', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

let ws = null;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:9347/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.addEventListener('open', res);
        ws.addEventListener('error', () => rej(new Error('ws fail')));
      });
      break;
    }
  } catch (_) { /* 未就绪 */ }
  await sleep(400);
}
if (!ws) { child.kill(); console.error('浏览器未就绪'); process.exit(1); }

const cdp = new CDP(ws);
await cdp.send('Page.enable');

const results = [];
for (const url of targets) {
  const t0 = Date.now();
  let err = '';
  try {
    const r = await cdp.send('Page.navigate', { url });
    await sleep(2500);
    err = r.errorText || '';
  } catch (e) { err = String(e.message); }
  const ms = Date.now() - t0;
  results.push({ url, err, ms });
  console.log(`  ${err ? '✗ 不通' : '✓ 可达'}  ${url.padEnd(46)} ${String(ms).padStart(6)}ms  ${err}`);
}

child.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
process.exitCode = results.every((r) => !r.err) ? 0 : 1;
