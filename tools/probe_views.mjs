/**
 * 三视图（无痕改字 / 文字工坊 / 图像生成）切换验证
 *
 * 关注五件事：
 *   1. / 上各视图能按 hash 正确切换（改字 ↔ 文字工坊 ↔ 生成 ↔ 作品库）
 *   2. 切换【不再重新加载页面】（这是当初合并的目的）
 *   3. 老链接 /image 与老 hash（#create/#combine…）仍能落到生成视图
 *   4. 文字工坊的三种模式深链（#text / #text-copy / #text-mask / #text-translate）
 *   5. 切换耗时（与合并前对比）
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
  const vis = (el) => !!(el && !el.hidden && getComputedStyle(el).display !== 'none');
  const e = document.getElementById('viewEdit');
  const i = document.getElementById('viewImages');
  const t = document.getElementById('viewText');
  return {
    edit: vis(e), images: vis(i), text: vis(t),
    hash: location.hash, path: location.pathname,
    genVisible: vis(document.getElementById('viewGenerate')),
    projVisible: vis(document.getElementById('viewProjects')),
    copyVisible: vis(document.getElementById('viewTextCopy')),
    maskVisible: vis(document.getElementById('viewTextMask')),
    transVisible: vis(document.getElementById('viewTextTranslate')),
    bodyMode: document.body.className,
  };
})()`);

/** 每个视图对应的容器 id（clickNav 用它判断"切过去了没有"） */
const VIEW_ID = { edit: 'viewEdit', images: 'viewImages', text: 'viewText' };

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
  const vid = VIEW_ID[expect] || 'viewEdit';
  const expr = `(() => { const el = document.getElementById('${vid}');`
    + " return !!(el && !el.hidden && getComputedStyle(el).display !== 'none'); })()";
  try {
    await cdp.waitFor(expr, 15000, `切到 ${expect}`);
  } catch (_) { /* 交给断言报错 */ }
  return { ok, ms: Date.now() - t0 };
}

try {
  console.log('='.repeat(74));
  console.log(`三视图切换验证   ${BASE}/`);
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

  console.log('\n[2] 点侧边栏「AI 生成」');
  const dbg = await cdp.evaluate(`(() => {
    const a = document.querySelector('.sb-item[data-key="generate"]');
    return { found: !!a, tag: a ? a.tagName : '', href: a ? a.getAttribute('href') : '',
             hash: location.hash };
  })()`);
  console.log(`      侧边栏项：found=${dbg.found} ${dbg.tag} href=${dbg.href} hash="${dbg.hash}"`);
  const c1 = await clickNav('generate', 'images');
  const s1 = await viewState();
  check('点击导航项成功', c1.ok === true, `ok=${c1.ok}`);
  check('切到生成视图', s1.images === true && s1.edit === false,
    `${c1.ms}ms · hash="${s1.hash}"`);
  check('生成视图内部显示生成区', s1.genVisible === true);
  check('切换没有重新加载页面', docLoads === loadsAfterFirst,
    `文档加载次数 ${docLoads}（切换前 ${loadsAfterFirst}）`);

  console.log('\n[2b] 合并后的侧栏与文案');
  const copy = await cdp.evaluate(`(() => {
    const q = (s) => (document.querySelector(s)?.textContent || '').trim();
    return {
      navs: [...document.querySelectorAll('.sb-item')].map(a => a.dataset.key),
      title: q('#toolTitle'),
      hint: q('#dropzone .dz-inner span'),
      refCount: q('#refCount'),
      tips: [...document.querySelectorAll('#emptyHints li')].map(li => li.textContent.trim()),
    };
  })()`);
  console.log(`      侧栏项：${copy.navs.join(' / ')}`);
  check('侧栏四项（改字 / 文字工坊 / AI 生成 / 作品库）',
    copy.navs.join(',') === 'edit,text,generate,projects', copy.navs.join(','));
  check('生成区标题是「AI 图片生成」', copy.title === 'AI 图片生成', copy.title);
  check('上传区说明写明「不传就是纯文生图」',
    copy.hint.includes('不传就是纯文生图'), copy.hint);
  check('参照图不再强制（计数为 0/4）', copy.refCount === '0/4', copy.refCount);
  check('空态提示已按合并后的语义改写',
    copy.tips.length === 3 && copy.tips[0].includes('不传参考图'), copy.tips[0] || '');

  console.log('\n[2c] 文字工坊：模式切换');
  const ctw = await clickNav('text', 'text');
  const stw = await viewState();
  check('点侧栏切到文字工坊视图',
    stw.text === true && stw.edit === false && stw.images === false,
    `${ctw.ms}ms · hash="${stw.hash}"`);
  check('默认落在「取文字」模式',
    stw.copyVisible === true && stw.maskVisible === false && stw.transVisible === false,
    `hash="${stw.hash}"`);
  check('文字工坊切换没有重新加载页面', docLoads === loadsAfterFirst,
    `文档加载 ${docLoads} 次`);

  // 点页签切模式：hash 要跟着变，否则这个地址分享出去就回不到同一个模式
  const tabOk = await cdp.evaluate(`(() => {
    const b = document.querySelector('.tw-tab[data-mode="mask"]');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(400);
  const sm = await viewState();
  check('点「打码」页签切到打码模式',
    tabOk && sm.maskVisible === true && sm.copyVisible === false, `hash="${sm.hash}"`);
  check('切模式后 hash 同步为 #text-mask', sm.hash === '#text-mask', `hash="${sm.hash}"`);

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
  // 「四个工具合并成一个」之后，老 hash 仍要能落地，并当场归一到 #generate
  await cdp.send('Page.navigate', { url: `${BASE}/#combine` });
  await sleep(2500);
  const s4 = await viewState();
  check('老深链 /#combine 直接落到生成视图', s4.images === true, `hash="${s4.hash}"`);
  check('老 hash 已归一到 #generate', s4.hash === '#generate', `hash="${s4.hash}"`);

  await cdp.send('Page.navigate', { url: `${BASE}/image#projects` });
  await sleep(3000);
  const s5 = await viewState();
  check('老链接 /image#projects 跳到同一页且保留 hash',
    s5.path === '/' && s5.hash === '#projects' && s5.images === true,
    `${s5.path}${s5.hash}`);

  await cdp.send('Page.navigate', { url: `${BASE}/#text-translate` });
  await sleep(2500);
  const s6 = await viewState();
  check('深链 /#text-translate 直达翻译模式',
    s6.text === true && s6.transVisible === true && s6.copyVisible === false,
    `hash="${s6.hash}"`);
  const hl = await cdp.evaluate(
    "(() => { const a = document.querySelector('.sb-item.on'); return a ? a.dataset.key : ''; })()");
  check('模式深链下侧栏仍高亮「文字工坊」', hl === 'text', `高亮项=${hl}`);
  check('深链切换也没有重新加载页面以外的副作用', s6.edit === false && s6.images === false);

  await cdp.send('Page.navigate', { url: `${BASE}/#text` });
  await sleep(2500);
  const s7 = await viewState();
  check('裸 #text 落到默认模式，且 hash 不被悄悄改写',
    s7.text === true && s7.copyVisible === true && s7.hash === '#text', `hash="${s7.hash}"`);

  console.log('\n[6] 双向切换耗时（采样 5 次取平均）');
  const times = [];
  for (let i = 0; i < 5; i++) {
    await cdp.send('Runtime.evaluate', { expression: `location.hash = '#edit'` });
    await sleep(400);
    const t0 = Date.now();
    await cdp.send('Runtime.evaluate', { expression: `location.hash = '#generate'` });
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
