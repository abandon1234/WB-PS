/**
 * 检测本机浏览器是否支持 Local Font Access API（queryLocalFonts）。
 *
 * 无头模式下这个 API 恒为 undefined（没有字体访问能力），所以必须带窗口跑。
 * 窗口位置挪到屏幕外，几秒后自动关闭，不打扰使用。
 *
 *   node tools/probe_fontapi.mjs [--base https://ps.ysw69.dpdns.org]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = arg('base', 'https://ps.ysw69.dpdns.org').replace(/\/$/, '');
const PORT = 9350;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!EDGE) { console.error('找不到浏览器'); process.exit(1); }
const profile = path.join(os.tmpdir(), `wb-fontapi-${Date.now()}`);
const child = spawn(EDGE, [
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--no-proxy-server',
  // queryLocalFonts 在不可见的页面上会抛 SecurityError: Page needs to be visible，
  // 所以这里不能挪到屏幕外；窗口只会短暂出现。
  '--window-size=900,600',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, BASE,
], { stdio: 'ignore' });

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
      setTimeout(() => { if (this.waiting.delete(id)) rej(new Error(`超时 ${method}`)); }, 60000);
    });
  }
  async evaluate(expr, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && t.url.startsWith(BASE));
    if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch (_) {}
  await sleep(500);
}
if (!wsUrl) { child.kill(); console.error('浏览器未就绪'); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
const cdp = new CDP(ws);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

// 等页面真正加载完再取值 —— 抢在导航完成前取，isSecureContext 会读到上一个文档的值
for (let i = 0; i < 60; i++) {
  const st = await cdp.evaluate(`({ href: location.href, ready: document.readyState })`).catch(() => null);
  if (st && st.ready === 'complete' && st.href.startsWith(BASE)) break;
  await sleep(500);
}
await sleep(1200);

const info = await cdp.evaluate(`(async () => ({
  href: location.href,
  ua: navigator.userAgent,
  secure: window.isSecureContext,
  // 注意：挂在 window 上，不是 navigator
  hasApi: typeof window.queryLocalFonts === 'function',
  alsoOnNavigator: typeof navigator.queryLocalFonts,
  permApi: !!(navigator.permissions && navigator.permissions.query),
}))()`);

console.log(`页面：${info.href}`);
console.log(`浏览器：${info.ua}`);
console.log(`安全上下文：${info.secure}`);
console.log(`window.queryLocalFonts 可用：${info.hasApi}（navigator 上：${info.alsoOnNavigator}）`);

if (info.hasApi) {
  // 预授权，免得卡在浏览器的权限弹窗上（弹窗在浏览器 UI 里，脚本点不到）
  await cdp.send('Browser.grantPermissions', {
    origin: BASE, permissions: ['localFonts'],
  }).catch((e) => console.log(`（预授权失败，可能仍会弹窗：${e.message}）`));

  // 页面必须是「可见」状态（Page Visibility），否则 API 直接抛 SecurityError
  await cdp.send('Page.bringToFront').catch(() => {});
  const vis = await cdp.evaluate('({state: document.visibilityState, focused: document.hasFocus()})');
  console.log(`可见性：${vis.state} · 有焦点：${vis.focused}`);

  // 必须由用户手势触发：先派发一次真实的点击，再从点击处理里调用
  const q = await cdp.evaluate(`(async () => {
    return await new Promise((resolve) => {
      const btn = document.createElement('button');
      btn.textContent = '扫描';
      btn.style.cssText = 'position:fixed;left:0;top:0;z-index:9999';
      document.body.appendChild(btn);
      btn.addEventListener('click', async () => {
        try {
          const list = await window.queryLocalFonts();
          const fams = [...new Set(list.map(f => f.family))];
          resolve({ ok: true, total: list.length, families: fams.length,
                    sample: fams.slice(0, 8),
                    hasBlob: typeof list[0]?.blob === 'function' });
        } catch (e) {
          resolve({ ok: false, name: e.name,
                    denied: /denied|permission|NotAllowed/i.test(String(e.name + ' ' + e.message)),
                    error: String(e.message || e) });
        }
      }, { once: true });
      btn.click();
    });
  })()`);
  if (q.ok) {
    console.log(`扫描成功：${q.total} 个字体记录 · ${q.families} 个字族`);
    console.log(`示例：${q.sample.join(' / ')}`);
    console.log(`可取字节（FontData.blob）：${q.hasBlob}`);
  } else {
    console.log(`调用被拒或失败：[${q.name}] ${q.error}`);
  }
}

child.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
