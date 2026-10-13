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

   本期（第 0 期）只搭外壳：模式切换 + 深链 + 空态，还没接引擎。
   完整设计与排期见 docs/plan-text-workshop.md。
   ========================================================================== */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);

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

/* 嵌进主页面时，把"显示哪个模式"的能力暴露出去，由 app.js 的视图路由按 hash 调用。
   视图内部的状态仍归本模块管。 */
window.WBText = {
  showKey(key) { setMode(modeOfKey(key), key); },
  get ready() { return S.ready; },
  get mode() { return S.mode; },
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
  S.ready = true;
  // 就绪信号：外层可能因为"视图还没准备好"而把目标视图记成了待切换，
  // 收到这个信号后会补切一次（与 image.js 的 wb-images-ready 同一套机制）。
  window.dispatchEvent(new CustomEvent('wb-text-ready'));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
