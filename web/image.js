/* ==========================================================================
   图像工坊 · 前端交互
   ========================================================================== */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = (n) => n < 1024 ? n + ' B'
  : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(2) + ' MB';

/* ---------------------------------------------------------------- 状态 */
const S = {
  providers: [],
  activeId: null,
  editingId: null,          // null = 新增
  size: '1024x1024',
  count: 1,
  refFile: null,
  refUrl: null,
  images: [],               // [{data_url, url, bytes}]
  current: 0,
  busy: false,
  timer: null,
  startedAt: 0,
  controller: null,
  lastPrompt: '',
  lastMeta: {},
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
  }, 2600);
}

async function api(url, opt = {}) {
  const r = await fetch(url, opt);
  let body = null;
  try { body = await r.json(); } catch (_) {}
  if (!r.ok) {
    const d = (body && body.detail) || {};
    const err = new Error(
      typeof d === 'string' ? d : (d.message || `HTTP ${r.status}`));
    err.status = r.status;
    err.detail = typeof d === 'object' ? d.detail : '';
    err.hint = typeof d === 'object' ? d.hint : '';
    throw err;
  }
  return body;
}
const postJSON = (url, data, method = 'POST') => api(url, {
  method, headers: { 'Content-Type': 'application/json' },
  body: data === undefined ? undefined : JSON.stringify(data),
});

function showState(which) {
  ['stateEmpty', 'stateLoading', 'stateError'].forEach(id => {
    $(id).hidden = (id !== which);
  });
  $('result').hidden = (which !== null);
}

/* ---------------------------------------------------------------- 初始化 */
(async function init() {
  bindPrompt();
  bindRef();
  bindParams();
  bindGenerate();
  bindResult();
  bindDrawer();

  try {
    const ov = await api('/api/image/overview');
    S.providers = ov.providers || [];
    S.activeId = ov.active_id || null;
    renderProviderChip();
    renderProviderList();
  } catch (e) {
    toast('无法读取配置：' + e.message, 'err');
  }
})();

/* ---------------------------------------------------------------- 提示词 */
function bindPrompt() {
  const ta = $('prompt');
  const upd = () => {
    $('promptCount').textContent = `${ta.value.length} / 4000`;
  };
  ta.addEventListener('input', upd);
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); generate(); }
  });
  upd();

  $('quickPrompts').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    ta.value = b.dataset.p || '';
    ta.dispatchEvent(new Event('input'));
    ta.focus();
  });
}

/* ---------------------------------------------------------------- 参照图 */
function bindRef() {
  const dz = $('dropzone');
  const inp = $('refInput');

  inp.addEventListener('change', (e) => {
    if (e.target.files?.[0]) setRef(e.target.files[0]);
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
  dz.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) setRef(f);
  });

  $('btnClearRef').addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    clearRef();
  });
}

function setRef(file) {
  if (!file.type.startsWith('image/')) { toast('请选择图片文件', 'err'); return; }
  if (file.size > 8 * 1024 * 1024) { toast('参照图超过 8MB，请压缩后再用', 'err'); return; }
  if (S.refUrl) URL.revokeObjectURL(S.refUrl);
  S.refFile = file;
  S.refUrl = URL.createObjectURL(file);
  $('refThumb').src = S.refUrl;
  $('refName').textContent = file.name;
  $('refSize').textContent = `${fmtSize(file.size)} · ${file.type.replace('image/', '').toUpperCase()}`;
  $('dzEmpty').hidden = true;
  $('dzPreview').hidden = false;
  $('btnClearRef').hidden = false;
}

function clearRef() {
  if (S.refUrl) URL.revokeObjectURL(S.refUrl);
  S.refFile = null; S.refUrl = null;
  $('refThumb').removeAttribute('src');
  $('dzPreview').hidden = true;
  $('dzEmpty').hidden = false;
  $('btnClearRef').hidden = true;
  $('refInput').value = '';
}

/* ---------------------------------------------------------------- 参数 */
function bindParams() {
  const wire = (id, key, cast = (v) => v) => {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      [...$(id).children].forEach(x => x.classList.toggle('on', x === b));
      S[key] = cast(b.dataset.v);
    });
  };
  wire('segSize', 'size');
  wire('segCount', 'count', Number);
}

/* ---------------------------------------------------------------- 生成 */
function bindGenerate() {
  $('btnGenerate').addEventListener('click', generate);
  $('btnCancel').addEventListener('click', cancel);
  $('btnRetry').addEventListener('click', generate);
  $('btnAgain').addEventListener('click', generate);
  $('btnOpenConfig2').addEventListener('click', openDrawer);
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
  $('btnGenerate').disabled = on;
  $('btnGenerate').hidden = on;
  $('btnCancel').hidden = !on;
  $('genHint').textContent = on
    ? '正在生成，可点击取消'
    : '约需 30~60 秒，请保持页面打开';
}

async function generate() {
  if (S.busy) return;
  const prompt = $('prompt').value.trim();
  if (!prompt) {
    toast('请先填写提示词', 'err');
    $('prompt').focus();
    return;
  }
  if (!S.providers.some(p => p.enabled)) {
    toast('没有启用的中转站配置', 'err');
    openDrawer();
    return;
  }

  S.lastPrompt = prompt;
  setBusy(true);
  showState('stateLoading');
  startTimer();

  // 骨架屏：按生成数量给格子
  const sk = $('skeletonGrid');
  sk.innerHTML = Array.from({ length: S.count }, () => '<div class="sk"></div>').join('');
  $('loadingTitle').textContent = S.refFile ? '正在按参照图生成…' : '正在生成…';
  $('loadingSub').textContent = `模型：${activeModel()} · 尺寸 ${S.size === 'auto' ? '自动' : S.size} · ${S.count} 张`;

  const fd = new FormData();
  fd.append('prompt', prompt);
  fd.append('size', S.size);
  fd.append('n', String(S.count));
  if (S.activeId) fd.append('provider_id', S.activeId);
  if (S.refFile) fd.append('reference', S.refFile, S.refFile.name);

  S.controller = new AbortController();
  try {
    const res = await api('/api/image/generate', {
      method: 'POST', body: fd, signal: S.controller.signal,
    });
    stopTimer();
    S.images = res.images || [];
    S.current = 0;
    S.lastMeta = res;
    renderResult(res);
    toast(`生成完成，用时 ${res.elapsed}s`, 'ok');
  } catch (e) {
    stopTimer();
    if (e.name === 'AbortError') {
      showState('stateEmpty');
      toast('已取消生成');
    } else {
      renderError(e);
    }
  } finally {
    setBusy(false);
    S.controller = null;
  }
}

function cancel() {
  if (S.controller) S.controller.abort();
  stopTimer();
}

/* ---------------------------------------------------------------- 结果 */
function renderResult(res) {
  showState(null);
  $('resSize').textContent = `尺寸 ${res.size || S.size}`;
  $('resModel').textContent = res.model || activeModel();
  $('resElapsed').textContent = `耗时 ${res.elapsed}s`;
  $('resRef').hidden = !res.used_reference;
  $('resPrompt').textContent = S.lastPrompt;

  const revised = (res.images?.[0]?.revised_prompt) || '';
  $('resRevisedWrap').hidden = !revised;
  $('resRevised').textContent = revised;

  showImage(0);
  renderThumbs();
}

function showImage(i) {
  S.current = i;
  const img = S.images[i];
  if (!img) return;
  $('resultImg').src = img.data_url || img.url || '';
  [...$('thumbs').children].forEach((el, k) => el.classList.toggle('on', k === i));
}

function renderThumbs() {
  const box = $('thumbs');
  if (S.images.length <= 1) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = S.images.map((im, i) =>
    `<div class="thumb${i === 0 ? ' on' : ''}" data-i="${i}">
       <img src="${esc(im.data_url || im.url)}" alt="结果 ${i + 1}">
     </div>`).join('');
  [...box.children].forEach(el => el.addEventListener('click', () => showImage(+el.dataset.i)));
}

function bindResult() {
  $('btnDownload').addEventListener('click', () => {
    const img = S.images[S.current];
    if (!img) return;
    const a = document.createElement('a');
    a.href = img.data_url || img.url;
    a.download = `ai-${Date.now()}.png`;
    a.click();
    toast('已开始下载', 'ok');
  });

  $('btnOpenNew').addEventListener('click', () => {
    const img = S.images[S.current];
    if (!img) return;
    const w = window.open('', '_blank');
    if (!w) { toast('浏览器拦截了新窗口', 'err'); return; }
    w.document.write(
      `<title>生成结果</title><body style="margin:0;background:#0d0e14;display:grid;place-items:center;height:100vh">`
      + `<img src="${img.data_url || img.url}" style="max-width:100%;max-height:100%">`);
  });
}

/* ---------------------------------------------------------------- 错误 */
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

/* ---------------------------------------------------------------- 配置 */
function activeProvider() {
  return S.providers.find(p => p.id === S.activeId)
      || S.providers.find(p => p.enabled) || null;
}
function activeModel() {
  return (activeProvider() || {}).model || 'gpt-image-2';
}

function renderProviderChip() {
  const p = activeProvider();
  const chip = $('providerChip');
  if (p) {
    $('providerName').textContent = p.name;
    chip.className = 'provider-chip ok';
    chip.title = `${p.name} · ${p.base_url} · ${p.model}`;
  } else {
    const anyDisabled = S.providers.some(x => x.has_key);
    $('providerName').textContent = anyDisabled ? '配置已全部禁用' : '未配置';
    chip.className = 'provider-chip warn';
    chip.title = '点击右上角「中转站配置」进行设置';
  }
}

function renderProviderList() {
  const box = $('providerList');
  if (!S.providers.length) {
    box.innerHTML = `<div class="inline-msg info">还没有配置。点击下方「新增配置」，填入中转站地址与 API Key 即可开始。</div>`;
    return;
  }
  box.innerHTML = S.providers.map(p => `
    <div class="pcard${p.enabled ? '' : ' disabled'}${p.id === S.activeId ? ' active' : ''}" data-id="${p.id}">
      <div class="pcard-top">
        <span class="pcard-name" title="${esc(p.name)}">${esc(p.name)}</span>
        ${p.id === S.activeId ? '<span class="badge-current">使用中</span>' : ''}
      </div>
      <div class="pcard-rows">
        <div class="pcard-row"><span class="k">地址</span><span class="v">${esc(p.base_url)}</span></div>
        <div class="pcard-row"><span class="k">模型</span><span class="v">${esc(p.model)}</span></div>
        <div class="pcard-row"><span class="k">Key</span><span class="v">${esc(p.api_key || '（未设置）')}</span></div>
        ${p.note ? `<div class="pcard-row"><span class="k">备注</span><span class="v">${esc(p.note)}</span></div>` : ''}
      </div>
      <div class="pcard-actions">
        <button class="mini ${p.enabled ? 'on' : ''}" data-act="toggle">${p.enabled ? '已启用' : '已禁用'}</button>
        ${p.enabled && p.id !== S.activeId ? '<button class="mini" data-act="activate">设为使用</button>' : ''}
        <button class="mini" data-act="test">测试</button>
        <button class="mini" data-act="edit">编辑</button>
        <button class="mini danger" data-act="del">删除</button>
      </div>
      <div class="inline-msg" data-msg hidden></div>
    </div>`).join('');

  box.querySelectorAll('.pcard').forEach(card => {
    const id = card.dataset.id;
    card.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      e.stopPropagation();
      handleCardAction(id, btn.dataset.act, card);
    });
  });
}

async function handleCardAction(id, act, card) {
  const p = S.providers.find(x => x.id === id);
  if (!p) return;
  const msg = card.querySelector('[data-msg]');

  try {
    if (act === 'toggle') {
      const r = await postJSON(`/api/image/providers/${id}/toggle`, {});
      S.providers = r.providers; S.activeId = r.active_id || S.activeId;
      renderProviderList(); renderProviderChip();
      toast(p.enabled ? '已禁用' : '已启用', 'ok');

    } else if (act === 'activate') {
      const r = await postJSON(`/api/image/providers/${id}/activate`, {});
      S.providers = r.providers; S.activeId = r.active_id;
      renderProviderList(); renderProviderChip();
      toast(`已切换到「${p.name}」`, 'ok');

    } else if (act === 'test') {
      msg.hidden = false; msg.className = 'inline-msg info';
      msg.textContent = '正在测试连接…';
      const r = await postJSON(`/api/image/providers/${id}/test`, {});
      const info = r.result || {};
      if (info.model_found === false) {
        msg.className = 'inline-msg err';
        msg.textContent = `连接成功（${info.elapsed}s，${info.model_count} 个模型），`
          + `但没有找到模型「${p.model}」。`
          + (info.matched?.length ? ` 相近的有：${info.matched.join('、')}` : '');
      } else {
        msg.className = 'inline-msg ok';
        msg.textContent = `连接正常 · 耗时 ${info.elapsed}s · 可用模型 ${info.model_count} 个`
          + (info.model_found ? ` · 已找到 ${p.model}` : '');
      }

    } else if (act === 'edit') {
      openForm(p);

    } else if (act === 'del') {
      if (!confirm(`确定删除配置「${p.name}」？此操作不可撤销。`)) return;
      const r = await postJSON(`/api/image/providers/${id}`, undefined, 'DELETE');
      S.providers = r.providers;
      if (S.activeId === id) S.activeId = null;
      renderProviderList(); renderProviderChip();
      toast('已删除', 'ok');
    }
  } catch (e) {
    msg.hidden = false; msg.className = 'inline-msg err';
    msg.textContent = e.message + (e.hint ? ` —— ${e.hint}` : '');
  }
}

/* ---------------------------------------------------------------- 抽屉 */
function bindDrawer() {
  $('btnOpenConfig').addEventListener('click', openDrawer);
  $('btnCloseDrawer').addEventListener('click', closeDrawer);
  $('mask').addEventListener('click', closeDrawer);
  $('btnAdd').addEventListener('click', () => openForm(null));
  $('btnCancelForm').addEventListener('click', closeForm);
  $('btnEye').addEventListener('click', () => {
    const el = $('fKey');
    el.type = el.type === 'password' ? 'text' : 'password';
  });
  $('btnTestInline').addEventListener('click', () => testInline());
  $('pForm').addEventListener('submit', (e) => { e.preventDefault(); saveForm(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('drawer').hidden) closeDrawer();
  });
}

function openDrawer() {
  $('mask').hidden = false;
  $('drawer').hidden = false;
}
function closeDrawer() {
  $('mask').hidden = true;
  $('drawer').hidden = true;
  closeForm();
}

function openForm(p) {
  S.editingId = p ? p.id : null;
  $('formTitle').textContent = p ? '编辑配置' : '新增配置';
  $('fName').value = p?.name || '';
  $('fBase').value = p?.base_url || 'https://code.linlong520.com';
  $('fKey').value = p?.api_key || '';
  $('fModel').value = p?.model || 'gpt-image-2';
  $('fNote').value = p?.note || '';
  $('fEnabled').checked = p ? !!p.enabled : true;
  $('fKey').type = 'password';
  $('keyTip').textContent = p
    ? '留空表示不修改当前 Key'
    : '仅保存在本机 data/ 目录，不会进版本库';
  const m = $('inlineMsg'); m.hidden = true; m.textContent = '';
  $('pForm').hidden = false;
  $('pForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (!p) setTimeout(() => $('fName').focus(), 60);
}
function closeForm() {
  $('pForm').hidden = true;
  S.editingId = null;
}

function formPayload() {
  return {
    name: $('fName').value.trim() || '未命名中转站',
    base_url: $('fBase').value.trim(),
    api_key: $('fKey').value.trim(),
    model: $('fModel').value.trim() || 'gpt-image-2',
    note: $('fNote').value.trim(),
    enabled: $('fEnabled').checked,
  };
}

function inlineMsg(text, kind) {
  const m = $('inlineMsg');
  m.hidden = false; m.className = 'inline-msg ' + kind; m.textContent = text;
}

async function saveForm() {
  const data = formPayload();
  if (!data.base_url) return inlineMsg('请填写中转站地址', 'err');
  if (!S.editingId && !data.api_key) return inlineMsg('请填写 API Key', 'err');

  $('btnSave').disabled = true;
  try {
    const r = S.editingId
      ? await postJSON(`/api/image/providers/${S.editingId}`, data, 'PUT')
      : await postJSON('/api/image/providers', data);
    S.providers = r.providers;
    const ov = await api('/api/image/overview');
    S.activeId = ov.active_id;
    renderProviderList(); renderProviderChip();
    closeForm();
    toast(S.editingId ? '已保存' : '已新增配置', 'ok');
  } catch (e) {
    inlineMsg(e.message + (e.hint ? ` —— ${e.hint}` : ''), 'err');
  } finally {
    $('btnSave').disabled = false;
  }
}

async function testInline() {
  const data = formPayload();
  if (!data.base_url || !data.api_key) {
    return inlineMsg('测试需要先填写地址与 API Key', 'err');
  }
  inlineMsg('正在测试连接…', 'info');
  try {
    // 未保存时用"临时保存再删"的方式太重，这里直接走新增后的测试体验：
    // 先保存（若有编辑则更新），再测试
    const r = S.editingId
      ? await postJSON(`/api/image/providers/${S.editingId}`, data, 'PUT')
      : await postJSON('/api/image/providers', data);
    S.providers = r.providers;
    const id = S.editingId || (r.provider && r.provider.id);
    S.editingId = id;
    const t = await postJSON(`/api/image/providers/${id}/test`, {});
    const info = t.result || {};
    const ov = await api('/api/image/overview');
    S.activeId = ov.active_id;
    renderProviderList(); renderProviderChip();
    $('formTitle').textContent = '编辑配置';
    $('keyTip').textContent = '留空表示不修改当前 Key';
    if (info.model_found === false) {
      inlineMsg(`连接成功（${info.elapsed}s，${info.model_count} 个模型），但没有找到模型「${data.model}」`
        + (info.matched?.length ? `；相近的有：${info.matched.join('、')}` : ''), 'err');
    } else {
      inlineMsg(`连接正常 · 耗时 ${info.elapsed}s · 可用模型 ${info.model_count} 个`
        + (info.model_found ? ` · 已找到 ${data.model}` : ''), 'ok');
    }
  } catch (e) {
    inlineMsg(e.message + (e.hint ? ` —— ${e.hint}` : ''), 'err');
  }
}

})();
