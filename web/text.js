/* ==========================================================================
   文字工坊 · 取文字 / 打码 / 翻译
   ---------------------------------------------------------------------------
   这三个模式共用同一次文字检测结果（web/engine/index.js 的 detect / analyze），
   差别只在"后半段输出什么"：

     取文字 → 阅读顺序排序 + 段落合并 + 导出 txt / md   （只需 detect）
     打码   → 敏感信息规则匹配 + 区域遮盖               （只需 detect）
     翻译   → 译文写回 edit，复用现有 applyEdits()      （需要 analyze，要样式）

   为什么单独一个视图、不并进「无痕改字」：
   改字的 inspector 是重度样式编辑器（字体 / 描边 / 偏移 / 字距），把打码和取文字
   混进去会互相干扰、app.js 会迅速变烂。两者的关系是「工坊批量 → 改字精修」。

   进度：第 1 期（取文字）已接入本地引擎；打码 / 翻译仍是空壳。
   完整设计与排期见 docs/plan-text-workshop.md。
   ========================================================================== */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* 模式定义：key 就是 hash 里那个键（#text-copy / #text-mask / #text-translate） */
const MODES = [
  { id: 'copy',      key: 'text-copy',      label: '取文字', panel: 'viewTextCopy' },
  { id: 'mask',      key: 'text-mask',      label: '打码',   panel: 'viewTextMask' },
  { id: 'translate', key: 'text-translate', label: '翻译',   panel: 'viewTextTranslate' },
];

const DEFAULT_MODE = 'copy';

const S = { mode: DEFAULT_MODE, ready: false };

/* 嵌进主页面时外层用 #viewText 包着；独立成页时没有这个容器（留着以后拆分用） */
const embeddedBox = () => document.getElementById('viewText');

/** hash key → 模式 id。裸的 #text 落到默认模式。 */
function modeOfKey(key) {
  const h = String(key || '').replace(/^#/, '');
  const m = MODES.find((x) => x.key === h);
  return m ? m.id : DEFAULT_MODE;
}

/** 建页签 DOM（只建一次，避免每次切模式都重建、把监听器一起丢掉） */
function renderTabs() {
  const host = $('twModes');
  if (!host) return;
  host.innerHTML = MODES.map((m) => `
    <button class="tw-tab" type="button" role="tab" data-mode="${m.id}">${m.label}</button>`).join('');
  host.querySelectorAll('.tw-tab').forEach((btn) => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });
}

/** 只同步高亮与 aria 状态 */
function syncTabs() {
  const host = $('twModes');
  if (!host) return;
  host.querySelectorAll('.tw-tab').forEach((b) => {
    const on = b.dataset.mode === S.mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
}

/** 显示某个模式的面板 */
function paintMode(id) {
  for (const m of MODES) {
    const el = $(m.panel);
    if (el) el.hidden = m.id !== id;
  }
  syncTabs();
}

/**
 * 切换模式。
 *
 * keyForHash 用来保留调用方原本想要的那段 hash —— 从 #text 直接进来时
 * 不该被悄悄改写成 #text-copy，否则用户分享出去的地址会和打开时不一样。
 */
function setMode(id, keyForHash) {
  const m = MODES.find((x) => x.id === id) || MODES[0];
  S.mode = m.id;
  paintMode(m.id);

  if (embeddedBox()) {
    // 嵌入模式：整个视图的显隐交给外层，并且**主动喊一声**。
    // 不能只改 hash 等外层响应 —— 从空 hash 首页点进来时那句 hashchange
    // 并不总会派发，表现成"点了没反应"（image.js 那边实测踩过）。
    if (window.WBShowText) window.WBShowText(keyForHash || m.key);
  } else if (location.hash !== '#' + m.key) {
    location.hash = '#' + m.key;
  }
}

/* ======================================================================== */
/* 第 1 期 · 取文字                                                          */
/* ======================================================================== */

/** 本模式的全部状态。result 是 engine/extract.js 的返回值（行 / 段落 / 文本）。 */
const COPY = {
  file: null, name: '', objectUrl: '',
  imgW: 0, imgH: 0,
  result: null,
  busy: false,
};

/* 取文字用的是「只识别、不做样式分析」的通道：/api/analyze 会多跑一遍
   analyzeMany（字体 / 颜色 / 描边判定），那几个字段取文字一个都用不上。
   见 web/engine/localapi.js 的 textDetect。 */
const DETECT_URL = '/api/text/detect';

/** extract.js 是 ES module（引擎目录里都是 module），本文件是普通脚本，
    所以按需动态 import 一次并缓存。带版本号：页面脚本靠 ?v= 挡缓存，
    动态 import 的地址不在 index.html 里，不手动带上就会被浏览器吃旧版本。 */
let extractMod = null;
const VER = (() => {
  const s = document.querySelector('script[src*="/static/text.js"]');
  const m = s && s.src.match(/[?&]v=([^&]+)/);
  return m ? m[1] : '';
})();

async function loadExtract() {
  if (extractMod) return extractMod;
  const url = '/static/engine/extract.js' + (VER ? '?v=' + VER : '');
  extractMod = await import(url);
  window.WBExtract = extractMod;          // 自检与调试用：纯函数可以直接在控制台试
  return extractMod;
}

/**
 * 取本地引擎门面。
 *
 * ⚠️ 必须等一会儿：boot.js 是 <script type="module">（延迟执行），而本文件是
 * 普通脚本，会先于它执行 —— 不等的话 window.WBLocal 还是 undefined。
 * （与 app.js 的 localFacade 同一套理由。）
 */
async function localFacade(timeout = 20000) {
  if (!window.WBLocal) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      await new Promise((r) => setTimeout(r, 50));
      if (window.WBLocal) break;
    }
  }
  return window.WBLocal || null;
}

function progressText(p) {
  if (!p || !p.label) return '识别中…';
  const pct = p.phase === 'download' && p.total
    ? ` ${Math.round((p.done / p.total) * 100)}%` : '';
  return `${p.label}${pct}…`;
}

/** 只识别，不分析样式。首次调用会触发模型下载（之后走本机缓存）。 */
async function runDetect(file) {
  const L = await localFacade();
  if (!L) throw new Error('本地引擎未就绪，请刷新页面重试');

  // 临时接管进度回调，用完还原 —— 不去改 boot.js 的全局 progress，
  // 免得和改字视图那套状态条互相覆盖。
  const prev = L.progress;
  L.progress = (p) => {
    if (typeof prev === 'function') { try { prev(p); } catch (_) {} }
    setStatus(progressText(p), 'busy');
  };
  try {
    const fd = new FormData();
    fd.append('file', file, file.name || 'image.png');
    fd.append('merge_lines', 'true');
    const res = await L.handle(DETECT_URL, fd);
    if (!res) throw new Error('本地引擎未提供取文字能力，请刷新页面重试');
    return res;
  } finally {
    L.progress = prev;
  }
}

/* ---------------------------------------------------------------- 图片展示 */

function showImage(file) {
  const img = $('copyImg');
  if (COPY.objectUrl) URL.revokeObjectURL(COPY.objectUrl);
  COPY.objectUrl = URL.createObjectURL(file);
  img.src = COPY.objectUrl;
  $('copyDrop').hidden = true;
  $('copyImgBox').hidden = false;
}

/* ---------------------------------------------------------------- 检测框 */

/** 框的位置全用百分比 —— 图片宽度自适应，缩放/窄屏都不用重算 */
function renderOverlay() {
  const host = $('copyOverlay');
  const r = COPY.result;
  if (!host) return;
  if (!r || !r.lines.length || !COPY.imgW || !COPY.imgH) { host.innerHTML = ''; return; }
  host.innerHTML = r.lines.map((ln, i) => {
    const b = ln.rect;
    const p = (v, t) => ((v / t) * 100).toFixed(3);
    return `<span class="tw-box" data-i="${i}" style="left:${p(b.x, COPY.imgW)}%;`
      + `top:${p(b.y, COPY.imgH)}%;width:${p(b.w, COPY.imgW)}%;height:${p(b.h, COPY.imgH)}%"></span>`;
  }).join('');
  host.querySelectorAll('.tw-box').forEach((el) => {
    const i = Number(el.dataset.i);
    el.addEventListener('mouseenter', () => hoverLine(i, true));
    el.addEventListener('mouseleave', () => hoverLine(i, false));
    el.addEventListener('click', () => focusLine(i));
  });
}

/** 鼠标停在一行（左框或右行）→ 两边同时高亮 */
function hoverLine(i, on) {
  const box = $('copyOverlay') && $('copyOverlay').querySelector(`.tw-box[data-i="${i}"]`);
  const row = $('copyLines') && $('copyLines').querySelector(`.tw-line[data-i="${i}"]`);
  if (box) box.classList.toggle('on', on);
  if (row) row.classList.toggle('on', on);
}

function focusLine(i) {
  const row = $('copyLines') && $('copyLines').querySelector(`.tw-line[data-i="${i}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const ta = row.querySelector('textarea');
  if (ta) ta.focus();
}

/* ---------------------------------------------------------------- 行列表 */

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.max(22, ta.scrollHeight) + 'px';
}

function renderLines() {
  const host = $('copyLines');
  if (!host) return;
  const r = COPY.result;

  if (!r || !r.lines.length) {
    host.innerHTML = `<p class="tw-side-empty">${COPY.file
      ? '没有识别到文字。换一张更清晰的图试试（文字太小、太糊都会识别不到）'
      : '识别结果会按阅读顺序出现在这里'}</p>`;
    return;
  }

  host.innerHTML = r.lines.map((ln, i) => `
    <div class="tw-line" data-i="${i}">
      <span class="tw-line-no">${i + 1}</span>
      <textarea class="tw-line-text" rows="1" spellcheck="false"
        aria-label="第 ${i + 1} 行">${esc(ln.text)}</textarea>
      <button class="tw-line-copy" type="button" title="复制这一行">复制</button>
    </div>`).join('');

  host.querySelectorAll('.tw-line-text').forEach((ta) => {
    const i = Number(ta.parentElement.dataset.i);
    autosize(ta);
    ta.addEventListener('input', () => {
      autosize(ta);
      // 改动写回 line 对象（paragraphs 里存的就是同一批引用，段落结构会自然跟着变）
      COPY.result.lines[i].text = ta.value;
      refreshDerived();
      hoverLine(i, true);
    });
    ta.addEventListener('mouseenter', () => hoverLine(i, true));
    ta.addEventListener('mouseleave', () => hoverLine(i, false));
    ta.addEventListener('focus', () => hoverLine(i, true));
  });

  host.querySelectorAll('.tw-line-copy').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const i = Number(btn.parentElement.dataset.i);
      const ok = await copyText(COPY.result.lines[i].text);
      flash(btn, ok ? '已复制' : '复制失败');
    });
  });
}

/** 文本被手改后重算派生结果（txt / md 都从 paragraphs 现算，不另存一份） */
function refreshDerived() {
  const r = COPY.result;
  if (!r || !extractMod) return;
  r.text = extractMod.toPlainText(r.paragraphs);
  r.markdown = extractMod.toMarkdown(r.paragraphs, { baseH: r.baseH });
}

/* ---------------------------------------------------------------- 状态与按钮 */

function setStatus(msg, kind) {
  const box = $('copyStatus');
  if (!box) return;
  if (!msg) { box.hidden = true; return; }
  box.hidden = false;
  box.className = 'tw-status' + (kind ? ' ' + kind : '');
  box.innerHTML = (kind === 'busy' ? '<span class="spin"></span>' : '')
    + `<span>${esc(msg)}</span>`;
}

function setButtons(on) {
  for (const id of ['copyAllBtn', 'copyTxtBtn', 'copyMdBtn']) {
    const b = $(id);
    if (b) b.disabled = !on;
  }
}

function updateStats(meta) {
  const el = $('copyStats');
  if (!el) return;
  const r = COPY.result;
  if (!r) { el.textContent = '识别结果'; return; }
  const bits = [`${r.count} 行`];
  if (r.paraCount && r.paraCount !== r.count) bits.push(`${r.paraCount} 段`);
  if (meta && meta.elapsed_ms != null) bits.push(`${meta.elapsed_ms}ms`);
  if (r.tilted) bits.push('含倾斜 / 竖排，未重排');
  el.textContent = bits.join(' · ');
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  btn.classList.add('flash');
  setTimeout(() => { btn.textContent = old; btn.classList.remove('flash'); }, 1200);
}

/* ---------------------------------------------------------------- 复制 / 导出 */

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* 落到下面的兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

function download(name, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

const baseName = () => String(COPY.name || '文字').replace(/\.[^.]+$/, '') || '文字';

/* ---------------------------------------------------------------- 主流程 */

async function handleFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type || '')) { setStatus('请选择图片文件（JPG / PNG / WebP）', 'err'); return; }
  if (COPY.busy) return;

  COPY.busy = true;
  COPY.file = file;
  COPY.name = file.name || 'image';
  COPY.result = null;
  $('copyName').textContent = COPY.name;
  $('copyMeta').textContent = '';
  $('copyPickText').textContent = '换一张';
  showImage(file);
  renderOverlay();
  renderLines();
  updateStats(null);
  setButtons(false);
  setStatus('正在识别…', 'busy');

  try {
    const res = await runDetect(file);
    const m = await loadExtract();
    const out = m.extract(res.items);

    COPY.imgW = res.width || 0;
    COPY.imgH = res.height || 0;
    COPY.result = out;

    $('copyMeta').textContent = `${res.width}×${res.height}`
      + (res.elapsed_ms != null ? ` · 识别 ${res.elapsed_ms}ms` : '');
    renderOverlay();
    renderLines();
    updateStats(res);
    setButtons(out.lines.length > 0);
    setStatus(out.lines.length ? '' : '没有识别到文字', out.lines.length ? '' : 'err');
  } catch (err) {
    const msg = String((err && err.message) || err);
    const waiting = window.WBLocal && !window.WBLocal.ready && !window.WBLocal.error;
    setStatus(waiting ? `本地引擎准备中… ${msg}` : `识别失败：${msg}`, 'err');
    setButtons(false);
  } finally {
    COPY.busy = false;
  }
}

function wireCopyMode() {
  const input = $('copyInput');
  const canvas = $('copyCanvas');
  if (!input || !canvas) return;

  input.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handleFile(f);
    e.target.value = '';          // 允许再次选同一张
  });

  const pick = $('copyPick');
  if (pick) pick.addEventListener('click', () => input.click());

  // 拖拽：整块画布都是投放区，不用瞄准那个小框
  ['dragenter', 'dragover'].forEach((ev) => canvas.addEventListener(ev, (e) => {
    e.preventDefault(); canvas.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach((ev) => canvas.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && canvas.contains(e.relatedTarget)) return;
    canvas.classList.remove('drag');
  }));
  canvas.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  const all = $('copyAllBtn');
  if (all) all.addEventListener('click', async () => {
    if (!COPY.result) return;
    const ok = await copyText(COPY.result.text);
    flash(all, ok ? '已复制' : '复制失败');
  });

  const txt = $('copyTxtBtn');
  if (txt) txt.addEventListener('click', () => {
    if (!COPY.result) return;
    download(`${baseName()}.txt`, COPY.result.text, 'text/plain');
  });

  const md = $('copyMdBtn');
  if (md) md.addEventListener('click', () => {
    if (!COPY.result) return;
    download(`${baseName()}.md`, COPY.result.markdown, 'text/markdown');
  });
}

/* 嵌进主页面时，把"显示哪个模式"的能力暴露出去，由 app.js 的视图路由按 hash 调用。
   视图内部的状态仍归本模块管。

   注意它必须**无条件**存在：app.js 的视图路由靠 window.WBText 判断本视图是否就绪，
   少一个模式面板都不该让路由失去落点。 */
window.WBText = {
  showKey(key) { setMode(modeOfKey(key), key); },
  get ready() { return S.ready; },
  get mode() { return S.mode; },
  get copy() { return COPY; },
  text() { return COPY.result ? COPY.result.text : ''; },
  markdown() { return COPY.result ? COPY.result.markdown : ''; },
  lines() { return COPY.result ? COPY.result.lines.map((l) => l.text) : []; },
};

/* 独立成页时自己接 hash（主页面里由 app.js 统一接管，不重复挂） */
if (!embeddedBox()) {
  window.addEventListener('hashchange', () => setMode(modeOfKey(location.hash)));
}

function boot() {
  renderTabs();
  const h = location.hash.replace(/^#/, '');
  const initial = modeOfKey(h);       // 非本视图的 hash 会落到默认模式，正好
  S.mode = initial;
  paintMode(initial);
  wireCopyMode();
  // 纯函数层提前备好：等用户拖图时就不用再等一次网络往返
  loadExtract().catch(() => {});
  S.ready = true;
  // 就绪信号：外层可能因为"视图还没准备好"而把目标视图记成了待切换，
  // 收到这个信号后会补切一次（与 image.js 的 wb-images-ready 同一套机制）。
  window.dispatchEvent(new CustomEvent('wb-text-ready'));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
