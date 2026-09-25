/* ==========================================================================
   生成页 · 每个工具的独立草稿（本机 IndexedDB）
   --------------------------------------------------------------------------
   为什么需要：四个工具共用同一个页面，切来切去很容易把正在写的东西弄丢。
   这里给每个工具存一份自己的草稿——提示词、尺寸、数量、参照图，以及
   上一张结果的记录 id。

   设计取舍（与作品库 store.js 同一套思路）：
   * **拆两张表**。`state` 每次敲键盘都要写，只放几十字节的文本字段；
     `assets` 只在参照图增删时写，放可能上兆的图片字节。
     混成一张表的话，每敲一个字都要重写几 MB 参照图。
   * **结果图不复制字节**，只记作品库里的记录 id。生成时会自动入库，
     这里再存一份等于把每张 2MB 的图翻倍。记录被删掉时草稿里的结果
     自然失效——那是用户主动删的，符合预期。
   * **单独一个数据库**，避免与作品库的版本升级互相干扰
     （同一个库名用不同 version 打开会触发 blocked，很难排查）。
   * 所有数据只落在本机浏览器，不上传服务器。
   ========================================================================== */
window.ToolCache = (function () {
  'use strict';

  const DB_NAME = 'wb-image-tools';
  const DB_VER = 1;
  const STATE = 'state';
  const ASSETS = 'assets';
  const MAX_REFS = 4;                       // 与界面上的上限一致，防御性截断

  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('当前浏览器不支持 IndexedDB'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STATE)) {
          db.createObjectStore(STATE, { keyPath: 'tool' });
        }
        if (!db.objectStoreNames.contains(ASSETS)) {
          const os = db.createObjectStore(ASSETS, { keyPath: 'id' });
          os.createIndex('tool', 'tool');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('无法打开草稿库'));
    });
    return dbp;
  }

  function run(stores, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let out;
      try {
        out = fn(...stores.map(s => t.objectStore(s)));
      } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve((out && out.result !== undefined) ? out.result : out);
      t.onabort = () => reject(t.error || new Error('草稿写入失败'));
      t.onerror = () => reject(t.error || new Error('草稿写入失败'));
    }));
  }

  const req = (r) => new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

  /** 游标收集，返回一个带 result getter 的壳（事务完成后才取值） */
  function collect(cursorReq, mapper) {
    const out = [];
    cursorReq.onsuccess = () => {
      const c = cursorReq.result;
      if (!c) return;
      const v = mapper ? mapper(c.value) : c.value;
      if (v !== undefined) out.push(v);
      c.continue();
    };
    return { get result() { return out; } };
  }

  /* ------------------------------------------------------------ 轻量状态 */

  /** 每个工具一条记录，字段都是小文本 */
  function putState(rec) {
    return run([STATE], 'readwrite', (st) => st.put(rec));
  }

  function getState(tool) {
    return run([STATE], 'readonly', (st) => req(st.get(tool))).then(v => v || null);
  }

  function listStates() {
    return run([STATE], 'readonly', (st) => collect(st.openCursor()));
  }

  function dropState(tool) {
    return run([STATE], 'readwrite', (st) => st.delete(tool));
  }

  /* ------------------------------------------------------------ 参照图 */

  async function putRefs(tool, refs) {
    const rows = [];
    for (let i = 0; i < Math.min((refs || []).length, MAX_REFS); i++) {
      const r = refs[i];
      if (!r || !r.file) continue;
      let buf;
      try { buf = await r.file.arrayBuffer(); } catch (_) { continue; }
      rows.push({
        id: `${tool}:${i}`, tool, index: i,
        name: r.file.name || `ref${i + 1}`,
        type: r.file.type || 'image/png',
        buf,
      });
    }
    return run([ASSETS], 'readwrite', (as) => {
      // 先清掉这个工具的旧参照图，再整体写入，避免删图后残留
      const cur = as.index('tool').openKeyCursor(IDBKeyRange.only(tool));
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        as.delete(c.primaryKey);
        c.continue();
      };
      for (const row of rows) as.put(row);
    });
  }

  function getRefs(tool) {
    return run([ASSETS], 'readonly', (as) =>
      collect(as.index('tool').openCursor(IDBKeyRange.only(tool))))
      .then(rows => rows.sort((a, b) => (a.index || 0) - (b.index || 0)));
  }

  function removeRefs(tool) {
    return run([ASSETS], 'readwrite', (as) => {
      const cur = as.index('tool').openKeyCursor(IDBKeyRange.only(tool));
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        as.delete(c.primaryKey);
        c.continue();
      };
    });
  }

  /** 彻底丢弃某个工具的草稿（状态 + 参照图） */
  async function dropTool(tool) {
    await dropState(tool);
    return removeRefs(tool);
  }

  return { putState, getState, listStates, dropState, putRefs, getRefs, dropTool };
})();
