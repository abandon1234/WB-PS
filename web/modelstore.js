/* ==========================================================================
   WB-PS · 模型仓库（ModelStore）

   页面与 SW 之间的那层账本：
     - manifest.json 说「应该有哪些文件、多大、什么版本」
     - Cache Storage 说「实际存了哪些」
     两边一对，就知道还差什么、能不能离线用。

   典型用法
   --------
     const store = new ModelStore();
     const st = await store.status();          // { ready, missing, totalBytes, ... }
     if (!st.complete) await store.download(onProgress);

   下载交给浏览器就行：SW 会把每个响应写进缓存，
   这里只负责「按什么顺序、报到多细的进度」。
   ========================================================================== */

export const CACHE_NAME = 'wb-ps-assets-v1';
const MANIFEST_URL = '/assets/manifest.json';

// 资源分档：首屏先要什么、什么可以后台慢慢来。
// 识别模型 11MB 是大头，但它没到之前检测结果也能先画出来，
// 所以标成 lazy，由调用方决定什么时候拉。
export const KIND_ORDER = { core: 0, model: 1, font: 2 };

export class ModelStore {
  constructor({ base = '/assets', manifestUrl = MANIFEST_URL, cacheName = CACHE_NAME } = {}) {
    this.base = base;
    this.manifestUrl = manifestUrl;
    this.cacheName = cacheName;
    this._manifest = null;
  }

  static get supported() {
    return typeof caches !== 'undefined' && 'serviceWorker' in navigator;
  }

  async manifest(force = false) {
    if (this._manifest && !force) return this._manifest;
    const resp = await fetch(this.manifestUrl, force ? { cache: 'reload' } : {});
    if (!resp.ok) throw new Error(`读取资源清单失败：HTTP ${resp.status}`);
    this._manifest = await resp.json();
    return this._manifest;
  }

  /** 缓存命中情况：哪些已就绪、还差多少字节 */
  async status() {
    const mf = await this.manifest();
    const cache = await caches.open(this.cacheName);

    const files = await Promise.all((mf.files || []).map(async (f) => {
      let hit = null;
      try { hit = await cache.match(new URL(f.path, location.origin).href); } catch (_) {}
      return { ...f, cached: !!hit };
    }));

    const ready = files.filter((f) => f.cached);
    const missing = files.filter((f) => !f.cached);
    const sum = (arr) => arr.reduce((n, f) => n + (f.bytes || 0), 0);

    return {
      version: mf.version,
      files,
      ready,
      missing,
      readyBytes: sum(ready),
      missingBytes: sum(missing),
      totalBytes: mf.totalBytes || sum(files),
      complete: missing.length === 0 && files.length > 0,
    };
  }

  /**
   * 预热下载。
   * @param {(p: object) => void} onProgress 进度回调
   * @param {{kinds?: string[], order?: boolean}} opts
   *        kinds 限定只下某几档；order=true 时按「先小后大」排，
   *        让检测模型先到、页面能早点出框。
   */
  async download(onProgress = () => {}, { kinds = null, order = true } = {}) {
    const st = await this.status();
    let list = st.missing;
    if (kinds) list = list.filter((f) => kinds.includes(f.kind));
    if (order) {
      list = [...list].sort((a, b) =>
        (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || (a.bytes || 0) - (b.bytes || 0));
    }

    const total = list.reduce((n, f) => n + (f.bytes || 0), 0);
    let done = 0;

    onProgress({ phase: 'start', total, done: 0, count: list.length });
    for (const f of list) {
      onProgress({ phase: 'file', file: f, label: f.label || f.path, done, total });
      await this._fetchOne(f, (got) => {
        onProgress({ phase: 'progress', file: f, label: f.label || f.path, done: done + got, total });
      });
      done += f.bytes || 0;
      onProgress({ phase: 'file-done', file: f, done, total });
    }

    // 下载读完 ≠ 已落盘。SW 里的 cache.put 是异步的（挂在 waitUntil 上），
    // 最大的识别模型有 10MB，读完那一刻它往往还没写完 —— 这里必须等一下，
    // 否则调用方紧接着去查状态，会看到"少一个文件"，然后重复下载。
    onProgress({ phase: 'settling', done, total, count: list.length });
    const final = await this._awaitPersisted(list.map((f) => f.path));

    onProgress({ phase: 'done', done, total, count: list.length });
    return final;
  }

  /** 轮询等待指定路径全部出现在缓存里 */
  async _awaitPersisted(paths, timeoutMs = 30000) {
    const want = new Set(paths);
    const t0 = Date.now();
    let st = await this.status();
    while (want.size) {
      const cached = new Set(st.files.filter((f) => f.cached).map((f) => f.path));
      for (const p of [...want]) if (cached.has(p)) want.delete(p);
      if (!want.size || Date.now() - t0 > timeoutMs) break;
      await new Promise((r) => setTimeout(r, 200));
      st = await this.status();
    }
    return st;
  }

  /** 单文件带进度下载。响应 body 会被这里读掉，SW 里那份 clone 照常入缓存。 */
  async _fetchOne(f, onBytes) {
    const resp = await fetch(f.path, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`下载失败 ${f.path}：HTTP ${resp.status}`);

    const declared = Number(resp.headers.get('content-length')) || f.bytes || 0;

    // 没有流或没有长度：退化成一次性读完，进度直接跳到完成
    if (!resp.body || !resp.body.getReader || !declared) {
      const buf = await resp.arrayBuffer();
      onBytes(declared || buf.byteLength);
      return;
    }

    const reader = resp.body.getReader();
    let got = 0;
    let lastTick = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      // 每 256KB 报一次，避免进度回调把主线程刷爆
      if (got - lastTick >= 262144) {
        lastTick = got;
        onBytes(got);
      }
    }
    onBytes(Math.max(got, declared));
  }

  /** 本机占用（浏览器给的估算值），用于侧栏那根进度条 */
  async estimate() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    try {
      const e = await navigator.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0 };
    } catch (_) {
      return null;
    }
  }

  /** 确保缓存不会被浏览器自动回收（大模型不适合被当"可牺牲缓存"清掉） */
  async persist() {
    if (!navigator.storage || !navigator.storage.persist) return false;
    try {
      if (await navigator.storage.persisted?.()) return true;
      return await navigator.storage.persist();
    } catch (_) {
      return false;
    }
  }

  async clear() {
    await caches.delete(this.cacheName);
    this._manifest = null;
  }
}

/** 注册 SW。返回注册对象；不支持时返回 null（页面应降级为每次联网下载）。 */
export async function registerServiceWorker(url = '/sw.js') {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register(url, { scope: '/' });
    return reg;
  } catch (err) {
    console.warn('[WB-PS] Service Worker 注册失败，将退化为联网加载模型：', err);
    return null;
  }
}

/** 人类可读的字节数 */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
