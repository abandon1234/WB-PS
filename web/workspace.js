/* ==========================================================================
   无痕改字 · 工作区断点续做
   ---------------------------------------------------------------------------
   切换页面（/ → /image）是整页跳转，js 内存里的状态会全丢，
   回来就只剩一张空画布。这里把工作区落到浏览器本机，切页/刷新后自动接上。

   拆两张表，理由和作品库一样：
     `meta`  —— 轻量状态（session_id / 识别结果 / 改动 / 视图），每次编辑都写
     `image` —— 原图字节，只在换图时写
   如果混在一张表里，每敲一个字都要重写几 MB 的原图。

   数据只在本机，不会回传服务器。
   ========================================================================== */
window.TextWS = (function () {
  'use strict';

  const DB_NAME = 'wb-text-workspace';
  const DB_VER = 1;
  const META = 'meta';
  const IMG = 'image';
  const KEY = 'current';

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('当前浏览器不支持 IndexedDB，无法断点续做'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'k' });
        if (!db.objectStoreNames.contains(IMG)) db.createObjectStore(IMG, { keyPath: 'k' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('无法打开本地数据库'));
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction([META, IMG], mode);
      let out;
      try { out = fn(t.objectStore(META), t.objectStore(IMG)); }
      catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(out);
      t.onabort = () => reject(t.error || new Error('本地写入失败'));
      t.onerror = () => reject(t.error || new Error('本地写入失败'));
    }));
  }

  function req(r) {
    return new Promise((res, rej) => {
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  /* ------------------------------------------------------------ 写入 */

  /** 保存轻量状态（识别结果 + 改动 + 视图），不碰原图 */
  async function saveState(state) {
    return tx('readwrite', (m) => m.put(Object.assign({ k: KEY }, state)));
  }

  /** 保存原图字节。只在换图时调用 */
  async function saveImage(buf, type, name) {
    return tx('readwrite', (_m, i) => i.put({
      k: KEY, buf, type: type || 'image/png', name: name || 'image.png',
      ts: Date.now(),
    }));
  }

  /* ------------------------------------------------------------ 读取 */

  /** 一次读出状态与原图；任缺其一都视为没有可恢复的工作区 */
  async function load() {
    return tx('readonly', async (m, i) => {
      const state = await req(m.get(KEY));
      if (!state) return null;
      const image = await req(i.get(KEY));
      return { state, image };
    });
  }

  async function clear() {
    return tx('readwrite', (m, i) => { m.clear(); i.clear(); });
  }

  return { saveState, saveImage, load, clear };
})();
