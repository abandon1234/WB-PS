/* ==========================================================================
   WB-PS · 本地引擎引导

   页面加载时**不做任何重活**：40MB 模型 + 27MB 运行时，一上来就下会让
   首屏白等十几秒。这里只登记一个门面，等用户真正拖入图片（第一次调
   /api/analyze）时才初始化。

   暴露给非 module 脚本（web/app.js 是 IIFE）的接口：
     window.WBLocal.ready           引擎是否就绪
     window.WBLocal.progress        可赋值 (p) => {}，接收加载进度
     window.WBLocal.ensure()        手动预热（返回 Promise）
     window.WBLocal.handle(url, body)  —— 返回 undefined 表示本地不处理
   ========================================================================== */
import { LocalEngine } from './index.js';
import { LocalApi } from './localapi.js';
import { ModelStore, registerServiceWorker } from '../modelstore.js';

const state = { api: null, engine: null, loading: null, error: null };

/** 带进度地把资源备齐（没缓存就下，下过就跳过），然后装配引擎 */
async function ensureEngine(onProgress = () => {}) {
  if (state.api) return state.api;
  if (state.loading) return state.loading;

  state.loading = (async () => {
    try {
      const store = new ModelStore();

      onProgress({ phase: 'sw', label: '准备离线缓存' });
      const reg = await registerServiceWorker();
      if (reg) {
        // 没被 SW 接管的页面，fetch 不走 SW，下了也进不了缓存 —— 必须等接管
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) {
          await new Promise((res) => {
            const t = setTimeout(res, 3000);
            navigator.serviceWorker.addEventListener('controllerchange',
              () => { clearTimeout(t); res(); }, { once: true });
          });
        }
      }

      const st = await store.status();
      if (!st.complete) {
        onProgress({ phase: 'download', done: 0, total: st.missingBytes, label: '下载模型' });
        await store.persist();
        await store.download(onProgress);
      }

      onProgress({ phase: 'engine', label: '装配引擎' });
      const engine = await LocalEngine.create({ base: '/assets', onProgress });
      state.engine = engine;
      state.api = new LocalApi(engine);
      onProgress({ phase: 'ready', label: '就绪' });
      window.dispatchEvent(new CustomEvent('wb-local-ready'));
      return state.api;
    } catch (err) {
      state.error = err;
      state.loading = null;
      onProgress({ phase: 'error', label: String((err && err.message) || err) });
      throw err;
    }
  })();

  return state.loading;
}

window.WBLocal = {
  get ready() { return !!state.api; },
  get error() { return state.error; },
  get engine() { return state.engine; },

  /** 进度回调，宿主页面可覆盖 */
  progress: null,

  ensure() {
    return ensureEngine(this.progress || (() => {}));
  },

  async handle(url, body) {
    const api = await ensureEngine(this.progress || (() => {}));
    return api.handle(url, body);
  },

  /** 导出成图（返回 Blob，不走 handle 的 JSON 通道） */
  async exportBlob(body) {
    const api = await ensureEngine(this.progress || (() => {}));
    return api.exportBlob(body);
  },
};

// 页面空闲时悄悄预热：用户拖图之前模型多半已经就位
if ('requestIdleCallback' in window) {
  requestIdleCallback(() => { ensureEngine(() => {}).catch(() => {}); }, { timeout: 4000 });
} else {
  setTimeout(() => { ensureEngine(() => {}).catch(() => {}); }, 2500);
}
