/* ==========================================================================
   图像工坊 · 生成页交互
   服务端只负责「转发中转站请求」，图片一律由浏览器存进本机 IndexedDB。
   ========================================================================== */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = (n) => !n ? '—'
  : n < 1024 ? n + ' B'
  : n < 1048576 ? (n / 1024).toFixed(0) + ' KB'
  : (n / 1048576).toFixed(2) + ' MB';
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const modKey = isMac ? '⌘' : 'Ctrl+';

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return sameDay ? `今天 ${hm}`
    : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/* ---------------------------------------------------------------- 工具定义 */
/* 四个工具不是换个标题而已：各自有不同的参照图要求、默认尺寸，
   以及一段会拼进提示词的工具指令（wrap）——这样出来的画面才会真的不一样。 */
const TOOLS = [
  {
    id: 'create', name: '自由生成', icon: '#i-spark',
    title: 'AI 图片生成',
    desc: '纯文生图：用一段提示词直接生成全新画面，不依赖任何参照图。描述越具体越容易得到想要的效果：主体 + 场景 + 风格 + 光线。',
    refs: { min: 0, max: 0 },
    size: '1024x1024',
    wrap: (p) => p,
    placeholder: '描述你想生成的画面…\n例如：生成一个小狗，坐在草地上，阳光明媚，高清摄影风格',
    chips: ['生成一个小狗', '未来城市夜景，赛博朋克风格，霓虹灯', '极简扁平插画，女孩在窗边看书', '水墨风格的远山与孤舟'],
    hints: ['描述越具体越准：主体 + 场景 + 风格 + 光线',
            '提示词原样发送，不做任何改写',
            '要基于已有图片生成？用左侧「图像融合」或「人物写真」'],
    note: '自由生成是纯文生图，不需要参照图。要基于已有图片生成，请用「图像融合」「人物写真」或「商品图生成」。',
  },
  {
    id: 'combine', name: '图像融合', icon: '#i-layers',
    title: '图像融合',
    desc: '把参照图里的主体融入你描述的全新场景、背景与光线。可上传 1~4 张作为参考，主体外观会尽量保持一致。',
    refs: { min: 1, max: 4 },
    size: 'auto',
    wrap: (p) => '把参照图中的主体自然地融入以下场景，保持主体的外观与特征一致：\n' + p
      + '\n要求：光照、阴影、色温与场景保持统一，主体边缘自然，不要出现拼贴或抠图痕迹。',
    placeholder: '描述目标场景…\n例如：把主体放到海边日落场景中，柔和逆光，写实摄影风格',
    chips: ['把主体放到海边日落场景中', '换成纯白背景的电商主图', '融入未来城市霓虹街头', '放进原木桌面的静物场景'],
    hints: ['先上传 1~4 张参照图（多张会更贴近你想要的样子）',
            '提示词只写「要去哪里」，不必再描述主体长什么样',
            '光照与阴影会自动与新场景统一'],
    note: '',
  },
  {
    id: 'portrait', name: '人物写真', icon: '#i-person',
    title: '人物写真',
    desc: '以参照图的人像为基准生成新的写真，尽量保留人物身份特征（五官、发型、气质）。默认输出竖版。',
    refs: { min: 1, max: 1 },
    size: '1024x1536',
    wrap: (p) => '以参照图中人物的五官、发型与气质为准，生成一张新的写真照片：\n' + p
      + '\n要求：保持人物身份一致，不要改变面部特征；肤质自然，避免过度磨皮。',
    placeholder: '描述想要的写真风格…\n例如：日系胶片质感，浅景深，窗边自然光',
    chips: ['日系胶片质感，浅景深', '正装职业照，纯灰背景', '户外逆光，暖色调'],
    hints: ['上传 1 张清晰人像（正脸、无遮挡效果最好）',
            '提示词写「风格 + 光线 + 场景」即可，不必重复描述长相',
            '默认竖版 1024×1536，可用左下角切换'],
    note: '',
  },
  {
    id: 'product', name: '商品图生成', icon: '#i-box',
    title: '商品图生成',
    desc: '把参照图里的商品放进干净有质感的场景，输出可直接用于电商主图与详情页的画面。',
    refs: { min: 1, max: 1 },
    size: '1024x1024',
    wrap: (p) => '把参照图中的商品放进下面的场景，生成一张电商商品图：\n' + p
      + '\n要求：商品主体清晰完整、边缘干净、比例准确，不改变商品外观与颜色；'
      + '背景简洁有质感，画面中不要出现文字、水印或多余道具。',
    placeholder: '描述商品与场景…\n例如：大理石台面，柔和顶光，极简高级感',
    chips: ['大理石台面，柔和顶光', '纯白背景无阴影', '原木与绿植的自然场景'],
    hints: ['上传 1 张商品图（主体完整、边缘干净）',
            '提示词写「台面材质 + 光线 + 氛围」最有效',
            '输出会自动避免文字与水印'],
    note: '',
  },
];

/** 「1~4 张」这样的文案 */
function refRange(t) {
  const { min, max } = t.refs;
  if (max === 0) return '不需要';
  return min === max ? `${min} 张` : `${min}~${max} 张`;
}

/** 显隐控制：同时写 hidden 与 inline display。
    只设 hidden 不够——组件自带的 display 声明会压过浏览器默认的 [hidden]{display:none}。 */
function show(el, on) {
  if (!el) return;
  el.hidden = !on;
  el.style.display = on ? '' : 'none';
}

const SIZES = [
  { v: '1024x1024', label: '1024×1024', hint: '正方形' },
  { v: '1536x1024', label: '1536×1024', hint: '横向 3:2' },
  { v: '1024x1536', label: '1024×1536', hint: '竖向 2:3' },
  { v: 'auto', label: '自动', hint: '由模型决定' },
];
const COUNTS = [1, 2, 3, 4];

/* ---------------------------------------------------------------- 状态 */
const S = {
  tool: TOOLS[0],
  size: TOOLS[0].size,
  count: 1,
  refs: [],                 // [{file, url}]
  status: null,
  view: 'generate',
  images: [],               // 本轮结果 [{data_url, url, bytes, recId}]
  current: 0,
  busy: false,
  timer: null,
  startedAt: 0,
  controller: null,
  lastPrompt: '',        // 用户输入的
  lastSent: '',          // 真正发给模型的（含工具指令）
  lastMeta: {},
  library: [],              // 作品库列表
  search: '',
  favOnly: false,
  lbId: null,
  autoSave: true,
};

/* ---------------------------------------------------------------- 通用 */
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('toastWrap').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s'; el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, 2800);
}

async function api(url, opt = {}) {  const r = await fetch(url, { credentials: 'same-origin', ...opt });
  let body = null;
  try { body = await r.json(); } catch (_) { /* 非 JSON */ }
  if (!r.ok) {
    const d = (body && body.detail) || {};
    const err = new Error(typeof d === 'string' ? d : (d.message || `HTTP ${r.status}`));
    err.status = r.status;
    err.detail = typeof d === 'object' ? (d.detail || '') : '';
    err.hint = typeof d === 'object' ? (d.hint || '') : '';
    throw err;
  }
  return body;
}

/* ================================================================ 初始化 */
(async function init() {
  bindRefs();
  bindPrompt();
  bindPills();
  bindGenerate();
  bindResult();
  bindProjects();
  bindLightbox();

  // hash 路由先挂上：后面任何一步渲染出错，深链和侧栏高亮都不该跟着失效
  window.addEventListener('hashchange', applyHash);
  applyHash();

  $('genKey').textContent = modKey + '3';
  $('prompt').placeholder = S.tool.placeholder;
  try {
    applySizeLabel();
    renderRefs();
    renderToolState();
  } catch (e) {
    console.error('工具初始渲染失败', e);
  }

  try {
    S.status = await api('/api/image/status');
  } catch (e) {
    S.status = { ready: false, model: '', message: '无法读取服务状态', hint: e.message };
  }
  if (!S.status.ready) {
    toast(`后台未就绪：${S.status.message}`, 'warn');
  }
})();

/* ================================================================ 工具切换 */
function selectTool(id) {
  const t = TOOLS.find(x => x.id === id);
  if (!t) return;
  if (S.view !== 'generate') switchView('generate', t.id);

  const changed = t.id !== S.tool.id;
  const hadResult = S.images.length > 0;
  S.tool = t;

  $('toolTitle').textContent = t.title;
  $('toolDesc').textContent = t.desc;
  $('prompt').placeholder = t.placeholder;

  // 每个工具自带默认尺寸：人像竖版、融合沿用参照图比例
  S.size = t.size;
  applySizeLabel();

  // 参照图数量不符合新工具要求就清掉，别把「不需要参照图」的图悄悄带过去
  while (S.refs.length > t.refs.max) removeRef(S.refs.length - 1, true);
  renderToolChips();
  renderRefs();
  renderToolState();
  closePop();
  setHash(t.id);

  // 切工具等于换个工作台：上一张结果已自动存进作品库，舞台回到该工具自己的空态。
  // 否则从「自由生成」切到「人物写真」会看到同一张图，容易以为四个工具没区别。
  if (changed) {
    resetStage();
    if (hadResult) toast('已切换到「' + t.name + '」，上一张结果已存入作品库', 'ok');
  }
}

/* ================================================================ 视图与深链 */
/** 把当前视图/工具写进 URL（#projects 或 #<工具 id>），便于深链与侧栏高亮 */
function setHash(key) {
  const want = '#' + key;
  if (location.hash !== want) history.replaceState(null, '', want);
  if (window.WBShell) WBShell.syncActive();
}

function switchView(v, hashKey) {
  S.view = v;
  $('viewGenerate').hidden = v !== 'generate';
  $('viewProjects').hidden = v !== 'projects';
  setHash(v === 'projects' ? 'projects' : (hashKey || S.tool.id));
  if (v === 'projects') refreshLibrary();
}

/** URL hash → 界面状态。支持 /image#projects 与 /image#combine 这类深链。 */
function applyHash() {
  const h = location.hash.replace(/^#/, '');
  if (h === 'projects') { switchView('projects'); return; }
  const t = TOOLS.find(x => x.id === h);
  switchView('generate', t ? t.id : null);
  if (t) selectTool(t.id);
}

/* ================================================================ 参照图 */
function bindRefs() {
  const dz = $('dropzone');
  const inp = $('refInput');

  inp.addEventListener('change', (e) => {
    addRefs([...e.target.files]);
    e.target.value = '';
  });
  ['dragenter', 'dragover'].forEach(t => dz.addEventListener(t, (e) => {
    e.preventDefault(); dz.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach(t => dz.addEventListener(t, (e) => {
    e.preventDefault();
    if (t === 'dragleave' && e.relatedTarget) return;
    dz.classList.remove('drag');
  }));
  dz.addEventListener('drop', (e) => addRefs([...(e.dataTransfer?.files || [])]));
}

function addRefs(files) {
  const t = S.tool;
  if (t.refs.max === 0) {
    toast(`「${t.name}」不需要参照图，要基于图片生成请换「图像融合」等工具`, 'warn');
    return;
  }
  const room = t.refs.max - S.refs.length;
  if (room <= 0) {
    toast(`「${t.name}」最多 ${t.refs.max} 张参照图`, 'warn');
    return;
  }
  const accepted = [];
  for (const f of files) {
    if (accepted.length >= room) { toast(`超出上限，已忽略多余文件`, 'warn'); break; }
    if (!f.type.startsWith('image/')) { toast(`跳过非图片文件：${f.name}`, 'warn'); continue; }
    if (f.size > 8 * 1024 * 1024) { toast(`${f.name} 超过 8MB，已跳过`, 'err'); continue; }
    accepted.push({ file: f, url: URL.createObjectURL(f) });
  }
  S.refs.push(...accepted);
  renderRefs();
}

function removeRef(i, silent) {
  const r = S.refs[i];
  if (!r) return;
  URL.revokeObjectURL(r.url);
  S.refs.splice(i, 1);
  if (!silent) renderRefs();
}

function renderRefs() {
  const box = $('refStrip');
  const t = S.tool;
  $('refCount').textContent = t.refs.max === 0 ? '无需' : `${S.refs.length}/${t.refs.max}`;
  if (!S.refs.length) { box.hidden = true; box.innerHTML = ''; }
  else {
    box.hidden = false;
    box.innerHTML = S.refs.map((r, i) => `
      <div class="ref-thumb" data-i="${i}">
        <img src="${r.url}" alt="参照图 ${i + 1}">
        <span class="idx">${i + 1}</span>
        <button title="移除"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>
      </div>`).join('');
    box.querySelectorAll('.ref-thumb').forEach(el => {
      el.querySelector('button').addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        removeRef(+el.dataset.i);
      });
    });
  }
  renderRefZone();
}

/** 不同工具的参照图区不一样：自由生成干脆不显示上传框 */
function renderRefZone() {
  const t = S.tool;
  const noRef = t.refs.max === 0;
  show($('dropzone'), !noRef);
  show($('refNote'), noRef);
  if (noRef) $('refNoteText').textContent = t.note || '该工具不需要参照图。';
  else {
    const label = '拖入或点击上传图片';
    const hint = `JPG、PNG、WebP · 单张不超过 8MB · 需要 ${refRange(t)}`;
    const inner = $('dropzone').querySelector('.dz-inner');
    if (inner) {
      inner.querySelector('p').textContent = label;
      inner.querySelector('span').textContent = hint;
    }
  }
}

/** 舞台空态按工具改写：缺参照图时直接把话说清楚 */
function renderToolState() {
  const t = S.tool;
  const need = t.refs.min > 0;
  const missing = need && !S.refs.length;
  $('emptyTitle').textContent = missing ? `请先上传参照图（${refRange(t)}）`
    : (need ? '参照图已就绪' : '准备就绪');
  $('emptyDesc').textContent = missing
    ? '这个工具以参照图为基础，没有参照图无法开始'
    : (need ? '写下提示词，点「Generate」即可开始'
            : '写下提示词，点「Generate」即可开始');
  $('emptyHints').innerHTML = t.hints.map(h => `<li>${esc(h)}</li>`).join('');
}

/** 清空舞台上的结果视图（结果本身已存进作品库，不会丢） */
function resetStage() {
  S.images = [];
  S.current = 0;
  S.lastMeta = {};
  S.lastPrompt = '';
  S.lastSent = '';
  $('resultImg').removeAttribute('src');
  showState('stateEmpty');
  renderToolState();
}

/** 骨架屏尺寸跟着所选比例走，让等待期的占位和将要出现的画面一致 */
function skeletonSize() {
  if (S.size === 'auto') return { w: 168, h: 168 };
  const m = /^(\d+)x(\d+)$/.exec(S.size);
  if (!m) return { w: 168, h: 168 };
  const a = Number(m[1]), b = Number(m[2]);
  const long = 172;
  return a >= b ? { w: long, h: Math.round(long * b / a) }
                : { w: Math.round(long * a / b), h: long };
}

/* ================================================================ 提示词 */
function applySizeLabel() {
  const s = SIZES.find(x => x.v === S.size);
  $('pillSizeText').textContent = s ? s.label : S.size;
}

function bindPrompt() {
  const ta = $('prompt');
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); generate(); }
  });
}

function renderToolChips() {
  $('chips').innerHTML = S.tool.chips.map(c =>
    `<button class="chip" data-p="${esc(c)}">${esc(c)}</button>`).join('');
  $('chips').querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
    const ta = $('prompt');
    ta.value = b.dataset.p;
    ta.focus();
  }));
}

/* ================================================================ 弹出菜单 */
function closePop() {
  const wrap = $('popWrap');
  wrap.hidden = true;
  // 必须把面板一起移除：它是 fixed 定位，光隐藏遮罩它仍会留在屏幕上
  // ——之前就是这个 bug，弹出菜单关不掉了。
  wrap.querySelectorAll('.pop').forEach(el => el.remove());
}

function openPop(anchor, items, title) {
  const wrap = $('popWrap');
  closePop();
  wrap.hidden = false;

  const pop = document.createElement('div');
  pop.className = 'pop';
  pop.innerHTML = (title ? `<div class="pop-title">${esc(title)}</div>` : '')
    + items.map(it => `<button type="button" data-v="${esc(it.v)}" class="${it.on ? 'on' : ''}">
         <svg class="ic" viewBox="0 0 24 24"><use href="#i-check"/></svg>
         <span>${esc(it.label)}</span></button>`).join('');
  // 放进遮罩里，这样隐藏遮罩就等于隐藏菜单，不会再留残影
  wrap.appendChild(pop);

  // 先量尺寸再定位：优先贴锚点上方，放不下翻到下方，都不行就夹在视口内
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const vw = innerWidth;
  const vh = innerHeight;
  const gap = 8;

  let left = r.left;
  left = Math.max(gap, Math.min(left, vw - pw - gap));
  let top = r.top - ph - gap;
  if (top < gap) {
    const below = r.bottom + gap;
    top = below + ph <= vh - gap ? below : Math.max(gap, vh - ph - gap);
  }
  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(top) + 'px';

  pop.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    e.stopPropagation();
    const v = b.dataset.v;
    closePop();
    anchor.dispatchEvent(new CustomEvent('picked', { detail: v }));
  });
  wrap.onclick = closePop;
}

function bindPills() {
  const sz = $('pillSize'), ct = $('pillCount');
  sz.addEventListener('click', () => openPop(sz, SIZES.map(s => ({
    v: s.v, label: `${s.label}　${s.hint}`, on: s.v === S.size,
  })), '尺寸'));
  sz.addEventListener('picked', (e) => {
    S.size = e.detail;
    applySizeLabel();
  });
  ct.addEventListener('click', () => openPop(ct, COUNTS.map(n => ({
    v: String(n), label: `${n} 张`, on: n === S.count,
  })), '数量'));
  ct.addEventListener('picked', (e) => {
    S.count = Number(e.detail);
    $('pillCountText').textContent = `${S.count} 张`;
  });
}

/* ================================================================ 生成 */
function bindGenerate() {
  $('btnGenerate').addEventListener('click', generate);
  $('btnCancel').addEventListener('click', cancel);
  $('btnRetry').addEventListener('click', generate);
  $('btnAgain').addEventListener('click', generate);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === '3') { e.preventDefault(); generate(); }
  });
}

function showState(which) {
  ['stateEmpty', 'stateLoading', 'stateError'].forEach(id => { $(id).hidden = id !== which; });
  $('result').hidden = which !== null;
}

function startTimer() {
  S.startedAt = Date.now();
  $('elapsed').textContent = '0.0';
  clearInterval(S.timer);
  S.timer = setInterval(() => {
    $('elapsed').textContent = ((Date.now() - S.startedAt) / 1000).toFixed(1);
  }, 100);
}
function stopTimer() { clearInterval(S.timer); S.timer = null; }

function setBusy(on) {
  S.busy = on;
  $('btnGenerate').hidden = on;
  $('btnCancel').hidden = !on;
}

/**
 * 多张参照图 → 合成一张拼图。
 * 该中转站只稳定支持单张参照图（`image` 字段传数组会触发内容拦截），
 * 因此多图时先按网格拼成一张再发送，并在界面上告知用户。
 */
async function composeRefs(refs) {
  if (refs.length === 1) return refs[0].file;
  const imgs = await Promise.all(refs.map(r => new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('参照图解码失败'));
    im.src = r.url;
  })));
  const cols = refs.length <= 2 ? refs.length : 2;
  const rows = Math.ceil(refs.length / cols);
  const cell = 640;
  const cv = document.createElement('canvas');
  cv.width = cols * cell; cv.height = rows * cell;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  imgs.forEach((im, i) => {
    const cx = (i % cols) * cell, cy = Math.floor(i / cols) * cell;
    const sc = Math.min(cell / im.naturalWidth, cell / im.naturalHeight);
    const w = im.naturalWidth * sc, h = im.naturalHeight * sc;
    ctx.drawImage(im, cx + (cell - w) / 2, cy + (cell - h) / 2, w, h);
  });
  const blob = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.92));
  return new File([blob], 'references.jpg', { type: 'image/jpeg' });
}

async function generate() {
  if (S.busy) return;
  const t = S.tool;
  const prompt = $('prompt').value.trim();
  if (!prompt) { toast('请先填写提示词', 'err'); $('prompt').focus(); return; }
  if (S.status && !S.status.ready) {
    toast(`后台未就绪：${S.status.message}`, 'err');
    return;
  }
  if (S.refs.length < t.refs.min) {
    toast(`「${t.name}」需要 ${refRange(t)}参照图，当前 ${S.refs.length} 张`, 'err');
    renderToolState();
    return;
  }

  // 每个工具往提示词里拼自己的指令，这样同样的输入也会得到不同的结果
  const finalPrompt = t.wrap ? t.wrap(prompt) : prompt;
  S.lastPrompt = prompt;
  S.lastSent = finalPrompt;

  setBusy(true);
  showState('stateLoading');
  startTimer();
  $('loadingTitle').textContent = S.refs.length ? '正在按参照图生成…' : '正在生成…';
  $('loadingSub').textContent =
    `${t.name} · 模型 ${S.status?.model || '—'} · ${S.size === 'auto' ? '自动尺寸' : S.size} · ${S.count} 张`
    + (S.refs.length ? ` · ${S.refs.length} 张参照图` : '');
  const sk = skeletonSize();
  $('skGrid').innerHTML = Array.from({ length: S.count },
    () => `<div class="sk" style="width:${sk.w}px;height:${sk.h}px"></div>`).join('');

  const fd = new FormData();
  fd.append('prompt', finalPrompt);
  fd.append('tool', t.id);
  fd.append('size', S.size);
  fd.append('n', String(S.count));
  S.refs.forEach((r, i) =>
    fd.append('references', r.file, r.file.name || `ref${i + 1}.png`));

  S.controller = new AbortController();
  try {
    let res;
    try {
      res = await api('/api/image/generate', {
        method: 'POST', body: fd, signal: S.controller.signal,
      });
    } catch (e) {
      // 多图被拦时，拼成一张再试一次
      if (S.refs.length > 1 && e.name !== 'AbortError') {
        $('loadingSub').textContent = '多张参照图被拒，正在改用拼图方式重试…';
        const merged = await composeRefs(S.refs);
        const fd2 = new FormData();
        fd2.append('prompt', prompt);
        fd2.append('size', S.size);
        fd2.append('n', String(S.count));
        fd2.append('references', merged, merged.name);
        res = await api('/api/image/generate', {
          method: 'POST', body: fd2, signal: S.controller.signal,
        });
        toast('已改用拼图方式生成', 'warn');
      } else {
        throw e;
      }
    }
    stopTimer();
    S.images = (res.images || []).map(im => ({ ...im, recId: null }));
    S.current = 0;
    S.lastMeta = res;
    renderResult(res);
    toast(`生成完成，用时 ${res.elapsed}s`, 'ok');
    if (S.autoSave) await autoSave(res);
  } catch (e) {
    stopTimer();
    if (e.name === 'AbortError') { showState('stateEmpty'); toast('已取消生成'); }
    else renderError(e);
  } finally {
    setBusy(false);
    S.controller = null;
  }
}

function cancel() {
  if (S.controller) S.controller.abort();
  stopTimer();
}

/* ================================================================ 存进作品库 */
async function autoSave(res) {
  if (!window.ImgStore) return;
  let saved = 0;
  for (const im of S.images) {
    const src = im.data_url || '';
    if (!src.startsWith('data:')) continue;
    try {
      const rec = await ImgStore.save(src, {
        prompt: S.lastPrompt,
        revised: im.revised_prompt || '',
        model: res.model || '',
        size: res.size || S.size,
        tool: S.tool.id,
        toolName: S.tool.name,
        usedRef: !!res.used_reference,
      });
      im.recId = rec.id;
      saved++;
    } catch (e) {
      toast('本地保存失败：' + e.message, 'err');
      return;
    }
  }
  if (saved) {
    $('resSaved').hidden = false;
    $('resSaved').textContent = `已存入作品库（${saved} 张）`;
    await refreshLibraryCount();
    await refreshStorage();
  }
}

/* ================================================================ 结果 */
function renderResult(res) {
  showState(null);
  $('resTool').textContent = res.tool_name || S.tool.name;
  $('resSize').textContent = `尺寸 ${res.size || S.size}`;
  $('resModel').textContent = res.model || '—';
  $('resElapsed').textContent = `耗时 ${res.elapsed}s`;
  $('resRef').hidden = !res.used_reference;
  $('resPrompt').textContent = S.lastPrompt;
  // 有加工具指令时把真正发出去的内容也亮出来，避免「四个工具看起来一样」的困惑
  const sent = S.lastSent || '';
  const wrapped = !!sent && sent !== S.lastPrompt;
  $('resSentWrap').hidden = !wrapped;
  if (wrapped) $('resSent').textContent = sent;
  $('resSaved').hidden = true;
  $('btnFav').classList.remove('on');

  const revised = res.images?.[0]?.revised_prompt || '';
  $('resRevisedWrap').hidden = !revised;
  $('resRevised').textContent = revised;

  const nav = $('canvasNav');
  nav.hidden = S.images.length <= 1;
  nav.innerHTML = S.images.length <= 1 ? ''
    : `${S.images.map((_, i) => `<button data-i="${i}" title="第 ${i + 1} 张">${i + 1}</button>`).join('')}`;
  nav.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => showImage(+b.dataset.i)));
  markNav();

  showImage(0);
}

function markNav() {
  $('canvasNav').querySelectorAll('button').forEach((b, i) =>
    b.classList.toggle('on', i === S.current));
}

function showImage(i) {
  const im = S.images[i];
  if (!im) return;
  S.current = i;
  $('resultImg').src = im.data_url || im.url || '';
  markNav();
  $('btnFav').classList.remove('on');
}

function bindResult() {
  $('btnDownload').addEventListener('click', async () => {
    const im = S.images[S.current];
    if (!im) return;
    await downloadImage(im);
  });

  $('btnFav').addEventListener('click', async () => {
    const im = S.images[S.current];
    if (!im || !im.recId) { toast('这张图未存入作品库', 'warn'); return; }
    const rec = await ImgStore.get(im.recId);
    if (!rec) { toast('记录已不存在', 'err'); return; }
    await ImgStore.update(im.recId, { favorite: !rec.favorite });
    $('btnFav').classList.toggle('on', !rec.favorite);
    toast(!rec.favorite ? '已加入收藏' : '已取消收藏', 'ok');
    await refreshLibraryCount();
  });

  $('btnOpenNew').addEventListener('click', () => {
    const im = S.images[S.current];
    if (!im) return;
    const w = window.open('', '_blank');
    if (!w) { toast('浏览器拦截了新窗口', 'err'); return; }
    w.document.write(
      `<title>生成结果</title><body style="margin:0;background:#0a0a0a;display:grid;place-items:center;height:100vh">`
      + `<img src="${im.data_url || im.url}" style="max-width:100%;max-height:100%">`);
  });
}

async function downloadImage(im) {
  const a = document.createElement('a');
  a.href = im.data_url || im.url;
  a.download = `ai-${im.recId || Date.now()}.png`;
  a.click();
  toast('已开始下载', 'ok');
}

function renderError(e) {
  showState('stateError');
  $('errTitle').textContent = e.status === 504 ? '生成超时' : '生成失败';
  $('errMsg').textContent = e.message || '未知错误';
  $('errHint').hidden = !e.hint;
  $('errHint').textContent = e.hint || '';
  const detail = (e.detail || '').trim();
  $('errDetailWrap').hidden = !detail;
  $('errDetail').textContent = detail;
}

/* ================================================================ 作品库 */
function bindProjects() {
  $('projSearch').addEventListener('input', (e) => {
    S.search = e.target.value.trim().toLowerCase();
    renderLibrary();
  });
  $('btnFavFilter').addEventListener('click', () => {
    S.favOnly = !S.favOnly;
    $('btnFavFilter').classList.toggle('on', S.favOnly);
    renderLibrary();
  });
  $('btnClearAll').addEventListener('click', async () => {
    const n = S.library.length;
    if (!n) { toast('作品库已经是空的'); return; }
    if (!confirm(`确定清空作品库里的 ${n} 张图片？此操作不可恢复。`)) return;
    await ImgStore.clear();
    await refreshLibrary();
    await refreshStorage();
    toast('已清空作品库', 'ok');
  });
}

let shellSyncTimer = null;
/** 侧栏的作品数量与容量条由 shell.js 渲染，这里只负责触发一次刷新（合并抖动） */
function syncShell() {
  clearTimeout(shellSyncTimer);
  shellSyncTimer = setTimeout(() => {
    if (window.WBShell) WBShell.refresh();
  }, 60);
}
async function refreshLibraryCount() { syncShell(); }
async function refreshStorage() { syncShell(); }

async function refreshLibrary() {
  if (!window.ImgStore) return;
  try {
    S.library = await ImgStore.list();
  } catch (e) {
    S.library = [];
    toast('读取本机作品库失败：' + e.message, 'err');
  }
  renderLibrary();
  syncShell();               // 容量统计交给外壳，不阻塞画廊渲染
}

function filtered() {
  return S.library.filter(r => {
    if (S.favOnly && !r.favorite) return false;
    if (S.search && !(r.prompt || '').toLowerCase().includes(S.search)) return false;
    return true;
  });
}

function renderLibrary() {
  const rows = filtered();
  const grid = $('projGrid');
  const empty = $('projEmpty');

  if (!rows.length) {
    grid.innerHTML = '';
    empty.hidden = false;
    const hasAny = S.library.length > 0;
    $('projEmptyTitle').textContent = hasAny ? '没有匹配的作品' : '作品库还是空的';
    $('projEmptyDesc').textContent = hasAny
      ? '换个关键词，或取消「只看收藏」'
      : '生成一张图片，它会自动出现在这里';
    return;
  }
  empty.hidden = true;
  grid.innerHTML = rows.map(r => {
    const url = r.thumb ? ImgStore.bufferToURL(r.thumb, r.thumbMime) : '';
    return `
    <div class="pcard" data-id="${r.id}">
      <div class="pcard-img" data-act="open">
        ${url ? `<img src="${url}" alt="" loading="lazy">` : ''}
        <button class="pcard-star${r.favorite ? ' on' : ''}" data-act="fav" title="收藏">
          <svg class="ic" viewBox="0 0 24 24"><use href="#${r.favorite ? 'i-star-fill' : 'i-star'}"/></svg>
        </button>
        <div class="hov"><p>${esc(r.prompt || '（无提示词）')}</p></div>
      </div>
      <div class="pcard-foot">
        <span class="pcard-time">${fmtTime(r.createdAt)}</span>
        ${r.toolName ? `<span class="pcard-tool">${esc(r.toolName)}</span>` : ''}
        <span class="acts">
          <button class="icon-act" data-act="down" title="下载"><svg class="ic" viewBox="0 0 24 24"><use href="#i-download"/></svg></button>
          <button class="icon-act danger" data-act="del" title="删除"><svg class="ic" viewBox="0 0 24 24"><use href="#i-trash"/></svg></button>
        </span>
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.pcard').forEach(card => {
    card.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      const id = card.dataset.id;
      if (act === 'fav') { e.stopPropagation(); toggleFav(id); }
      else if (act === 'del') { e.stopPropagation(); deleteRec(id); }
      else if (act === 'down') { e.stopPropagation(); downloadRec(id); }
      else openLightbox(id);
    });
  });
}

async function toggleFav(id) {
  const rec = await ImgStore.get(id);
  if (!rec) return;
  await ImgStore.update(id, { favorite: !rec.favorite });
  const row = S.library.find(r => r.id === id);
  if (row) row.favorite = !rec.favorite;
  renderLibrary();
}

async function deleteRec(id) {
  const rec = await ImgStore.get(id);
  if (!rec) return;
  if (!confirm('删除这张图片？')) return;
  await ImgStore.remove(id);
  S.library = S.library.filter(r => r.id !== id);
  renderLibrary();
  await refreshLibraryCount();
  await refreshStorage();
  toast('已删除', 'ok');
}

async function downloadRec(id) {
  const rec = await ImgStore.get(id);
  if (!rec) return;
  const url = ImgStore.bufferToURL(rec.full, rec.mime);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ai-${id}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ================================================================ 灯箱 */
function bindLightbox() {
  $('lbClose').addEventListener('click', closeLightbox);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('lightbox').hidden) closeLightbox();
      else closePop();
    }
  });
}

let lbURL = null;

async function openLightbox(id) {
  const rec = await ImgStore.get(id);
  if (!rec) { toast('记录已不存在', 'err'); return; }
  S.lbId = id;
  if (lbURL) URL.revokeObjectURL(lbURL);
  lbURL = ImgStore.bufferToURL(rec.full, rec.mime);
  $('lbImg').src = lbURL;
  $('lbPrompt').textContent = rec.prompt || '（无提示词）';
  $('lbMeta').innerHTML = [
    rec.size && `尺寸 ${esc(rec.size)}`,
    rec.model && `模型 ${esc(rec.model)}`,
    rec.toolName && `工具 ${esc(rec.toolName)}`,
    rec.usedRef && '含参照图',
    rec.width && `${rec.width}×${rec.height}`,
    fmtSize(rec.bytes),
    fmtTime(rec.createdAt),
  ].filter(Boolean).map(t => `<span class="tag">${t}</span>`).join('');
  $('lbFavText').textContent = rec.favorite ? '取消收藏' : '收藏';
  $('lbFav').classList.toggle('on', rec.favorite);
  $('lightbox').hidden = false;
}

function closeLightbox() {
  $('lightbox').hidden = true;
  $('lbImg').removeAttribute('src');
  if (lbURL) { URL.revokeObjectURL(lbURL); lbURL = null; }
  S.lbId = null;
}

document.addEventListener('click', async (e) => {
  const id = S.lbId;
  if (!id) return;
  if (e.target.closest('#lbFav')) {
    await toggleFav(id); await openLightbox(id);
  } else if (e.target.closest('#lbDown')) {
    await downloadRec(id);
  } else if (e.target.closest('#lbDel')) {
    await deleteRec(id); closeLightbox();
  }
});

})();
