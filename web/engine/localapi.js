/* ==========================================================================
   WB-PS · 本地 API 层

   把 Python 服务端的改字接口（/api/analyze、/api/preview、/api/apply …）
   在浏览器里原样实现一遍。前端 web/app.js 只需要把那一层 api() 换掉，
   UI 逻辑、数据结构、错误处理全都不用动。

   会话模型与 Python 侧一致：analyze 时把原图与识别结果挂在 session_id 下，
   后续 preview / apply 都基于同一张原图重算 —— 这样"局部预览"与"最终结果"
   必然一致（这也是 Python 侧刻意保留下来的性质）。
   ========================================================================== */
import { imageDataToBgrMat, matToImageData } from './cvutil.js';
import { rm } from './cvutil.js';
import { detect, analyze, applyEdits, previewItem, detectMaskRegion } from './index.js';
import { analyzeMany } from './style.js';

const MAX_SESSIONS = 3;

function uid() {
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function blobToImageData(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('图片解码失败'));
      i.src = url;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return { imageData: ctx.getImageData(0, 0, c.width, c.height), name: file.name || 'image' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function dataUrlBytes(dataUrl) {
  const i = dataUrl.indexOf(',');
  const body = i >= 0 ? dataUrl.slice(i + 1) : '';
  return Math.round(body.length * 0.75);
}

export class LocalApi {
  constructor(engine) {
    this.engine = engine;
    this.sessions = new Map();
  }

  /** 统一入口。返回 undefined 表示"本地不处理，交给服务端"。 */
  async handle(url, body) {
    try {
      if (url === '/api/health') return this.health();
      if (url === '/api/fonts') return this.fonts();
      if (url === '/api/fonts/reload') return await this.fontsReload();
      if (url === '/api/fonts/upload') return await this.fontsUpload(body);
      if (url === '/api/fonts/scan') return await this.fontsScan();
      if (url === '/api/analyze') return await this.analyze(body);
      if (url === '/api/preview') return await this.preview(body);
      if (url === '/api/preview-batch') return await this.previewBatch(body);
      if (url === '/api/apply') return await this.apply(body);
      if (url.startsWith('/api/session/')) {
        return this.session(decodeURIComponent(url.slice('/api/session/'.length)));
      }
      if (url === '/api/bounds') return this.bounds(body);
      return undefined;
    } catch (err) {
      // 错误形状对齐 FastAPI：detail 为字符串，前端 api() 直接取它当文案
      const e = new Error(String((err && err.message) || err));
      e.local = true;
      throw e;
    }
  }

  /* ---------------------------------------------------------- 会话 */

  _put(imgBgr, items, meta) {
    const sid = uid();
    this.sessions.set(sid, { imgBgr, items, ...meta });
    // 只留最近的几个：BGR 位图很占内存，旧会话及时释放
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      this._drop(oldest);
    }
    return sid;
  }

  _drop(sid) {
    const s = this.sessions.get(sid);
    if (!s) return;
    rm(s.imgBgr);
    this.sessions.delete(sid);
  }

  _get(sid) {
    const s = this.sessions.get(sid);
    if (!s) throw new Error('会话已失效，请重新识别');
    return s;
  }

  /* ---------------------------------------------------------- 接口实现 */

  async analyze(fd) {
    const file = fd.get('file');
    if (!file || typeof file === 'string') throw new Error('缺少图片文件');
    const mergeLines = String(fd.get('merge_lines') ?? 'true') !== 'false';

    const t0 = performance.now();
    const { imageData, name } = await blobToImageData(file);
    const cv = this.engine.cv;
    const imgBgr = imageDataToBgrMat(cv, imageData);

    const items = await detect(cv, this.engine.ocr, imgBgr, { merge: mergeLines, minScore: 0.35 });
    analyzeMany(cv, imgBgr, items);

    // 旧会话全清：一个页面同时只编辑一张图
    for (const key of [...this.sessions.keys()]) this._drop(key);
    const sid = this._put(imgBgr, items, { fileName: name, width: imgBgr.cols, height: imgBgr.rows });

    return {
      session_id: sid,
      width: imgBgr.cols,
      height: imgBgr.rows,
      backend: 'browser-wasm',
      count: items.length,
      items,
      elapsed_ms: Math.round(performance.now() - t0),
    };
  }

  async preview(body) {
    const s = this._get(body.session_id);
    const item = s.items.find((it) => String(it.id) === String(body.id));
    if (!item) throw new Error('找不到该文字块');
    await this._primeFonts([[item, body.edit || {}]]);
    const { patch, info } = previewItem(this.engine.cv, this.engine.fonts, s.imgBgr, item, body.edit || {});
    return { id: item.id, region: info.region, patch, info };
  }

  async previewBatch(body) {
    const s = this._get(body.session_id);
    const edits = body.edits || {};
    const pairs = [];
    for (const [id, edit] of Object.entries(edits)) {
      const item = s.items.find((it) => String(it.id) === String(id));
      if (item) pairs.push([item, edit || {}]);
    }
    await this._primeFonts(pairs);

    const out = [];
    for (const [item, edit] of pairs) {
      try {
        const { patch, info } = previewItem(this.engine.cv, this.engine.fonts, s.imgBgr, item, edit);
        out.push({ id: item.id, region: info.region, patch, info });
      } catch (err) {
        out.push({ id: item.id, info: { warnings: [String((err && err.message) || err)] } });
      }
    }
    return { items: out };
  }

  async apply(body) {
    const s = this._get(body.session_id);
    const edits = body.edits || {};

    // 本机字体是按需取字节的，画之前得先把它注册好，否则 canvas 会
    // 静默回退到默认字体 —— 度量全错但不报错。
    const pairs = [];
    for (const it of s.items) {
      const e = edits[String(it.id)];
      if (e) pairs.push([it, e]);
    }
    await this._primeFonts(pairs);

    const t0 = performance.now();
    const res = applyEdits(this.engine.cv, this.engine.fonts, s.imgBgr, s.items,
      edits, body.new_items || []);

    const canvas = document.createElement('canvas');
    canvas.width = res.image.cols;
    canvas.height = res.image.rows;
    canvas.getContext('2d').putImageData(matToImageData(this.engine.cv, res.image), 0, 0);
    const image = canvas.toDataURL('image/png');
    rm(res.image);

    return {
      image,
      bytes: dataUrlBytes(image),
      width: canvas.width,
      height: canvas.height,
      stats: { ...res.stats, elapsed_ms: Math.round(performance.now() - t0) },
    };
  }

  /**
   * 预热字体：把「明确选中的字族」和「自动匹配会遍历的候选池」先注册好。
   * 本机字体（Local Font Access 扫到的）只有到这里才会真正读字节。
   * pairs: [[item, edit], ...]
   */
  async _primeFonts(pairs) {
    const fonts = this.engine.fonts;
    if (!fonts || !fonts.ensureFamilies) return;
    const fams = new Set();
    for (const [it, edit] of pairs || []) {
      const e = edit || {};
      if (e.family) fams.add(e.family);      // 手动选定的一定要能渲染
      if (e.auto_family !== false) {         // 自动匹配要遍历候选池
        const text = (e.text != null && e.text !== '') ? String(e.text) : (it.text || '');
        for (const f of fonts.candidates(text, 22)) fams.add(f);
      }
    }
    await fonts.ensureFamilies([...fams]);
  }

  session(sid) {
    const s = this.sessions.get(sid);
    if (!s) return { alive: false };
    return {
      alive: true,
      session_id: sid,
      width: s.width,
      height: s.height,
      count: s.items.length,
      items: s.items,
      file_name: s.fileName,
    };
  }

  bounds(body) {
    const s = this._get(body.session_id);
    const item = s.items.find((it) => String(it.id) === String(body.id));
    if (!item) throw new Error('找不到该文字块');
    return detectMaskRegion(this.engine.cv, s.imgBgr, item.rect);
  }

  health() {
    const fonts = this.engine.fonts;
    const count = fonts.all().length;
    return {
      ok: true,
      ocr_backend: 'browser-wasm',
      ocr_ready: true,
      fonts: count,
      font_count: count,           // 前端初始化读的是这个字段
      local_fonts: fonts.scanned ? fonts.scanned.length : 0,
      imported_fonts: fonts.imported ? fonts.imported.length : 0,
      mode: 'local',
    };
  }

  /* ---------------------------------------------------------- 字体 */

  /**
   * 字体清单。字段**逐个对齐 Python 版 /api/fonts**：
   *   families  [{name, bold, user, files}]   ← 前端就是按这个渲染下拉的
   *   user_count / count / user_dir
   * 另外附带 scan（本机字体扫描状态）与 scanned_count，供界面提示用。
   */
  fonts() {
    const fonts = this.engine.fonts;
    const families = fonts.listForUi();
    const userCount = families.filter((f) => f.user).length;
    return {
      families,
      fonts: families,                     // 旧字段名，保持兼容
      count: families.length,
      user_count: userCount,
      user_dir: '浏览器本机（Cache Storage，未上传）',
      scanned_count: (fonts.scanned || []).length,
      scan: fonts.scanState || null,
      mode: 'local',
    };
  }

  /** 导入字体：只存本机（Cache Storage + FontFace），不上传 */
  async fontsUpload(fd) {
    const files = [];
    if (fd && typeof fd.getAll === 'function') {
      for (const f of fd.getAll('files')) {
        if (f && typeof f !== 'string') files.push(f);
      }
    }
    const { added, errors } = await this.engine.fonts.importFiles(files);
    const out = this.fonts();
    return {
      ...out,
      added: added.map((e) => ({ name: e.family, family: e.family, file: e.file, bytes: e.bytes })),
      errors,
      uploaded_to_server: false,     // 明示：这些字节没有离开浏览器
    };
  }

  /** 重新扫描：托管字体 + 导入字体 + 指纹探测 + 本机字体 */
  async fontsReload() {
    const fonts = this.engine.fonts;
    fonts.hosted = [];
    fonts.imported = [];
    fonts.systemFamilies = [];
    await fonts.init({ scan: 'never' });
    return this.fonts();
  }

  /** 扫描本机字体（需要用户授权，字节不离开本机） */
  async fontsScan() {
    const state = await this.engine.fonts.scanLocalFonts();
    return { ...this.fonts(), scan: state };
  }

  /**
   * 导出成图。返回 Blob（不是 JSON），所以不走 handle()，由 boot.js 单独暴露。
   * 之前前端导出是裸 fetch('/api/export')，CF 版没这个路由 → 必然 404。
   */
  async exportBlob(body) {
    const applied = await this.apply(body);
    const fmt = String(body.format || 'png').toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[fmt] || 'image/png';
    const quality = Math.min(1, Math.max(0.1, (Number(body.quality) || 95) / 100));

    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('结果图解码失败'));
      i.src = applied.image;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (mime === 'image/jpeg') {          // JPEG 无透明通道，先铺白底免得发黑
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0);

    const blob = await new Promise((res) => canvas.toBlob(res, mime, quality));
    if (!blob) throw new Error('导出失败：浏览器不支持该格式');
    return { blob, bytes: blob.size, width: canvas.width, height: canvas.height,
      stats: applied.stats, format: fmt };
  }
}
