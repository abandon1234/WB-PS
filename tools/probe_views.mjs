/**
 * 视图切换 + 文字纯函数层 回归验证
 *
 * 关注四件事：
 *   1. / 上各视图能按 hash 正确切换（改字 ↔ 生成 ↔ 作品库）
 *   2. 切换【不再重新加载页面】（这是当初合并的目的）
 *   3. 老链接 /image、老 hash（#create/#combine…）、老 #text 家族仍能落到该去的地方
 *   4. 切换耗时（与合并前对比）
 *
 * 文字抽取（extract.js）与打码规则（mask.js）是**纯函数**，不碰 DOM 也不下模型，
 * 顺路在这里验 —— 它们与视图无关，放这儿比塞进 UI 探针更省事。
 *
 * 「右栏三页签」（改字 / 打码 / 翻译）的交互回归在 tools/probe_edit_panes.mjs，
 * 那边用打桩引擎跑，几秒一轮。
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

// 自动放行 confirm()：无头下没人点"确定"，对话框会把脚本挂住
// （改字视图的"覆盖当前图片"确认、关闭图片的确认都会走这里）。
cdp.on('Page.javascriptDialogOpening', () => {
  cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
});

const viewState = () => cdp.evaluate(`(() => {
  const vis = (el) => !!(el && !el.hidden && getComputedStyle(el).display !== 'none');
  const e = document.getElementById('viewEdit');
  const i = document.getElementById('viewImages');
  return {
    edit: vis(e), images: vis(i),
    hash: location.hash, path: location.pathname,
    genVisible: vis(document.getElementById('viewGenerate')),
    projVisible: vis(document.getElementById('viewProjects')),
    // 右栏当前打开的页签（老 #text* 深链要落在这里）
    pane: (document.querySelector('#inspector > .pane:not([hidden])') || {}).dataset?.pane || '',
    bodyMode: document.body.className,
  };
})()`);

/** 每个视图对应的容器 id（clickNav 用它判断"切过去了没有"） */
const VIEW_ID = { edit: 'viewEdit', images: 'viewImages' };

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
  console.log(`视图切换与文字纯函数验证   ${BASE}/`);
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
  check('侧栏三项（改字 / AI 生成 / 作品库）',
    copy.navs.join(',') === 'edit,generate,projects', copy.navs.join(','));
  check('生成区标题是「AI 图片生成」', copy.title === 'AI 图片生成', copy.title);
  check('上传区说明写明「不传就是纯文生图」',
    copy.hint.includes('不传就是纯文生图'), copy.hint);
  check('参照图不再强制（计数为 0/4）', copy.refCount === '0/4', copy.refCount);
  check('空态提示已按合并后的语义改写',
    copy.tips.length === 3 && copy.tips[0].includes('不传参考图'), copy.tips[0] || '');

  /* 原来这里有一整段「文字工坊：模式切换 / 深链」。那个独立视图已经删掉，
     三个功能并进无痕改字右栏页签 —— 相关断言全部移到 probe_edit_panes.mjs，
     老 #text* 深链的兼容性在下文 [5] 里验。 */

  console.log('\n[2c] 文字抽取：纯函数层（不依赖 OCR，用构造的框）');
  const pure = await cdp.evaluate(`(async () => {
    const m = await import('/static/engine/extract.js');
    const items = [
      { id: 0, rect: { x: 100, y: 200, w: 80, h: 20 }, text: '第二行', score: .9, angle: 0, quad_axis: true },
      { id: 1, rect: { x: 20, y: 100, w: 160, h: 60 }, text: '大标题', score: .9, angle: 0, quad_axis: true },
      { id: 2, rect: { x: 20, y: 200, w: 60, h: 20 }, text: '第一行', score: .9, angle: 0, quad_axis: true },
      { id: 3, rect: { x: 20, y: 240, w: 300, h: 20 }, text: '正文一句结束了。', score: .9, angle: 0, quad_axis: true },
      { id: 4, rect: { x: 20, y: 280, w: 300, h: 20 }, text: '另一段话', score: .9, angle: 0, quad_axis: true },
    ];
    const out = m.extract(items);
    return {
      lines: out.lines.map(l => l.text),
      paras: out.paragraphs.map(p => p.map(l => l.text)),
      md: out.markdown,
      tight: m.joinSegments(['SN-2026', '0918'],
        { gaps: [0, 0.5], lineH: 20 }),
      loose: m.joinSegments(['Hello', 'world']),
    };
  })()`);
  console.log(`      行：${JSON.stringify(pure.lines)}`);
  console.log(`      段：${JSON.stringify(pure.paras)}`);
  check('纯函数：行内按 x 排、跨行按 y 排',
    pure.lines.join('|') === '大标题|第一行第二行|正文一句结束了。|另一段话',
    pure.lines.join('|'));
  check('纯函数：句末标点断开分段、标题不并进正文',
    pure.paras.length === 3 && pure.paras[0].length === 1 && pure.paras[0][0] === '大标题',
    JSON.stringify(pure.paras));
  check('纯函数：md 按行高给出标题层级',
    pure.md.startsWith('## 大标题'), JSON.stringify(pure.md.split('\n')[0]));
  check('纯函数：段落内合行、中文不加空格（ASCII 词之间才加）',
    pure.md.includes('第一行第二行正文一句结束了。'), '');
  check('纯函数：贴得很近的片段不插空格', pure.tight === 'SN-20260918', pure.tight);
  check('纯函数：正常间距的英文词之间加空格', pure.loose === 'Hello world', pure.loose);

  console.log('\n[2d] 打码规则：纯函数层（不依赖 OCR，用构造的行）');
  const mkPure = await cdp.evaluate(`(async () => {
    // 直接 import 模块，不依赖页面有没有把 mask.js 挂到 window 上
    // （panel 那边挂的是 window.WBTextEngine，属于调试口，不该被用例绑住）
    const M = await import('/static/engine/mask.js');
    const ln = (text) => [{ id: 0, text, rect: { x: 10, y: 20, w: 200, h: 24 },
      items: [{ id: 0, text, rect: { x: 10, y: 20, w: 200, h: 24 } }] }];
    const ids = (hits) => hits.map((h) => h.ruleId).join(',');
    const off = M.defaultRuleState(); off.phone = false;
    // 一行两个框：号码单独成框时应该只盖号码那个
    const two = [{ id: 0, text: '电话 13800138000', rect: { x: 0, y: 0, w: 300, h: 24 },
      items: [{ id: 0, text: '电话', rect: { x: 0, y: 0, w: 60, h: 24 } },
              { id: 1, text: '13800138000', rect: { x: 70, y: 0, w: 200, h: 24 } }] }];
    // 号码被切成两半 → 只能靠整行兜底
    const split = [{ id: 0, text: '13800138000', rect: { x: 0, y: 0, w: 300, h: 24 },
      items: [{ id: 0, text: '1380013', rect: { x: 0, y: 0, w: 100, h: 24 } },
              { id: 1, text: '8000', rect: { x: 110, y: 0, w: 60, h: 24 } }] }];
    const merged = M.toRects([
      { rect: { x: 100, y: 10, w: 50, h: 20 }, on: true },
      { rect: { x: 145, y: 10, w: 50, h: 20 }, on: true },
    ], { pad: 0 });
    return {
      phone: ids(M.findSensitive(ln('13800138000'))),
      idcard: ids(M.findSensitive(ln('110101199003078888'))),
      bank: ids(M.findSensitive(ln('6222021234567890123'))),
      longWhole: M.findSensitive(ln('202610131234567')).length,
      longInText: M.findSensitive(ln('订单号 202610131234567')).length,
      phoneOff: M.findSensitive(ln('13800138000'), { enabled: off }).length,
      emailStill: ids(M.findSensitive(ln('a@b.com'), { enabled: off })),
      two: M.findSensitive(two).map((h) => h.scope + ':' + Math.round(h.rect.x)).join(','),
      split: M.findSensitive(split).map((h) => h.scope).join(','),
      merged: merged.length + ':' + merged[0].w,
    };
  })()`);
  check('打码 · 手机号 / 身份证 / 银行卡 各归其类（顺序优先级）',
    mkPure.phone === 'phone' && mkPure.idcard === 'idcard' && mkPure.bank === 'bank',
    `phone=${mkPure.phone} idcard=${mkPure.idcard} bank=${mkPure.bank}`);
  check('打码 · 长数字串必须整框（混在句子里的不打）',
    mkPure.longWhole === 1 && mkPure.longInText === 0,
    `整框=${mkPure.longWhole} 句内=${mkPure.longInText}`);
  check('打码 · 关掉「手机号」后 11 位数字不再被兜底规则打掉',
    mkPure.phoneOff === 0, `剩余命中 ${mkPure.phoneOff} 处`);
  check('打码 · 关掉一条规则不影响其它规则', mkPure.emailStill === 'email', mkPure.emailStill);
  check('打码 · 能落到具体文字框就不整行盖',
    mkPure.two === 'item:70', mkPure.two);
  check('打码 · 号码被切成两半时整行兜底能接住',
    mkPure.split === 'line', mkPure.split);
  check('打码 · 相邻遮盖矩形合并（半透明叠加不会叠深）',
    mkPure.merged === '1:95', mkPure.merged);

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

  // 文字工坊并进「无痕改字」右栏之后，它那套老 hash 仍要能落地：
  // 落到改字视图 + 当场打开对应页签，hash 原样保留（刷新/分享回来还在同一页）
  await cdp.send('Page.navigate', { url: `${BASE}/#text-translate` });
  await sleep(2500);
  const s6 = await viewState();
  check('老深链 /#text-translate 落到改字视图并打开翻译页签',
    s6.edit === true && s6.images === false && s6.pane === 'translate',
    `hash="${s6.hash}" pane=${s6.pane}`);
  check('老 hash 原样保留，不被悄悄改写', s6.hash === '#text-translate', `hash="${s6.hash}"`);
  const hl = await cdp.evaluate(
    "(() => { const a = document.querySelector('.sb-item.on'); return a ? a.dataset.key : ''; })()");
  check('老深链下侧栏高亮「无痕改字」', hl === 'edit', `高亮项=${hl}`);

  await cdp.send('Page.navigate', { url: `${BASE}/#text-mask` });
  await sleep(2500);
  const s7 = await viewState();
  check('老深链 /#text-mask 打开打码页签',
    s7.edit === true && s7.pane === 'mask', `hash="${s7.hash}" pane=${s7.pane}`);

  await cdp.send('Page.navigate', { url: `${BASE}/#text` });
  await sleep(2500);
  const s8 = await viewState();
  check('裸 #text 落到改字页签',
    s8.edit === true && s8.pane === 'edit', `hash="${s8.hash}" pane=${s8.pane}`);

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
