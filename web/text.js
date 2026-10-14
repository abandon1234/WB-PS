/* ==========================================================================
   文字工坊 · 取文字 / 打码 / 翻译
   ---------------------------------------------------------------------------
   三个功能键在**同一页**里切换：共用一块画布（图 / 缩放 / 状态条 / 叠加层），
   点按键只换右侧面板。选一次图就能在三个功能之间来回试，不用重选、也不用
   重新等识别 —— 这是「一个页面三个功能键」的全部意义。

   三个功能的后半段各不相同：

     取文字 → 阅读顺序排序 + 段落合并 + 导出 txt / md   （只需 detect）
     打码   → 敏感信息规则匹配 + 区域遮盖               （只需 detect）
     翻译   → 译文写回 edit，复用现有 applyEdits()      （需要 analyze，要样式）

   识别按需补跑：`ensureLoaded(mode)` 只在「这个模式还没算过这张图」时跑一次。
   取文字与打码走同一个 detectOnce（本身带缓存 + 在途去重），互相切不重跑。

   为什么单独一个视图、不并进「无痕改字」：
   改字的 inspector 是重度样式编辑器（字体 / 描边 / 偏移 / 字距），把打码和取文字
   混进去会互相干扰、app.js 会迅速变烂。两者的关系是「工坊批量 → 改字精修」。

   完整设计与排期见 docs/plan-text-workshop.md。
   ========================================================================== */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* 模式定义：key 就是 hash 里那个键（#text-copy / #text-mask / #text-translate）。
   三个模式共用左边那块画布，区别只有右侧面板（data-side）与画布上几个配件。 */
const MODES = [
  { id: 'copy', key: 'text-copy', label: '取文字',
    dropIc: '#i-upload', desc: 'JPG、PNG、WebP · 识别全程在本机完成，图片不会上传' },
  { id: 'mask', key: 'text-mask', label: '打码',
    dropIc: '#i-shield', desc: '识别与遮盖全程在本机完成，图片不会上传' },
  { id: 'translate', key: 'text-translate', label: '翻译',
    dropIc: '#i-type', desc: '识别与重绘在本机完成；只有识别出来的文字会发往服务端翻译' },
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

/** 画布上随模式变的配件：拖拽提示、遮盖层、手动框选提示、译文切换 */
function syncStage(id) {
  const m = MODES.find((x) => x.id === id) || MODES[0];

  // 拖拽区的图标与说明（三个模式讲的是不同的隐私承诺，别混用一套文案）
  const ic = $('twDropIc');
  if (ic) ic.setAttribute('href', m.dropIc);
  const desc = $('twDropDesc');
  if (desc) desc.textContent = m.desc;

  // 只有打码要拖框选遮盖区域
  const hint = $('twHint');
  if (hint) hint.hidden = id !== 'mask';

  // 只有打码有遮盖层。切走时清空 —— 留着会盖在别的模式的图上
  const cv = $('twMaskCv');
  if (cv) {
    cv.hidden = id !== 'mask';
    if (id !== 'mask' && cv.width) {
      cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    }
  }

  // 「译文 / 原图」只在翻译模式、且已经出过译文图时才给
  const vw = $('twView');
  if (vw) vw.hidden = !(id === 'translate' && !!TR.outUrl);

  const mq = $('twMarquee');
  if (mq) mq.hidden = true;

  // 非翻译模式一律显示原图：翻译模式的 img 可能正停在译文图上。
  // 回到翻译模式则恢复用户上次看的那一面（译文 / 原图）。
  if (id === 'translate') switchTrView(TR.view || 'source');
  else ensureSourceImage();

  // 检测框 / 命中框共用同一层，按模式重画（翻译不需要框，清空）
  renderStageOverlay();
}

/** 切右侧面板。左边画布与图不动，所以切模式不再有"换了个页面"的感觉。 */
function paintMode(id) {
  const host = $('viewTextMain');
  if (host) {
    for (const el of host.querySelectorAll('.tw-side[data-side]')) {
      el.hidden = el.dataset.side !== id;
    }
  }
  syncStage(id);
  syncTabs();
}

/** 切到某模式时，若这张图还没在该模式里算过，就补跑一次识别。
    （取文字与打码走同一个 detectOnce，互相切不重跑；翻译走 analyze，代价大。） */
function ensureLoaded(mode) {
  if (!CUR.file) return;
  const sig = fileSig(CUR.file);
  if (LOADED[mode] === sig) return;
  LOADED[mode] = sig;
  if (mode === 'copy') runCopy(CUR.file);
  else if (mode === 'mask') runMask(CUR.file);
  else runTrAnalyze(CUR.file);
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
  if (m.id === 'translate') checkTrStatus();     // 进翻译就先问一句"能不能用"
  setStatus(ELS.status, '');                     // 上一个模式的状态条不该跟过来
  ensureLoaded(m.id);

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

/** 取文字的全部状态。result 是 engine/extract.js 的返回值（行 / 段落 / 文本）。
    文件本身归 CUR（三个模式共用），这里只放取文字自己的识别结果。 */
const COPY = {
  imgW: 0, imgH: 0,
  result: null,
  meta: '',             // 文件名旁那行（尺寸 + 识别耗时）
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

/**
 * 调本地引擎，并把加载进度接到**调用方自己的**状态条上。
 *
 * 临时接管 L.progress、用完还原 —— 不去改 boot.js 的全局 progress，
 * 免得和改字视图那套状态条互相覆盖。
 */
async function callLocal(url, body, onStatus) {
  const L = await localFacade();
  if (!L) throw new Error('本地引擎未就绪，请刷新页面重试');
  const prev = L.progress;
  L.progress = (p) => {
    if (typeof prev === 'function') { try { prev(p); } catch (_) {} }
    if (onStatus) onStatus(progressText(p));
  };
  try {
    return await L.handle(url, body);
  } finally {
    L.progress = prev;
  }
}

/** 只识别，不分析样式。首次调用会触发模型下载（之后走本机缓存）。 */
async function runDetect(file, onStatus) {
  const fd = new FormData();
  fd.append('file', file, file.name || 'image.png');
  fd.append('merge_lines', 'true');
  const res = await callLocal(DETECT_URL, fd, onStatus);
  if (!res) throw new Error('本地引擎未提供取文字能力，请刷新页面重试');
  return res;
}

/* 取文字与打码共用同一次检测：同一张图在两个模式之间切换不该重跑一遍
   （识别要 1~5 秒，切一次等一次很烦，而且结果是完全一样的）。
   签名用「文件名 + 大小 + 修改时间」—— 比按文件内容做哈希便宜，且换图必然变。 */
const DETECT_CACHE = { sig: '', res: null, inflight: null };
const fileSig = (f) => `${f.name}|${f.size}|${f.lastModified}`;

async function detectOnce(file, onStatus) {
  const sig = fileSig(file);
  if (DETECT_CACHE.sig === sig && DETECT_CACHE.res) return DETECT_CACHE.res;
  // 同一次检测正在路上就别再发一份：共用画布之后，用户在检测跑到一半时
  // 切到另一个模式，两个模式都会来要同一张图的结果。
  if (DETECT_CACHE.inflight && DETECT_CACHE.inflight.sig === sig) {
    return DETECT_CACHE.inflight.p;
  }
  const p = runDetect(file, onStatus).then((res) => {
    DETECT_CACHE.sig = sig;
    DETECT_CACHE.res = res;
    return res;
  }).finally(() => {
    if (DETECT_CACHE.inflight && DETECT_CACHE.inflight.p === p) DETECT_CACHE.inflight = null;
  });
  DETECT_CACHE.inflight = { sig, p };
  return p;
}

/* ---------------------------------------------------------------- 图片展示 */

/* 三个模式**共用同一套画布元素**。
   原来一套 id 一份、一共三份，切模式等于把整块画布换掉（图没了、缩放归零、
   状态条重来），看着就像换了个页面。合并成一份之后，切模式只换右栏。 */
const ELS = {
  canvas: 'twCanvas', img: 'twImg', drop: 'twDrop',
  imgBox: 'twImgBox', zoom: 'twZoom', status: 'twStatus',
  input: 'twInput', pick: 'twPick', pickText: 'twPickText',
  name: 'twName', meta: 'twMeta',
};

/* ---------------------------------------------------------------- 当前这张图 */

/* 三个模式共享的「当前这张图」。
   切模式不该把图丢掉 —— 选一次图就能在取文字 / 打码 / 翻译之间来回试，
   这是「一个页面三个功能键」的前提。各模式自己的识别结果仍各自持有。 */
const CUR = {
  file: null,
  name: '',
  url: '',            // 原图的 object URL（翻译的译文图另存 TR.outUrl）
  imgW: 0, imgH: 0,
  fittedOnce: false,  // 只在"换了新图"时适应窗口；翻译换译文图不该冲掉比例
};

/* 每个模式「已经算过哪个文件」的签名。切模式时按它判断要不要补跑识别 ——
   取文字与打码走同一个 detectOnce（本身有缓存，互相切不重跑），
   翻译单独走 analyze，代价大，更不能白跑。 */
const LOADED = { copy: '', mask: '', translate: '' };

function showImage(file) {
  const img = $(ELS.img);
  if (CUR.url) URL.revokeObjectURL(CUR.url);
  CUR.url = URL.createObjectURL(file);
  stageZoom.reset();
  // 先藏起来：新版图解码完就按原尺寸渲染，等 load 里「适应窗口」算好了再亮，
  // 否则会闪一下两千多 px 高的大图。
  img.style.visibility = 'hidden';
  img.src = CUR.url;
  $(ELS.drop).hidden = true;
  $(ELS.imgBox).hidden = false;
  const z = $(ELS.zoom);
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

/** 已建好的缩放控制器。三个模式共用同一个，所以这里只会有一个。 */
const ZOOMS = [];

/* 三模式共用同一个缩放控制器（原来是三个实例、各缩各的，一切模式比例就重来）。
   onChange 按当前模式分发：只有打码要把遮盖层按新显示尺寸重绘一遍。 */
const stageZoom = createZoom({
  canvas: 'twCanvas', img: 'twImg', fit: 'twFit',
  zin: 'twZoomIn', zout: 'twZoomOut', val: 'twZoomVal',
  onChange: () => { if (S.mode === 'mask') paintMasks(); },
});

/* ---------------------------------------------------------------- 检测框 */

/* 三个模式共用同一层 overlay，但内容不同（取文字是识别框、打码是命中框、
   翻译不画框）。切模式时必须整层重画，否则会留着上一个模式的框。 */
function renderStageOverlay() {
  if (S.mode === 'copy') renderCopyOverlay();
  else if (S.mode === 'mask') { renderMaskOverlay(); paintMasks(); }
  else { const host = $('twOverlay'); if (host) host.innerHTML = ''; }
}

/* 翻译模式的 img 会在原图 / 译文图之间切；只要离开翻译模式就必须切回原图，
   否则取文字与打码会画在译文图上、坐标看着对但底下不是原图。 */
function ensureSourceImage() {
  const img = $('twImg');
  if (!img || !CUR.url || !img.src) return;
  if (img.src !== CUR.url) img.src = CUR.url;
}

/** 框的位置全用百分比 —— 图片宽度自适应，缩放/窄屏都不用重算 */
function renderCopyOverlay() {
  const host = $('twOverlay');
  if (!host || S.mode !== 'copy') return;
  const r = COPY.result;
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
  const box = $('twOverlay') && $('twOverlay').querySelector(`.tw-box[data-i="${i}"]`);
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
    host.innerHTML = `<p class="tw-side-empty">${CUR.file
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
 * 三个模式共用的「选图 / 拖拽 / 适应窗口」这一层 —— 只挂一次。
 * 原来三个模式各挂一份（因为各有一套画布），现在画布只有一块，选图也就只有一个入口。
 */
function wireStage() {
  const input = $(ELS.input);
  const canvas = $(ELS.canvas);
  if (!input || !canvas) return;

  input.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) openFile(f);
    e.target.value = '';          // 允许再次选同一张
  });

  const pick = $(ELS.pick);
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
    if (f) openFile(f);
  });

  // 图解码完 → 先按「适应窗口」缩好再亮出来（配合 showImage 里的 visibility）。
  // 翻译模式会在原图 / 译文图之间换 src，两张图尺寸完全相同 —— 那种"换 src"
  // 不该把用户手动定好的比例冲掉，所以只在换了新图时才适应。
  const img = $(ELS.img);
  img.addEventListener('load', () => {
    if (!CUR.fittedOnce) { stageZoom.setFit(); CUR.fittedOnce = true; }
    img.style.visibility = '';
    // 换 src（原图 ↔ 译文图）后叠加层要跟着这张图重画。src 没变时这里是空转。
    renderStageOverlay();
  });
  // 解码失败也要把图亮回来（否则画布一直空着，看起来像卡住）
  img.addEventListener('error', () => {
    img.style.visibility = '';
    setStatus(ELS.status, '这张图读不出来，换一张试试', 'err');
  });

  stageZoom.wire();
}

/** 文件名旁边那行元信息跟着当前模式走（三个模式各记各的识别耗时） */
function paintMeta() {
  const el = $('twMeta');
  if (!el) return;
  el.textContent = (S.mode === 'copy' ? COPY.meta
    : S.mode === 'mask' ? MASK.meta : TR.meta) || '';
}

/** 只在"当前模式"处于前台时才写状态条。
    共用一条状态条之后，后台跑完的任务（识别是异步的，中途可能已经切走）
    不该把前台正在做的事的提示盖掉。 */
function setStatusFor(mode, msg, kind) {
  if (S.mode === mode) setStatus(ELS.status, msg, kind);
}

/**
 * 选图 / 拖图的唯一入口。
 *
 * 一张图进来后三个模式**共用**它：切模式只换右栏，图、缩放、文件名全都不动 ——
 * 所以点「取文字 / 打码 / 翻译」不再像换了个页面，也不用重新选图。
 * 识别按需补跑（见 ensureLoaded），当前模式立刻跑。
 */
function openFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type || '')) {
    setStatus(ELS.status, '请选择图片文件（JPG / PNG / WebP）', 'err');
    return;
  }

  CUR.file = file;
  CUR.name = file.name || 'image';
  CUR.imgW = 0; CUR.imgH = 0;
  CUR.fittedOnce = false;
  LOADED.copy = ''; LOADED.mask = ''; LOADED.translate = '';   // 三个模式都重来

  resetCopy(); resetMask(); resetTr();

  $(ELS.name).textContent = CUR.name;
  setStatus(ELS.status, '');
  showImage(file);
  const vw = $('twView');                 // 换了图，翻译回到原图
  if (vw) vw.hidden = true;
  paintMeta();

  ensureLoaded(S.mode);
}

/* ==================================================================== */
/* 第 1 期 · 取文字 主流程                                                */
/* ==================================================================== */

/** 换图时把取文字的结果清干净 —— 图换了，旧的行与框都不能留 */
function resetCopy() {
  COPY.result = null;
  COPY.imgW = 0; COPY.imgH = 0;
  COPY.meta = '';
  renderLines();
  updateStats(null);
  setButtons(false);
}

async function runCopy(file) {
  if (!file || COPY.busy || !CUR.file) return;

  COPY.busy = true;
  COPY.result = null;
  COPY.meta = '';
  renderLines();
  updateStats(null);
  setButtons(false);
  setStatus(ELS.status, '正在识别…', 'busy');

  try {
    const res = await detectOnce(file, (m) => setStatusFor('copy', m, 'busy'));
    const m = await loadExtract();
    const out = m.extract(res.items);

    COPY.imgW = res.width || 0;
    COPY.imgH = res.height || 0;
    COPY.result = out;
    COPY.meta = `${res.width}×${res.height}`
      + (res.elapsed_ms != null ? ` · 识别 ${res.elapsed_ms}ms` : '');
    // 识别跑完时用户可能已经切到别的模式了：那就不碰共用画布与状态条，
    // 只把结果收下（切回来时 syncStage 会按结果重画整层）。
    if (S.mode === 'copy') {
      paintMeta();
      renderCopyOverlay();
      setStatus(ELS.status,
        out.lines.length ? '' : '没有识别到文字', out.lines.length ? '' : 'err');
    }
    renderLines();
    updateStats(res);
    setButtons(out.lines.length > 0);
  } catch (err) {
    const msg = String((err && err.message) || err);
    const waiting = window.WBLocal && !window.WBLocal.ready && !window.WBLocal.error;
    setStatusFor('copy', waiting ? `本地引擎准备中… ${msg}` : `识别失败：${msg}`, 'err');
    setButtons(false);
  } finally {
    COPY.busy = false;
  }
}

/** 取文字面板上的按钮（选图 / 拖拽那一层已由 wireStage 统一接管） */
function wireCopyMode() {
  const all = $('copyAllBtn');
  if (all) all.addEventListener('click', async () => {
    if (!COPY.result) return;
    const ok = await copyText(COPY.result.text);
    flash(all, ok ? '已复制' : '复制失败');
  });

  const txt = $('copyTxtBtn');
  if (txt) txt.addEventListener('click', () => {
    if (!COPY.result) return;
    download(`${baseName(CUR.name)}.txt`, COPY.result.text, 'text/plain');
  });

  const md = $('copyMdBtn');
  if (md) md.addEventListener('click', () => {
    if (!COPY.result) return;
    download(`${baseName(CUR.name)}.md`, COPY.result.markdown, 'text/markdown');
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
  imgW: 0, imgH: 0,
  meta: '',             // 文件名旁那行（尺寸 + 识别耗时）
  lines: null,          // extract 的行（与取文字同一份检测结果算出）
  hits: [],             // 待遮盖清单：自动命中 + 手动框选
  rules: null,          // 规则开关 { ruleId: bool }
  method: 'block',      // block | mosaic | blur | erase
  color: '#111111',
  busy: false,
  erasing: false,
  eraseImg: null,       // 抹字档的引擎结果（解码后的 Image）
  eraseSig: '',         // 结果对应的「开启中命中项的签名」，变了要重算
  leftovers: [],        // 逐块残留（灰度标准差，有纹理的底子用它判）
  peaks: [],            // 逐块「最大离背景偏移」（纯色底用它判）
  worst: 0,             // 上述峰值里的最大者，给状态条用
  levels: [],           // 诊断：逐块估出的背景主峰（查「取色错」时最直接的一眼）
  inks: [],             // 诊断：逐块框内墨占比
  masks: [],            // 诊断：逐块掩膜像素数
  resids: [],           // 诊断：逐块边缘能量
  methods: [],          // 诊断：逐块实际用的策略
  probeCv: null,        // 自检用的取像素画布（记录里删掉抹字结果图时也要清）
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
  const cv = $('twMaskCv'), img = $('twImg');
  if (!cv || !img || !img.naturalWidth) return null;
  const w = img.clientWidth, h = img.clientHeight;
  if (!(w > 0) || !(h > 0)) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  return { ctx: cv.getContext('2d'), w, h, dpr };
}

function paintMasks() {
  // 遮盖层只在打码模式有意义：识别在后台跑完时用户可能已经切走了，
  // 这时画上去会盖在别的模式的图上。
  if (S.mode !== 'mask') return;
  const c = syncMaskCanvas();
  if (!c) return;
  const { ctx, w, h, dpr } = c;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const img = $('twImg');
  if (!img.naturalWidth || !MASK.hits.length || !maskMod) return;
  const rects = maskMod.toRects(MASK.hits, { pad: 2 });
  if (!rects.length) return;
  drawMasks(ctx, img, rects, w / img.naturalWidth, MASK.method);
}

/** 命中框：开启的实线红、关掉的虚线灰（关掉也要看得见，否则不知道漏了什么） */
function renderMaskOverlay() {
  if (S.mode !== 'mask') return;
  const host = $('twOverlay');
  const img = $('twImg');
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
    host.innerHTML = `<p class="tw-side-empty">${CUR.file
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
  const box = $('twOverlay') && $('twOverlay').querySelector(`.tw-box[data-id="${id}"]`);
  if (box) box.classList.toggle('hov', on);
}

function updateMaskStats() {
  const el = $('maskStats');
  const n = MASK.hits.filter((h) => h.on !== false).length;
  const total = MASK.hits.length;
  if (el) {
    let t = total
      ? `遮盖 ${n} / ${total} 处`
      : (CUR.file ? '未识别到敏感信息' : '待遮盖');
    // 抹字档：把"到底擦干净没有"直接写在数字旁边，别让人只看预览去猜。
    // 只在结果确实对应当前命中集时才报（签名一致），阈值与 ensureErase 同步。
    if (MASK.method === 'erase' && MASK.eraseImg && total && MASK.eraseSig === hitSig()) {
      t += MASK.worst > 16 ? ` · 抹字有残留(${MASK.worst})` : ' · 抹字已擦净';
    }
    el.textContent = t;
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
  if (MASK.erasing || !CUR.file || !maskMod) return;
  const rects = maskMod.toRects(MASK.hits, { pad: 2 });
  if (!rects.length) return;
  const sig = hitSig();
  if (MASK.eraseSig === sig && MASK.eraseImg) return;

  MASK.erasing = true;
  setStatus(ELS.status, '正在擦除文字…', 'busy');
  try {
    const L = await localFacade();
    if (!L) throw new Error('本地引擎未就绪，请刷新页面重试');
    const fd = new FormData();
    fd.append('file', CUR.file, CUR.name);
    fd.append('rects', JSON.stringify(rects));
    fd.append('method', 'auto');
    const res = await L.handle('/api/text/erase', fd);
    if (!res || !res.image) throw new Error('本地引擎未提供擦除能力，请刷新页面重试');
    MASK.eraseImg = await loadImgEl(res.image);
    MASK.eraseSig = sig;
    MASK.probeCv = null;                        // 换了结果图，取像素用的画布作废
    const peaks = res.peaks || [];
    const solids = res.solids || [];
    MASK.leftovers = res.leftovers || [];       // 自检与调试用
    MASK.peaks = peaks;
    MASK.levels = res.levels || [];
    MASK.inks = res.inks || [];
    MASK.masks = res.masks || [];
    MASK.resids = res.resids || [];
    MASK.methods = res.methods || [];
    // 擦完还有残留就直说 —— 抹字留了残影而用户以为盖好了，比不盖更糟。
    // 两把尺子分开用：纯色底看"最大离背景偏移"（擦净 0~3，一道灰痕就上几十）；
    // 有纹理的底子那个数没有判别力，回退看灰度标准差（擦净 < 2）。
    const badSolid = peaks.filter((v, i) => solids[i] && typeof v === 'number' && v > 16).length;
    const badTexture = (res.leftovers || [])
      .filter((v, i) => !solids[i] && v > 8).length;
    const bad = badSolid + badTexture;
    MASK.worst = peaks.reduce(
      (m, v) => (typeof v === 'number' && v > m ? v : m), 0);
    setStatus(ELS.status,
      bad ? `有 ${bad} 处没擦净，这类内容建议改用色块` : '',
      bad ? 'err' : '');
    updateMaskStats();
    paintMasks();
  } catch (err) {
    setStatus(ELS.status, `擦除失败：${String((err && err.message) || err)}`, 'err');
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

/** 抹字结果与它那堆诊断量一起清掉（命中变了、图换了都必须重算） */
function clearErase() {
  MASK.eraseImg = null;
  MASK.eraseSig = '';
  MASK.probeCv = null;
  MASK.leftovers = [];
  MASK.peaks = [];
  MASK.worst = 0;
  MASK.levels = []; MASK.inks = []; MASK.masks = []; MASK.resids = []; MASK.methods = [];
}

/** 换图时清空打码状态 —— 图换了，命中项与抹字结果都作废 */
function resetMask() {
  MASK.imgW = 0; MASK.imgH = 0;
  MASK.meta = '';
  MASK.lines = null;
  MASK.hits = [];
  clearErase();
  renderHits();
  updateMaskStats();
}

async function runMask(file) {
  if (!file || MASK.busy || !CUR.file) return;

  MASK.busy = true;
  MASK.imgW = 0; MASK.imgH = 0;
  MASK.meta = '';
  MASK.lines = null;
  MASK.hits = [];
  clearErase();
  renderHits();
  updateMaskStats();
  setStatus(ELS.status, '正在识别…', 'busy');

  try {
    const res = await detectOnce(file, (m) => setStatusFor('mask', m, 'busy'));
    const m = await loadExtract();
    MASK.imgW = res.width || 0;
    MASK.imgH = res.height || 0;
    MASK.lines = m.buildLines(res.items);
    MASK.meta = `${res.width}×${res.height}`
      + (res.elapsed_ms != null ? ` · 识别 ${res.elapsed_ms}ms` : '');

    renderRules();
    rematch();                       // 重算命中并重画（内部对非前台模式会跳过绘制）
    if (S.mode === 'mask') {
      paintMeta();
      setStatus(ELS.status, '');
    }
  } catch (err) {
    const msg = String((err && err.message) || err);
    const waiting = window.WBLocal && !window.WBLocal.ready && !window.WBLocal.error;
    setStatusFor('mask', waiting ? `本地引擎准备中… ${msg}` : `识别失败：${msg}`, 'err');
  } finally {
    MASK.busy = false;
  }
}

/* ------------------------------------------------------------ 手动框选 */

function wireMarquee() {
  const box = $('twImgBox');
  const img = $('twImg');
  const mq = $('twMarquee');
  if (!box || !img || !mq) return;
  let sx = 0, sy = 0, drawing = false;

  const toImg = (e, r) => ({
    x: Math.max(0, Math.min(MASK.imgW, (e.clientX - r.left) * (MASK.imgW / r.width))),
    y: Math.max(0, Math.min(MASK.imgH, (e.clientY - r.top) * (MASK.imgH / r.height))),
  });

  box.addEventListener('pointerdown', (e) => {
    // 画布是三个模式共用的，只有打码模式才认这个拖拽框选
    if (S.mode !== 'mask') return;
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
  const img = $('twImg');
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
  if (!blob) { setStatus(ELS.status, '导出失败：浏览器不支持该格式', 'err'); return; }
  // canvas 重新编码 → 天然不带 EXIF（GPS / 机型等原始元信息不会跟着出去）
  saveBlob(blob, `${baseName(CUR.name)}-已遮盖.${fmt}`);
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

/** 打码面板上的控件（选图 / 拖拽那一层已由 wireStage 统一接管） */
function wireMaskMode() {
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

/* ==================================================================== */
/* 第 3 期 · 翻译                                                        */
/* ----------------------------------------------------------------------
   与取文字 / 打码最大的不同：这一步**必须拿样式**，因为译文要按原样式画回去。
   所以走 /api/analyze（detect + 样式分析 + 建会话），而不是 /api/text/detect。

   重绘这一层**一行新代码都没有**：译文写进 edit.text，交给现有的 applyEdits()
   —— 擦除、字体匹配、描边校准、过宽缩字号（editParams 里的 auto_fit /
   font_scale）全是改字视图在用的同一套。这也是当初把翻译排在第三期的原因。
   ==================================================================== */

const TR = {
  imgW: 0, imgH: 0,
  meta: '',             // 文件名旁那行（尺寸 + 识别耗时）
  sessionId: '',
  items: null,          // /api/analyze 的结果（含 style，重绘要用）
  pairs: [],            // [{ id, src, dst, on, fitted, warn, applied }]
  from: 'zh', to: 'en',
  autoFit: true,
  view: 'source',       // source | result
  outUrl: '',           // 重绘结果（data URL）
  busy: false,
  elapsed: null,
  model: '',
  serverReady: null,    // /api/text/status 的结论：null 还没探、false 明确不可用
  serverMsg: '',
};

/* ------------------------------------------------------------ 展示 */

/** 原图 / 译文图切换：两张图尺寸必然一致，直接换 src 最省事 */
function switchTrView(v) {
  const img = $('twImg');
  if (!TR.outUrl) v = 'source';
  TR.view = v;
  const host = $('twView');
  if (host) host.querySelectorAll('.tw-tbtn').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  if (!img || !CUR.url) return;
  // 重绘是异步的，跑完时用户可能已经切到取文字 / 打码了 —— 那时候画布上
  // 必须是原图（共用画布之后，译文图绝不能漏到别的模式里去）。
  const want = (v === 'result' && TR.outUrl && S.mode === 'translate') ? TR.outUrl : CUR.url;
  if (img.src !== want) img.src = want;
}

function trApplied() {
  return TR.pairs.filter((p) => p.on !== false && p.applied).length;
}

function updateTrStats() {
  const el = $('trStats');
  if (!el) return;
  if (!TR.items) { el.textContent = '翻译结果'; return; }
  const bits = [`${TR.items.length} 行`];
  const done = TR.pairs.filter((p) => String(p.dst || '').trim()).length;
  if (done) bits.push(`已译 ${done}`);
  const fit = TR.pairs.filter((p) => p.fitted).length;
  if (fit) bits.push(`缩字号 ${fit}`);
  if (TR.elapsed != null) bits.push(`翻译 ${TR.elapsed}ms`);
  el.textContent = bits.join(' · ');
}

function setTrButtons() {
  const hasItems = !!(TR.items && TR.items.length);
  const n = trApplied();
  const dis = (id, v) => { const b = $(id); if (b) b.disabled = v; };
  dis('trRunBtn', !hasItems || TR.busy);
  dis('trSwapBtn', !hasItems || TR.busy);
  dis('trSavePng', n === 0);
  dis('trSaveJpg', n === 0);
  dis('trToEdit', n === 0);
  // 「译文 / 原图」只在翻译模式且有译文图时出现 —— 后台跑完重绘时用户可能
  // 已经切走了，别把这个按钮亮到别的模式的头上。
  const v = $('twView');
  if (v) v.hidden = !TR.outUrl || S.mode !== 'translate';
}

function renderTrPairs() {
  const host = $('trPairs');
  if (!host) return;
  if (!TR.pairs.length) {
    host.innerHTML = `<p class="tw-side-empty">${CUR.file
      ? '没有识别到文字。换一张更清晰的图试试（文字太小、太糊都会识别不到）'
      : '上传图片后会列出识别到的每一行，翻译后可逐行修改'}</p>`;
    return;
  }
  host.innerHTML = TR.pairs.map((p, i) => `
    <div class="tw-pair${p.on === false ? ' off' : ''}${p.fitted ? ' fitted' : ''}" data-i="${i}">
      <input type="checkbox" ${p.on === false ? '' : 'checked'} aria-label="是否翻译这一行">
      <span class="tw-pair-no">${i + 1}</span>
      <div class="tw-pair-body">
        <span class="tw-pair-src">${esc(p.src)}</span>
        <textarea class="tw-pair-dst" rows="1" spellcheck="false"
          placeholder="（未翻译）" aria-label="第 ${i + 1} 行译文">${esc(p.dst)}</textarea>
        ${p.fitted ? `<span class="tw-pair-tag">${esc(p.warn || '已缩小字号以放进原位')}</span>` : ''}
      </div>
    </div>`).join('');

  host.querySelectorAll('.tw-pair').forEach((el) => {
    const i = Number(el.dataset.i);
    const p = TR.pairs[i];
    const cb = el.querySelector('input[type="checkbox"]');
    const ta = el.querySelector('textarea');
    autosize(ta);

    // 逐字改写不重渲染（重渲染会把光标挤掉），只回写状态 + 去抖重绘
    ta.addEventListener('input', () => {
      autosize(ta);
      p.dst = ta.value;
      p.fitted = false; p.warn = '';    // 换了译文，之前的缩字号结论作废
      el.classList.remove('fitted');
      updateTrStats();
      scheduleTrApply();
    });
    ta.addEventListener('mouseenter', () => hoverTrPair(i, true));
    ta.addEventListener('mouseleave', () => hoverTrPair(i, false));

    cb.addEventListener('change', () => {
      p.on = cb.checked;
      el.classList.toggle('off', !cb.checked);
      updateTrStats();
      scheduleTrApply();
    });
  });
}

/** 悬停某一行的译文 → 高亮对应的原文（反过来也一样） */
function hoverTrPair(i, on) {
  const el = $('trPairs') && $('trPairs').querySelector(`.tw-pair[data-i="${i}"]`);
  if (el) el.classList.toggle('hover', on);
}

/**
 * 改译文后重绘的防抖。
 * apply 要走一遍擦除 + 重绘（几百 ms 量级），逐字触发会一直排队；
 * 但也不能等太久 —— 用户改完一个字就想看到画布变了。
 */
let trApplyTimer = 0;
function scheduleTrApply() {
  clearTimeout(trApplyTimer);
  trApplyTimer = setTimeout(() => {
    applyTranslation().catch((err) => {
      setStatus(ELS.status, `重绘失败：${String((err && err.message) || err)}`, 'err');
    });
  }, 650);
}

/* ------------------------------------------------------------ 翻译请求 */

/* 一次打包多少行。上游一个请求翻太多行时容易漏行 / 被截断，
   所以分批；某一批对不上行数就自动降半批重试（见 translateChunk）。 */
const TR_CHUNK = 30;
const TR_MAX_DEPTH = 3;

async function reqTranslate(texts) {
  const r = await fetch('/api/text/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts, from: TR.from, to: TR.to }),
  });
  const txt = await r.text();
  let j = null;
  try { j = txt ? JSON.parse(txt) : null; } catch (_) { /* 下面统一报可读文案 */ }
  if (!r.ok) {
    // detail 可能是对象 {message,hint}（对齐 Python 侧形状），取可读字段
    let m = j && (j.detail || j.message);
    if (m && typeof m === 'object') m = m.message || m.hint || '';
    throw new Error(m || `HTTP ${r.status}`);
  }
  if (!j || !Array.isArray(j.texts) || j.texts.length !== texts.length) {
    throw new Error('译文行数与原文对不上');
  }
  if (j.model) TR.model = j.model;
  return j.texts.map((t) => (t == null ? '' : String(t)));
}

/**
 * 翻一批，失败就劈成两半各翻一次。
 * 为什么值得这么写：行数对不上是这类调用最常见的失败（模型漏行、被截断），
 * 而"整批重来"在 30 行时几乎必然再失败一次 —— 降半批能很快落到能成功的粒度，
 * 代价只是多几次往返。
 */
async function translateChunk(texts, depth = 0) {
  try {
    return await reqTranslate(texts);
  } catch (err) {
    if (texts.length <= 1 || depth >= TR_MAX_DEPTH) throw err;
    const mid = Math.ceil(texts.length / 2);
    const a = await translateChunk(texts.slice(0, mid), depth + 1);
    const b = await translateChunk(texts.slice(mid), depth + 1);
    return [...a, ...b];
  }
}

/* ------------------------------------------------------------ 重绘 */

/** 把当前译文整理成 applyEdits 认的 edits 结构 */
function buildTrEdits() {
  const edits = {};
  for (const p of TR.pairs) {
    if (p.on === false) continue;
    const t = String(p.dst || '');
    if (!t.trim()) continue;
    // 只放 text 与 auto_fit，其余（字体 / 颜色 / 描边）一律交给引擎按原样式推断
    edits[String(p.id)] = { text: t, auto_fit: TR.autoFit };
  }
  return edits;
}

/**
 * 译文写回 → 复用 /api/apply（内部就是 applyEdits）。
 * 结果图整张换掉左侧的 <img>，所以"看到的"就是"导出的"。
 */
async function applyTranslation() {
  if (!TR.sessionId || !TR.items) return null;
  const edits = buildTrEdits();
  const ids = Object.keys(edits);
  if (!ids.length) {
    TR.outUrl = '';
    for (const p of TR.pairs) { p.applied = false; p.fitted = false; p.warn = ''; }
    switchTrView('source');
    renderTrPairs(); updateTrStats(); setTrButtons();
    return null;
  }

  const res = await callLocal('/api/apply', { session_id: TR.sessionId, edits });
  if (!res || !res.image) throw new Error('本地引擎未提供重绘能力，请刷新页面重试');

  TR.outUrl = res.image;
  const byId = new Map(((res.stats && res.stats.log) || []).map((r) => [String(r.id), r]));
  for (const p of TR.pairs) {
    const r = byId.get(String(p.id));
    p.applied = !!(r && (r.action === 'replace' || r.action === 'insert'));
    p.fitted = !!(r && r.fitted);
    p.warn = (r && r.warnings && r.warnings.length) ? String(r.warnings[0]) : '';
    if (r && r.action === 'error') { p.applied = false; p.warn = '重绘失败：' + String(r.error || '').slice(0, 80); }
  }
  switchTrView('result');
  renderTrPairs(); updateTrStats(); setTrButtons();
  return res;
}

/* ------------------------------------------------------------ 可用性探测 */

/* 数据来源：/api/text/status。服务端（Worker 或本地 Python）会回"有没有配
   text_model"。**只探一次**，且失败时静默 —— 纯静态托管下这个接口不存在，
   提示一句"翻译不可用"只会让用户以为整个页面坏了；真正的失败留给点翻译时报。 */
let trStatusChecked = false;
async function checkTrStatus() {
  if (trStatusChecked) return;
  trStatusChecked = true;
  try {
    const r = await fetch('/api/text/status');
    if (!r.ok) return;
    const j = await r.json();
    TR.serverReady = !!j.ready;
    TR.serverMsg = j.ready ? '' : [j.message, j.hint].filter(Boolean).join('　');
    // 只在"正停在翻译页签、还没选图、也不在忙"时提示 —— 否则会盖掉识别进度
    if (!j.ready && S.mode === 'translate' && !TR.busy && !CUR.file) {
      setStatus(ELS.status, `翻译暂不可用：${TR.serverMsg}`, 'err');
    }
  } catch (_) { /* 离线 / 静态托管：不打扰 */ }
}

/** 识别完把状态条恢复成空 —— 但翻译本来就用不了时，把原因继续留在那儿 */
function clearTrStatus() {
  if (TR.serverReady === false && TR.serverMsg) {
    setStatus(ELS.status, `翻译暂不可用：${TR.serverMsg}`, 'err');
    return;
  }
  setStatus(ELS.status, '');
}

/* ------------------------------------------------------------ 主流程 */

/** 换图时清空翻译状态（图换了，识别项、译文图、对照表都作废） */
function resetTr() {
  TR.imgW = 0; TR.imgH = 0;
  TR.meta = '';
  TR.sessionId = '';
  TR.items = null;
  TR.pairs = [];
  TR.outUrl = '';
  TR.elapsed = null;
  TR.view = 'source';
  const sentBox = $('trSentBox');
  if (sentBox) { sentBox.hidden = true; sentBox.open = false; }
  renderTrPairs(); updateTrStats(); setTrButtons();
}

async function runTrAnalyze(file) {
  if (!file || TR.busy || !CUR.file) return;

  TR.busy = true;
  TR.imgW = 0; TR.imgH = 0;
  TR.meta = '';
  TR.sessionId = '';
  TR.items = null;
  TR.pairs = [];
  TR.outUrl = '';
  TR.elapsed = null;
  const sentBox = $('trSentBox');
  if (sentBox) { sentBox.hidden = true; sentBox.open = false; }
  renderTrPairs(); updateTrStats(); setTrButtons();
  setStatus(ELS.status, '正在识别…', 'busy');

  try {
    // 走 /api/analyze（而不是取文字用的 /api/text/detect）：翻译要按原样式重绘，
    // 必须拿字体 / 颜色 / 描边 / 字号，同时它会建会话给后面的 /api/apply 用。
    const fd = new FormData();
    fd.append('file', file, CUR.name);
    fd.append('merge_lines', 'true');
    const res = await callLocal('/api/analyze', fd, (m) => setStatusFor('translate', m, 'busy'));
    if (!res || !res.session_id) throw new Error('本地引擎未提供识别能力，请刷新页面重试');

    TR.sessionId = res.session_id;
    TR.items = res.items || [];
    TR.imgW = res.width || 0;
    TR.imgH = res.height || 0;
    TR.pairs = TR.items.map((it) => ({
      id: it.id, src: it.text || '', dst: '', on: true, fitted: false, warn: '', applied: false,
    }));
    TR.meta = `${res.width}×${res.height}`
      + (res.elapsed_ms != null ? ` · 识别 ${res.elapsed_ms}ms` : '');

    renderTrPairs(); updateTrStats(); setTrButtons();
    if (S.mode === 'translate') {
      paintMeta();
      if (TR.items.length) clearTrStatus();
      else setStatus(ELS.status, '没有识别到文字', 'err');
    }
  } catch (err) {
    const msg = String((err && err.message) || err);
    const waiting = window.WBLocal && !window.WBLocal.ready && !window.WBLocal.error;
    setStatusFor('translate', waiting ? `本地引擎准备中… ${msg}` : `识别失败：${msg}`, 'err');
  } finally {
    TR.busy = false;
    setTrButtons();
  }
}

async function runTranslate() {
  if (TR.busy || !TR.items) return;
  const targets = TR.pairs.filter((p) => p.on !== false && String(p.src || '').trim());
  if (!targets.length) { setStatus(ELS.status, '没有需要翻译的文字', 'err'); return; }

  TR.busy = true;
  setTrButtons();
  const t0 = performance.now();
  const sent = [];
  try {
    for (let i = 0; i < targets.length; i += TR_CHUNK) {
      const slice = targets.slice(i, i + TR_CHUNK);
      setStatus(ELS.status,
        `正在翻译… ${i} / ${targets.length}（首批要连上游，稍慢）`, 'busy');
      const out = await translateChunk(slice.map((p) => p.src));
      slice.forEach((p, k) => { p.dst = out[k]; });
      sent.push(...slice.map((p) => p.src));
    }
    TR.elapsed = Math.round(performance.now() - t0);

    // 把**实际发出去的文字**亮出来（沿用改字视图的先例：不藏着）
    const box = $('trSentBox');
    const pre = $('trSent');
    if (box && pre) {
      pre.textContent = sent.map((t, i) => `${i + 1}. ${t}`).join('\n');
      box.hidden = false;
    }

    setStatus(ELS.status, '正在按原样式重绘…', 'busy');
    await applyTranslation();
    setStatus(ELS.status, '');
  } catch (err) {
    setStatus(ELS.status, `翻译失败：${String((err && err.message) || err)}`, 'err');
  } finally {
    TR.busy = false;
    renderTrPairs(); updateTrStats(); setTrButtons();
  }
}

/** 交换方向：清掉已有译文并按新方向重翻 —— 比"让用户自己再点一次"顺手 */
async function swapTrLangs() {
  const a = TR.from; TR.from = TR.to; TR.to = a;
  const f = $('trFrom'), t = $('trTo');
  if (f) f.value = TR.from;
  if (t) t.value = TR.to;
  for (const p of TR.pairs) { p.dst = ''; p.fitted = false; p.warn = ''; p.applied = false; }
  TR.outUrl = '';
  switchTrView('source');
  renderTrPairs(); updateTrStats(); setTrButtons();
  if (TR.items && TR.items.length) await runTranslate();
}

/* ------------------------------------------------------------ 导出 / 交接 */

async function exportTr(fmt) {
  if (!TR.outUrl) return;
  const img = await loadImgEl(TR.outUrl);
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  const ctx = cv.getContext('2d');
  if (fmt === 'jpg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); }
  ctx.drawImage(img, 0, 0);
  const mime = fmt === 'jpg' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise((res) => cv.toBlob(res, mime, 0.92));
  if (!blob) { setStatus(ELS.status, '导出失败：浏览器不支持该格式', 'err'); return; }
  saveBlob(blob, `${baseName(CUR.name)}-译文.${fmt}`);
}

/**
 * 把这张图与译文交给「无痕改字」继续精修。
 *
 * 走的是 app.js 已有的本机工作区（workspace.js 的 TextWS）：把原图字节 +
 * 会话 id + items + edits 落盘，再切视图并让它重读一次。
 * 之所以能这么省事：识别用的是同一个会话，item id 天然对得上，
 * remapEdits 那层兜底都不需要用上。
 */
async function sendToEdit() {
  const edits = buildTrEdits();
  if (!CUR.file || !TR.items || !Object.keys(edits).length) return;
  if (!window.TextWS) { setStatus(ELS.status, '本机存储不可用，无法交接', 'err'); return; }
  try {
    setStatus(ELS.status, '正在交接给「无痕改字」…', 'busy');
    const buf = await CUR.file.arrayBuffer();
    await TextWS.saveImage(buf, CUR.file.type || 'image/png', CUR.name);
    await TextWS.saveState({
      sessionId: TR.sessionId,
      fileName: CUR.name,
      backend: 'browser-wasm',
      items: TR.items,
      edits,
    });
    setStatus(ELS.status, '');
    // 先切视图再让它重读 —— 顺序反过来的话，restoreWorkspace 会把状态条
    // 写到改字视图上，而那时改字视图还没显示出来。
    if (window.WBEdit) {
      if (window.WBEdit.show) window.WBEdit.show();
      if (window.WBEdit.reload) await window.WBEdit.reload();
    }
  } catch (err) {
    setStatus(ELS.status, `交接失败：${String((err && err.message) || err)}`, 'err');
  }
}

/** 翻译面板上的控件（选图 / 拖拽那一层已由 wireStage 统一接管） */
function wireTranslateMode() {
  const run = $('trRunBtn');
  if (run) run.addEventListener('click', () => runTranslate());
  const sw = $('trSwapBtn');
  if (sw) sw.addEventListener('click', () => swapTrLangs());

  const f = $('trFrom'), t = $('trTo');
  if (f) f.addEventListener('change', () => { TR.from = f.value; });
  if (t) t.addEventListener('change', () => { TR.to = t.value; });
  const fit = $('trAutoFit');
  if (fit) fit.addEventListener('change', () => {
    TR.autoFit = fit.checked;
    if (TR.outUrl) scheduleTrApply();
  });

  const vh = $('twView');
  if (vh) vh.querySelectorAll('.tw-tbtn').forEach((b) => {
    b.addEventListener('click', () => switchTrView(b.dataset.v));
  });

  const png = $('trSavePng');
  if (png) png.addEventListener('click', () => exportTr('png'));
  const jpg = $('trSaveJpg');
  if (jpg) jpg.addEventListener('click', () => exportTr('jpg'));

  const te = $('trToEdit');
  if (te) te.addEventListener('click', () => sendToEdit());
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
  get translate() { return TR; },
  text() { return COPY.result ? COPY.result.text : ''; },
  markdown() { return COPY.result ? COPY.result.markdown : ''; },
  lines() { return COPY.result ? COPY.result.lines.map((l) => l.text) : []; },
  // 翻译用：当前译文图是不是已经生成、逐行对照的数据是什么（自检与调试用）
  trPairs() { return TR.pairs.map((p) => ({ id: p.id, src: p.src, dst: p.dst, on: p.on, fitted: p.fitted })); },
  trEdits() { return buildTrEdits(); },
  runTranslate() { return runTranslate(); },
  // 自检用：直接读遮盖层像素，判断"某一处到底盖住没有"
  maskPixel(x, y) {
    const cv = $('twMaskCv'), img = $('twImg');
    if (!cv || !img || !img.naturalWidth) return null;
    const k = cv.width / img.naturalWidth;
    const d = cv.getContext('2d').getImageData(
      Math.round(x * k), Math.round(y * k), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  },
  /**
   * 自检用：读**抹字结果图**任意区域的灰度极值。
   * 不走遮盖层 —— 那里除命中框之外是透明的，量"框外有没有被碰"会量到假值。
   */
  eraseBox(x, y, w, h) {
    const im = MASK.eraseImg;
    if (!im || !im.naturalWidth) return null;
    if (!MASK.probeCv) {
      const c = document.createElement('canvas');
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0);
      MASK.probeCv = c;
    }
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const w0 = Math.max(1, Math.min(Math.round(w), im.naturalWidth - x0));
    const h0 = Math.max(1, Math.min(Math.round(h), im.naturalHeight - y0));
    const d = MASK.probeCv.getContext('2d').getImageData(x0, y0, w0, h0).data;
    let lo = 255, hi = 0, at = null;
    for (let i = 0; i < d.length; i += 4) {
      const g = (0.114 * d[i] + 0.587 * d[i + 1] + 0.299 * d[i + 2]) | 0;
      if (g < lo) { lo = g; at = [x0 + (i / 4) % w0, y0 + Math.floor((i / 4) / w0)]; }
      if (g > hi) hi = g;
    }
    return { min: lo, max: hi, at };
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
  // 深链直接落在翻译模式时也要探一次（这条路不走 setMode）
  if (initial === 'translate') checkTrStatus();
  wireStage();                        // 三模式共用的选图 / 拖拽 / 缩放，只挂一次
  wireCopyMode();
  wireMaskMode();
  wireTranslateMode();
  // 语言方向与开关的初值以 DOM 为准（HTML 里写的就是默认值），
  // 免得 JS 里再写一份默认值、两处迟早对不上。
  if ($('trFrom')) TR.from = $('trFrom').value;
  if ($('trTo')) TR.to = $('trTo').value;
  if ($('trAutoFit')) TR.autoFit = $('trAutoFit').checked;
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
