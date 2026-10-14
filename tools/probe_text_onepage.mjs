/**
 * 文字工坊「单页面 · 三功能键」回归验证
 *
 * 验证的是这次重构的核心承诺：
 *   1. 三个模式共用**一套**画布 DOM —— 切模式不重选图、不重算缩放、不重建节点
 *   2. 选一次图，三个模式都能用；切模式只换右侧面板
 *   3. 识别按需补跑：取文字与打码共享同一次检测（只跑一遍）
 *   4. 打码的遮盖层 / 命中框、翻译的译文图，都不会漏到别的模式里
 *
 * 用打桩的本地引擎（window.WBLocal.handle）跑，**不下载模型**，几秒一轮：
 *   node tools/probe_text_onepage.mjs [--base http://127.0.0.1:8000] [--profile <dir>]
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
const PORT = 9359;
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
      try { if (await this.evaluate(expr)) return true; } catch (_) {}
      await sleep(150);
    }
    throw new Error(`等待超时：${label}`);
  }
}

const profile = fixedProfile || path.join(os.tmpdir(), `wb-onepage-${Date.now()}`);
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });

const kill = () => { try { child.kill(); } catch (_) {} };
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
await cdp.send('Log.enable');
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
  { text: '联系电话 13800138000', rect: { x: 40, y: 60, w: 320, h: 30 } },
  { text: '深圳市南山区科技园', rect: { x: 40, y: 130, w: 300, h: 30 } },
];

const STUB = `(() => {
  window.__calls = [];
  const items = ${JSON.stringify(MOCK_ITEMS)};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.WBLocal = {
    ready: true,
    progress: null,
    async handle(url) {
      window.__calls.push(url);
      await sleep(30);
      if (url === '/api/text/detect') {
        return { items, width: 600, height: 400, elapsed_ms: 12 };
      }
      if (url === '/api/analyze') {
        return { session_id: 'probe-session', items, width: 600, height: 400, elapsed_ms: 18 };
      }
      if (url === '/api/apply') {
        return { image: window.__probeOut, stats: { log: [] } };
      }
      return {};
    },
  };
  // 打桩的"译文图"：拿原图当结果图（尺寸一致正是真实情形的关键前提）
  window.__probeOut = '';
  return true;
})()`;

/* ---------------------------------------------------------------- 开跑 */

await cdp.send('Page.navigate', { url: `${BASE}/#text` });
try {
  await cdp.waitFor(`!!window.WBText && window.WBText.ready`, 30000, '文字工坊就绪');
} catch (err) {
  // 多半是本地服务没起来（沙箱里后台进程会被回收）：探针自己不会告诉你这件事
  const diag = await cdp.evaluate(`(() => ({
    href: location.href,
    hasText: !!window.WBText,
    viewHidden: document.getElementById('viewText') ? document.getElementById('viewText').hidden : 'no-el',
  }))()`).catch((e) => ({ evErr: String(e) }));
  console.error('诊断：', JSON.stringify(diag, null, 2));
  console.error('页面报错：\n' + pageErrors.join('\n'));
  console.error(`提示：确认 ${BASE} 上的服务在跑。`);
  kill();
  process.exit(1);
}
await cdp.evaluate(STUB);

const cases = [];

cases.push(['页面加载无 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ')]);

const dom = await cdp.evaluate(`(() => {
  const ids = ['twCanvas', 'twImg', 'twOverlay', 'twMaskCv', 'twMarquee', 'twStatus',
               'twZoom', 'twName', 'twPick', 'twDrop', 'twView'];
  const dup = ids.filter((id) => document.querySelectorAll('#' + id).length !== 1);
  const stale = ['copyImg', 'maskImg', 'trImg', 'copyCanvas', 'maskCanvas', 'trCanvas',
                 'copyOverlay', 'maskOverlay', 'maskCv', 'copyStatus', 'maskStatus', 'trStatus']
    .filter((id) => document.getElementById(id));
  const sides = [...document.querySelectorAll('#viewTextMain .tw-side')];
  return {
    dup, stale,
    sideCount: sides.length,
    visibleSides: sides.filter((s) => !s.hidden).map((s) => s.dataset.side),
    stageCount: document.querySelectorAll('#viewTextMain .tw-stage').length,
  };
})()`);
cases.push(['共用画布元素各只有一份', dom.dup.length === 0, dom.dup.join(',')]);
cases.push(['旧的分模式画布元素已不存在', dom.stale.length === 0, dom.stale.join(',')]);
cases.push(['左栏只有一块画布', dom.stageCount === 1, `stage=${dom.stageCount}`]);
cases.push(['三个面板都在，默认只显示取文字',
  dom.sideCount === 3 && dom.visibleSides.join() === 'copy',
  `visible=${dom.visibleSides.join(',')}`]);

/* 切模式：面板换、hash 同步、节点身份不变 */
const before = await cdp.evaluate(`(() => {
  window.__refImg = document.getElementById('twImg');
  window.__refCanvas = document.getElementById('twCanvas');
  return true;
})()`);
void before;

await cdp.evaluate(`document.querySelector('.tw-tab[data-mode="mask"]').click()`);
await sleep(150);
let st = await cdp.evaluate(`(() => {
  const sides = [...document.querySelectorAll('#viewTextMain .tw-side')];
  return {
    hash: location.hash,
    visible: sides.filter((s) => !s.hidden).map((s) => s.dataset.side),
    sameImg: window.__refImg === document.getElementById('twImg'),
    sameCanvas: window.__refCanvas === document.getElementById('twCanvas'),
    hint: !document.getElementById('twHint').hidden,
  };
})()`);
cases.push(['点「打码」只换右栏', st.visible.join() === 'mask', `visible=${st.visible.join(',')}`]);
cases.push(['hash 同步为 #text-mask', st.hash === '#text-mask', `hash=${st.hash}`]);
cases.push(['切模式未重建画布节点', st.sameImg && st.sameCanvas]);
cases.push(['打码模式才显示拖框提示', st.hint]);

await cdp.evaluate(`document.querySelector('.tw-tab[data-mode="translate"]').click()`);
await sleep(150);
st = await cdp.evaluate(`(() => {
  const sides = [...document.querySelectorAll('#viewTextMain .tw-side')];
  return {
    visible: sides.filter((s) => !s.hidden).map((s) => s.dataset.side),
    hint: document.getElementById('twHint').hidden,
    overlay: document.getElementById('twOverlay').children.length,
  };
})()`);
cases.push(['点「翻译」只换右栏', st.visible.join() === 'translate', `visible=${st.visible.join(',')}`]);
cases.push(['离开打码后拖框提示收起、叠加层清空', st.hint && st.overlay === 0,
  `overlay=${st.overlay}`]);

/* 选图 → 取文字 */
await cdp.evaluate(`document.querySelector('.tw-tab[data-mode="copy"]').click()`);
await sleep(120);

const pick = `(async () => {
  const cv = document.createElement('canvas');
  cv.width = 600; cv.height = 400;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, 400);
  ctx.fillStyle = '#111'; ctx.font = '24px sans-serif';
  ctx.fillText('联系电话 13800138000', 40, 85);
  ctx.fillText('深圳市南山区科技园', 40, 155);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  const file = new File([blob], 'probe.png', { type: 'image/png' });
  const dt = new DataTransfer(); dt.items.add(file);
  const input = document.getElementById('twInput');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;
await cdp.evaluate(pick);
await cdp.waitFor(`window.WBText.copy.result && window.WBText.copy.result.lines.length`,
  20000, '取文字出结果');

st = await cdp.evaluate(`(() => ({
  lines: document.querySelectorAll('#copyLines .tw-line').length,
  boxes: document.querySelectorAll('#twOverlay .tw-box').length,
  calls: window.__calls.slice(),
  name: document.getElementById('twName').textContent,
  src: document.getElementById('twImg').src,
  k: 0,
}))()`);
cases.push(['取文字拿到识别结果', st.lines === 2, `lines=${st.lines}`]);
cases.push(['取文字在共用画布上画出检测框', st.boxes === 2, `boxes=${st.boxes}`]);
cases.push(['文件名已显示在同一处', st.name === 'probe.png', `name=${st.name}`]);
cases.push(['检测只调了一次', st.calls.filter((u) => u === '/api/text/detect').length === 1,
  st.calls.join(' ,')]);

const srcAfterCopy = st.src;
const zoomAfterCopy = await cdp.evaluate(`(() => {
  const i = document.getElementById('twImg');
  return i.style.width + 'x' + i.style.height;
})()`);

/* 切打码：同一次检测复用，不重跑 */
await cdp.evaluate(`document.querySelector('.tw-tab[data-mode="mask"]').click()`);
await cdp.waitFor(`window.WBText.mask.lines && window.WBText.mask.lines.length`, 20000, '打码出结果');
st = await cdp.evaluate(`(() => ({
  calls: window.__calls.slice(),
  boxes: document.querySelectorAll('#twOverlay .tw-box').length,
  hits: document.querySelectorAll('#maskHits .tw-hit').length,
  sameSrc: document.getElementById('twImg').src === ${JSON.stringify(srcAfterCopy)},
  zoom: document.getElementById('twImg').style.width + 'x' + document.getElementById('twImg').style.height,
  maskCvShown: !document.getElementById('twMaskCv').hidden,
}))()`);
cases.push(['切打码复用了同一次检测（没有重跑）',
  st.calls.filter((u) => u === '/api/text/detect').length === 1, st.calls.join(' ,')]);
cases.push(['切打码后图还是那张、缩放没变', st.sameSrc && st.zoom === zoomAfterCopy,
  `zoom=${st.zoom}`]);
cases.push(['打码的命中框画在共用叠加层上', st.boxes === st.hits && st.hits > 0,
  `boxes=${st.boxes} hits=${st.hits}`]);
cases.push(['打码模式才显示遮盖层', st.maskCvShown]);

/* 切翻译：走 analyze，只跑一次 */
await cdp.evaluate(`document.querySelector('.tw-tab[data-mode="translate"]').click()`);
await cdp.waitFor(`window.WBText.translate.items && window.WBText.translate.items.length`,
  20000, '翻译出识别结果');
st = await cdp.evaluate(`(() => ({
  calls: window.__calls.slice(),
  pairs: document.querySelectorAll('#trPairs .tw-pair').length,
  overlay: document.getElementById('twOverlay').children.length,
  maskCvHidden: document.getElementById('twMaskCv').hidden,
  sameSrc: document.getElementById('twImg').src === ${JSON.stringify(srcAfterCopy)},
}))()`);
cases.push(['翻译走 analyze，只调一次',
  st.calls.filter((u) => u === '/api/analyze').length === 1, st.calls.join(' ,')]);
cases.push(['翻译列出了逐行对照', st.pairs === 2, `pairs=${st.pairs}`]);
cases.push(['翻译模式不画检测框、遮盖层收起', st.overlay === 0 && st.maskCvHidden]);
cases.push(['翻译模式显示的还是原图', st.sameSrc]);

/* 切回取文字：结果还在，且没有再调引擎 */
await cdp.evaluate(`document.querySelector('.tw-tab[data-mode="copy"]').click()`);
await sleep(200);
st = await cdp.evaluate(`(() => ({
  calls: window.__calls.slice(),
  lines: document.querySelectorAll('#copyLines .tw-line').length,
  boxes: document.querySelectorAll('#twOverlay .tw-box').length,
  sameSrc: document.getElementById('twImg').src === ${JSON.stringify(srcAfterCopy)},
  zoom: document.getElementById('twImg').style.width + 'x' + document.getElementById('twImg').style.height,
}))()`);
cases.push(['切回取文字，结果原样还在（没重跑）',
  st.lines === 2 && st.calls.filter((u) => u === '/api/text/detect').length === 1,
  `lines=${st.lines} calls=${st.calls.length}`]);
cases.push(['切回后检测框恢复', st.boxes === 2, `boxes=${st.boxes}`]);
cases.push(['切回后图与缩放仍是原样', st.sameSrc && st.zoom === zoomAfterCopy, `zoom=${st.zoom}`]);

/* 打码的遮盖层内容不会留在画布上（切到取文字后应为空） */
const maskLeft = await cdp.evaluate(`(() => {
  const cv = document.getElementById('twMaskCv');
  if (!cv.width || !cv.height) return 0;
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
  return n;
})()`);
cases.push(['离开打码后遮盖层被清空', maskLeft === 0, `非透明像素=${maskLeft}`]);

cases.push(['全程无 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ')]);

/* ---------------------------------------------------------------- 汇总 */

console.log('');
for (const [name, ok, detail] of cases) check(name, ok, detail || '');
console.log(`\n  通过 ${PASS.length} / ${PASS.length + FAIL.length}`);
if (FAIL.length) console.log(`  失败：\n    - ${FAIL.join('\n    - ')}`);
kill();
process.exit(FAIL.length ? 1 : 0);
