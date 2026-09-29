/**
 * 双视图合并后的切换验证
 *
 * 关注四件事：
 *   1. / 上两个视图能按 hash 正确切换（改字 ↔ 生成 ↔ 作品库）
 *   2. 切换【不再重新加载页面】（这是本次改造的目的）
 *   3. 老链接 /image 仍能落到生成视图
 *   4. 切换耗时（与合并前对比）
 *
 *   node tools/probe_views.mjs [--base http://127.0.0.1:8788] [--profile <dir>]
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
const PORT = 9355;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PASS = [], FAIL = [];
const check = (name, ok, detail = '') => {
  (ok ? PASS : FAIL).push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
};

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

const profile = fixedProfile || path.join(os.tmpdir(), `wb-views-${Date.now()}`);
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

// 统计页面加载次数：合并成功后，切视图不该再触发新的 document 加载
let docLoads = 0;
cdp.on('Page.frameNavigated', (p) => { if (!p.frame.parentId) docLoads++; });
const pageErrors = [];
cdp.on('Runtime.exceptionThrown', (p) => pageErrors.push(String(
  p.exceptionDetails?.exception?.description || p.exceptionDetails?.text).split('\n')[0]));

const viewState = () => cdp.evaluate(`(() => {
  const e = document.getElementById('viewEdit'), i = document.getElementById('viewImages');
  const vis = (el) => !!(el && !el.hidden && getComputedStyle(el).display !== 'none');
  return {
    edit: vis(e), images: vis(i),
    hash: location.hash, path: location.pathname,
    genVisible: (() => { const g = document.getElementById('viewGenerate');
      return !!(g && !g.hidden && getComputedStyle(g).display !== 'none'); })(),
    projVisible: (() => { const pr = document.getElementById('viewProjects');
      return !!(pr && !pr.hidden && getComputedStyle(pr).display !== 'none'); })(),
    bodyMode: document.body.className,
  };
})()`);

/** 点侧边栏导航项，并等目标视图真正显示出来（不是死等固定时长） */
async function clickNav(key, expect) {
  const t0 = Date.now();
  // 侧边栏由 shell.js 异步渲染，点击前先确认目标项存在 ——
  // 否则 querySelector 拿不到元素、点击静默失败（表现成"点了没反应"）。
  await cdp.waitFor(`!!document.querySelector('.sb-item[data-key="${key}"]')`,
    20000, `侧边栏出现 ${key} 项`);
  const ok = await cdp.evaluate(`(() => {
    const a = document.querySelector('.sb-item[data-key="${key}"]');
    if (!a) return false;
    a.click();
    return true;
  })()`);
  // 等到期望的视图可见 —— 切换本身很快，但内部还要渲染，固定 sleep 会误判
  const expr = expect === 'edit'
    ? "(() => { const e=document.getElementById('viewEdit'); return !!(e && !e.hidden && getComputedStyle(e).display!=='none'); })()"
    : "(() => { const i=document.getElementById('viewImages'); return !!(i && !i.hidden && getComputedStyle(i).display!=='none'); })()";
  try {
    await cdp.waitFor(expr, 15000, `切到 ${expect}`);
  } catch (_) { /* 交给断言报错 */ }
  return { ok, ms: Date.now() - t0 };
}

try {
  console.log('='.repeat(74));
  console.log(`双视图切换验证   ${BASE}/`);
  console.log('='.repeat(74));

  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor("!!window.WBImage", 120000, '生成模块加载');
  await cdp.waitFor("!!window.WBImage.ready", 60000, '生成模块就绪');
  // 等视图路由把改字视图显示出来（外层路由是异步接管的）
  await cdp.waitFor(
    "(() => { const e = document.getElementById('viewEdit');"
    + " const i = document.getElementById('viewImages');"
    + " if (!e || !i) return false;"
    + " return !e.hidden && i.hidden; })()",
    30000, '初始落在改字视图');
  console.log('\n[1] 初始状态');
  const s0 = await viewState();
  check('默认落在改字视图', s0.edit === true && s0.images === false,
    `hash="${s0.hash}" body=${s0.bodyMode}`);
  const loadsAfterFirst = docLoads;

  console.log('\n[2] 点侧边栏「自由生成」');
  const dbg = await cdp.evaluate(`(() => {
    const a = document.querySelector('.sb-item[data-key="create"]');
    return { found: !!a, tag: a ? a.tagName : '', href: a ? a.getAttribute('href') : '',
             hash: location.hash };
  })()`);
  console.log(`      侧边栏项：found=${dbg.found} ${dbg.tag} href=${dbg.href} hash="${dbg.hash}"`);
  const c1 = await clickNav('create', 'images');
  const s1 = await viewState();
  check('点击导航项成功', c1.ok === true, `ok=${c1.ok}`);
  check('切到生成视图', s1.images === true && s1.edit === false,
    `${c1.ms}ms · hash="${s1.hash}"`);
  check('生成视图内部显示生成区', s1.genVisible === true);
  check('切换没有重新加载页面', docLoads === loadsAfterFirst,
    `文档加载次数 ${docLoads}（切换前 ${loadsAfterFirst}）`);

  console.log('\n[3] 点「作品库」');
  const c2 = await clickNav('projects', 'images');
  const s2 = await viewState();
  check('切到作品库视图', s2.images === true && s2.projVisible === true,
    `${c2.ms}ms · hash="${s2.hash}"`);
  check('作品库切换也没有重新加载页面', docLoads === loadsAfterFirst, `文档加载 ${docLoads} 次`);

  console.log('\n[4] 点回「无痕改字」');
  const c3 = await clickNav('edit', 'edit');
  const s3 = await viewState();
  check('切回改字视图', s3.edit === true && s3.images === false,
    `${c3.ms}ms · hash="${s3.hash}"`);
  check('切回也没有重新加载页面', docLoads === loadsAfterFirst, `文档加载 ${docLoads} 次`);
  check('生成视图已隐藏', s3.images === false);

  console.log('\n[5] 深链与兼容入口');
  await cdp.send('Page.navigate', { url: `${BASE}/#combine` });
  await sleep(2500);
  const s4 = await viewState();
  check('深链 /#combine 直接落到生成视图', s4.images === true, `hash="${s4.hash}"`);

  await cdp.send('Page.navigate', { url: `${BASE}/image#projects` });
  await sleep(3000);
  const s5 = await viewState();
  check('老链接 /image#projects 跳到同一页且保留 hash',
    s5.path === '/' && s5.hash === '#projects' && s5.images === true,
    `${s5.path}${s5.hash}`);

  console.log('\n[6] 双向切换耗时（采样 5 次取平均）');
  const times = [];
  for (let i = 0; i < 5; i++) {
    await cdp.send('Runtime.evaluate', { expression: `location.hash = '#edit'` });
    await sleep(400);
    const t0 = Date.now();
    await cdp.send('Runtime.evaluate', { expression: `location.hash = '#create'` });
    await cdp.waitFor("(() => { const i = document.getElementById('viewImages');"
      + " return i && !i.hidden && getComputedStyle(i).display !== 'none'; })()", 10000);
    times.push(Date.now() - t0);
    await sleep(300);
  }
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  check('改字 → 生成 切换耗时很短', avg < 500,
    `平均 ${avg}ms（样本 ${times.join('/')}）· 对比合并前切回改字 5770ms`);

  console.log('\n' + '='.repeat(74));
  console.log(`结果：${PASS.length} 通过 / ${FAIL.length} 失败`);
  if (FAIL.length) FAIL.forEach((f) => console.log(`  ✗ ${f}`));
  if (pageErrors.length) {
    console.log('页面侧错误：');
    pageErrors.slice(0, 6).forEach((e) => console.log(`  ${e.slice(0, 150)}`));
  }
  console.log('='.repeat(74));
  process.exitCode = FAIL.length ? 1 : 0;
} catch (err) {
  console.error('\n验证中断：', err.message);
  if (pageErrors.length) pageErrors.slice(0, 6).forEach((e) => console.error(`  ${e.slice(0, 150)}`));
  process.exitCode = 1;
} finally {
  child.kill();
  if (!fixedProfile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} }
}
