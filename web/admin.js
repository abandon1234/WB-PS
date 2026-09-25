/* ==========================================================================
   图像工坊 · 后台管理交互
   与生成页完全独立：独立页面、独立静态资源、独立接口前缀（/api/admin/*）
   ========================================================================== */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  providers: [],
  activeId: null,
  editingId: null,
  mode: 'login',        // login | setup
  busy: false,
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

/** 统一请求：跨域凭证带上，401 一律回到登录态 */
async function api(url, opt = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...opt });
  let body = null;
  try { body = await r.json(); } catch (_) { /* 非 JSON */ }
  if (!r.ok) {
    const d = (body && body.detail) || {};
    const err = new Error(typeof d === 'string' ? d : (d.message || `HTTP ${r.status}`));
    err.status = r.status;
    err.hint = typeof d === 'object' ? (d.hint || '') : '';
    if (r.status === 401) setTimeout(showGate, 0);
    throw err;
  }
  return body;
}
const postJSON = (url, data, method = 'POST') => api(url, {
  method, headers: { 'Content-Type': 'application/json' },
  body: data === undefined ? undefined : JSON.stringify(data),
});

function showGate() {
  $('shell').hidden = true;
  $('gate').hidden = false;
}
function showShell() {
  $('gate').hidden = true;
  $('shell').hidden = false;
}

/* ================================================================ 启动 */
(async function init() {
  bindGate();
  bindRail();
  bindProviders();
  bindSecurity();

  let st;
  try {
    st = await api('/api/admin/status');
  } catch (e) {
    gateMsg('无法连接服务：' + e.message, 'err');
    return;
  }
  if (st.needs_setup) { renderGate('setup', st); return; }
  if (!st.authenticated) { renderGate('login', st); return; }
  await enterShell(st);
})();

/* ================================================================ 登录门 */
function bindGate() {
  $('gateEye').addEventListener('click', () => {
    const el = $('gatePw');
    el.type = el.type === 'password' ? 'text' : 'password';
  });
  $('gateForm').addEventListener('submit', (e) => { e.preventDefault(); submitGate(); });
}

function renderGate(mode, st) {
  S.mode = mode;
  showGate();
  $('gateEye').hidden = false;

  if (mode === 'setup') {
    $('gateTitle').textContent = '设置管理密码';
    $('gateDesc').textContent =
      '这是后台的首次使用。请设定一个管理密码——它只用于进入本页，'
      + '与中转站的 API Key 无关。密码以 PBKDF2 哈希保存在本机 data/admin.json，'
      + '服务端不存明文，也没有任何默认口令。';
    $('pwLabel').textContent = '设定密码';
    $('gatePw').placeholder = `至少 ${st.min_password_len || 6} 位`;
    $('gatePw').autocomplete = 'new-password';
    $('pw2Wrap').hidden = false;
    $('gateSubmit').textContent = '设置并进入';
    $('gateHint').textContent = '忘记密码时：停止服务 → 删除 data/admin.json → 重启后重新设置';
  } else {
    $('gateTitle').textContent = '后台登录';
    $('gateDesc').textContent =
      '这里可以管理中转站地址与 API Key。密钥只在服务端使用，'
      + '不会下发到生成页，也不用担心被前端看到。';
    $('pwLabel').textContent = '管理密码';
    $('gatePw').placeholder = '请输入密码';
    $('gatePw').autocomplete = 'current-password';
    $('pw2Wrap').hidden = true;
    $('gateSubmit').textContent = '登录';
  }
  $('gatePw').value = '';
  $('gatePw2').value = '';
  gateMsg('', '');
  setTimeout(() => $('gatePw').focus(), 80);
}

function gateMsg(text, kind) {
  const el = $('gateMsg');
  el.hidden = !text;
  el.className = 'inline-msg ' + (kind || 'err');
  el.textContent = text || '';
}

async function submitGate() {
  if (S.busy) return;
  const pw = $('gatePw').value;
  if (!pw) { gateMsg('请输入密码'); return; }

  let body = { password: pw };
  if (S.mode === 'setup') {
    if (pw.length < 6) { gateMsg('密码至少 6 位'); return; }
    if (pw !== $('gatePw2').value) { gateMsg('两次输入的密码不一致'); return; }
    body = { password: pw };
  }

  S.busy = true;
  $('gateSubmit').disabled = true;
  try {
    const url = S.mode === 'setup' ? '/api/admin/setup' : '/api/admin/login';
    const r = await postJSON(url, body);
    toast(r.message || '已进入后台', 'ok');
    await enterShell();
  } catch (e) {
    gateMsg(e.message + (e.hint ? `　${e.hint}` : ''));
  } finally {
    S.busy = false;
    $('gateSubmit').disabled = false;
  }
}

/* ================================================================ 主界面 */
async function enterShell() {
  showShell();
  await Promise.all([loadSystem(), loadProviders()]);
}

function bindRail() {
  document.querySelectorAll('.rail-item').forEach(el => {
    el.addEventListener('click', () => switchPage(el.dataset.page));
  });
  $('btnLogout').addEventListener('click', async () => {
    try { await postJSON('/api/admin/logout', {}); } catch (_) { /* 忽略 */ }
    toast('已退出登录');
    const st = await api('/api/admin/status').catch(() => ({ needs_setup: false }));
    renderGate('login', st);
  });
}

function switchPage(p) {
  document.querySelectorAll('.rail-item').forEach(el =>
    el.classList.toggle('on', el.dataset.page === p));
  $('pageOverview').hidden = p !== 'overview';
  $('pageProviders').hidden = p !== 'providers';
  $('pageSecurity').hidden = p !== 'security';
}

/* ================================================================ 概览 */
async function loadSystem() {
  let d;
  try { d = await api('/api/admin/system'); }
  catch (e) { toast('读取系统信息失败：' + e.message, 'err'); return; }

  $('stats').innerHTML = `
    <div class="stat"><div class="k">配置总数</div><div class="v">${d.provider_count}</div>
      <div class="s">其中启用 ${d.enabled_count} 条</div></div>
    <div class="stat"><div class="k">当前使用</div>
      <div class="v sm">${esc(d.active_name || '未启用')}</div>
      <div class="s">${esc(d.active_model || '—')}</div></div>
    <div class="stat"><div class="k">生成结果留存</div>
      <div class="v sm" style="color:var(--ok)">服务端不保存</div>
      <div class="s">图片由浏览器本机存储</div></div>
    <div class="stat"><div class="k">配置文件</div>
      <div class="v sm" style="font-family:var(--mono);font-size:12px">data/image_providers.json</div>
      <div class="s">${d.data_dir_exists ? '目录已就绪' : '目录尚未创建'}</div></div>`;

  $('factConfigFile').textContent = d.config_file || '—';
  $('factTtl').textContent = `登录后 12 小时内有效，过期需重新登录。`;
  renderActivePill();
}

function renderActivePill() {
  const p = S.providers.find(x => x.id === S.activeId);
  const el = $('tbActive');
  el.className = 'pill ' + (p ? 'ok' : 'warn');
  el.querySelector('span').textContent = p ? `${p.name} · ${p.model}` : '未启用任何配置';
  el.title = p ? p.base_url : '请到「中转站配置」启用一条';
}

/* ================================================================ 配置列表 */
function bindProviders() {
  $('btnAdd').addEventListener('click', () => openForm(null));
  $('btnCancelForm').addEventListener('click', closeForm);
  $('pform').addEventListener('submit', (e) => { e.preventDefault(); saveForm(false); });
  $('btnTestInline').addEventListener('click', () => saveForm(true));
  $('btnEye').addEventListener('click', () => {
    const el = $('fKey');
    el.type = el.type === 'password' ? 'text' : 'password';
    $('btnEye').querySelector('use').setAttribute('href',
      el.type === 'password' ? '#i-eye' : '#i-eye-off');
  });
}

async function loadProviders() {
  try {
    const d = await api('/api/admin/providers');
    S.providers = d.providers || [];
    S.activeId = d.active_id || null;
  } catch (e) {
    toast('读取配置失败：' + e.message, 'err');
    return;
  }
  renderProviders();
  renderActivePill();
}

function renderProviders() {
  const box = $('plist');
  if (!S.providers.length) {
    box.innerHTML = `<div class="inline-msg info">
      还没有任何配置。点击右上角「新增配置」，填入中转站地址与 API Key 即可开始使用。</div>`;
    return;
  }
  box.innerHTML = S.providers.map(p => `
    <div class="pcard${p.id === S.activeId ? ' active' : ''}${p.enabled ? '' : ' off'}" data-id="${p.id}">
      <div class="pcard-top">
        <span class="pcard-name">${esc(p.name)}</span>
        ${p.id === S.activeId ? '<span class="badge current">使用中</span>' : ''}
        <span class="badge ${p.enabled ? 'ok' : 'off'}">${p.enabled ? '已启用' : '已禁用'}</span>
        <span class="acts">
          ${p.enabled && p.id !== S.activeId
            ? '<button class="btn sm" data-act="activate"><svg class="ic" viewBox="0 0 24 24"><use href="#i-bolt"/></svg>设为使用</button>' : ''}
          <button class="btn sm ghost" data-act="test"><svg class="ic" viewBox="0 0 24 24"><use href="#i-check"/></svg>测试</button>
          <button class="btn sm ghost" data-act="toggle">${p.enabled ? '禁用' : '启用'}</button>
          <button class="btn sm ghost" data-act="edit"><svg class="ic" viewBox="0 0 24 24"><use href="#i-edit"/></svg></button>
          <button class="btn sm danger" data-act="del"><svg class="ic" viewBox="0 0 24 24"><use href="#i-trash"/></svg></button>
        </span>
      </div>
      <div class="pcard-rows">
        <div class="row"><span class="k">地址</span><span class="v mono">${esc(p.base_url)}</span></div>
        <div class="row"><span class="k">模型</span><span class="v mono">${esc(p.model)}</span></div>
        <div class="row"><span class="k">Key</span><span class="v mono">${esc(p.api_key || '（未设置）')}</span></div>
        ${p.note ? `<div class="row"><span class="k">备注</span><span class="v">${esc(p.note)}</span></div>` : ''}
      </div>
      <div class="inline-msg" data-msg hidden></div>
    </div>`).join('');

  box.querySelectorAll('.pcard').forEach(card => {
    card.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      e.stopPropagation();
      cardAction(card.dataset.id, btn.dataset.act, card);
    });
  });
}

async function cardAction(id, act, card) {
  const p = S.providers.find(x => x.id === id);
  if (!p) return;
  const msg = card.querySelector('[data-msg]');
  const setMsg = (text, kind) => {
    msg.hidden = false; msg.className = 'inline-msg ' + kind; msg.textContent = text;
  };

  try {
    if (act === 'toggle') {
      const r = await postJSON(`/api/admin/providers/${id}/toggle`, {});
      S.providers = r.providers; S.activeId = r.active_id || null;
      renderProviders(); renderActivePill();
      toast(p.enabled ? '已禁用' : '已启用', 'ok');

    } else if (act === 'activate') {
      const r = await postJSON(`/api/admin/providers/${id}/activate`, {});
      S.providers = r.providers; S.activeId = r.active_id;
      renderProviders(); renderActivePill();
      toast(`已切换到「${p.name}」`, 'ok');

    } else if (act === 'test') {
      setMsg('正在测试连接…', 'info');
      const r = await postJSON(`/api/admin/providers/${id}/test`, {});
      const info = r.result || {};
      if (info.model_found === false) {
        setMsg(`连接成功（${info.elapsed}s · ${info.model_count} 个模型），`
          + `但没有找到模型「${p.model}」`
          + (info.matched?.length ? `；相近的有：${info.matched.join('、')}` : ''), 'err');
      } else {
        setMsg(`连接正常 · 耗时 ${info.elapsed}s · 可用模型 ${info.model_count} 个`
          + (info.model_found ? ` · 已找到 ${p.model}` : ''), 'ok');
      }

    } else if (act === 'edit') {
      openForm(p);

    } else if (act === 'del') {
      if (!confirm(`确定删除配置「${p.name}」？此操作不可撤销。`)) return;
      const r = await postJSON(`/api/admin/providers/${id}`, undefined, 'DELETE');
      S.providers = r.providers;
      S.activeId = r.active_id || null;
      renderProviders(); renderActivePill();
      closeForm();
      toast('已删除', 'ok');
    }
  } catch (e) {
    setMsg(e.message + (e.hint ? `　${e.hint}` : ''), 'err');
  }
}

/* ---------------------------------------------------------------- 表单 */
function openForm(p) {
  S.editingId = p ? p.id : null;
  $('formTitle').textContent = p ? '编辑配置' : '新增配置';
  $('fName').value = p?.name || '';
  $('fBase').value = p?.base_url || '';
  $('fKey').value = '';
  $('fModel').value = p?.model || 'gpt-image-2';
  $('fNote').value = p?.note || '';
  $('fEnabled').checked = p ? !!p.enabled : true;
  $('fKey').type = 'password';
  $('btnEye').querySelector('use').setAttribute('href', '#i-eye');
  $('fKey').placeholder = p ? '留空表示不修改当前 Key' : 'sk-...';
  $('keyTip').textContent = p
    ? '出于安全考虑不回显明文，留空即保持不变'
    : '保存后接口只会返回打码值，明文永不出库';
  inlineMsg('', '');
  $('pform').hidden = false;
  switchPage('providers');
  $('pform').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (!p) setTimeout(() => $('fName').focus(), 60);
}
function closeForm() {
  $('pform').hidden = true;
  S.editingId = null;
}
function inlineMsg(text, kind) {
  const m = $('inlineMsg');
  m.hidden = !text;
  m.className = 'inline-msg ' + (kind || '');
  m.textContent = text || '';
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

async function saveForm(thenTest) {
  const data = formPayload();
  if (!data.base_url) return inlineMsg('请填写中转站地址', 'err');
  if (!S.editingId && !data.api_key) return inlineMsg('请填写 API Key', 'err');

  $('btnSave').disabled = true;
  $('btnTestInline').disabled = true;
  try {
    const r = S.editingId
      ? await postJSON(`/api/admin/providers/${S.editingId}`, data, 'PUT')
      : await postJSON('/api/admin/providers', data);
    const savedId = (r.provider && r.provider.id) || S.editingId;
    toast(S.editingId ? '已保存' : '已新增配置', 'ok');
    await loadProviders();

    if (thenTest && savedId) {
      const card = document.querySelector(`.pcard[data-id="${savedId}"]`);
      if (card) await cardAction(savedId, 'test', card);
      S.editingId = savedId;
      $('formTitle').textContent = '编辑配置';
      $('fKey').placeholder = '留空表示不修改当前 Key';
      $('keyTip').textContent = '出于安全考虑不回显明文，留空即保持不变';
    } else {
      closeForm();
    }
  } catch (e) {
    inlineMsg(e.message + (e.hint ? `　${e.hint}` : ''), 'err');
  } finally {
    $('btnSave').disabled = false;
    $('btnTestInline').disabled = false;
  }
}

/* ================================================================ 安全 */
function bindSecurity() {
  $('pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const oldPw = $('pwOld').value;
    const newPw = $('pwNew').value;
    if (!oldPw) return pwMsg('请输入当前密码', 'err');
    if (newPw.length < 6) return pwMsg('新密码至少 6 位', 'err');
    if (newPw !== $('pwNew2').value) return pwMsg('两次输入的新密码不一致', 'err');

    $('btnPwSave').disabled = true;
    try {
      const r = await postJSON('/api/admin/password',
        { old_password: oldPw, new_password: newPw });
      pwMsg(r.message || '密码已更新', 'ok');
      $('pwOld').value = ''; $('pwNew').value = ''; $('pwNew2').value = '';
      toast('密码已更新', 'ok');
    } catch (e2) {
      pwMsg(e2.message + (e2.hint ? `　${e2.hint}` : ''), 'err');
    } finally {
      $('btnPwSave').disabled = false;
    }
  });
}
function pwMsg(text, kind) {
  const m = $('pwMsg');
  m.hidden = false;
  m.className = 'inline-msg ' + kind;
  m.textContent = text;
}

})();
