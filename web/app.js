/* ==========================================================================
   图片文字处理工具 · 前端交互
   画布分层：imgLayer（图像 + 预览补丁） / boxLayer（识别框叠加层）
   ========================================================================== */
(() => {
'use strict';

const $  = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- 视图路由 */
/**
 * 本页现在是"无痕改字 + 图像生成"的双视图单页：
 *   #edit（默认）→ 改字视图      其余 hash（#create/#combine/#projects…）→ 生成视图
 *
 * 以前是 / → /image 两次独立加载，每次切回改字都要重新初始化本地引擎（实测 5.77s）。
 * 合并到一页后，引擎只初始化一次，切换只换显隐，实测接近瞬时。
 */

/** 生成视图的 hash 集合（与 image.js 的 TOOLS id 对应） */
const IMAGE_KEYS = new Set(['create', 'combine', 'portrait', 'product', 'projects']);

function currentViewKey() {
  const h = location.hash.replace(/^#/, '');
  if (h && IMAGE_KEYS.has(h)) return h;
  return 'edit';
}

/**
 * 生成视图请求切到某个工具时的回调（由 image.js 在嵌入模式下调用）。
 *
 * 为什么需要它：从「空 hash 的首页」点侧边栏「自由生成」时，
 * 目标地址 /#create 与当前 / 相比只有 hash 变化，而 hashchange 在
 * 「空 hash → 有 hash」这一步上并不总会派发（实测某些时序下收不到），
 * 结果点了没反应。所以让 image.js 直接喊一声，外层立刻切视图，
 * 不依赖 hashchange 事件。
 */
window.WBShowImages = function (key) {
  imagesReady = true;
  const boxImages = $('viewImages');
  const boxEdit = $('viewEdit');
  if (!boxImages || !boxEdit) return;
  boxImages.hidden = false;
  boxImages.classList.add('on');
  boxEdit.hidden = true;
  boxEdit.classList.remove('on');
  document.body.classList.add('mode-images');
  // 把 hash 补上（这样刷新/分享能回到同一视图），但不再回喊 image.js，避免绕圈
  const want = '#' + (key || 'create');
  if (location.hash !== want) history.replaceState(null, '', want);
  if (window.WBShell) WBShell.syncActive();
};

/** 外层只负责显示哪个视图；生成视图内部显示什么由 image.js 按自己的状态决定 */
function applyViewRoute() {
  const key = currentViewKey();
  const toImages = key !== 'edit';
  const boxImages = $('viewImages');
  const boxEdit = $('viewEdit');
  if (!boxImages || !boxEdit) return;

  // 生成视图就绪前不切过去 —— 否则会闪一个空壳
  if (toImages && !imagesReady) {
    window.__pendingView = key;
    return;
  }

  boxImages.hidden = !toImages;
  boxImages.classList.toggle('on', toImages);
  boxEdit.hidden = toImages;
  boxEdit.classList.toggle('on', !toImages);
  document.body.classList.toggle('mode-images', toImages);

  if (toImages && window.WBImage && window.WBImage.showKey) {
    window.WBImage.showKey(key);
  }
  if (window.WBShell) WBShell.syncActive();
}

let imagesReady = false;
window.addEventListener('hashchange', applyViewRoute);
window.addEventListener('wb-images-ready', () => {
  imagesReady = true;
  const want = window.__pendingView;
  window.__pendingView = null;
  applyViewRoute();
  if (want && window.WBImage && window.WBImage.showKey) window.WBImage.showKey(want);
});

/* 浏览器本地引擎优先：改字全流程（识别→样式→擦除→重绘）都在本地跑，
   模型与算力都来自浏览器缓存，服务端不再参与。
   本地不可用（引擎起不来、或该接口本地没实现）时，自动回落到服务端接口 —— 
   两种部署形态（纯静态 / 带 Python 后端）共用同一份前端。 */

/**
 * 把本地引擎的进度接到状态栏。
 *
 * 没有这个，首次进页面会先静默下载 39MB 模型（几十秒到几分钟），
 * 状态栏一直停在"等待上传图片" —— 用户只会以为页面卡死了。
 */
const wireLocalProgress = (L) => {
  if (!L || L._progressWired) return L;
  L._progressWired = true;
  L.progress = (p) => {
    if (!p || !p.label) return;
    const pct = p.phase === 'download' && p.total
      ? ` ${Math.round((p.done / p.total) * 100)}%` : '';
    const once = p.phase === 'download' ? '（仅首次，之后从本机缓存读取）' : '';
    status(`本地引擎：${p.label}${pct}`, 'busy', once);
  };
  return L;
};

/**
 * 取本地引擎门面。
 *
 * ⚠️ 这里必须等一会儿：boot.js 是 <script type="module">（延迟执行），
 * 而本文件是普通脚本，会**先于**它执行。不等的话 window.WBLocal 还是 undefined，
 * 于是所有接口都被判成"本地不处理"，一股脑发到服务端 —— 在只有静态托管的
 * Cloudflare 版上就是一堆 404（表现为"无法连接后端服务 · HTTP 404"）。
 */
const localFacade = async (timeout = 20000) => {
  if (!window.WBLocal) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      await new Promise((r) => setTimeout(r, 50));
      if (window.WBLocal) break;
    }
  }
  return wireLocalProgress(window.WBLocal);
};

const api = async (url, body, isForm = false) => {
  const L = await localFacade();
  if (L) {
    try {
      const local = await L.handle(url, body);
      if (local !== undefined) return local;
    } catch (err) {
      if (L.ready) throw err;                 // 引擎已就绪仍失败 → 真错误，别掩盖
      console.warn('[WB-PS] 本地引擎不可用，回退到服务端：', err);
    }
  }

  const opt = { method: 'POST' };
  if (isForm) opt.body = body;
  else { opt.headers = { 'Content-Type': 'application/json' }; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const j = await r.json();
      // detail 可能是字符串（无痕改字）也可能是对象 {message,hint}（图像生成），
      // 一律取出可读文案，避免把对象塞进 Error 里显示成 [object Object]
      let d = j.detail || j.message;
      if (d && typeof d === 'object') d = d.message || d.hint || '';
      msg = d || msg;
    } catch (_) {}
    throw new Error(msg);
  }
  return readJson(r);
};

/* GET 版，同样本地引擎优先。
   早先这里几处直接写了裸 fetch，结果 CF 版（没有 Python 后端）一进页面就报
   「无法连接后端服务」—— 请求打到 Worker 上没有对应路由，拿回一个空体，
   r.json() 抛 "Unexpected end of JSON input"。现在统一走这条路径，
   并且把空体/非 JSON 变成人能看懂的话。 */
const apiGet = async (url) => {
  const L = await localFacade();
  if (L) {
    try {
      const local = await L.handle(url, null);
      if (local !== undefined) return local;
    } catch (err) {
      if (L.ready) throw err;
      console.warn('[WB-PS] 本地引擎不可用，回退到服务端：', err);
    }
  }
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return readJson(r);
};

/** 空体/非 JSON 都要说人话，而不是把解析器的报错直接甩给用户 */
async function readJson(r) {
  const txt = await r.text();
  if (!txt) throw new Error('服务端返回了空响应');
  try {
    return JSON.parse(txt);
  } catch (_) {
    throw new Error(`服务端返回的不是 JSON：${txt.slice(0, 120)}`);
  }
}

/* ---------------------------------------------------------------- 状态 */
const S = {
  sessionId: null,
  fileName: null,        // 原图文件名（断点续做时要还原）
  file: null,
  img: null,             // 原始 HTMLImageElement
  W: 0, H: 0,
  items: [],
  edits: {},             // { id: editObject }
  sel: null,
  scale: 1, panX: 0, panY: 0,
  showBoxes: true,
  compare: false,
  picking: false,
  spaceDown: false,
  resultMode: false,
  applied: {},           // { id: [x,y,w,h] } 已贴补丁的区域
  fonts: [],
  backend: '',
  dirty: false,
};

const imgLayer = $('imgLayer'), boxLayer = $('boxLayer');
const ictx = imgLayer.getContext('2d', { willReadFrequently: true });
const bctx = boxLayer.getContext('2d');

/* ---------------------------------------------------------------- 工具 */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rgb2hex = (c) => '#' + [0, 1, 2].map(i =>
  clamp(Math.round(c[i] ?? 0), 0, 255).toString(16).padStart(2, '0')).join('');
const hex2rgb = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

function status(text, kind = '', meta = '') {
  $('statusText').textContent = text;
  $('statusDot').className = 'dot ' + kind;
  $('statusMeta').innerHTML = meta;
}
function foot(left, right) {
  if (left !== undefined) $('footLeft').textContent = left;
  if (right !== undefined) $('footRight').textContent = right;
}
/* 显示/隐藏控制。
   不能只依赖 element.hidden：组件自带的 display 声明（如 .loading{display:grid}）
   优先级高于浏览器默认的 [hidden]{display:none}，会让 hidden 失效。
   这里同时写 inline style 兜底，保证任何情况下都能真正藏住。 */
function show(el, on) {
  if (!el) return;
  el.hidden = !on;
  el.style.display = on ? '' : 'none';
}
function busy(on, text) {
  if (on && text) $('loadingText').textContent = text;
  show($('loading'), !!on);
}
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ---------------------------------------------------------------- 视图 */
function fitView() {
  const vp = $('viewport');
  const vw = vp.clientWidth, vh = vp.clientHeight, pad = 48;
  if (!S.W || !S.H) return;
  S.scale = clamp(Math.min((vw - pad) / S.W, (vh - pad) / S.H), 0.02, 1);
  S.panX = (vw - S.W * S.scale) / 2;
  S.panY = (vh - S.H * S.scale) / 2;
  applyView();
}
function applyView() {
  $('scene').style.transform =
    `translate(${S.panX}px, ${S.panY}px) scale(${S.scale})`;
  $('zoomLabel').textContent = Math.round(S.scale * 100) + '%';
}
function zoomAt(cx, cy, factor) {
  const ns = clamp(S.scale * factor, 0.03, 8);
  const k = ns / S.scale;
  S.panX = cx - (cx - S.panX) * k;
  S.panY = cy - (cy - S.panY) * k;
  S.scale = ns;
  applyView();
}
const toImg = (clientX, clientY) => {
  const r = $('viewport').getBoundingClientRect();
  return {
    x: (clientX - r.left - S.panX) / S.scale,
    y: (clientY - r.top - S.panY) / S.scale,
  };
};

/* ---------------------------------------------------------------- 绘制 */
function paintBase() {
  ictx.clearRect(0, 0, S.W, S.H);
  ictx.drawImage(S.img, 0, 0, S.W, S.H);
}
function restoreRegion(region) {
  if (!region) return;
  ictx.clearRect(region[0], region[1], region[2], region[3]);
  ictx.drawImage(S.img, region[0], region[1], region[2], region[3],
                 region[0], region[1], region[2], region[3]);
}
function pastePatch(region, dataURL) {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => {
      ictx.clearRect(region[0], region[1], region[2], region[3]);
      ictx.drawImage(im, region[0], region[1], region[2], region[3]);
      res();
    };
    im.src = dataURL;
  });
}

function itemColor(it) {
  const e = S.edits[it.id];
  if (e && isChanged(it.id)) return '#fbbf24';
  return 'rgba(96,165,250,.85)';
}
function isChanged(id) {
  const e = S.edits[id];
  if (!e) return false;
  if (e.text !== undefined) return true;
  for (const k of ['family', 'fg_color', 'bold', 'italic', 'align', 'letter_spacing',
                   'offset_x', 'offset_y', 'font_scale', 'erase_method', 'weight_bias']) {
    // 字号 100% 与"自动"等价：滑块拖回 100 时不该把这项算成改动
    if (k === 'font_scale' && e[k] === 1) continue;
    if (e[k] !== undefined && e[k] !== null && e[k] !== 0 && e[k] !== '' &&
        e[k] !== false && e[k] !== 'auto') return true;
  }
  return false;
}

/** 粗细微调档位 → 显示文案。0 档代表"自动"，不做任何额外处理。 */
function weightLabel(step) {
  const v = Number(step) || 0;
  if (!v) return '自动';
  return (v > 0 ? '+' : '') + v + ' 档';
}

function paintBoxes() {
  bctx.clearRect(0, 0, S.W, S.H);
  if (!S.showBoxes || S.resultMode || S.compare) return;
  const lw = Math.max(1, 1.4 / S.scale);
  S.items.forEach((it) => {
    const r = it.rect;
    const sel = S.sel === it.id;
    bctx.lineWidth = sel ? lw * 2 : lw;
    bctx.strokeStyle = sel ? '#60a5fa' : itemColor(it);
    bctx.setLineDash(sel ? [] : [5 / S.scale, 3 / S.scale]);
    bctx.strokeRect(r.x + .5, r.y + .5, r.w - 1, r.h - 1);
    bctx.setLineDash([]);

    if (sel) {
      bctx.fillStyle = 'rgba(59,130,246,.1)';
      bctx.fillRect(r.x, r.y, r.w, r.h);
      const s = 4 / S.scale;
      bctx.fillStyle = '#60a5fa';
      [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]
        .forEach(([x, y]) => bctx.fillRect(x - s, y - s, s * 2, s * 2));
    }
    // 序号
    const fs = clamp(11 / S.scale, 8, 40);
    bctx.font = `600 ${fs}px system-ui, sans-serif`;
    const label = String(it.id + 1);
    const tw = bctx.measureText(label).width;
    bctx.fillStyle = sel ? 'rgba(59,130,246,.95)' : 'rgba(30,34,41,.82)';
    bctx.fillRect(r.x, Math.max(0, r.y - fs * 1.5), tw + fs * .7, fs * 1.35);
    bctx.fillStyle = sel ? '#fff' : '#a4adbb';
    bctx.fillText(label, r.x + fs * .35, Math.max(fs, r.y - fs * .45));
  });
}

/* ---------------------------------------------------------------- 列表 */
function renderList() {
  const box = $('itemList');
  const kw = $('searchInput').value.trim().toLowerCase();
  const only = $('chkOnlyEdited').checked;
  let list = S.items;
  if (kw) list = list.filter(it => (it.text + (S.edits[it.id]?.text || '')).toLowerCase().includes(kw));
  if (only) list = list.filter(it => isChanged(it.id));

  $('countBadge').textContent = S.items.length;

  if (!list.length) {
    box.innerHTML = `<div class="list-empty">${S.items.length ? '没有匹配项' : '暂无识别结果'}</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  list.forEach((it) => {
    const e = S.edits[it.id] || {};
    const changed = isChanged(it.id);
    const now = e.text !== undefined ? e.text : it.text;
    const st = it.style || {};
    const el = document.createElement('div');
    el.className = 'item' + (S.sel === it.id ? ' sel' : '') + (changed ? ' changed' : '');
    el.dataset.id = it.id;
    el.innerHTML = `
      <div class="item-no">${it.id + 1}</div>
      <div class="item-body">
        <div class="item-text">${changed
          ? `<em>${esc(now || '（已擦除）')}</em>`
          : esc(it.text)}</div>
        <div class="item-meta">
          <span class="tag"><i class="swatch" style="background:${rgb2hex(st.fg_color || [0,0,0])}"></i></span>
          <span>${(e.family || st.font_size || 0)}px</span>
          <span>${esc((e.align || st.align || 'left'))}</span>
          ${st.bold ? '<span>粗</span>' : ''}
          <span>${it.rect.w}×${it.rect.h}</span>
          <span>${Math.round(it.score * 100)}%</span>
        </div>
      </div>`;
    el.onclick = () => select(it.id);
    frag.appendChild(el);
  });
  box.innerHTML = '';
  box.appendChild(frag);
}

function scrollToItem(id) {
  const el = $('itemList').querySelector(`.item[data-id="${id}"]`);
  if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ---------------------------------------------------------------- 选择 */
function select(id) {
  S.sel = id;
  const it = S.items.find(i => i.id === id);
  const card = $('editorCard');
  if (!it) { show(card, false); paintBoxes(); renderList(); return; }

  show(card, true);
  $('editIndex').textContent = `#${id + 1}`;
  $('origText').textContent = it.text || '（空）';

  loadEditor(it);
  paintBoxes();
  renderList();
  scrollToItem(id);
}

function loadEditor(it) {
  const e = S.edits[it.id] || {};
  const st = it.style || {};
  const txt = e.text !== undefined ? e.text : it.text;

  $('inpText').value = txt;
  $('charCount').textContent = txt.length + ' 字';
  $('inpColor').value = rgb2hex(e.fg_color || st.fg_color || [0, 0, 0]);

  const scalePct = Math.round((e.font_scale || 1) * 100);
  $('rngSize').value = scalePct;
  $('vSize').textContent = e.font_scale ? scalePct + '%' : '自动';

  const bold = e.bold !== undefined ? e.bold : !!st.bold;
  const italic = !!e.italic;
  $('chipBold').classList.toggle('on', bold);
  $('chipItalic').classList.toggle('on', italic);

  // 粗细微调：0 = 自动（沿用原图笔画反推），非 0 才在渲染时叠加偏移
  const wb = Number(e.weight_bias) || 0;
  $('rngWeight').value = wb;
  $('vWeight').textContent = weightLabel(wb);

  const align = e.align || st.align || 'left';
  [...$('segAlign').children].forEach(b => b.classList.toggle('on', b.dataset.v === align));

  const valign = e.valign || 'bottom';
  [...$('segVAlign').children].forEach(b => b.classList.toggle('on', b.dataset.v === valign));

  $('selErase').value = e.erase_method || 'auto';
  $('vOffset').textContent = `${e.offset_x || 0}, ${e.offset_y || 0}`;
  $('chkAutoFit').checked = e.auto_fit === true;
  $('chkMatchSharp').checked = e.match_sharpness !== false;
  $('chkAutoFamily').checked = e.auto_family !== false;
  $('chkMatchStroke').checked = e.match_stroke !== false;
  $('fontHint').textContent = '';

  // 字体下拉：首项为「自动匹配」，选中它会交给本地引擎按字形挑字体。
  // 清单可能有几百项（扫过本机字体之后），所以按来源分组 + 支持搜索。
  rebuildFontSelect();

  const w = $('warnBox');
  const warns = (e._warnings || []);
  show(w, !!warns.length);
  w.innerHTML = warns.map(esc).join('<br>');
}

/* ---------------------------------------------------------------- 编辑写入 */
function setEdit(id, patch) {
  const e = S.edits[id] || (S.edits[id] = {});
  Object.assign(e, patch);
  if (!isChanged(id)) delete S.edits[id];
  schedulePreview(id);
  renderList();
  persistSoon();
}

const schedulePreview = debounce(async (id) => {
  try { await previewItem(id); } catch (err) { foot('预览失败：' + err.message); }
}, 260);

// 预览请求序号：并发返回时只应用最新一次结果，避免旧补丁覆盖新补丁
let previewSeq = 0;

async function previewItem(id) {
  const it = S.items.find(i => i.id === id);
  if (!it || !S.sessionId) return;
  const seq = ++previewSeq;

  // 先还原上一轮补丁，避免残留
  if (S.applied[id]) { restoreRegion(S.applied[id]); delete S.applied[id]; }

  const edit = { ...(S.edits[id] || {}) };
  delete edit._warnings;
  if (edit.text === undefined) edit.text = it.text;

  // 无任何改动 → 保持原样
  if (!isChanged(id)) { paintBoxes(); return; }

  const res = await api('/api/preview', { session_id: S.sessionId, id, edit });
  if (seq !== previewSeq) return;             // 已有更新的请求，丢弃本次结果
  if (res.region) {
    await pastePatch(res.region, res.patch);
    S.applied[id] = res.region;
  }
  if (res.info) {
    S.edits[id] = S.edits[id] || {};
    if (res.info.warnings?.length) S.edits[id]._warnings = res.info.warnings;
    else delete S.edits[id]._warnings;
    if (S.sel === id) {
      show($('warnBox'), !!res.info.warnings?.length);
      $('warnBox').innerHTML = (res.info.warnings || []).map(esc).join('<br>');
      if (res.info.font_size) {
        $('vSize').textContent = (S.edits[id].font_scale ? Math.round(S.edits[id].font_scale * 100) + '%' : '自动')
          + ` · ${res.info.font_size}px`;
      }
      // 字体匹配与笔画校准的反馈
      const mi = res.info.matched || {};
      const si = res.info.stroke || {};
      const bits = [];
      if (mi.stage === 'shape' && mi.iou !== undefined) bits.push(`字形相似度 ${Math.round(mi.iou * 100)}%`);
      else if (mi.stage === 'metrics') bits.push('已按字形比例匹配');
      if (res.info.family && mi.stage) bits.push(res.info.family);
      if (si.target) bits.push(`笔画 ${si.rendered}→${si.target}px`);
      const wb = Number(S.edits[id]?.weight_bias) || 0;
      if (wb) bits.push(`粗细 ${weightLabel(wb)}`);
      $('fontHint').textContent = bits.join(' · ');
    }
  }
  paintBoxes();
  S.dirty = true;
  updateDirty();
  persistNow();                 // 一轮编辑结束，立即落盘，切页不丢
}

function updateDirty() {
  const n = S.items.filter(it => isChanged(it.id)).length;
  $('btnRevert').disabled = !S.items.length;
  $('btnExport').disabled = !S.items.length;
  show($('btnClose'), !!S.items.length);
  show($('overviewCard'), !!S.items.length);
  foot(n ? `已修改 ${n} 处` : (S.items.length ? '未做修改' : '就绪'));
}

/* ---------------------------------------------------------------- 断点续做
   切到 /image 再回来是整页跳转，内存里的东西全会没。
   这里把工作区落到浏览器本机：轻量状态每次编辑都存，原图只在换图时存。
   恢复时优先复用服务端内存会话（不重跑 OCR），会话没了就用本机原图重新识别。 */

/** 只保留可序列化的部分；_warnings 是预览反馈，不属于用户改动 */
function cleanEdits() {
  const out = {};
  Object.keys(S.edits).forEach((k) => {
    const { _warnings, ...rest } = S.edits[k];
    out[k] = rest;
  });
  return out;
}

function snapshot() {
  return {
    sessionId: S.sessionId,
    fileName: S.fileName,
    W: S.W, H: S.H,
    items: S.items,
    edits: cleanEdits(),
    view: { scale: S.scale, panX: S.panX, panY: S.panY,
            showBoxes: S.showBoxes, sel: S.sel },
    backend: S.backend,
    ts: Date.now(),
  };
}

async function persistNow() {
  if (!S.sessionId || !S.items.length || !window.TextWS) return;
  try { await TextWS.saveState(snapshot()); } catch (_) { /* 存不下不影响使用 */ }
}
const persistSoon = debounce(persistNow, 400);

/** 换图时连原图一起存，之后恢复就不必再让用户选一次文件 */
async function persistImage(file) {
  if (!window.TextWS) return;
  try {
    const buf = await file.arrayBuffer();
    await TextWS.saveImage(buf, file.type, file.name);
  } catch (_) { /* 忽略 */ }
}

async function sessionAlive(sid) {
  try {
    return await apiGet(`/api/session/${encodeURIComponent(sid)}`);
  } catch (_) { return null; }
}

/** 重新识别后 item id 可能变，按「id → 原文 + 位置」两级兜底匹配改动 */
function remapEdits(oldItems, newItems, edits) {
  const byId = new Map(newItems.map(it => [String(it.id), it.id]));
  const rectKey = (it) => `${it.text}\u0000${it.rect.x},${it.rect.y},${it.rect.w},${it.rect.h}`;
  const byRect = new Map(newItems.map(it => [rectKey(it), it.id]));
  const oldById = new Map(oldItems.map(it => [String(it.id), it]));

  const out = {};
  Object.keys(edits).forEach((k) => {
    if (byId.has(String(k))) { out[byId.get(String(k))] = edits[k]; return; }
    const old = oldById.get(String(k));
    if (old && byRect.has(rectKey(old))) out[byRect.get(rectKey(old))] = edits[k];
  });
  return out;
}

/** 一次性把已改动的样式贴回画布（服务端批量出补丁，避免 N 次往返） */
async function repaintEdits() {
  const edits = cleanEdits();
  const keys = Object.keys(edits);
  if (!keys.length || !S.sessionId) return;
  try {
    const res = await api('/api/preview-batch', { session_id: S.sessionId, edits });
    for (const it of res.items || []) {
      if (it.region) { await pastePatch(it.region, it.patch); S.applied[it.id] = it.region; }
      if (it.info?.warnings?.length && S.edits[it.id]) {
        S.edits[it.id]._warnings = it.info.warnings;
      }
    }
    paintBoxes();
  } catch (err) {
    foot('改动样式回填失败（改动本身仍在）：' + err.message);
  }
}

async function restoreWorkspace() {
  if (!window.TextWS) return false;
  let saved = null;
  try { saved = await TextWS.load(); } catch (_) { return false; }
  if (!saved || !saved.state || !saved.image || !saved.image.buf) return false;

  const st = saved.state;
  if (!Array.isArray(st.items) || !st.items.length) return false;

  busy(true, '正在恢复上次的编辑…');
  try {
    const type = saved.image.type || 'image/png';
    const name = saved.image.name || st.fileName || 'image.png';
    const blob = new Blob([saved.image.buf], { type });
    const url = URL.createObjectURL(blob);
    const im = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i); i.onerror = () => rej(new Error('原图解码失败'));
      i.src = url;
    });
    S.img = im; S.W = im.naturalWidth; S.H = im.naturalHeight; S.fileName = name;
    imgLayer.width = S.W; imgLayer.height = S.H;
    boxLayer.width = S.W; boxLayer.height = S.H;
    show($('emptyState'), false);
    show($('viewport'), true);
    paintBase();

    // 服务端会话还在就直接复用；不在就用本机原图重新识别
    let items = st.items;
    let sid = st.sessionId;
    let backend = st.backend;
    let reused = false;
    const info = sid ? await sessionAlive(sid) : null;
    if (info && Array.isArray(info.items) && info.items.length) {
      items = info.items; backend = info.meta?.backend || backend; reused = true;
    } else {
      const fd = new FormData();
      fd.append('file', new File([blob], name, { type }), name);
      fd.append('merge_lines', 'true');
      const res = await api('/api/analyze', fd, true);
      sid = res.session_id; items = res.items || []; backend = res.backend;
    }

    S.sessionId = sid;
    S.items = items;
    if (backend) S.backend = backend;
    S.edits = remapEdits(st.items, items, st.edits || {});
    S.applied = {}; S.sel = null; S.resultMode = false;

    const v = st.view || {};
    S.showBoxes = v.showBoxes !== false;
    $('btnShowBoxes').classList.toggle('on', S.showBoxes);
    if (v.scale) { S.scale = v.scale; S.panX = v.panX; S.panY = v.panY; applyView(); }
    else fitView();

    show($('editorCard'), false);
    renderList(); paintBoxes(); updateDirty();

    // 先把改动贴回画布，再选中，这样编辑器里能立刻看到字号/字形反馈
    await repaintEdits();
    if (typeof v.sel === 'number' && S.items.some(i => i.id === v.sel)) select(v.sel);

    const n = Object.keys(S.edits).length;
    status('已恢复上次的编辑', 'ok',
      `${S.items.length} 处文字 · ${n} 处改动 · ${S.W}×${S.H}`
      + (reused ? '' : ' · 会话已过期，已重新识别'));
    foot(`已恢复上次编辑状态（${n} 处改动）`);
    return true;
  } catch (err) {
    console.error('恢复工作区失败', err);
    TextWS.clear().catch(() => {});
    S.sessionId = null; S.items = []; S.edits = {}; S.img = null;
    show($('emptyState'), true); show($('viewport'), false);
    renderList(); updateDirty();
    status('上次的编辑状态恢复失败', 'err', esc(err.message));
    return false;
  } finally {
    busy(false);
  }
}

/** 主动丢弃当前图片与本地快照，回到空状态 */
async function closeImage() {
  if (!S.items.length && !S.sessionId) return;
  if (!confirm('关闭当前图片？未导出的改动会一并丢弃。')) return;
  if (window.TextWS) { try { await TextWS.clear(); } catch (_) { /* 忽略 */ } }

  S.sessionId = null; S.fileName = null; S.file = null; S.img = null;
  S.items = []; S.edits = {}; S.applied = {}; S.sel = null;
  S.W = 0; S.H = 0; S.resultMode = false;
  ictx.clearRect(0, 0, imgLayer.width, imgLayer.height);
  bctx.clearRect(0, 0, boxLayer.width, boxLayer.height);

  show($('emptyState'), true);
  show($('viewport'), false);
  show($('editorCard'), false);
  show($('overviewCard'), false);
  $('fileInput').value = '';
  renderList(); updateDirty();
  status('等待上传图片', '', '');
  foot('就绪 · 拖入图片开始');
}

/* ---------------------------------------------------------------- 上传 */
async function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) { foot('请选择图片文件'); return; }
  S.file = file;
  busy(true, '正在加载图片…');
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im); im.onerror = rej; im.src = url;
    });
    S.img = img;
    S.W = img.naturalWidth; S.H = img.naturalHeight;
    if (Math.max(S.W, S.H) > 12000) throw new Error('图片过大（长边超过 12000px），请先缩小');

    imgLayer.width = S.W; imgLayer.height = S.H;
    boxLayer.width = S.W; boxLayer.height = S.H;
    show($('emptyState'), false);
    show($('viewport'), true);
    paintBase();
    fitView();

    S.items = []; S.edits = {}; S.sel = null; S.applied = {};
    S.resultMode = false;
    show($('editorCard'), false);
    show($('overviewCard'), false);
    renderList(); paintBoxes();

    busy(true, '正在识别文字并分析样式…');
    status('正在识别…', 'busy', `${S.W} × ${S.H}`);

    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('merge_lines', 'true');
    const t0 = performance.now();
    const res = await api('/api/analyze', fd, true);
    const dt = Math.round(performance.now() - t0);

    S.sessionId = res.session_id;
    S.items = res.items || [];
    S.fileName = file.name;
    renderList(); paintBoxes(); updateDirty();

    status(`识别完成 · ${res.count} 处文字`, 'ok',
      `引擎 ${esc(res.backend)} · 耗时 ${dt}ms · ${S.W}×${S.H}`);
    foot(`识别到 ${res.count} 处文字，点击任意框开始编辑`,
         `${Math.round(S.W)}×${Math.round(S.H)}`);

    // 存一份到本机：切到别的模块再回来能接着改
    await persistImage(file);
    await persistNow();
  } catch (err) {
    status('处理失败：' + err.message, 'err');
    foot('处理失败：' + err.message);
    console.error(err);
  } finally {
    busy(false);
  }
}

/* ---------------------------------------------------------------- 还原 */
function revertAll() {
  S.edits = {}; S.applied = {};
  paintBase(); paintBoxes(); renderList(); updateDirty();
  if (S.sel !== null) loadEditor(S.items.find(i => i.id === S.sel) || {});
  foot('已还原为原图');
  persistNow();
}

function resetItem() {
  const id = S.sel;
  if (id === null) return;
  delete S.edits[id];
  if (S.applied[id]) { restoreRegion(S.applied[id]); delete S.applied[id]; }
  const it = S.items.find(i => i.id === id);
  if (it) loadEditor(it);
  paintBoxes(); renderList(); updateDirty();
  foot(`已重置第 ${id + 1} 项`);
  persistSoon();
}

/* ---------------------------------------------------------------- 吸色 */
function enterPickMode() {
  S.picking = true;
  $('viewport').classList.add('picking');
  const hint = document.createElement('div');
  hint.className = 'pick-hint'; hint.id = 'pickHint';
  hint.textContent = '点击图片上的文字拾取颜色 · 按 Esc 取消';
  $('stage').appendChild(hint);
}
function exitPickMode() {
  S.picking = false;
  $('viewport').classList.remove('picking');
  $('pickHint')?.remove();
}
function pickColorAt(x, y) {
  const d = ictx.getImageData(clamp(x, 0, S.W - 1), clamp(y, 0, S.H - 1), 1, 1).data;
  // 直接取像素可能落在抗锯齿边上，取 3×3 里最深的像素更接近真实字色
  const r = 3;
  const patch = ictx.getImageData(clamp(x - r, 0, S.W - 1), clamp(y - r, 0, S.H - 1),
                                  r * 2 + 1, r * 2 + 1).data;
  let best = [d[0], d[1], d[2]], bestL = d[0] * .299 + d[1] * .587 + d[2] * .114;
  for (let i = 0; i < patch.length; i += 4) {
    const l = patch[i] * .299 + patch[i + 1] * .587 + patch[i + 2] * .114;
    if (l < bestL) { bestL = l; best = [patch[i], patch[i + 1], patch[i + 2]]; }
  }
  return best;
}

/* ---------------------------------------------------------------- 结果 */
async function generateResult(show = true) {
  if (!S.sessionId) return null;
  busy(true, '正在生成结果图…');
  try {
    const edits = {};
    Object.keys(S.edits).forEach((k) => {
      const { _warnings, ...rest } = S.edits[k];
      edits[k] = rest;
    });
    const res = await api('/api/apply', {
      session_id: S.sessionId, edits, new_items: [], format: 'png',
    });
    if (show) {
      const im = new Image();
      await new Promise((r) => { im.onload = r; im.src = res.image; });
      S.resultImg = im;
      S.resultMode = true;
      ictx.clearRect(0, 0, S.W, S.H);
      ictx.drawImage(im, 0, 0, S.W, S.H);
      paintBoxes();
      foot('结果预览中 · 点「返回编辑」继续修改');
      status('结果已生成', 'ok', `改动 ${res.stats.rendered} 处 · ${(res.bytes / 1024).toFixed(0)} KB`);
    }
    return res;
  } finally { busy(false); }
}

async function exportImage() {
  if (!S.sessionId) return;
  const fmt = $('selFormat').value;
  busy(true, '正在导出…');
  try {
    const edits = {};
    Object.keys(S.edits).forEach((k) => {
      const { _warnings, ...rest } = S.edits[k];
      edits[k] = rest;
    });
    const payload = { session_id: S.sessionId, edits, new_items: [], format: fmt, quality: 95 };

    // 本地引擎优先：CF 版没有 /api/export，裸 fetch 必然 404。
    // 本地导出走 canvas.toBlob，格式/质量与原服务端一致。
    const L = await localFacade();
    let blob = null;
    if (L && L.exportBlob) {
      const r = await L.exportBlob(payload);
      blob = r.blob;
    } else {
      const r = await fetch('/api/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error('导出失败 HTTP ' + r.status);
      blob = await r.blob();
    }

    const stem = (S.file?.name || 'image').replace(/\.[^.]+$/, '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${stem}_edited.${fmt}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    foot('已导出 ' + a.download);
    status('导出成功', 'ok', a.download);
  } catch (err) {
    foot('导出失败：' + err.message);
    status('导出失败', 'err', esc(err.message));
  } finally { busy(false); }
}

/* ---------------------------------------------------------------- 事件 */
$('fileInput').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) handleFile(f);
  e.target.value = '';
});

// 拖拽上传
const stage = $('stage');
['dragenter', 'dragover'].forEach(t => stage.addEventListener(t, (e) => {
  e.preventDefault(); stage.classList.add('dragging');
}));
['dragleave', 'drop'].forEach(t => stage.addEventListener(t, (e) => {
  e.preventDefault(); if (t === 'dragleave' && e.relatedTarget) return;
  stage.classList.remove('dragging');
}));
stage.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
});

// 画布交互
const vp = $('viewport');
let dragging = false, panning = false, last = null;

vp.addEventListener('mousedown', (e) => {
  if (S.picking) {
    const p = toImg(e.clientX, e.clientY);
    const c = pickColorAt(p.x, p.y);
    $('inpColor').value = rgb2hex(c);
    if (S.sel !== null) setEdit(S.sel, { fg_color: c });
    exitPickMode();
    return;
  }
  if (e.button === 1 || e.button === 2 || e.altKey || S.spaceDown) {
    panning = true;
  } else if (e.button === 0) {
    const p = toImg(e.clientX, e.clientY);
    const hit = hitTest(p.x, p.y);
    if (hit !== null) {
      select(hit);
      dragging = true;                        // 待定：移动超过阈值才算拖动
      S.dragStart = {
        x: p.x, y: p.y,
        ox: S.edits[hit]?.offset_x || 0,
        oy: S.edits[hit]?.offset_y || 0,
        id: hit, active: false,
      };
    } else {
      S.sel = null; show($('editorCard'), false); paintBoxes(); renderList();
    }
  }
  last = { x: e.clientX, y: e.clientY };
  if (panning) vp.classList.add('grabbing');
});

window.addEventListener('mousemove', (e) => {
  if (!last) return;
  const dx = e.clientX - last.x, dy = e.clientY - last.y;
  if (panning) {
    S.panX += dx; S.panY += dy; applyView();
  } else if (dragging && S.dragStart) {
    const p = toImg(e.clientX, e.clientY);
    const ddx = Math.round(p.x - S.dragStart.x);
    const ddy = Math.round(p.y - S.dragStart.y);
    // 阈值 3px：避免"只想选中"时手抖就改掉位置
    if (!S.dragStart.active && Math.abs(ddx) < 3 && Math.abs(ddy) < 3) {
      last = { x: e.clientX, y: e.clientY };
      return;
    }
    S.dragStart.active = true;
    const eo = S.edits[S.dragStart.id] || (S.edits[S.dragStart.id] = {});
    eo.offset_x = S.dragStart.ox + ddx;
    eo.offset_y = S.dragStart.oy + ddy;
    $('vOffset').textContent = `${eo.offset_x}, ${eo.offset_y}`;
    schedulePreview(S.dragStart.id);
  }
  last = { x: e.clientX, y: e.clientY };
});

window.addEventListener('mouseup', () => {
  panning = false; dragging = false; S.dragStart = null;
  vp.classList.remove('grabbing');
});

vp.addEventListener('contextmenu', (e) => e.preventDefault());

vp.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = vp.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
}, { passive: false });

function hitTest(x, y) {
  for (let i = S.items.length - 1; i >= 0; i--) {
    const r = S.items[i].rect;
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return S.items[i].id;
  }
  return null;
}

// 属性面板
$('inpText').addEventListener('input', (e) => {
  if (S.sel === null) return;
  const v = e.target.value;
  $('charCount').textContent = v.length + ' 字';
  const it = S.items.find(i => i.id === S.sel);
  if (it && v === it.text) {
    const eo = S.edits[S.sel]; if (eo) { delete eo.text; if (!isChanged(S.sel)) delete S.edits[S.sel]; }
    renderList(); schedulePreview(S.sel);
  } else {
    setEdit(S.sel, { text: v });
  }
});

$('selFont').addEventListener('change', (e) => {
  const fam = e.target.value;
  // 手动选定字体 = 关掉「自动匹配」；选回第一项则恢复自动。
  // 不联动的话，勾选框还显示"自动匹配"，与实际渲染用的字体对不上。
  setEdit(S.sel, { family: fam, auto_family: !fam });
});

/* 字体搜索框：边打边筛，重建下拉即可（不会丢输入焦点）。
   本机字体常有 200+ 项，靠原生 select 找字太难了。 */
$('fontFilter')?.addEventListener('input', debounce(rebuildFontSelect, 120));
$('inpColor').addEventListener('input', (e) => setEdit(S.sel, { fg_color: hex2rgb(e.target.value) }));

/* ---- 字号 / 笔画粗细：滑块（拖）+ 左右 ± 按钮（点）---------------
   拖滑块很难精确停在"就差 1%"上，所以两项都配一对 ± ：点一下动一档，
   按住不放连续动。两者走同一个 applyXxx，保证读数、edit 字段不会走岔。 */

/** 按住不放连续触发（先立即动一次，400ms 后转入每 60ms 一次）。 */
function holdRepeat(btn, fn) {
  if (!btn) return;
  let delay = null, timer = null;
  const stop = () => { clearTimeout(delay); clearInterval(timer); delay = timer = null; };
  const start = (ev) => {
    if (ev) ev.preventDefault();         // 别让按钮抢焦点，免得画布快捷键失效
    stop();
    fn();
    delay = setTimeout(() => { timer = setInterval(fn, 60); }, 400);
  };
  btn.addEventListener('mousedown', start);
  btn.addEventListener('mouseup', stop);
  btn.addEventListener('mouseleave', stop);
  btn.addEventListener('touchstart', start, { passive: false });
  btn.addEventListener('touchend', stop);
  btn.addEventListener('touchcancel', stop);
  // 键盘（Enter/Space）触发的 click 没有 mousedown，补一次
  btn.addEventListener('click', (ev) => { if (ev.detail === 0) fn(); });
  btn.addEventListener('contextmenu', (ev) => ev.preventDefault());
}

/** 夹到滑块自己的 min/max，四舍五入到整数档 */
function clampToSlider(el, v) {
  return Math.round(Math.min(+el.max, Math.max(+el.min, v)));
}

function applySize(v) {
  if (S.sel === null) return;
  const el = $('rngSize');
  const n = clampToSlider(el, v);
  el.value = n;
  $('vSize').textContent = n + '%';
  setEdit(S.sel, { font_scale: n / 100 });
}

function applyWeight(step) {
  if (S.sel === null) return;
  const el = $('rngWeight');
  const n = clampToSlider(el, step);
  el.value = n;
  $('vWeight').textContent = weightLabel(n);
  setEdit(S.sel, { weight_bias: n });
}

$('rngSize').addEventListener('input', (e) => applySize(+e.target.value));
holdRepeat($('btnSizeDown'), () => applySize((+$('rngSize').value || 100) - 1));
holdRepeat($('btnSizeUp'), () => applySize((+$('rngSize').value || 100) + 1));
$('chipBold').addEventListener('click', (e) => {
  const on = !e.currentTarget.classList.contains('on');
  e.currentTarget.classList.toggle('on', on);
  setEdit(S.sel, { bold: on });
});
$('chipItalic').addEventListener('click', (e) => {
  const on = !e.currentTarget.classList.contains('on');
  e.currentTarget.classList.toggle('on', on);
  setEdit(S.sel, { italic: on });
});
/* 粗细微调：档位直接存进 edit.weight_bias，渲染时由引擎换算成描边偏移。
   拖回 0 档等于恢复自动，edit 里该字段归零后会被 isChanged 判为"未改动"。 */
$('rngWeight').addEventListener('input', (e) => applyWeight(+e.target.value));
holdRepeat($('btnWeightDown'), () => applyWeight((+$('rngWeight').value || 0) - 1));
holdRepeat($('btnWeightUp'), () => applyWeight((+$('rngWeight').value || 0) + 1));
$('btnWeightReset').addEventListener('click', () => applyWeight(0));
[...$('segAlign').children].forEach(b => b.addEventListener('click', () => {
  [...$('segAlign').children].forEach(x => x.classList.toggle('on', x === b));
  setEdit(S.sel, { align: b.dataset.v });
}));
[...$('segVAlign').children].forEach(b => b.addEventListener('click', () => {
  [...$('segVAlign').children].forEach(x => x.classList.toggle('on', x === b));
  setEdit(S.sel, { valign: b.dataset.v });
}));
$('selErase').addEventListener('change', (e) => setEdit(S.sel, { erase_method: e.target.value }));
$('chkAutoFit').addEventListener('change', (e) => setEdit(S.sel, { auto_fit: e.target.checked }));
$('chkMatchSharp').addEventListener('change', (e) => setEdit(S.sel, { match_sharpness: e.target.checked }));
$('chkAutoFamily').addEventListener('change', (e) => {
  const on = e.target.checked;
  // 重新勾上「自动匹配」时把手动指定的字体清掉，下拉也跟着回到第一项
  setEdit(S.sel, on ? { auto_family: true, family: '' } : { auto_family: false });
});
$('chkMatchStroke').addEventListener('change', (e) => setEdit(S.sel, { match_stroke: e.target.checked }));
$('btnPickColor').addEventListener('click', enterPickMode);

document.querySelectorAll('.nudge .tbtn').forEach(b => b.addEventListener('click', () => {
  if (S.sel === null) return;
  const eo = S.edits[S.sel] || (S.edits[S.sel] = {});
  if (b.dataset.dx === '0' && b.dataset.dy === '0') { eo.offset_x = 0; eo.offset_y = 0; }
  else {
    eo.offset_x = (eo.offset_x || 0) + (+b.dataset.dx);
    eo.offset_y = (eo.offset_y || 0) + (+b.dataset.dy);
  }
  $('vOffset').textContent = `${eo.offset_x || 0}, ${eo.offset_y || 0}`;
  schedulePreview(S.sel);
}));

/* ---------------------------------------------------------------- 字体管理 */
function applyFontList(families, userCount) {
  // families 是 [{name,bold,user,files}] —— 与 Python 版 /api/fonts 同形。
  // 兼容一下早期只给字符串数组的实现，避免旧缓存里存的数据把下拉搞空。
  S.fonts = (families || []).map(f => (typeof f === 'string' ? { name: f, user: false } : f))
    .filter(f => f && f.name);
  $('selFont').dataset.sig = '';                 // 强制重建下拉
  const it = S.items.find(i => i.id === S.sel);
  if (it) loadEditor(it);
  $('userFontCount').textContent = userCount ? `★ 已导入 ${userCount} 个` : '';
}

/** 当前编辑项选定的字体（'' = 自动匹配） */
function currentFontChoice() {
  const e = S.sel !== null ? S.edits[S.sel] : null;
  return (e && e.family) || '';
}

/**
 * 重建字体下拉。
 *
 * 扫过本机字体后清单可能有两三百项，原生 select 又不能搜索 ——
 * 直接铺开就是一屏空白（踩过：选项标签渲染成空串）且没法找。
 * 所以这里：① 按来源分组 ② 受 #fontFilter 关键词过滤 ③ 永远保留「自动匹配」。
 */
function rebuildFontSelect() {
  const sel = $('selFont');
  if (!sel) return;
  const cur = currentFontChoice();
  const box = $('fontFilter');
  const q = (box && box.value || '').trim();
  const norm = (s) => String(s).toLowerCase().replace(/[\s\-_]+/g, '');

  const list = (S.fonts || []).filter(f => !q || norm(f.name).includes(norm(q)));

  const GENERIC = ['sans-serif', 'serif', 'monospace'];
  const isCjk = (n) => /yahei|simsun|simhei|kai|fang|pingfang|heiti|songti|jhenghei|cjk|source han|wenquanyi|hiragino|sthei|微软|雅黑|宋|黑体|楷|仿宋/i.test(n);
  const groups = [
    ['★ 已导入', list.filter(f => f.user)],
    ['中文字体', list.filter(f => !f.user && isCjk(f.name))],
    ['其他字体', list.filter(f => !f.user && !isCjk(f.name) && !GENERIC.includes(f.name))],
    ['通用', list.filter(f => GENERIC.includes(f.name))],
  ];

  const parts = ['<option value="">自动匹配（推荐）</option>'];
  for (const [label, arr] of groups) {
    if (!arr.length) continue;
    parts.push(`<optgroup label="${esc(label)} · ${arr.length}">`);
    for (const f of arr) {
      parts.push(`<option value="${esc(f.name)}"${f.name === cur ? ' selected' : ''}>`
        + `${f.user ? '★ ' : ''}${esc(f.name)}${f.bold ? ' Bold' : ''}</option>`);
    }
    parts.push('</optgroup>');
  }
  if (q && !list.length) {
    parts.push(`<option value="" disabled>没有匹配「${esc(q)}」的字体</option>`);
  }
  // 选中的字体不在清单里（清单刚被重扫过）也要能显示，否则会静默回到"自动匹配"
  if (cur && !list.some(f => f.name === cur)) {
    parts.push(`<optgroup label="当前选择">`
      + `<option value="${esc(cur)}" selected>${esc(cur)}</option></optgroup>`);
  }

  sel.innerHTML = parts.join('');
  sel.dataset.sig = `${(S.fonts || []).length}|${cur}|${q}`;
  if (cur) sel.value = cur;
}

async function importFonts(files) {
  if (!files || !files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  busy(true, '正在导入字体…');
  try {
    const res = await api('/api/fonts/upload', fd, true);
    applyFontList(res.families, res.user_count);
    const okN = (res.added || []).length;
    const errs = res.errors || [];
    if (errs.length) {
      status(`字体导入：成功 ${okN} 个，失败 ${errs.length} 个`, 'busy',
        esc(errs.map(e => `${e.file} ${e.error}`).join('；')));
      foot(`字体导入：成功 ${okN} 个，失败 ${errs.length} 个`);
    } else {
      status('字体已导入', 'ok', `可用字体共 ${S.fonts.length} 个`);
      foot(`已导入 ${okN} 个字体，共 ${S.fonts.length} 个字体族可用`);
    }
  } catch (err) {
    status('字体导入失败', 'err', esc(err.message));
    foot('字体导入失败：' + err.message);
  } finally { busy(false); }
}

$('fontFileInput').addEventListener('change', (e) => {
  importFonts(e.target.files);
  e.target.value = '';
});

$('btnFontReload').addEventListener('click', async () => {
  busy(true, '正在重新扫描字体…');
  try {
    const res = await api('/api/fonts/reload', {});
    applyFontList(res.families, res.user_count);
    status('字体库已刷新', 'ok', `可用字体 ${S.fonts.length} 个`);
    foot(`已重新扫描，共 ${S.fonts.length} 个字体族可用`);
  } catch (err) {
    foot('扫描失败：' + err.message);
  } finally { busy(false); }
});

/* 扫描本机字体：走浏览器的 Local Font Access API，字体文件不上传。
   首次会弹授权框；拒绝或浏览器不支持时给出可读的说明，而不是静默失败。 */
$('btnScanLocalFonts')?.addEventListener('click', async () => {
  busy(true, '正在读取本机字体…');
  try {
    const res = await api('/api/fonts/scan', {});
    applyFontList(res.families, res.user_count);
    const sc = res.scan || {};
    if (sc.supported === false) {
      status('无法读取本机字体', 'err', esc(sc.error || '当前浏览器不支持'));
      foot('当前浏览器不支持读取本机字体（Chrome / Edge 104+ 可用）');
    } else if (sc.denied) {
      status('读取本机字体的授权被拒绝', 'err', '可在地址栏左侧的站点设置里重新允许');
      foot('未获得授权，本机字体未加入清单');
    } else {
      status('本机字体已加入清单', 'ok',
        `本机 ${sc.count} 个字体族 · 合计可用 ${S.fonts.length} 个`);
      foot(`读到本机 ${sc.count} 个字体族，合计 ${S.fonts.length} 个可用；字体文件始终留在本机`);
    }
  } catch (err) {
    status('读取本机字体失败', 'err', esc(err.message));
    foot('读取本机字体失败：' + err.message);
  } finally { busy(false); }
});

$('btnResetItem').addEventListener('click', resetItem);
$('btnRevert').addEventListener('click', revertAll);
$('btnClearAll').addEventListener('click', revertAll);
$('btnClose').addEventListener('click', closeImage);
$('btnExport').addEventListener('click', exportImage);
$('btnApplyAll').addEventListener('click', async () => {
  if (S.resultMode) {
    // 退回编辑模式：重绘原图并重贴所有已生效的补丁
    S.resultMode = false;
    S.applied = {};
    paintBase();
    for (const k of Object.keys(S.edits)) {
      if (isChanged(+k)) await previewItem(+k);
    }
    paintBoxes();
    foot('已返回编辑模式');
    return;
  }
  await generateResult(true);
});

$('searchInput').addEventListener('input', renderList);
$('chkOnlyEdited').addEventListener('change', renderList);
$('btnZoomIn').addEventListener('click', () => {
  const r = vp.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.2);
});
$('btnZoomOut').addEventListener('click', () => {
  const r = vp.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1 / 1.2);
});
$('btnZoomFit').addEventListener('click', fitView);
$('btnShowBoxes').addEventListener('click', (e) => {
  S.showBoxes = !S.showBoxes;
  e.currentTarget.classList.toggle('on', S.showBoxes);
  paintBoxes();
});
$('btnCompare').addEventListener('mousedown', () => {
  S.compare = true;
  ictx.clearRect(0, 0, S.W, S.H);
  ictx.drawImage(S.img, 0, 0, S.W, S.H);
  paintBoxes();
});
['mouseup', 'mouseleave'].forEach(t => $('btnCompare').addEventListener(t, () => {
  if (!S.compare) return;
  S.compare = false;
  paintBase();
  Object.entries(S.applied).forEach(async ([id, region]) => {
    // 恢复补丁显示
    try { await previewItem(+id); } catch (_) {}
  });
  paintBoxes();
}));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { exitPickMode(); return; }
  if (e.code === 'Space') {                     // 空格 = 平移模式
    S.spaceDown = true;
    if (S.W) { e.preventDefault(); vp.style.cursor = 'grab'; }
    return;
  }
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (S.sel === null) return;
    e.preventDefault();
    const i = S.items.findIndex(x => x.id === S.sel);
    select(S.items[clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, S.items.length - 1)].id);
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { S.spaceDown = false; vp.style.cursor = ''; }
});

window.addEventListener('resize', () => { if (S.W) applyView(); });

/* ---------------------------------------------------------------- 启动 */
(async function init() {
  $('btnShowBoxes').classList.add('on');
  // 显式重置初始可见性：不依赖 CSS 的 [hidden] 规则，避免样式被缓存时遮罩残留
  show($('loading'), false);
  show($('viewport'), false);
  show($('emptyState'), true);
  show($('editorCard'), false);
  show($('overviewCard'), false);
  show($('btnClose'), false);
  show($('warnBox'), false);

  // 离开页面前把工作区落盘，切模块/刷新回来能接着改
  window.addEventListener('pagehide', () => { persistNow(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistNow();
  });

  /* 探测后端并铺字体清单。
     抽成函数是因为它可能要跑两次：boot.js 是延迟加载的模块，慢网络下可能比
     本脚本晚好几秒才执行；那一轮会落到网络请求上（纯静态部署就是 404）。
     等本地引擎真正就绪时再补一次，界面自然就正确了。 */
  let probed = false;
  const probeBackend = async () => {
    if (probed) return;
    try {
      const h = await apiGet('/api/health');
      S.backend = h.ocr_backend;
      if (h.ocr_error || h.ocr_backend === 'unavailable') {
        status('OCR 引擎未就绪', 'err', esc(h.ocr_error || ''));
      } else {
        status('服务就绪', 'ok', `OCR ${esc(h.ocr_backend)} · 可用字体 ${h.font_count}`);
      }
      const f = await apiGet('/api/fonts');
      applyFontList(f.families, f.user_count);
      probed = true;
      foot('就绪 · 拖入图片开始');
    } catch (err) {
      // 本地引擎还在下载/装配时不要报「无法连接后端服务」——那是误导。
      // 这时候进度由 progress 回调写在状态栏上，这里只兜一句说明。
      const L = window.WBLocal;
      if (L && !L.ready && !L.error) {
        status('本地引擎准备中…', 'busy', '首次使用需下载模型，之后从本机缓存读取');
      } else {
        status('无法连接后端服务', 'err', esc(err.message));
      }
    }
  };
  await probeBackend();

  // 本地引擎晚到时补一次（含"事件已经派发过"的情况）
  window.addEventListener('wb-local-ready', () => { probeBackend(); });
  if (window.WBLocal && window.WBLocal.ready) probeBackend();

  // 有上次的工作区就自动接上（放在最后，避免被上面的状态文案覆盖）
  try {
    const restored = await restoreWorkspace();
    if (!restored) foot('就绪 · 拖入图片开始');
  } catch (err) {
    console.error('恢复工作区异常', err);
  }

  // 视图路由放最后：上面的初始化都可能改写界面，路由决定最终显示哪一个视图。
  // 用 ?v=#create 这类深链进来时也能直接落到生成视图。
  applyViewRoute();
})();

})();
