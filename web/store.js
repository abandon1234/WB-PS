/* ==========================================================================
   本地作品库 · IndexedDB 封装
   --------------------------------------------------------------------------
   设计取舍：
   * 存 ArrayBuffer + MIME，而不是 Blob/DataURL。DataURL 会让体积膨胀 33%，
     Blob 在老版本 Safari 的 IDB 里又有兼容问题，ArrayBuffer 最稳。
   * **拆成两张表**：`meta` 放元数据 + 360px 缩略图，`blobs` 放原图字节。
     如果混在一张表里，画廊遍历游标时会把每张 2MB 的原图都读进内存——
     50 张就是 100MB 的 I/O，页面直接卡死。拆开后画廊只读几十 KB 的缩略图，
     点开灯箱才按 id 单独取原图。
   * 所有数据只落在本机浏览器，任何请求都不会把它回传服务器。
   ========================================================================== */
window.ImgStore = (function () {
  'use strict';

  const DB_NAME = 'wb-image-studio';
  const DB_VER = 2;
  const META = 'meta';
  const BLOBS = 'blobs';
  const THUMB_MAX = 360;

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('当前浏览器不支持 IndexedDB，无法保存作品'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (ev) => {
        const db = req.result;
        // v1 → v2：把旧的单表拆成 meta + blobs，旧数据直接丢弃（本地缓存，无需迁移）
        if (db.objectStoreNames.contains('images')) db.deleteObjectStore('images');
        if (!db.objectStoreNames.contains(META)) {
          const os = db.createObjectStore(META, { keyPath: 'id' });
          os.createIndex('createdAt', 'createdAt');
          os.createIndex('fav', 'fav');
        }
        if (!db.objectStoreNames.contains(BLOBS)) {
          db.createObjectStore(BLOBS, { keyPath: 'id' });
        }
        void ev;
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('无法打开本地数据库'));
    });
    return dbPromise;
  }

  /** 在同一个事务里操作两张表，保证 meta 与 blobs 不会写偏 */
  function tx(mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction([META, BLOBS], mode);
      let out;
      try {
        out = fn(t.objectStore(META), t.objectStore(BLOBS));
      } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve((out && out.result !== undefined) ? out.result : out);
      t.onabort = () => reject(t.error || new Error('本地写入失败'));
      t.onerror = () => reject(t.error || new Error('本地写入失败'));
    }));
  }

  /** 事务里等一个 IDBRequest */
  function req(r) {
    return new Promise((res, rej) => {
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  /* ------------------------------------------------------------ 工具 */

  function dataURLToBuffer(dataUrl) {
    const comma = dataUrl.indexOf(',');
    const meta = dataUrl.slice(0, comma);
    const body = dataUrl.slice(comma + 1);
    const mime = (meta.match(/data:([^;]+)/) || [, 'image/png'])[1];
    const bin = atob(body);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return { buf: buf.buffer, mime };
  }

  function bufferToURL(buf, mime) {
    return URL.createObjectURL(new Blob([buf], { type: mime || 'image/png' }));
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = url;
    });
  }

  /** 生成缩略图，返回 {buf, mime, width, height} */
  async function makeThumb(buf, mime) {
    const url = bufferToURL(buf, mime);
    try {
      const img = await loadImage(url);
      const scale = Math.min(1, THUMB_MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      return {
        ...dataURLToBuffer(cv.toDataURL('image/jpeg', 0.82)),
        width: img.naturalWidth,
        height: img.naturalHeight,
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ------------------------------------------------------------ 写入 */

  /**
   * 保存一张图片。
   * @param {string} dataUrl  图片的 data URL（生成结果即为此格式）
   * @param {object} meta     {prompt, revised, model, size, tool, toolName, usedRef, favorite}
   */
  async function save(dataUrl, meta = {}) {
    const { buf, mime } = dataURLToBuffer(dataUrl);
    const thumb = await makeThumb(buf, mime).catch(() => null);
    const id = uid();
    const rec = {
      id,
      createdAt: Date.now(),
      fav: meta.favorite ? 1 : 0,
      favorite: !!meta.favorite,
      prompt: meta.prompt || '',
      revised: meta.revised || '',
      model: meta.model || '',
      size: meta.size || '',
      tool: meta.tool || '',
      toolName: meta.toolName || '',
      usedRef: !!meta.usedRef,
      bytes: buf.byteLength,
      width: thumb ? thumb.width : 0,
      height: thumb ? thumb.height : 0,
      mime,
      // 缩略图生成失败时退回原图，保证画廊不会出现空白格子
      thumb: thumb ? thumb.buf : buf,
      thumbMime: thumb ? thumb.mime : mime,
    };
    await tx('readwrite', (m, b) => {
      m.put(rec);
      b.put({ id, full: buf });
    });
    return rec;
  }

  /** 只改元数据，不碰原图字节 */
  async function update(id, patch) {
    return tx('readwrite', async (m) => {
      const rec = await req(m.get(id));
      if (!rec) throw new Error('记录不存在');
      Object.assign(rec, patch);
      if ('favorite' in patch) rec.fav = patch.favorite ? 1 : 0;
      m.put(rec);
      return rec;
    });
  }

  async function remove(id) {
    return tx('readwrite', (m, b) => { m.delete(id); b.delete(id); });
  }

  async function clear() {
    return tx('readwrite', (m, b) => { m.clear(); b.clear(); });
  }

  /* ------------------------------------------------------------ 读取 */

  /** 列表：只读 meta 表（含缩略图），不含原图字节 */
  async function list() {
    const rows = await tx('readonly', (m) => {
      const out = [];
      const r = m.openCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return;
        const v = c.value;
        out.push({
          id: v.id, createdAt: v.createdAt, favorite: !!v.favorite,
          prompt: v.prompt, revised: v.revised, model: v.model, size: v.size,
          tool: v.tool, toolName: v.toolName, usedRef: v.usedRef,
          bytes: v.bytes, width: v.width, height: v.height,
          thumb: v.thumb, thumbMime: v.thumbMime,
        });
        c.continue();
      };
      return { get result() { return out; } };
    });
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return rows;
  }

  /** 单条完整记录（含原图字节），供灯箱 / 下载用 */
  async function get(id) {
    return tx('readonly', async (m, b) => {
      const meta = await req(m.get(id));
      if (!meta) return null;
      const blob = await req(b.get(id));
      return Object.assign({}, meta, { full: blob ? blob.full : null });
    });
  }

  async function count() {
    return tx('readonly', (m) => m.count());
  }

  /** 已用容量（按元数据里的字节数累加，无需读原图） */
  async function usage() {
    return tx('readonly', (m) => {
      let total = 0;
      const r = m.openCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return;
        total += c.value.bytes || 0;
        c.continue();
      };
      return { get result() { return total; } };
    });
  }

  /** 浏览器配额估算；不可用时返回 null */
  async function quota() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        return { usage: e.usage || 0, quota: e.quota || 0 };
      }
    } catch (_) { /* 忽略 */ }
    return null;
  }

  return {
    save, update, remove, clear, list, get, count, usage, quota,
    bufferToURL, dataURLToBuffer,
  };
})();
