/**
 * 给「字体选择器」截图（用于人工复核下拉是否清楚可读）
 *
 *   node tools/shot_fontpick.mjs [--base https://ps.ysw69.dpdns.org] [--profile <dir>] [--filter <kw>]
 *
 * 会：打开页面 → 等引擎就绪 → 点开第一个文字块 → 截图编辑器面板。
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
const filter = arg('filter', '');
const PORT = 9351;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = fixedProfile || path.join(os.tmpdir(), `wb-shot-${Date.now()}`);
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--no-proxy-server', '--disable-extensions', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1400,900', 'about:blank',
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
      setTimeout(() => { if (this.waiting.delete(id)) rej(new Error(`超时 ${method}`)); }, 300000);
    });
  }
  async evaluate(expr, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async waitFor(expr, timeout = 60000, label = expr) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await this.evaluate(expr)) return true; } catch (_) {}
      await sleep(300);
    }
    throw new Error(`等待超时：${label}`);
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
if (!wsUrl) { child.kill(); console.error('浏览器未就绪'); process.exit(1); }
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
const cdp = new CDP(ws);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

try {
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('window.WBLocal && window.WBLocal.ready === true', 300000, '本地引擎就绪');

  // 先确保本机字体已扫（这样列表里能看到系统的 200 多个字族）
  await cdp.send('Browser.grantPermissions', { origin: BASE, permissions: ['localFonts'] }).catch(() => {});
  const sc = await cdp.evaluate(`window.WBLocal.handle('/api/fonts/scan', null)`);
  console.log(`本机字体：${sc.scan && sc.scan.supported ? sc.scan.count + ' 个字族' : '不可用'} · 合计 ${sc.families.length}`);

  // 恢复的工作区里应该已经有文字块；没有就先选一张图
  const has = await cdp.evaluate(`document.querySelectorAll('#itemList .item').length`);
  if (!has) {
    const b64 = fs.readFileSync('samples/test_card.png').toString('base64');
    await cdp.evaluate(`(() => {
      const bin = atob(${JSON.stringify(b64)});
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([u8], 'test_card.png', { type: 'image/png' }));
      const inp = document.getElementById('fileInput');
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`, false);
    await cdp.waitFor("document.querySelectorAll('#itemList .item').length > 0", 180000, '识别出文字块');
  }
  await cdp.evaluate("document.querySelector('#itemList .item').click()", false);
  await cdp.waitFor("document.querySelectorAll('#selFont option').length > 1", 30000, '字体列表填充');

  if (filter) {
    await cdp.evaluate(`(() => {
      const b = document.getElementById('fontFilter');
      b.value = ${JSON.stringify(filter)};
      b.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`, false);
    await sleep(600);
  }

  const stat = await cdp.evaluate(`(() => ({
    optionCount: document.querySelectorAll('#selFont option').length,
    groups: [...document.querySelectorAll('#selFont optgroup')].map(g => g.label),
    first: [...document.querySelectorAll('#selFont option')].slice(0, 4).map(o => o.textContent.trim()),
  }))()`);
  console.log(`下拉：${stat.optionCount} 项 · 分组 ${stat.groups.join(' / ')}`);
  console.log(`前几项：${stat.first.join(' | ')}`);

  // 只截右上那个编辑面板，聚焦看字体区
  const box = await cdp.evaluate(`(() => {
    const el = document.getElementById('selFont').closest('.card') || document.getElementById('selFont').parentElement;
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), w: r.width + 16, h: r.height + 16 };
  })()`);
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x, y: box.y, width: box.w, height: Math.min(box.h, 900), scale: 2 },
  });
  fs.mkdirSync('samples/out', { recursive: true });
  const out = path.resolve('samples/out/font_picker.png');
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`已保存：${out}`);
} catch (err) {
  console.error('失败：', err.message);
  process.exitCode = 1;
} finally {
  child.kill();
  if (!fixedProfile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} }
}
