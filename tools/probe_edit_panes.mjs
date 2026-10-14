/**
 * 「改字右栏三页签」回归验证（原文字工坊并进无痕改字之后）
 *
 * 验证的是这次融合的核心承诺：
 *   1. 侧栏不再有独立的「文字工坊」，只剩 无痕改字 / AI 生成 / 作品库
 *   2. 右栏是 改字 / 打码 / 翻译 三个页签，切页签**只换右栏内容** ——
 *      画布节点身份不变、识别结果不重算、图不用重选
 *   3. 三个功能共用同一份识别结果与同一套 edit 契约：
 *      打码的「抹字」与翻译的译文都写进 edits，走同一条预览/导出通路
 *   4. 遮盖层（色块/马赛克/模糊）是**图的属性**，不随页签切换而消失
 *   5. 右栏宽度可拖拽并记住
 *   6. 老链接 #text / #text-mask / #text-translate 仍能落到对应页签
 *
 * 用打桩的本地引擎（window.WBLocal.handle）跑，**不下载模型**，几秒一轮：
 *   node tools/probe_edit_panes.mjs [--base http://127.0.0.1:8000] [--profile <dir>]
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
const BASE = arg('base', 'http://127.0.0.1:8000').replace(/\/$/, '');
const fixedProfile = arg('profile', '');
const PORT = 9361;
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
      setTimeout(() => { if (this.waiting.delete(id)) rej(new Error(`超时 ${method}`)); }, 120000);
    });
  }
  async evaluate(expr, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async waitFor(expr, timeout = 30000, label = expr) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await this.evaluate(expr)) return true; } catch (_) { /* 继续等 */ }
      await sleep(150);
    }
    throw new Error(`等待超时：${label}`);
  }
}

const profile = fixedProfile || path.join(os.tmpdir(), `wb-panes-${Date.now()}`);
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });

const kill = () => { try { child.kill(); } catch (_) { /* 已退出 */ } };
process.on('exit', kill);
process.on('SIGINT', () => { kill(); process.exit(1); });

let ws;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  try {
    const j = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = j.find((t) => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch (_) { /* 还没起来 */ }
}
if (!ws) { console.error('连不上 DevTools'); kill(); process.exit(1); }
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

const cdp = new CDP(ws);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const pageErrors = [];
cdp.on('Runtime.exceptionThrown', (p) => {
  pageErrors.push(String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || ''));
});
cdp.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') pageErrors.push(p.args.map((a) => a.value || a.description || '').join(' '));
});
cdp.on('Page.javascriptDialogOpening', () => cdp.send('Page.handleJavaScriptDialog', { accept: true }));

/* ---------------------------------------------------------------- 打桩 */

/* 识别结果用真结构：extract.buildLines 认 text + rect */
const MOCK_ITEMS = [
  { id: 0, text: '联系电话 13800138000', rect: { x: 40, y: 60, w: 320, h: 30 } },
  { id: 1, text: '深圳市南山区科技园', rect: { x: 40, y: 130, w: 300, h: 30 } },
];

const STUB = `(() => {
  window.__probeStub = true;
  window.__calls = [];
  window.__stacks = [];
  const items = ${JSON.stringify(MOCK_ITEMS)};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* 打桩的"重绘结果图"：就是原图本身（尺寸一致正是真实情形的关键前提） */
  window.__probeOut = window.__probeSrc || '';

  const stub = {
    ready: true, progress: null,
    async handle(url, body) {
      window.__calls.push(url);
      // 记录调用来源：多出来的那次调用到底是谁发起的，一看栈就知道
      window.__stacks.push(url + '  <-  ' +
        String(new Error().stack || '').split('\\n').slice(1, 4).join(' | '));
      await sleep(20);
      if (url === '/api/analyze') {
        return { session_id: 'probe-session', items, count: items.length,
                 width: 600, height: 400, elapsed_ms: 18, backend: 'probe' };
      }
      if (url === '/api/apply') return { image: window.__probeOut, stats: { rendered: 1, log: [] } };
      if (url === '/api/preview-batch') return { items: [], count: 0 };
      if (url === '/api/text/erase') {
        return { image: window.__probeOut, peaks: [], solids: [], leftovers: [],
                 levels: [], inks: [], masks: [], resids: [], methods: [] };
      }
      if (url === '/api/health') return { ocr_backend: 'probe', font_count: 3 };
      if (url === '/api/fonts') return { families: ['sans-serif'], user_count: 0 };
      return {};
    },
  };

  /* ⚠️ 必须锁成访问器属性，不能直接赋值。
     web/engine/boot.js 是 <script type="module">，它在执行时会**整体覆盖**
     window.WBLocal（文件末尾那句 window.WBLocal = {...}）。直接赋值的话，
     我们预注入的桩会被它顶掉 —— 现象是 analyze 打不到桩上、页面反而真去下
     40MB 模型（脚本挂在"正在识别…"再也不动）。
     锁成 getter + 空 setter 后，boot.js 的赋值落进空 setter 被静默丢弃。 */
  Object.defineProperty(window, 'WBLocal', {
    configurable: true,
    get: () => stub,
    set: () => {},
  });

  /* 顺带掐掉 boot.js 的「空闲预热」。它在 requestIdleCallback 里**直接调内部的
     ensureEngine**（不经过 window.WBLocal），所以桩锁得再死也拦不住它 ——
     不管的话每轮都会去注册 SW、读 manifest、拉模型。预热纯粹是性能优化，
     探针不需要，关掉换来几秒一轮的确定性。只有 boot.js 用 rIC，关它无副作用。 */
  window.requestIdleCallback = () => 0;

  /* /api/text/status 与 /api/text/translate 走的是裸 fetch（不经引擎门面），
     所以这里把 fetch 也打桩掉 —— 只拦这两个，其余原样放行。 */
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.startsWith('/api/text/status')) {
      return new Response(JSON.stringify({ ready: true, model: 'probe-model' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.startsWith('/api/text/translate')) {
      const body = JSON.parse((init && init.body) || '{}');
      window.__sentTexts = body.texts || [];
      return new Response(JSON.stringify({
        texts: (body.texts || []).map((t) => 'EN:' + t), model: 'probe-model',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  };
  return true;
})()`;

/* ---------------------------------------------------------------- 开跑 */

/* 先把本机工作区清掉再进页面。
   不清的话：复用同一个 --profile 时，上一轮留下的工作区会在初始化阶段被
   restoreWorkspace 自动接上，于是 /api/analyze 会多跑一次 —— 那是探针自己
   的污染，不是被测代码的问题。只清 indexeddb，Cache Storage 里的模型缓存留着。 */
try {
  await cdp.send('Storage.clearDataForOrigin', { origin: BASE, storageTypes: 'indexeddb' });
} catch (_) { /* 老版本 CDP 没这个方法也不影响其它用例 */ }

/* ⚠️ 打桩必须在**文档创建之前**装好。
   页面初始化是异步的（等字体 / 等引擎 / 恢复工作区），如果等 window 上出现
   某个对象再注入，早晚会碰上"注入时初始化已经跑到一半"的时序 ——
   表现为 analyze 打到了真引擎上（于是真的去下模型），或调用计数时有时无。
   addScriptToEvaluateOnNewDocument 保证它先于页面里任何脚本执行。 */
const { identifier: stubId } =
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });

await cdp.send('Page.navigate', { url: `${BASE}/#edit` });
try {
  // 等应用**初始化跑完**，而不只是 window 上出现了对象：
// 侧栏渲染完成 + 面板模块就位 + 工作区恢复那一步已经做过（没有被自动接上）
await cdp.waitFor(
  `!!window.WBEdit && !!window.WBPanels && window.__probeStub
   && document.querySelectorAll('.sb-item').length === 3
   && !document.getElementById('viewEdit').hidden`,
  30000, '改字视图与面板模块就绪');
} catch (err) {
  const diag = await cdp.evaluate(`(() => ({
    href: location.href,
    hasEdit: !!window.WBEdit,
    hasPanels: !!window.WBPanels,
    hasShell: !!window.WBShell,
  }))()`).catch((e) => ({ evErr: String(e) }));
  console.error('诊断：', JSON.stringify(diag, null, 2));
  console.error('页面报错：\n' + (pageErrors.join('\n') || '(无)'));
  console.error(`提示：确认 ${BASE} 上的服务在跑。`);
  kill();
  process.exit(1);
}

/* ---- 1. 结构 ---- */

const dom = await cdp.evaluate(`(() => {
  const ids = ['inspector', 'paneTabs', 'maskLayer', 'imgLayer', 'boxLayer', 'marquee'];
  const dup = ids.filter((id) => document.querySelectorAll('#' + id).length !== 1);
  const stale = ['viewText', 'viewTextMain', 'twImg', 'twCanvas', 'twOverlay', 'twMaskCv',
                 'twStatus', 'twDrop', 'twModes', 'maskHits', 'copyLines', 'copyStats']
    .filter((id) => document.getElementById(id));
  const tabs = [...document.querySelectorAll('.pane-tab')].map((b) => b.dataset.pane);
  const panes = [...document.querySelectorAll('#inspector > .pane')].map((p) => p.dataset.pane);
  const visible = [...document.querySelectorAll('#inspector > .pane')]
    .filter((p) => !p.hidden).map((p) => p.dataset.pane);
  const nav = [...document.querySelectorAll('.sb-item')].map((a) => a.dataset.key);
  const inspector = document.getElementById('inspector');
  return {
    dup, stale, tabs, panes, visible, nav,
    // maskLayer 必须在 imgLayer 之上、boxLayer 之下：遮盖盖住图，识别框又盖住遮盖
    layerOrder: [...document.getElementById('scene').children].map((el) => el.id),
    widthVar: getComputedStyle(inspector).getPropertyValue('--insp-w').trim(),
    widthPx: Math.round(inspector.getBoundingClientRect().width),
  };
})()`);

check('页面加载无 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
check('关键元素各只有一份', dom.dup.length === 0, dom.dup.join(','));
check('旧文字工坊的元素已全部移除', dom.stale.length === 0, dom.stale.join(','));
check('右栏是三个页签', dom.tabs.join(',') === 'edit,mask,translate', dom.tabs.join(','));
check('三个页签内容块都在，默认只显示改字',
  dom.panes.join(',') === 'edit,mask,translate' && dom.visible.join(',') === 'edit',
  `visible=${dom.visible.join(',')}`);
check('侧栏不再有「文字工坊」', !dom.nav.includes('text'), dom.nav.join(','));
check('侧栏剩三项且顺序正确', dom.nav.join(',') === 'edit,generate,projects', dom.nav.join(','));
check('遮盖层夹在图与识别框之间',
  (() => {
    const want = ['imgLayer', 'maskLayer', 'boxLayer', 'marquee'];
    return dom.layerOrder.filter((x) => x).join(',') === want.join(',');
  })(), dom.layerOrder.join(','));

/* ---- 2. 选图 → 识别一次 ---- */

const pick = (name) => `(async () => {
  const cv = document.createElement('canvas');
  cv.width = 600; cv.height = 400;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, 400);
  ctx.fillStyle = '#111'; ctx.font = '24px sans-serif';
  ctx.fillText('联系电话 13800138000', 40, 85);
  ctx.fillText('深圳市南山区科技园', 40, 155);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  window.__probeSrc = URL.createObjectURL(blob);
  window.__probeOut = window.__probeSrc;
  const file = new File([blob], '${name}', { type: 'image/png' });
  const dt = new DataTransfer(); dt.items.add(file);
  const input = document.getElementById('fileInput');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

await cdp.evaluate(pick('probe.png'));
await cdp.waitFor(`window.WBEdit.items.length === 2`, 30000, '识别完成');
await sleep(400);

let st = await cdp.evaluate(`(() => {
  const calls = window.__calls.filter((u) => u === '/api/analyze').length;
  const items = window.WBEdit.items.length;
  const list = document.querySelectorAll('#itemList .list-row, #itemList .row').length;
  return { calls, items, list, badge: document.getElementById('countBadge').textContent,
           stacks: window.__stacks.filter((s) => s.startsWith('/api/analyze')),
           copyOn: !document.getElementById('btnCopyAll').disabled,
           txtOn: !document.getElementById('btnExportTxt').disabled };
})()`);
check('识别只跑一次 analyze', st.calls === 1,
  `analyze×${st.calls}` + (st.calls > 1 ? '\n        ' + st.stacks.join('\n        ') : ''));
check('识别结果落到列表', st.items === 2 && st.badge === '2', `items=${st.items} badge=${st.badge}`);
check('取文字的「复制全部 / 导出 txt」已启用', st.copyOn && st.txtOn);

/* ---- 3. 切页签：只换右栏，不动画布与识别结果 ---- */

await cdp.evaluate(`(() => {
  window.__refImg = document.getElementById('imgLayer');
  window.__refCanvas = document.getElementById('viewport');
  return true;
})()`);

await cdp.evaluate(`document.querySelector('.pane-tab[data-pane="mask"]').click()`);
/* 切到打码页签后，面板要**异步**把命中项算出来并同步给画布：
   panels.js 里首次要动态 import extract.js / mask.js，然后 sync 还带 120ms 去抖。
   本地这两个模块是瞬时命中缓存，线上是真要走一次网络 —— 固定 sleep 在线上一跑就炸
   （表现为 picks=0 / method=undefined，本地却全绿）。
   所以这里等条件，不等时间。 */
await cdp.waitFor(`window.WBEdit.picks.length > 0`, 15000, '打码命中项同步到画布')
  .catch(() => {});
await sleep(250);
st = await cdp.evaluate(`(() => ({
  visible: [...document.querySelectorAll('#inspector > .pane')].filter((p) => !p.hidden).map((p) => p.dataset.pane),
  sameImg: window.__refImg === document.getElementById('imgLayer'),
  sameVp: window.__refCanvas === document.getElementById('viewport'),
  analyzing: window.__calls.filter((u) => u === '/api/analyze').length,
  rules: document.querySelectorAll('#mkRuleList .rule-row').length,
  hits: [...document.querySelectorAll('#mkHits .hit-row')].map((el) => el.querySelector('.hit-text').textContent),
}))()`);
check('点「打码」只换右栏', st.visible.join(',') === 'mask', `visible=${st.visible.join(',')}`);
check('切页签未重建画布节点', st.sameImg && st.sameVp);
check('切页签未重跑识别', st.analyzing === 1, `analyze×${st.analyzing}`);
check('规则清单已渲染', st.rules >= 8, `rules=${st.rules}`);
check('手机号被规则命中并列出', st.hits.some((t) => t.includes('13800138000')), st.hits.join(' | '));

/* 默认色块 → 遮盖层要有像素 */
let px = await cdp.evaluate(`(() => {
  const cv = document.getElementById('maskLayer');
  const d = cv.getContext('2d').getImageData(40, 60, 320, 30).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return { n, picks: window.WBEdit.picks.length, method: window.WBEdit.picks[0] && window.WBEdit.picks[0].method };
})()`);
check('色块遮盖真的画上了遮盖层', px.n > 0 && px.picks > 0, `非透明=${px.n} picks=${px.picks} ${px.method}`);

/* 换马赛克 / 模糊：同一块区域要有像素，但不再是纯色 */
for (const m of ['mosaic', 'blur']) {
  await cdp.evaluate(`document.querySelector('#mkMethod .seg-btn[data-m="${m}"]').click()`);
  // 同样等条件：换档位要经过那 120ms 去抖才会画到遮盖层上
  await cdp.waitFor(`window.WBEdit.picks[0] && window.WBEdit.picks[0].method === '${m}'`,
    8000, `遮盖档位切到 ${m}`).catch(() => {});
  await sleep(120);
  const r = await cdp.evaluate(`(() => {
    const cv = document.getElementById('maskLayer');
    const d = cv.getContext('2d').getImageData(40, 60, 320, 30).data;
    const s = new Set();
    let n = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 0) { n++; s.add(d[i] + ',' + d[i+1] + ',' + d[i+2]); } }
    return { n, uniq: s.size, method: window.WBEdit.picks[0] && window.WBEdit.picks[0].method };
  })()`);
  check(`「${m === 'mosaic' ? '马赛克' : '模糊'}」档在该区域画了东西且不是纯色`,
    r.n > 0 && r.uniq > 1 && r.method === m, `非透明=${r.n} 颜色数=${r.uniq}`);
}

/* 抹字 → 写进 edits（而不是遮盖层） */
await cdp.evaluate(`document.querySelector('#mkMethod .seg-btn[data-m="erase"]').click()`);
await cdp.waitFor(`Object.keys(window.WBEdit.edits).length > 0`, 10000, '抹字写进 edits')
  .catch(() => {});
await sleep(300);
st = await cdp.evaluate(`(() => {
  const e = window.WBEdit.edits;
  const ids = Object.keys(e);
  const cv = document.getElementById('maskLayer');
  const d = cv.getContext('2d').getImageData(40, 60, 320, 30).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return { ids, allEmpty: ids.every((k) => e[k].text === ''), layerPx: n,
           picks: window.WBEdit.picks.length };
})()`);
check('「抹字」命中项写进 edits 且文字置空',
  st.ids.length > 0 && st.allEmpty, `ids=${st.ids.join(',')}`);
check('「抹字」不占用遮盖层（交给引擎擦除）',
  st.layerPx === 0 && st.picks === 0, `layerPx=${st.layerPx} picks=${st.picks}`);

/* 切走抹字 → 文字要还回来 */
await cdp.evaluate(`document.querySelector('#mkMethod .seg-btn[data-m="block"]').click()`);
await sleep(400);
st = await cdp.evaluate(`(() => {
  const e = window.WBEdit.edits;
  return { ids: Object.keys(e), n: Object.keys(e).length };
})()`);
check('从「抹字」切回色块时把写空的文字还了回去', st.n === 0, `剩余 edits=${st.ids.join(',')}`);

/* ---- 4. 遮盖是"图的属性"，不随页签走 ---- */

await cdp.evaluate(`document.querySelector('.pane-tab[data-pane="translate"]').click()`);
await sleep(250);
st = await cdp.evaluate(`(() => {
  const cv = document.getElementById('maskLayer');
  const d = cv.getContext('2d').getImageData(40, 60, 320, 30).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return {
    visible: [...document.querySelectorAll('#inspector > .pane')].filter((p) => !p.hidden).map((p) => p.dataset.pane),
    layerPx: n,
    pairs: document.querySelectorAll('#trPairs .pair').length,
    analyzeCalls: window.__calls.filter((u) => u === '/api/analyze').length,
  };
})()`);
check('点「翻译」只换右栏', st.visible.join(',') === 'translate', `visible=${st.visible.join(',')}`);
check('切到翻译后遮盖仍在（遮盖属于图，不属于页签）', st.layerPx > 0, `非透明=${st.layerPx}`);
check('翻译列出逐行对照', st.pairs === 2, `pairs=${st.pairs}`);
check('切页签始终只识别一次', st.analyzeCalls === 1, `analyze×${st.analyzeCalls}`);

/* 翻译 → 写进 edits（与手动改字同一个字段） */
await cdp.evaluate(`document.getElementById('trRun').click()`);
await cdp.waitFor(`Object.keys(window.WBEdit.edits).length === 2`, 15000, '译文写进 edits')
  .catch(() => {});
await sleep(400);
st = await cdp.evaluate(`(() => {
  const e = window.WBEdit.edits;
  const ks = Object.keys(e);
  return {
    ks,
    texts: ks.map((k) => e[k].text),
    sent: (window.__sentTexts || []).length,
    onCanvas: document.getElementById('trCount').textContent,
  };
})()`);
check('翻译把译文写进了 edits（同一套 edit 契约）',
  st.ks.length === 2 && st.texts.every((t) => String(t).startsWith('EN:')),
  `${st.ks.length} 条 · ${String(st.texts[0] || '').slice(0, 22)}`);
check('发往上游的正是识别出来的原文', st.sent === 2, `sent=${st.sent}`);

/* ---- 5. 右栏宽度可拖拽 ---- */

const w0 = await cdp.evaluate(`Math.round(document.getElementById('inspector').getBoundingClientRect().width)`);
const drag = await cdp.evaluate(`(() => {
  const h = document.getElementById('inspResize');
  const r = h.getBoundingClientRect();
  const opt = { bubbles: true, clientX: r.left + 3, clientY: r.top + 200, button: 0, pointerId: 1, isPrimary: true };
  h.setPointerCapture = () => {};
  h.dispatchEvent(new PointerEvent('pointerdown', opt));
  h.dispatchEvent(new PointerEvent('pointermove', { ...opt, clientX: r.left - 120 }));
  h.dispatchEvent(new PointerEvent('pointerup', { ...opt, clientX: r.left - 120 }));
  const w = Math.round(document.getElementById('inspector').getBoundingClientRect().width);
  return { w0: ${w0}, w, saved: localStorage.getItem('wb.inspW') };
})()`);
check('拖拽手柄能加宽右栏', drag.w > drag.w0 + 80, `${drag.w0}px → ${drag.w}px`);
check('宽度写进了 localStorage', drag.saved && Number(drag.saved) > drag.w0, `saved=${drag.saved}`);

/* ---- 6. 老链接落到对应页签 ---- */

await cdp.send('Page.navigate', { url: `${BASE}/#text-mask` });
await cdp.waitFor(`!!window.WBEdit && window.WBEdit.pane === 'mask'`, 25000, '老链接 #text-mask')
  .catch(() => {});
st = await cdp.evaluate(`(() => ({
  pane: window.WBEdit.pane,
  view: !document.getElementById('viewEdit').hidden,
  navOn: (document.querySelector('.sb-item.on') || {}).dataset
    ? document.querySelector('.sb-item.on').dataset.key : '',
}))()`);
check('老链接 #text-mask 落到改字视图并打开打码页签',
  st.pane === 'mask' && st.view, `pane=${st.pane} view=${st.view}`);
check('老链接下侧栏高亮「无痕改字」', st.navOn === 'edit', `on=${st.navOn}`);

await cdp.send('Page.navigate', { url: `${BASE}/#text-translate` });
await cdp.waitFor(`!!window.WBEdit && window.WBEdit.pane === 'translate'`, 25000, '老链接 #text-translate')
  .catch(() => {});
check('老链接 #text-translate 打开翻译页签',
  await cdp.evaluate(`window.WBEdit.pane`) === 'translate');

/* ---- 收尾 ---- */

console.log('');
console.log('='.repeat(74));
console.log(`结果：${PASS.length} 通过 / ${FAIL.length} 失败`);
if (FAIL.length) console.log('失败项：\n  ' + FAIL.join('\n  '));
console.log('='.repeat(74));
if (pageErrors.length) console.log('页面报错：\n' + pageErrors.join('\n'));

kill();
process.exit(FAIL.length ? 1 : 0);
