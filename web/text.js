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

/** 取文字的全部状态。result 是 engine/extract.js 的返回值（行 / 段落 / 文本）。 */
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

/** 只识别，不分析样式。首次调用会触发模型下载（之后走本机缓存）。
    onStatus 用来把进度写到**调用方自己的**状态条上（取文字与打码各有一条）。 */
async function runDetect(file, onStatus) {
  const L = await localFacade();
  if (!L) throw new Error('本地引擎未就绪，请刷新页面重试');

  // 临时接管进度回调，用完还原 —— 不去改 boot.js 的全局 progress，
  // 免得和改字视图那套状态条互相覆盖。
  const prev = L.progress;
  L.progress = (p) => {
    if (typeof prev === 'function') { try { prev(p); } catch (_) {} }
    if (onStatus) onStatus(progressText(p));
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

/* 取文字与打码共用同一次检测：同一张图在两个模式之间切换不该重跑一遍
   （识别要 1~5 秒，切一次等一次很烦，而且结果是完全一样的）。
   签名用「文件名 + 大小 + 修改时间」—— 比按文件内容做哈希便宜，且换图必然变。 */
const DETECT_CACHE = { sig: '', res: null };
const fileSig = (f) => `${f.name}|${f.size}|${f.lastModified}`;

async function detectOnce(file, onStatus) {
  const sig = fileSig(file);
  if (DETECT_CACHE.sig === sig && DETECT_CACHE.res) return DETECT_CACHE.res;
  const res = await runDetect(file, onStatus);
  DETECT_CACHE.sig = sig;
  DETECT_CACHE.res = res;
  return res;
}

/* ---------------------------------------------------------------- 图片展示 */

/** 两个模式的元素 id 一组一份 —— 除 id 外行为完全相同，不重复写两遍 */
const COPY_ELS = {
  canvas: 'copyCanvas', img: 'copyImg', drop: 'copyDrop',
  imgBox: 'copyImgBox', zoom: 'copyZoom', status: 'copyStatus',
  input: 'copyInput', pick: 'copyPick', pickText: 'copyPickText',
  name: 'copyName', meta: 'copyMeta',
};
const MASK_ELS = {
  canvas: 'maskCanvas', img: 'maskImg', drop: 'maskDrop',
  imgBox: 'maskImgBox', zoom: 'maskZoom', status: 'maskStatus',
  input: 'maskInput', pick: 'maskPick', pickText: 'maskPickText',
  name: 'maskName', meta: 'maskMeta',
};

function showImage(file, els, zoom, holder) {
  const img = $(els.img);
  if (holder.objectUrl) URL.revokeObjectURL(holder.objectUrl);
  holder.objectUrl = URL.createObjectURL(file);
  zoom.reset();
  // 先藏起来：新版图解码完就按原尺寸渲染，等 load 里「适应窗口」算好了再亮，
  // 否则会闪一下两千多 px 高的大图。
  img.style.visibility = 'hidden';
  img.src = holder.objectUrl;
  $(els.drop).hidden = true;
  $(els.imgBox).hidden = false;
  const z = $(els.zoom);
  if (z) z.hidden = false;
}

/* ---------------------------------------------------------------- 缩放 */

/* 手机截图动辄 618×2560（1:4），按原宽铺开就是两千多 px 高 —— 得滚半天才看得全，
   也把右侧挤没了意义。所以默认「适应窗口」收进可视区，要核对文字再放大。
   检测框与遮盖层都按显示尺寸对齐，缩放后不用重算坐标。

   取文字与打码共用这一套（唯一差别是元素 id 前缀），所以抽成工厂：
   行为约定只写一份，两个面板不会各自跑偏。 */
const ZOOM_LADDER = [0.05, 0.08, 0.12, 0.17, 0.25, 0.33, 0.5, 0.67, 0.8,
                     1, 1.25, 1.5, 2, 2.5, 3, 4, 6];

/* 要求至少变化这个倍数，否则按一下几乎看不出变化 ——「适应窗口」算出来的比例
   （比如 24.7%）常常正好贴着某个挡位（25%），没有阈值时第一下 + 只是从 25%
   挪到 25%，像点了没反应。 */
const ZOOM_STEP = 1.15;

/**
 * 缩放控制器。onChange 在每次比例变化后回调 —— 打码要靠它按新尺寸重绘遮盖层。
 */
function createZoom({ canvas, img, fit, zin, zout, val, onChange }) {
  const el = (id) => $(id);
  const st = { k: 1, mode: 'fit' };

  /** 画布可视区（去掉内边距）。视图不可见时量出来是 0 → null，让调用方跳过 */
  function box() {
    const c = el(canvas);
    if (!c) return null;
    const cs = getComputedStyle(c);
    const w = c.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = c.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (!(w > 1) || !(h > 1)) return null;
    return { w, h };
  }

  /** 「适应窗口」的比例：等比收到可视区内，**不放大**（小图保持原始像素，别糊） */
  function fitScale() {
    const i = el(img);
    const b = box();
    if (!i || !b || !i.naturalWidth) return 0;
    return Math.min(b.w / i.naturalWidth, b.h / i.naturalHeight, 1);
  }

  /** 把比例写到 img 上（imgbox 缩到内容大小，overlay / canvas 才对得上） */
  function apply(k) {
    const i = el(img);
    if (!i || !i.naturalWidth || !(k > 0)) return;
    st.k = k;
    i.style.width = Math.max(1, Math.floor(i.naturalWidth * k)) + 'px';
    i.style.height = Math.max(1, Math.floor(i.naturalHeight * k)) + 'px';
    const v = el(val);
    if (v) v.textContent = Math.round(k * 100) + '%';
    const f = el(fit);
    if (f) f.classList.toggle('on', st.mode === 'fit');
    if (onChange) onChange(k);
  }

  function setFit() {
    st.mode = 'fit';
    apply(fitScale() || 1);
  }

  function setZoom(k) {
    st.mode = 'manual';
    apply(k);
  }

  /** 按挡位跳一格（挡位固定，行为可预期，不是乘 1.25） */
  function step(dir) {
    const i = el(img);
    if (!i || !i.naturalWidth) return;
    const cur = st.k || 1;
    const k = dir > 0
      ? (ZOOM_LADDER.find((v) => v > cur * ZOOM_STEP) || ZOOM_LADDER[ZOOM_LADDER.length - 1])
      : (ZOOM_LADDER.filter((v) => v < cur / ZOOM_STEP).pop() || ZOOM_LADDER[0]);
    setZoom(k);
  }

  /** 绑定控件与窗口自适应。只在 fit 模式跟随 —— 用户手动定过的比例不该被改掉 */
  function wire() {
    const fb = el(fit); if (fb) fb.addEventListener('click', setFit);
    const zi = el(zin); if (zi) zi.addEventListener('click', () => step(1));
    const zo = el(zout); if (zo) zo.addEventListener('click', () => step(-1));
    const vv = el(val); if (vv) vv.addEventListener('click', () => setZoom(1));   // 点比例 → 回 100%
    const c = el(canvas);
    if (window.ResizeObserver && c) {
      let timer = 0;
      new ResizeObserver(() => {
        if (st.mode !== 'fit' || !box()) return;
        // 用 setTimeout 而不是 requestAnimationFrame 去抖：无头 / 后台标签页里
        // rAF 会被节流甚至不触发，那样"画布变大但比例没跟上"就补不上了。
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (st.mode !== 'fit') return;
          const k = fitScale();
          if (k) apply(k);
        }, 0);
      }).observe(c);
    }
  }

  /** 布局变动后主动补一次适应（不依赖 RO 的观察时机） */
  function refitIfFits() {
    if (st.mode === 'fit' && box()) setFit();
  }

  /** 换图：回到「适应窗口」。此刻 naturalWidth 还是 0，等 load 事件再算 */
  function reset() { st.mode = 'fit'; st.k = 1; }

  const api = {
    wire, reset, setFit, setZoom, step, box, fitScale, refitIfFits,
    get k() { return st.k; },
    get mode() { return st.mode; },
  };
  ZOOMS.push(api);          // 状态条显隐之类会改画布高度，需要能被统一补算
  return api;
}

/** 已建好的缩放控制器。目前只有取文字与打码两个。 */
const ZOOMS = [];

const copyZoom = createZoom({
  canvas: 'copyCanvas', img: 'copyImg', fit: 'copyFit',
  zin: 'copyZoomIn', zout: 'copyZoomOut', val: 'copyZoomVal',
});

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

/** 状态条按模式各有一条，所以第一个参数是元素 id */
function setStatus(boxId, msg, kind) {
  const box = $(boxId);
  if (!box) return;
  const wasHidden = box.hidden;
  if (!msg) {
    box.hidden = true;
  } else {
    box.hidden = false;
    box.className = 'tw-status' + (kind ? ' ' + kind : '');
    box.innerHTML = (kind === 'busy' ? '<span class="spin"></span>' : '')
      + `<span>${esc(msg)}</span>`;
  }
  // 状态条显隐会改变它上方画布的可用高度。正停在「适应窗口」时补算一次 ——
  // 否则识别跑完状态条一收，图还是按旧高度缩的（偏小一圈）。不能只靠
  // ResizeObserver：后台标签页 / 无头环境里 rAF 会被节流，等它补上就晚了。
  if (wasHidden === !msg) return;         // 显隐没变，不用重算
  setTimeout(() => { for (const z of ZOOMS) z.refitIfFits(); }, 0);
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
  saveBlob(blob, name);
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

const baseName = (name) =>
  String(name || '文字').replace(/\.[^.]+$/, '') || '文字';

/* ------------------------------------------------------------------ 通用交互 */

/**
 * 取文字与打码共用的「选图 / 拖拽 / 适应窗口」这一层。
 * onFile 是各自的主流程（一个去做识别，一个去做识别 + 规则匹配）。
 */
function wireCommon(els, zoom, onFile) {
  const input = $(els.input);
  const canvas = $(els.canvas);
  if (!input || !canvas) return;

  input.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) onFile(f);
    e.target.value = '';          // 允许再次选同一张
  });

  const pick = $(els.pick);
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
    if (f) onFile(f);
  });

  // 图解码完 → 先按「适应窗口」缩好再亮出来（配合 showImage 里的 visibility）
  const img = $(els.img);
  img.addEventListener('load', () => {
    zoom.setFit();
    img.style.visibility = '';
  });
  // 解码失败也要把图亮回来（否则画布一直空着，看起来像卡住）
  img.addEventListener('error', () => {
    img.style.visibility = '';
    setStatus(els.status, '这张图读不出来，换一张试试', 'err');
  });

  zoom.wire();
}

/* ==================================================================== */
/* 第 1 期 · 取文字 主流程                                                */
/* ==================================================================== */

async function handleFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type || '')) { setStatus(COPY_ELS.status, '请选择图片文件（JPG / PNG / WebP）', 'err'); return; }
  if (COPY.busy) return;

  COPY.busy = true;
  COPY.file = file;
  COPY.name = file.name || 'image';
  COPY.result = null;
  $(COPY_ELS.name).textContent = COPY.name;
  $(COPY_ELS.meta).textContent = '';
  $(COPY_ELS.pickText).textContent = '换一张';
  showImage(file, COPY_ELS, copyZoom, COPY);
  renderOverlay();
  renderLines();
  updateStats(null);
  setButtons(false);
  setStatus(COPY_ELS.status, '正在识别…', 'busy');

  try {
    const res = await detectOnce(file, (m) => setStatus(COPY_ELS.status, m, 'busy'));
    const m = await loadExtract();
    const out = m.extract(res.items);

    COPY.imgW = res.width || 0;
    COPY.imgH = res.height || 0;
    COPY.result = out;

    $(COPY_ELS.meta).textContent = `${res.width}×${res.height}`
      + (res.elapsed_ms != null ? ` · 识别 ${res.elapsed_ms}ms` : '');
    renderOverlay();
    renderLines();
    updateStats(res);
    setButtons(out.lines.length > 0);
    setStatus(COPY_ELS.status,
      out.lines.length ? '' : '没有识别到文字', out.lines.length ? '' : 'err');
  } catch (err) {
    const msg = String((err && err.message) || err);
    const waiting = window.WBLocal && !window.WBLocal.ready && !window.WBLocal.error;
    setStatus(COPY_ELS.status, waiting ? `本地引擎准备中… ${msg}` : `识别失败：${msg}`, 'err');
    setButtons(false);
  } finally {
    COPY.busy = false;
  }
}

function wireCopyMode() {
  wireCommon(COPY_ELS, copyZoom, handleFile);

  const all = $('copyAllBtn');
  if (all) all.addEventListener('click', async () => {
    if (!COPY.result) return;
    const ok = await copyText(COPY.result.text);
    flash(all, ok ? '已复制' : '复制失败');
  });

  const txt = $('copyTxtBtn');
  if (txt) txt.addEventListener('click', () => {
    if (!COPY.result) return;
    download(`${baseName(COPY.name)}.txt`, COPY.result.text, 'text/plain');
  });

  const md = $('copyMdBtn');
  if (md) md.addEventListener('click', () => {
    if (!COPY.result) return;
    download(`${baseName(COPY.name)}.md`, COPY.result.markdown, 'text/markdown');
  });
}

/* ==================================================================== */
/* 第 2 期 · 打码                                                        */
/* ----------------------------------------------------------------------
   复用同一次检测结果（detectOnce 有缓存），叠一层规则匹配，再按选定样式遮盖。
   色块 / 马赛克 / 模糊都是 canvas 原生能力 —— 前端实时重绘，零延迟；
   只有「抹字」要走引擎（web/engine/localapi.js 的 /api/text/erase）。
   ==================================================================== */

const MASK = {
  file: null, name: '', objectUrl: '',
  imgW: 0, imgH: 0,
  lines: null,          // extract 的行（与取文字同一份检测结果算出）
  hits: [],             // 待遮盖清单：自动命中 + 手动框选
  rules: null,          // 规则开关 { ruleId: bool }
  method: 'block',      // block | mosaic | blur | erase
  color: '#111111',
  busy: false,
  erasing: false,
  eraseImg: null,       // 抹字档的引擎结果（解码后的 Image）
  eraseSig: '',         // 结果对应的「开启中命中项的签名」，变了要重算
};

const MASK_DETECT = { sig: '', lines: null, meta: null };

let maskMod = null;
async function loadMask() {
  if (maskMod) return maskMod;
  const url = '/static/engine/mask.js' + (VER ? '?v=' + VER : '');
  maskMod = await import(url);
  window.WBMaskMod = maskMod;             // 自检与调试用
  return maskMod;
}

const maskZoom = createZoom({
  canvas: 'maskCanvas', img: 'maskImg', fit: 'maskFit',
  zin: 'maskZoomIn', zout: 'maskZoomOut', val: 'maskZoomVal',
  // 缩放变了要按新尺寸重绘遮盖层（canvas 尺寸跟着显示尺寸走）
  onChange: () => paintMasks(),
});

/* ------------------------------------------------------------ 遮盖绘制 */

/**
 * 把遮盖画到 ctx 上。预览（scale = 显示比例）与导出（scale = 1）共用这一份，
 * 保证「看到的」与「导出的」永远一致 —— 两套绘制代码早晚会漂移。
 */
function drawMasks(ctx, img, rects, scale, method) {
  for (const r of rects) {
    const dx = r.x * scale, dy = r.y * scale;
    const dw = r.w * scale, dh = r.h * scale;

    if (method === 'erase') {
      // 抹字：引擎已经把结果图整张擦好了，这里只把对应区域贴过来。
      // 源坐标仍用原图像素 —— 所以预览与导出取的是同一块像素。
      if (MASK.eraseImg) {
        ctx.drawImage(MASK.eraseImg, r.x, r.y, r.w, r.h, dx, dy, dw, dh);
      }
      continue;
    }

    if (method === 'block') {
      ctx.fillStyle = MASK.color;
      ctx.fillRect(dx, dy, dw, dh);
      continue;
    }

    if (method === 'mosaic') {
      // 像素化：先把该区域缩到很小（尺寸即"块"的粒度），再关掉平滑放大回去。
      // 块大小取 **框高的 40%**（不是常见的固定值）：打码的目的是"看不出是什么"，
      // 块取小了会保留字形轮廓，眯着眼还能认出来 —— 那就白打了。
      const bs = Math.max(6, Math.round(Math.min(r.w, r.h) * 0.4));   // 原图像素
      const tw = Math.max(1, Math.round(r.w / bs));
      const th = Math.max(1, Math.round(r.h / bs));
      const tmp = document.createElement('canvas');
      tmp.width = tw; tmp.height = th;
      const tctx = tmp.getContext('2d');
      tctx.imageSmoothingEnabled = true;
      tctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, tw, th);
      const prev = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, tw, th, dx, dy, dw, dh);
      ctx.imageSmoothingEnabled = prev;
      continue;
    }

    // blur：裁到该区域后把整图重绘一遍（filter 会作用在绘制上）
    ctx.save();
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    ctx.clip();
    ctx.filter = `blur(${Math.max(3, Math.min(r.w, r.h) * 0.22 * scale)}px)`;
    ctx.drawImage(img, 0, 0, img.naturalWidth * scale, img.naturalHeight * scale);
    ctx.filter = 'none';
    ctx.restore();
  }
}

/** 同步 canvas 尺寸到图片的显示尺寸（按 dpr 提清晰度，马赛克尤其需要） */
function syncMaskCanvas() {
  const cv = $('maskCv'), img = $('maskImg');
  if (!cv || !img || !img.naturalWidth) return null;
  const w = img.clientWidth, h = img.clientHeight;
  if (!(w > 0) || !(h > 0)) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  return { ctx: cv.getContext('2d'), w, h, dpr };
}

function paintMasks() {
  const c = syncMaskCanvas();
  if (!c) return;
  const { ctx, w, h, dpr } = c;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const img = $('maskImg');
  if (!img.naturalWidth || !MASK.hits.length || !maskMod) return;
  const rects = maskMod.toRects(MASK.hits, { pad: 2 });
  if (!rects.length) return;
  drawMasks(ctx, img, rects, w / img.naturalWidth, MASK.method);
}

/** 命中框：开启的实线红、关掉的虚线灰（关掉也要看得见，否则不知道漏了什么） */
function renderMaskOverlay() {
  const host = $('maskOverlay');
  const img = $('maskImg');
  if (!host) return;
  if (!MASK.imgW || !MASK.imgH || !MASK.hits.length) { host.innerHTML = ''; return; }
  const p = (v, t) => ((v / t) * 100).toFixed(3);
  host.innerHTML = MASK.hits.map((hh) => {
    const b = hh.rect;
    const on = hh.on !== false;
    const cls = hh.kind === 'manual' ? 'manual' : (on ? 'hit on' : 'hit off');
    return `<span class="tw-box ${cls}" data-id="${hh.id}" style="left:${p(b.x, MASK.imgW)}%;`
      + `top:${p(b.y, MASK.imgH)}%;width:${p(b.w, MASK.imgW)}%;height:${p(b.h, MASK.imgH)}%"></span>`;
  }).join('');
  host.querySelectorAll('.tw-box').forEach((el) => {
    el.addEventListener('mouseenter', () => hoverHit(el.dataset.id, true));
    el.addEventListener('mouseleave', () => hoverHit(el.dataset.id, false));
  });
}

function hoverHit(id, on) {
  const row = $('maskHits') && $('maskHits').querySelector(`.tw-hit[data-id="${id}"]`);
  if (row) row.classList.toggle('hover', on);
}

/* ------------------------------------------------------------ 命中清单 */

/** 手动项与开关状态要在重算规则后保住，所以给每项一个稳定 key */
const hitKey = (h) => `${h.ruleId}|${h.text}|${Math.round(h.rect.x)}|${Math.round(h.rect.y)}`
  + `|${Math.round(h.rect.w)}x${Math.round(h.rect.h)}`;

function rematch() {
  if (!maskMod || !MASK.lines) { MASK.hits = MASK.hits.filter((h) => h.kind === 'manual'); return; }
  // 旧状态按 key 记下来（用户关掉过的项，重算后不该又开回来）
  const prev = new Map(MASK.hits.filter((h) => h.kind === 'auto').map((h) => [hitKey(h), h.on !== false]));
  const manual = MASK.hits.filter((h) => h.kind === 'manual');
  const auto = maskMod.findSensitive(MASK.lines, { enabled: MASK.rules }).map((h) => {
    const k = hitKey(h);
    return { ...h, kind: 'auto', key: k, on: prev.has(k) ? prev.get(k) : true };
  });
  MASK.hits = [...auto, ...manual];
  MASK.eraseSig = '';                      // 命中变了，抹字结果作废
  renderHits();
  renderMaskOverlay();
  paintMasks();
  updateMaskStats();
}

function renderHits() {
  const host = $('maskHits');
  if (!host) return;
  if (!MASK.hits.length) {
    host.innerHTML = `<p class="tw-side-empty">${MASK.file
      ? '没有识别到需要遮盖的内容。可以在图上拖拽手动框选。'
      : '识别结果会出现在这里，逐条可开关'}</p>`;
    return;
  }
  host.innerHTML = MASK.hits.map((h) => {
    const on = h.on !== false;
    const manual = h.kind === 'manual';
    return `<div class="tw-hit ${on ? 'on-hit' : 'off-hit'}" data-id="${h.id}">
      <input type="checkbox" ${on ? 'checked' : ''} aria-label="是否遮盖">
      <span class="tw-hit-tag ${manual ? 'manual' : ''}">${esc(manual ? '手动' : h.label)}</span>
      <span class="tw-hit-text" title="${esc(h.text || '手动框选')}">${esc(h.text || '手动框选')}</span>
      <span class="tw-hit-line">${manual ? '' : 'L' + (h.lineId + 1)}</span>
      ${manual ? '<button class="tw-hit-del" type="button" title="删除这一项">删除</button>' : ''}
    </div>`;
  }).join('');

  host.querySelectorAll('.tw-hit').forEach((el) => {
    const id = el.dataset.id;
    const cb = el.querySelector('input');
    const toggle = (v) => {
      const h = MASK.hits.find((x) => x.id === id);
      if (!h) return;
      h.on = v;
      el.classList.toggle('on-hit', v);
      el.classList.toggle('off-hit', !v);
      MASK.eraseSig = '';
      renderMaskOverlay();
      paintMasks();
      updateMaskStats();
      if (MASK.method === 'erase') ensureErase();
    };
    cb.addEventListener('change', () => toggle(cb.checked));
    el.addEventListener('click', (e) => {
      if (e.target === cb) return;
      if (e.target.closest('.tw-hit-del')) {
        MASK.hits = MASK.hits.filter((x) => x.id !== id);
        MASK.eraseSig = '';
        renderHits(); renderMaskOverlay(); paintMasks(); updateMaskStats();
        return;
      }
      cb.checked = !cb.checked;
      toggle(cb.checked);
    });
    el.addEventListener('mouseenter', () => hoverHitBox(id, true));
    el.addEventListener('mouseleave', () => hoverHitBox(id, false));
  });
}

function hoverHitBox(id, on) {
  const box = $('maskOverlay') && $('maskOverlay').querySelector(`.tw-box[data-id="${id}"]`);
  if (box) box.classList.toggle('hov', on);
}

function updateMaskStats() {
  const el = $('maskStats');
  const n = MASK.hits.filter((h) => h.on !== false).length;
  const total = MASK.hits.length;
  if (el) {
    el.textContent = total
      ? `遮盖 ${n} / ${total} 处`
      : (MASK.file ? '未识别到敏感信息' : '待遮盖');
  }
  const dis = (id, v) => { const b = $(id); if (b) b.disabled = v; };
  dis('maskAllBtn', !total);
  dis('maskNoneBtn', !total);
  dis('maskSavePng', !n);
  dis('maskSaveJpg', !n);

  // 规则计数：让用户知道每条规则各命中了多少（关规则时心里有数）
  if (maskMod) {
    const sum = maskMod.summarize(MASK.hits.filter((h) => h.kind === 'auto'));
    const host = $('maskRuleList');
    if (host) host.querySelectorAll('.tw-rule-count').forEach((s) => {
      const c = sum.by[s.dataset.c] || 0;
      s.textContent = c ? String(c) : '';
    });
    const rs = $('maskRuleSum');
    if (rs) rs.textContent = sum.total ? `命中 ${sum.total} 处` : '';
  }
}

/* ------------------------------------------------------------ 规则开关 */

function renderRules() {
  const host = $('maskRuleList');
  if (!host || !maskMod) return;
  if (!MASK.rules) MASK.rules = maskMod.defaultRuleState();   // 可能早于 boot 的加载完成
  host.innerHTML = maskMod.RULES.map((r) => `
    <label class="tw-rule">
      <input type="checkbox" data-r="${r.id}" ${MASK.rules[r.id] !== false ? 'checked' : ''}>
      <span>${esc(r.label)}</span>
      <span class="tw-rule-count" data-c="${r.id}"></span>
    </label>`).join('');
  host.querySelectorAll('input[data-r]').forEach((cb) => {
    cb.addEventListener('change', () => {
      MASK.rules[cb.dataset.r] = cb.checked;
      rematch();
    });
  });
}

/* ------------------------------------------------------------ 抹字（走引擎） */

const hitSig = () => MASK.hits.filter((h) => h.on !== false)
  .map((h) => `${Math.round(h.rect.x)},${Math.round(h.rect.y)},`
    + `${Math.round(h.rect.w)},${Math.round(h.rect.h)}`).join('|');

/**
 * 抹字要引擎参与（把文字擦掉、保留背景），是异步且可能几秒的，
 * 所以结果按「当前开启的命中矩形」签名缓存 —— 只开关某一项时不用重算整张。
 */
async function ensureErase() {
  if (MASK.erasing || !MASK.file || !maskMod) return;
  const rects = maskMod.toRects(MASK.hits, { pad: 2 });
  if (!rects.length) return;
  const sig = hitSig();
  if (MASK.eraseSig === sig && MASK.eraseImg) return;

  MASK.erasing = true;
  setStatus(MASK_ELS.status, '正在擦除文字…', 'busy');
  try {
    const L = await localFacade();
    if (!L) throw new Error('本地引擎未就绪，请刷新页面重试');
    const fd = new FormData();
    fd.append('file', MASK.file, MASK.name);
    fd.append('rects', JSON.stringify(rects));
    fd.append('method', 'auto');
    const res = await L.handle('/api/text/erase', fd);
    if (!res || !res.image) throw new Error('本地引擎未提供擦除能力，请刷新页面重试');
    MASK.eraseImg = await loadImgEl(res.image);
    MASK.eraseSig = sig;
    MASK.leftovers = res.leftovers || [];       // 自检与调试用
    // 擦完还有起伏就直说 —— 抹字留了残影而用户以为盖好了，比不盖更糟。
    // 阈值 8：纯色底擦净时标准差 < 2，肉眼可见的残影一般在 10 以上。
    const bad = (res.leftovers || []).filter((v) => v > 8).length;
    setStatus(MASK_ELS.status,
      bad ? `有 ${bad} 处没擦净，这类内容建议改用色块` : '',
      bad ? 'err' : '');
    paintMasks();
  } catch (err) {
    setStatus(MASK_ELS.status, `擦除失败：${String((err && err.message) || err)}`, 'err');
  } finally {
    MASK.erasing = false;
  }
}

function loadImgEl(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('擦除结果解码失败'));
    i.src = src;
  });
}

/* ------------------------------------------------------------ 主流程 */

async function handleMaskFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type || '')) { setStatus(MASK_ELS.status, '请选择图片文件（JPG / PNG / WebP）', 'err'); return; }
  if (MASK.busy) return;

  MASK.busy = true;
  MASK.file = file;
  MASK.name = file.name || 'image';
  MASK.hits = [];
  MASK.lines = null;
  MASK.eraseImg = null;
  MASK.eraseSig = '';
  $(MASK_ELS.name).textContent = MASK.name;
  $(MASK_ELS.meta).textContent = '';
  $(MASK_ELS.pickText).textContent = '换一张';
  showImage(file, MASK_ELS, maskZoom, MASK);
  renderHits();
  renderMaskOverlay();
  paintMasks();
  updateMaskStats();
  setStatus(MASK_ELS.status, '正在识别…', 'busy');

  try {
    const res = await detectOnce(file, (m) => setStatus(MASK_ELS.status, m, 'busy'));
    const m = await loadExtract();
    MASK.imgW = res.width || 0;
    MASK.imgH = res.height || 0;
    MASK.lines = m.buildLines(res.items);

    $(MASK_ELS.meta).textContent = `${res.width}×${res.height}`
      + (res.elapsed_ms != null ? ` · 识别 ${res.elapsed_ms}ms` : '');

    renderRules();
    rematch();
    setStatus(MASK_ELS.status, '');
  } catch (err) {
    const msg = String((err && err.message) || err);
    const waiting = window.WBLocal && !window.WBLocal.ready && !window.WBLocal.error;
    setStatus(MASK_ELS.status, waiting ? `本地引擎准备中… ${msg}` : `识别失败：${msg}`, 'err');
  } finally {
    MASK.busy = false;
  }
}

/* ------------------------------------------------------------ 手动框选 */

function wireMarquee() {
  const box = $('maskImgBox');
  const img = $('maskImg');
  const mq = $('maskMarquee');
  if (!box || !img || !mq) return;
  let sx = 0, sy = 0, drawing = false;

  const toImg = (e, r) => ({
    x: Math.max(0, Math.min(MASK.imgW, (e.clientX - r.left) * (MASK.imgW / r.width))),
    y: Math.max(0, Math.min(MASK.imgH, (e.clientY - r.top) * (MASK.imgH / r.height))),
  });

  box.addEventListener('pointerdown', (e) => {
    if (!MASK.imgW || e.button !== 0) return;
    const r = box.getBoundingClientRect();
    const p = toImg(e, r);
    sx = p.x; sy = p.y; drawing = true;
    box.setPointerCapture(e.pointerId);
    mq.hidden = false;
    mq.style.left = '0'; mq.style.top = '0';
    mq.style.width = '0'; mq.style.height = '0';
  });

  box.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const r = box.getBoundingClientRect();
    const p = toImg(e, r);
    const x = Math.min(sx, p.x), y = Math.min(sy, p.y);
    const w = Math.abs(p.x - sx), h = Math.abs(p.y - sy);
    const k = r.width / MASK.imgW;
    mq.style.left = (x * k) + 'px';
    mq.style.top = (y * k) + 'px';
    mq.style.width = (w * k) + 'px';
    mq.style.height = (h * k) + 'px';
  });

  const finish = (e) => {
    if (!drawing) return;
    drawing = false;
    mq.hidden = true;
    const r = box.getBoundingClientRect();
    const p = toImg(e, r);
    const x = Math.min(sx, p.x), y = Math.min(sy, p.y);
    const w = Math.abs(p.x - sx), h = Math.abs(p.y - sy);
    // 太小的框多半是误点，不当成一个区域
    if (w < 6 || h < 6) return;
    MASK.hits.push({
      id: `u${Date.now().toString(36)}`,
      ruleId: 'manual', label: '手动', text: '',
      rect: { x, y, w, h }, lineId: -1, scope: 'manual',
      kind: 'manual', on: true,
    });
    MASK.eraseSig = '';
    renderHits(); renderMaskOverlay(); paintMasks(); updateMaskStats();
    if (MASK.method === 'erase') ensureErase();
  };
  box.addEventListener('pointerup', finish);
  box.addEventListener('pointercancel', () => { drawing = false; mq.hidden = true; });
}

/* ------------------------------------------------------------ 导出 */

async function exportMask(fmt) {
  const img = $('maskImg');
  if (!img.naturalWidth || !MASK.imgW || !maskMod) return;
  const rects = maskMod.toRects(MASK.hits, { pad: 2 });
  if (!rects.length) return;

  // 抹字档要先确认引擎结果在（否则导出的图里那块是原样未盖的）
  if (MASK.method === 'erase') {
    await ensureErase();
    if (!MASK.eraseImg) return;
  }

  const cv = document.createElement('canvas');
  cv.width = MASK.imgW;
  cv.height = MASK.imgH;
  const ctx = cv.getContext('2d');
  if (fmt === 'jpg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); }
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  drawMasks(ctx, img, rects, 1, MASK.method);          // scale = 1 → 原图尺寸重绘

  const mime = fmt === 'jpg' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise((res) => cv.toBlob(res, mime, 0.92));
  if (!blob) { setStatus(MASK_ELS.status, '导出失败：浏览器不支持该格式', 'err'); return; }
  // canvas 重新编码 → 天然不带 EXIF（GPS / 机型等原始元信息不会跟着出去）
  saveBlob(blob, `${baseName(MASK.name)}-已遮盖.${fmt}`);
}

/* ------------------------------------------------------------ 装配 */

function setMaskMethod(m) {
  MASK.method = m;
  const host = $('maskMethod');
  if (host) host.querySelectorAll('.tw-mbtn').forEach((b) => {
    b.classList.toggle('on', b.dataset.m === m);
  });
  paintMasks();
  if (m === 'erase') ensureErase();     // 先按现状画（可能还没有结果），再异步补
}

function wireMaskMode() {
  wireCommon(MASK_ELS, maskZoom, handleMaskFile);

  const mhost = $('maskMethod');
  if (mhost) mhost.querySelectorAll('.tw-mbtn').forEach((b) => {
    b.addEventListener('click', () => setMaskMethod(b.dataset.m));
  });

  const all = $('maskAllBtn');
  if (all) all.addEventListener('click', () => {
    MASK.hits.forEach((h) => { h.on = true; });
    MASK.eraseSig = '';
    renderHits(); renderMaskOverlay(); paintMasks(); updateMaskStats();
    if (MASK.method === 'erase') ensureErase();
  });

  const none = $('maskNoneBtn');
  if (none) none.addEventListener('click', () => {
    MASK.hits.forEach((h) => { h.on = false; });
    MASK.eraseSig = '';
    renderHits(); renderMaskOverlay(); paintMasks(); updateMaskStats();
  });

  const png = $('maskSavePng');
  if (png) png.addEventListener('click', () => exportMask('png'));
  const jpg = $('maskSaveJpg');
  if (jpg) jpg.addEventListener('click', () => exportMask('jpg'));

  wireMarquee();
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
  get mask() { return MASK; },
  text() { return COPY.result ? COPY.result.text : ''; },
  markdown() { return COPY.result ? COPY.result.markdown : ''; },
  lines() { return COPY.result ? COPY.result.lines.map((l) => l.text) : []; },
  // 自检用：直接读遮盖层像素，判断"某一处到底盖住没有"
  maskPixel(x, y) {
    const cv = $('maskCv'), img = $('maskImg');
    if (!cv || !img || !img.naturalWidth) return null;
    const k = cv.width / img.naturalWidth;
    const d = cv.getContext('2d').getImageData(
      Math.round(x * k), Math.round(y * k), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  },
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
  wireMaskMode();
  // 纯函数层提前备好：等用户拖图时就不用再等一次网络往返
  loadExtract().catch(() => {});
  loadMask().then(() => {
    MASK.rules = maskMod.defaultRuleState();
    renderRules();
  }).catch(() => {});
  S.ready = true;
  // 就绪信号：外层可能因为"视图还没准备好"而把目标视图记成了待切换，
  // 收到这个信号后会补切一次（与 image.js 的 wb-images-ready 同一套机制）。
  window.dispatchEvent(new CustomEvent('wb-text-ready'));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
