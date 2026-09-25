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
const TOOLS = [
  {
    id: 'create', name: '自由生成', icon: '#i-spark',
    title: 'AI 图片生成',
    desc: '用一段提示词直接生成全新画面。描述越具体越容易得到想要的效果：主体 + 场景 + 风格 + 光线。',
    maxRef: 4, needRef: false,
    placeholder: '描述你想生成的画面…\n例如：生成一个小狗，坐在草地上，阳光明媚，高清摄影风格',
    chips: ['生成一个小狗', '未来城市夜景，赛博朋克风格，霓虹灯', '极简扁平插画，女孩在窗边看书', '水墨风格的远山与孤舟'],
  },
  {
    id: 'combine', name: '图像融合', icon: '#i-layers',
    title: '图像融合',
    desc: '上传主体图，把它融入你描述的全新场景、背景与光线里。可一次上传多张作为参考，多张会先合成为一张拼图再发送。',
    maxRef: 4, needRef: true,
    placeholder: '描述目标场景…\n例如：把主体放到海边日落场景中，柔和逆光，写实摄影风格',
    chips: ['把主体放到海边日落场景中', '换成纯白背景的电商主图', '融入未来城市霓虹街头', '放进原木桌面的静物场景'],
  },
  {
    id: 'portrait', name: '人物写真', icon: '#i-person',
    title: '人物写真',
    desc: '以参照图的人像为基准，生成新的写真风格与场景，保留人物特征。',
    maxRef: 1, needRef: true,
    placeholder: '描述想要的写真风格…\n例如：日系胶片质感，浅景深，窗边自然光',
    chips: ['日系胶片质感，浅景深', '正装职业照，纯灰背景', '户外逆光，暖色调'],
  },
  {
    id: 'product', name: '商品图', icon: '#i-box',
    title: '商品图生成',
    desc: '把商品放进干净有质感的场景，适合电商主图与详情页。',
    maxRef: 1, needRef: true,
    placeholder: '描述商品与场景…\n例如：大理石台面，柔和顶光，极简高级感',
    chips: ['大理石台面，柔和顶光', '纯白背景无阴影', '原木与绿植的自然场景'],
  },
];

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
  size: '1024x1024',
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
  lastPrompt: '',
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

async function api(url, opt = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...opt });
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
  buildToolNav();
  bindSidebar();
  bindRefs();
  bindPrompt();
  bindPills();
  bindGenerate();
  bindResult();
  bindProjects();
  bindLightbox();

  $('genKey').textContent = modKey + '3';
  $('prompt').placeholder = S.tool.placeholder;

  try {
    S.status = await api('/api/image/status');
  } catch (e) {
    S.status = { ready: false, model: '', message: '无法读取服务状态', hint: e.message };
  }
  if (!S.status.ready) {
    toast(`后台未就绪：${S.status.message}`, 'warn');
  }

  await refreshLibraryCount();
  await refreshStorage();
  renderToolChips();
})();

/* ================================================================ 侧栏 */
function buildToolNav() {
  $('toolNav').innerHTML = TOOLS.map(t => `
    <button class="sb-item${t.id === S.tool.id ? ' on' : ''}" data-tool="${t.id}">
      <svg class="ic" viewBox="0 0 24 24"><use href="${t.icon}"/></svg>
      <span>${esc(t.name)}</span>
    </button>`).join('');
  $('toolNav').querySelectorAll('[data-tool]').forEach(el => {
    el.addEventListener('click', () => selectTool(el.dataset.tool));
  });
}

function selectTool(id) {
  const t = TOOLS.find(x => x.id === id);
  if (!t) return;
  // 从「作品库」点工具时要能切回生成视图——之前这里提前 return，
  // 导致在作品库里点当前已选中的工具没有任何反应。
  if (S.view !== 'generate') switchView('generate');
  if (t.id === S.tool.id) return;

  S.tool = t;
  $('toolNav').querySelectorAll('[data-tool]').forEach(el =>
    el.classList.toggle('on', el.dataset.tool === id));
  $('toolTitle').textContent = t.title;
  $('toolDesc').textContent = t.desc;
  $('prompt').placeholder = t.placeholder;
  // 超出新工具上限的参照图自动裁掉
  while (S.refs.length > t.maxRef) removeRef(S.refs.length - 1);
  renderToolChips();
  closePop();
}

function bindSidebar() {
  $('btnCollapse').addEventListener('click', () => {
    const c = document.querySelector('.app').classList.toggle('collapsed');
    localStorage.setItem('wb.sbCollapsed', c ? '1' : '0');
  });
  if (localStorage.getItem('wb.sbCollapsed') === '1') {
    document.querySelector('.app').classList.add('collapsed');
  }
  document.querySelectorAll('[data-view]').forEach(el => {
    el.addEventListener('click', () => switchView(el.dataset.view));
  });
}

function switchView(v) {
  S.view = v;
  $('viewGenerate').hidden = v !== 'generate';
  $('viewProjects').hidden = v !== 'projects';
  document.querySelectorAll('.sb-item').forEach(el => {
    const isView = el.dataset.view;
    if (isView) el.classList.toggle('on', isView === v);
    else if (v !== 'generate') el.classList.remove('on');
  });
  document.querySelectorAll('#toolNav [data-tool]').forEach(el =>
    el.classList.toggle('on', v === 'generate' && el.dataset.tool === S.tool.id));
  // 深链：/image#projects
  history.replaceState(null, '', v === 'projects' ? '#projects' : location.pathname);
  if (v === 'projects') refreshLibrary();
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
  const room = S.tool.maxRef - S.refs.length;
  if (room <= 0) {
    toast(`「${S.tool.name}」最多 ${S.tool.maxRef} 张参照图`, 'warn');
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

function removeRef(i) {
  const r = S.refs[i];
  if (!r) return;
  URL.revokeObjectURL(r.url);
  S.refs.splice(i, 1);
  renderRefs();
}

function renderRefs() {
  const box = $('refStrip');
  $('refCount').textContent = `${S.refs.length}/${S.tool.maxRef}`;
  if (!S.refs.length) { box.hidden = true; box.innerHTML = ''; return; }
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

/* ================================================================ 提示词 */
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
function closePop() { $('popWrap').hidden = true; }

function openPop(anchor, items, title) {
  const wrap = $('popWrap');
  wrap.hidden = false;
  const old = document.querySelector('.pop');
  if (old) old.remove();

  const pop = document.createElement('div');
  pop.className = 'pop';
  pop.innerHTML = (title ? `<div class="pop-title">${esc(title)}</div>` : '')
    + items.map(it => `<button data-v="${esc(it.v)}" class="${it.on ? 'on' : ''}">
         <svg class="ic" viewBox="0 0 24 24"><use href="#i-check"/></svg>
         <span>${esc(it.label)}</span></button>`).join('');
  document.body.appendChild(pop);

  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px';
  const top = r.top - pop.offsetHeight - 8;
  pop.style.top = (top < 8 ? r.bottom + 8 : top) + 'px';

  pop.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    closePop();
    anchor.dispatchEvent(new CustomEvent('picked', { detail: b.dataset.v }));
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
    $('pillSizeText').textContent =
      (SIZES.find(s => s.v === S.size) || {}).label || S.size;
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
  const prompt = $('prompt').value.trim();
  if (!prompt) { toast('请先填写提示词', 'err'); $('prompt').focus(); return; }
  if (S.status && !S.status.ready) {
    toast(`后台未就绪：${S.status.message}`, 'err');
    return;
  }
  if (S.tool.needRef && !S.refs.length) {
    toast(`「${S.tool.name}」需要至少上传 1 张参照图`, 'err');
    return;
  }

  S.lastPrompt = prompt;
  setBusy(true);
  showState('stateLoading');
  startTimer();
  $('loadingTitle').textContent = S.refs.length ? '正在按参照图生成…' : '正在生成…';
  $('loadingSub').textContent =
    `模型 ${S.status?.model || '—'} · ${S.size === 'auto' ? '自动尺寸' : S.size} · ${S.count} 张`
    + (S.refs.length > 1 ? ` · 已把 ${S.refs.length} 张参照图合成为拼图` : '');
  $('skGrid').innerHTML = Array.from({ length: S.count }, () => '<div class="sk"></div>').join('');

  const fd = new FormData();
  fd.append('prompt', prompt);
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
  $('resSize').textContent = `尺寸 ${res.size || S.size}`;
  $('resModel').textContent = res.model || '—';
  $('resElapsed').textContent = `耗时 ${res.elapsed}s`;
  $('resRef').hidden = !res.used_reference;
  $('resPrompt').textContent = S.lastPrompt;
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

async function refreshLibraryCount() {
  if (!window.ImgStore) return;
  try {
    $('projCount').textContent = await ImgStore.count();
  } catch (_) { $('projCount').textContent = '0'; }
}

async function refreshStorage() {
  if (!window.ImgStore) return;
  try {
    const used = await ImgStore.usage();
    $('storageBox').hidden = false;
    $('storageText').textContent = fmtSize(used);
    const q = await ImgStore.quota();
    const pct = q && q.quota ? Math.min(100, (used / q.quota) * 100) : 0;
    $('storageBar').style.width = (q ? pct : (used ? 6 : 0)) + '%';
    if (q && pct > 80) toast('浏览器存储空间将满，建议清理作品库', 'warn');
  } catch (_) { /* 忽略 */ }
}

async function refreshLibrary() {
  if (!window.ImgStore) return;
  try {
    S.library = await ImgStore.list();
  } catch (e) {
    S.library = [];
    toast('读取本机作品库失败：' + e.message, 'err');
  }
  $('projCount').textContent = S.library.length;
  renderLibrary();
  refreshStorage();          // 不 await：容量统计不必阻塞画廊渲染
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
