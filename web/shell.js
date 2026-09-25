/* ==========================================================================
   共享外壳 · 侧边栏渲染与交互
   ---------------------------------------------------------------------------
   /（无痕改字）与 /image（图像生成）共用同一套侧边栏，
   导航项直接用 <a href>，所以跨页面跳转、浏览器前进后退都天然可用。
   /admin 不引入本脚本，那边是独立外观。
   ========================================================================== */
window.WBShell = (function () {
  'use strict';

  const KEY = 'wb.sbCollapsed';
  const AUTO_COLLAPSE_BELOW = 1100;

  /* 图标雪碧图：所有页面共用一份，避免每个 HTML 里抄一遍 */
  const SPRITE = `
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <symbol id="i-type" viewBox="0 0 24 24"><path d="M5 6.5V5h14v1.5M12 5v14M9 19h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-spark" viewBox="0 0 24 24"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" fill="currentColor"/></symbol>
  <symbol id="i-layers" viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5 9-5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M3 13l9 5 9-5M3 17l9 5 9-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" opacity=".55"/></symbol>
  <symbol id="i-person" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></symbol>
  <symbol id="i-box" viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" opacity=".6"/></symbol>
  <symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.3c.7 0 1.3.3 1.7.9l.9 1.3h7.1A2.5 2.5 0 0 1 21 9.7v7.8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-10Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></symbol>
  <symbol id="i-image" viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="8.75" cy="10" r="1.75" fill="currentColor"/><path d="M4 17l5-4.5 4 3.5 3-2.5 4 3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></symbol>
  <symbol id="i-upload" viewBox="0 0 24 24"><path d="M12 16V4m0 0 4 4m-4-4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-download" viewBox="0 0 24 24"><path d="M12 4v11m0 0 4-4m-4 4-4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 17v1.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-star" viewBox="0 0 24 24"><path d="M12 3.6l2.6 5.3 5.9.85-4.25 4.15 1 5.85L12 17l-5.25 2.75 1-5.85L3.5 9.75l5.9-.85L12 3.6Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></symbol>
  <symbol id="i-star-fill" viewBox="0 0 24 24"><path d="M12 3.6l2.6 5.3 5.9.85-4.25 4.15 1 5.85L12 17l-5.25 2.75 1-5.85L3.5 9.75l5.9-.85L12 3.6Z" fill="currentColor"/></symbol>
  <symbol id="i-trash" viewBox="0 0 24 24"><path d="M4 7h16M10 7V5.5A1.5 1.5 0 0 1 11.5 4h1A1.5 1.5 0 0 1 14 5.5V7M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 16l4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
  <symbol id="i-close" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></symbol>
  <symbol id="i-expand" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.35-5.65" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M20 4v4.5h-4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3l7 2.8v5.4c0 4.3-2.9 8-7 9.8-4.1-1.8-7-5.5-7-9.8V5.8L12 3Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9.2 12l2 2 3.6-3.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-side" viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9.5 4.5v15" stroke="currentColor" stroke-width="1.7"/></symbol>
  <symbol id="i-chevron" viewBox="0 0 24 24"><path d="M8 10l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
</defs></svg>`;

  /* 侧栏导航：一处定义，两个页面共用 */
  const NAV = [
    { key: 'edit', label: '无痕改字', href: '/', icon: '#i-type', sec: '图片工具' },
    { key: 'create', label: '自由生成', href: '/image#create', icon: '#i-spark', sec: '图片工具' },
    { key: 'combine', label: '图像融合', href: '/image#combine', icon: '#i-layers', sec: '图片工具' },
    { key: 'portrait', label: '人物写真', href: '/image#portrait', icon: '#i-person', sec: '图片工具' },
    { key: 'product', label: '商品图生成', href: '/image#product', icon: '#i-box', sec: '图片工具' },
    { key: 'projects', label: '作品库', href: '/image#projects', icon: '#i-folder', sec: '资源', badge: true },
  ];

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function currentKey() {
    const p = location.pathname.replace(/\/+$/, '') || '/';
    if (p === '/' || p === '/index.html') return 'edit';
    if (p === '/image') {
      const h = location.hash.replace(/^#/, '');
      return NAV.some((n) => n.key === h) ? h : 'create';
    }
    return '';
  }

  function build() {
    const sections = [];
    for (const n of NAV) {
      let sec = sections.find((s) => s.name === n.sec);
      if (!sec) { sec = { name: n.sec, items: [] }; sections.push(sec); }
      sec.items.push(n);
    }
    const active = currentKey();
    const nav = sections.map((sec, i) => `
      ${i ? '<div class="sb-divider"></div>' : ''}
      <div class="sb-section">
        <div class="sb-label">${esc(sec.name)}</div>
        <nav class="sb-nav">
          ${sec.items.map((n) => `
            <a class="sb-item${n.key === active ? ' on' : ''}" href="${n.href}" data-key="${n.key}"
               title="${esc(n.label)}">
              <svg class="ic" viewBox="0 0 24 24"><use href="${n.icon}"/></svg>
              <span>${esc(n.label)}</span>
              ${n.badge ? '<span class="sb-badge" data-role="count">0</span>' : ''}
            </a>`).join('')}
        </nav>
      </div>`).join('');

    return `
      <div class="sb-brand">
        <span class="logo">W</span>
        <span class="brand-name">图像工作台</span>
        <button class="sb-collapse" id="btnCollapse" type="button" title="收起侧栏"
                aria-label="收起侧栏">
          <svg viewBox="0 0 24 24"><use href="#i-side"/></svg>
        </button>
      </div>
      <div class="sb-scroll">${nav}</div>
      <div class="sb-foot">
        <div class="sb-storage" hidden>
          <div class="sb-storage-row"><span>本机占用</span><span data-role="usage">—</span></div>
          <div class="sb-bar"><i data-role="bar"></i></div>
          <p class="sb-note">图片只存在此浏览器，服务器不留存</p>
        </div>
        <a class="sb-admin" href="/admin" target="_blank" rel="noopener">
          <svg class="ic" viewBox="0 0 24 24"><use href="#i-shield"/></svg>
          <span>后台管理</span>
        </a>
      </div>`;
  }

  /* ---------------------------------------------------------------- 容量 */
  const fmtSize = (n) => !n ? '—'
    : n < 1024 ? n + ' B'
    : n < 1048576 ? (n / 1024).toFixed(0) + ' KB'
    : (n / 1048576).toFixed(2) + ' MB';

  async function refresh() {
    const host = document.getElementById('appSidebar');
    if (!host || !window.ImgStore) return;
    const badge = host.querySelector('[data-role=count]');
    const box = host.querySelector('.sb-storage');
    const usageEl = host.querySelector('[data-role=usage]');
    const barEl = host.querySelector('[data-role=bar]');
    try {
      const n = await ImgStore.count();
      if (badge) badge.textContent = n;
      const used = await ImgStore.usage();
      if (box) box.hidden = false;
      if (usageEl) usageEl.textContent = fmtSize(used);
      const q = await ImgStore.quota();
      if (barEl) {
        barEl.style.width = (q && q.quota
          ? Math.min(100, (used / q.quota) * 100)
          : (used ? 6 : 0)) + '%';
      }
    } catch (_) { /* 统计失败不影响使用 */ }
  }

  /* ---------------------------------------------------------------- 折叠 */
  function applyCollapsed(app, on) {
    app.classList.toggle('collapsed', on);
    const btn = app.querySelector('#btnCollapse');
    if (btn) {
      btn.title = on ? '展开侧栏' : '收起侧栏';
      btn.setAttribute('aria-label', btn.title);
    }
  }

  function bindCollapse(app) {
    const saved = localStorage.getItem(KEY);
    // 没有手动设置过，且窗口较窄 → 自动折叠一次；之后完全听用户的
    applyCollapsed(app, saved === null ? innerWidth < AUTO_COLLAPSE_BELOW : saved === '1');

    app.querySelector('#btnCollapse').addEventListener('click', (e) => {
      e.preventDefault();
      const on = !app.classList.contains('collapsed');
      applyCollapsed(app, on);
      localStorage.setItem(KEY, on ? '1' : '0');
    });
  }

  /** 按当前 URL 重画高亮。页内切换工具时由页面主动调用
   *  （history.replaceState 不会触发 hashchange） */
  function syncActive() {
    const host = document.getElementById('appSidebar');
    if (!host) return;
    const key = currentKey();
    host.querySelectorAll('.sb-item').forEach((el) =>
      el.classList.toggle('on', el.dataset.key === key));
  }

  function mount() {
    if (!document.getElementById('wb-shell-sprite')) {
      const wrap = document.createElement('div');
      wrap.id = 'wb-shell-sprite';
      wrap.innerHTML = SPRITE;
      document.body.appendChild(wrap.firstElementChild);
    }
    const host = document.getElementById('appSidebar');
    const app = document.querySelector('.app');
    if (!host || !app) return;
    host.className = 'sidebar';
    host.innerHTML = build();
    bindCollapse(app);
    refresh();

    // 同一页内点当前模块的另一个工具时，只变 hash，需要重画高亮
    window.addEventListener('hashchange', syncActive);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  return { mount, refresh, syncActive, currentKey, NAV, fmtSize };
})();
