/* ==========================================================================
   WB-PS · 字体管理（浏览器端）

   硬约束：浏览器**无法直接枚举系统字体**（早期结论）。现在有两条出路：

     1. 托管字体   assets/fonts/*.ttf，用 FontFace 加载 —— 最可靠，跨平台一致
     2. 本机字体   Local Font Access API（navigator.queryLocalFonts）。
                   Chromium 系可用，需要用户授权；拿到的是字体**列表 + 字节**，
                   全程在本机，一个字节都不上传。
     3. 指纹探测   对常见系统字体名做 canvas 度量比对，判断这台机器装没装
                   （在没有 Local Font Access 的浏览器里兜底）
     4. 通用族     sans-serif / serif / monospace —— 永远可用，兜底

   「导入字体」的文件也不上传：用 FontFace 注册进当前页面，并把字节存进
   Cache Storage（键名 __local-fonts__/*），刷新/重开浏览器都还在。
   ========================================================================== */

/** 通用族：不需要探测，浏览器保证有 */
export const GENERIC_FAMILIES = ['sans-serif', 'serif', 'monospace'];

/* ------------------------------------------------------------ 本机字体仓库 */

const FONT_CACHE = 'wb-ps-fonts-v1';
const FONT_INDEX_KEY = 'wb-ps-fonts-index';
const MAX_FONT_BYTES = 32 * 1024 * 1024;
const MAX_STYLES_PER_FAMILY = 6;   // 一个字族最多载入几个字重变体

/** 本地字体的缓存键：带前缀，避免与 /assets/ 下的托管字体混在一起 */
const localFontUrl = (file) => `/__local-fonts__/${encodeURIComponent(file)}`;

async function openFontCache() {
  try { return await caches.open(FONT_CACHE); } catch (_) { return null; }
}

function readFontIndex() {
  try {
    const raw = localStorage.getItem(FONT_INDEX_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_) { return []; }
}

function writeFontIndex(list) {
  try { localStorage.setItem(FONT_INDEX_KEY, JSON.stringify(list.slice(-200))); } catch (_) {}
}

/** 从文件名猜字重（SourceHanSansSC-Bold.ttf → 700） */
function guessWeight(name) {
  const n = String(name);
  if (/extralight|ultralight|hairline|thin/i.test(n)) return 100;
  if (/light/i.test(n)) return 300;
  if (/medium/i.test(n)) return 500;
  if (/semibold|demibold/i.test(n)) return 600;
  if (/extrabold|heavy|black/i.test(n)) return 800;
  if (/bold/i.test(n)) return 700;
  return 400;
}

/**
 * 从文件名推字族名：剥掉字重/斜体词。
 * 这样同一个字族的多个文件（Regular/Bold）会归到同一个 family，
 * canvas 里用 `700 57px "X"` 就能自然命中对应的字重变体。
 */
function familyFromFileName(fileName) {
  const stem = String(fileName || '').replace(/\.[a-z0-9]+$/i, '');
  const words = stem.split(/[-_\s]+/)
    .filter((w) => w && !WEIGHT_WORDS.has(w.toLowerCase()))
    .filter((w) => !/^(italic|oblique|regular|normal)$/i.test(w));
  const base = words.join(' ').replace(/\s+/g, ' ').trim();
  return base || stem || 'Imported Font';
}

/** 用 ArrayBuffer 注册一个字体面（FontFace 支持二进制源，不需要 URL） */
async function registerFace(family, buffer, meta) {
  const face = new FontFace(family, buffer, meta || {});
  await face.load();
  document.fonts.add(face);
  return face;
}

/**
 * 常见系统字体名（仅做指纹探测，装了就进候选池）。
 * 中文字体放前面 —— 这个项目的文字多半是中文。
 */
export const SYSTEM_PROBES = [
  // Windows · 中文
  'Microsoft YaHei', 'Microsoft YaHei UI', 'SimSun', 'SimHei', 'KaiTi', 'FangSong',
  'Microsoft JhengHei',
  // macOS · 中文
  'PingFang SC', 'Hiragino Sans GB', 'Heiti SC', 'Songti SC', 'STHeiti',
  // Linux · 中文
  'Noto Sans CJK SC', 'Noto Serif CJK SC', 'Source Han Sans SC', 'Source Han Serif SC',
  'WenQuanYi Micro Hei',
  // 拉丁
  'Arial', 'Helvetica', 'Helvetica Neue', 'Segoe UI', 'Tahoma', 'Verdana',
  'Times New Roman', 'Georgia', 'Calibri', 'Trebuchet MS', 'Impact',
  'Consolas', 'Courier New', 'Monaco', 'Menlo', 'Roboto', 'Open Sans', 'Inter',
];

/** 字重/样式相关的关键词（用于从族名里剥离出"基础族"） */
const WEIGHT_WORDS = new Set(['light', 'thin', 'regular', 'bold', 'italic', 'medium',
  'semibold', 'black', 'extralight', 'ultralight', 'oblique', 'book', 'heavy', 'demibold']);
const THIN_WORDS = ['light', 'thin', 'extralight', 'ultralight', 'hairline'];

let _probeCanvas = null;
function probeCtx() {
  if (!_probeCanvas) {
    _probeCanvas = document.createElement('canvas');
    _probeCanvas.width = 16;
    _probeCanvas.height = 16;
  }
  return _probeCanvas.getContext('2d');
}

const PROBE_TEXT = 'mmmwwwwiii国字测试';

/**
 * 指纹探测：某个字体名在这台机器上是否真的可用。
 *
 * 原理：把候选字体和三个通用族各测一遍宽度。若候选的度量与**任意一个**
 * 通用族完全相同，说明它根本不存在、浏览器回退到了兜底字体。
 */
export function detectSystemFont(family) {
  try {
    const ctx = probeCtx();
    const size = 72;
    const widthOf = (f) => {
      ctx.font = `${size}px ${f}`;
      return ctx.measureText(PROBE_TEXT).width;
    };
    const bases = GENERIC_FAMILIES.map(widthOf);
    const cand = widthOf(`"${family}"`);
    return !bases.some((b) => Math.abs(b - cand) < 0.5);
  } catch (_) {
    return false;
  }
}

/** 判断文本是否含中日韩字符（决定要偏向哪类字体） */
export function hasCjk(text) {
  return /[\u3000-\u9fff\uf900-\ufaff]/.test(text || '');
}

export class FontRegistry {
  constructor({ base = '/assets/fonts' } = {}) {
    this.base = base;
    this.hosted = [];            // 托管字体条目
    this.systemFamilies = [];    // 指纹探测到的系统字体
    this.imported = [];          // 用户导入并缓存在浏览器的字体
    this.scanned = [];           // Local Font Access 扫出来的字族名
    this.supported = new Set();  // family → 已加载的 FontFace
    this.ready = false;
    this._metricsCache = new Map();
    this._localData = new Map(); // 扫到的字族 → [FontData]（按需取字节）
    this._loadedLocal = new Set();
    this.scanState = { supported: false, denied: false, count: 0, error: '' };
  }

  /** 加载托管字体 + 已导入字体 + 探测系统字体。可重复调用。 */
  async init({ scan = 'auto' } = {}) {
    await this.loadHosted();
    await this.loadImported();
    if (!this.systemFamilies.length) {
      this.systemFamilies = SYSTEM_PROBES.filter((f) => detectSystemFont(f));
    }
    // 上次授权过就直接续用，不再弹窗打扰
    if (scan === 'auto') {
      const q = await this.localFontsPermission();
      if (q === 'granted') await this.scanLocalFonts().catch(() => {});
    }
    this.ready = true;
    return this;
  }

  /* --------------------------------------------------- 托管字体 */

  async loadHosted() {
    let list = [];
    try {
      const resp = await fetch(`${this.base}/fonts.json`, { cache: 'no-cache' });
      if (resp.ok) list = (await resp.json()).fonts || [];
    } catch (_) { /* 没有托管字体也能跑 */ }

    for (const f of list) {
      try {
        const url = `${this.base}/${f.file}`;
        const face = new FontFace(f.family, `url(${url})`, {
          weight: String(f.weight || 400),
          style: f.style || 'normal',
        });
        await face.load();
        document.fonts.add(face);
        this.supported.add(f.family);
        this.hosted.push({ ...f, url });
      } catch (err) {
        console.warn(`[WB-PS] 托管字体加载失败：${f.family}`, err);
      }
    }
    return this.hosted;
  }

  /* --------------------------------------------------- 导入字体（缓存在浏览器） */

  /** 把用户选的文件注册进当前页面，并存进 Cache Storage —— 不上传任何地方 */
  async importFiles(files) {
    const added = [];
    const errors = [];
    const cache = await openFontCache();
    const index = readFontIndex();

    for (const file of files || []) {
      const name = file.name || 'font';
      try {
        if (!/\.(ttf|otf|ttc|otc|woff2?)$/i.test(name)) {
          errors.push({ file: name, error: '不支持的格式（支持 ttf/otf/ttc/otc/woff/woff2）' });
          continue;
        }
        if (file.size > MAX_FONT_BYTES) {
          errors.push({ file: name, error: '文件过大（上限 32MB）' });
          continue;
        }
        const buf = await file.arrayBuffer();
        const family = familyFromFileName(name);
        const weight = guessWeight(name);
        const style = /italic|oblique/i.test(name) ? 'italic' : 'normal';

        // FontFace 会接管这份数据，另一份留给缓存 —— 所以传副本
        await registerFace(family, buf.slice(0), { weight: String(weight), style });
        if (cache) await cache.put(localFontUrl(name), new Response(buf.slice(0)));

        const entry = { file: name, family, weight, style, bytes: buf.byteLength, added_at: Date.now() };
        const dup = index.findIndex((e) => e.file === name);
        if (dup >= 0) index[dup] = entry; else index.push(entry);

        this.imported = this.imported.filter((e) => e.file !== name);
        this.imported.push(entry);
        this.supported.add(family);
        added.push(entry);
      } catch (err) {
        errors.push({ file: name, error: String((err && err.message) || err) });
      }
    }

    writeFontIndex(index);
    return { added, errors };
  }

  /** 从 Cache Storage 恢复上次导入的字体（刷新后仍在） */
  async loadImported() {
    const cache = await openFontCache();
    if (!cache) return 0;
    const index = readFontIndex();
    if (!index.length) return 0;

    let n = 0;
    for (const e of index) {
      try {
        const resp = await cache.match(localFontUrl(e.file));
        if (!resp) continue;
        const buf = await resp.arrayBuffer();
        await registerFace(e.family, buf, { weight: String(e.weight || 400), style: e.style || 'normal' });
        this.supported.add(e.family);
        this.imported.push(e);
        n++;
      } catch (err) {
        console.warn(`[WB-PS] 已存字体加载失败：${e.family}`, err);
      }
    }
    return n;
  }

  /** 清空导入的字体（缓存 + 索引）；已注册的 FontFace 留到下次刷新 */
  async clearImported() {
    const cache = await openFontCache();
    if (cache) {
      for (const e of readFontIndex()) {
        try { await cache.delete(localFontUrl(e.file)); } catch (_) {}
      }
    }
    writeFontIndex([]);
    const had = this.imported.length;
    this.imported = [];
    return had;
  }

  /* --------------------------------------------------- 本机字体扫描 */

  async localFontsPermission() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return 'unknown';
      const st = await navigator.permissions.query({ name: 'local-fonts' });
      return st.state;
    } catch (_) {
      return 'unknown';   // 浏览器不认这个名字（Safari/Firefox）
    }
  }

  /**
   * 用 Local Font Access API 扫本机字体。
   *
   * ⚠️ 这个 API 挂在 **window** 上（`Window.queryLocalFonts()`），不是 navigator ——
   * 写成 `navigator.queryLocalFonts` 会永远拿不到，表现为"当前浏览器不支持"，
   * 而浏览器其实完全支持。
   *
   * 另外两点约束（MDN）：必须在安全上下文里，且**必须由用户手势触发**
   * （否则抛 SecurityError）；未授权时抛 NotAllowedError。
   *
   * 只登记字族清单，字节在真正要用（ensureFamilies）时才按需读取 ——
   * 一次性把几百个字体的字节全读进内存太重。
   */
  async scanLocalFonts() {
    const api = typeof window !== 'undefined' ? window.queryLocalFonts : null;
    if (typeof api !== 'function') {
      this.scanState = {
        supported: false, denied: false, count: 0,
        error: '当前浏览器不支持读取本机字体（Chrome / Edge 103+ 桌面版可用）',
      };
      return this.scanState;
    }

    let data = [];
    try {
      data = await api.call(window);
    } catch (err) {
      const msg = String((err && err.message) || err);
      const denied = /denied|permission|NotAllowed/i.test(msg);
      this.scanState = {
        supported: true,
        denied,
        count: 0,
        // 原样带出浏览器的说明：可能是"授权被拒"，也可能是
        // "Page needs to be visible"（页面在后台）这类可自愈的情况 —— 别自己猜。
        error: denied ? '授权被拒绝' : msg,
      };
      return this.scanState;
    }

    this._localData = new Map();
    for (const fd of data) {
      const key = fd.family || fd.fullName;
      if (!key) continue;
      if (!this._localData.has(key)) this._localData.set(key, []);
      this._localData.get(key).push(fd);
    }
    this.scanned = [...this._localData.keys()].sort((a, b) => a.localeCompare(b));
    this._loadedLocal = new Set();
    this.scanState = { supported: true, denied: false, count: this.scanned.length, error: '' };
    return this.scanState;
  }

  /** 把指定字族的字节取回来并注册（首次用某个本机字体时才发生） */
  async ensureFamilies(families) {
    const jobs = [];
    for (const fam of families || []) {
      if (!fam || GENERIC_FAMILIES.includes(fam)) continue;
      if (!this._localData || !this._localData.has(fam)) continue;
      if (this._loadedLocal.has(fam)) continue;
      jobs.push(this._loadLocalFamily(fam));
    }
    if (jobs.length) await Promise.allSettled(jobs);
  }

  async _loadLocalFamily(fam) {
    if (this._loadedLocal.has(fam)) return;
    this._loadedLocal.add(fam);          // 先占位，避免并发重复加载
    const list = (this._localData.get(fam) || []).slice(0, MAX_STYLES_PER_FAMILY);
    for (const fd of list) {
      try {
        const buf = await (await fd.blob()).arrayBuffer();
        await registerFace(fd.family || fam, buf, {
          weight: String(fd.weight || 400),
          style: fd.style || 'normal',
        });
        this.supported.add(fd.family || fam);
      } catch (err) {
        console.warn(`[WB-PS] 本机字体载入失败：${fam}`, err);
      }
    }
  }

  /* --------------------------------------------------- 清单 */

  /** 全部可用字体名（托管 + 导入 + 精选探测 + 扫到的本机字体）
   *
   *  顺序有意义：candidates() 是按这个顺序取前 N 个的。
   *  扫到的本机字体有几百个（含各种装饰体），必须排在**精选探测清单之后**，
   *  否则"自动匹配"会先撞上 Algerian 这类显示字体，把拉丁文匹配得乱七八糟。
   */
  all() {
    const out = [];
    const push = (f) => { if (f && !out.includes(f)) out.push(f); };
    for (const f of this.hosted) push(f.family);
    for (const f of this.imported) push(f.family);
    for (const f of this.systemFamilies) push(f);
    for (const f of this.scanned) push(f);
    return out;
  }

  /**
   * 供界面用的清单。
   *
   * ⚠️ 形状必须与 Python 版 `font_lib.list_families()` 完全一致：
   *     [{ name, bold, user, files }]
   * 早先这里返回的是**字符串数组**，而前端是按 `f.name` 渲染的 ——
   * 结果 232 个选项的标签全是空串，下拉一打开是一片空白（且不报错）。
   * 排序语义也沿用原版：自定义（导入）在前，其次中文，然后其他，通用族收尾。
   */
  listForUi() {
    const cjkNames = /yahei|simsun|simhei|kai|fang|pingfang|heiti|songti|jhenghei|noto.*cjk|source han|wenquanyi|hiragino|sthei|微软|雅黑|宋|黑体|楷|仿宋/i;
    const items = [];
    const seen = new Set();
    const push = (name, extra) => {
      if (!name || seen.has(name)) return;
      seen.add(name);
      items.push({ name, bold: false, user: false, files: 1, source: 'system', ...extra });
    };

    for (const f of this.imported) {
      push(f.family, {
        user: true, source: 'imported',
        bold: /bold|black|heavy|semibold|demibold/i.test(f.file || '') || (Number(f.weight) || 0) >= 600,
      });
    }
    for (const f of this.hosted) push(f.family, { source: 'hosted', bold: (Number(f.weight) || 0) >= 600 });
    for (const f of this.systemFamilies) push(f, { source: 'probed' });
    for (const f of this.scanned) push(f, { source: 'scanned' });

    const rank = (it) => {
      if (it.user) return 0;
      if (GENERIC_FAMILIES.includes(it.name)) return 3;
      return cjkNames.test(it.name) ? 1 : 2;
    };
    items.sort((a, b) => (rank(a) - rank(b)) || a.name.localeCompare(b.name));
    return items;
  }

  /**
   * 候选清单。含 CJK 时优先中文字体 —— 否则会选中 Arial 这类
   * 画不出汉字的拉丁字体，随后所有墨迹度量全部失真。
   */
  candidates(text = '', limit = 22) {
    const all = this.all();
    const cjk = hasCjk(text);
    const cjkNames = /yahei|simsun|simhei|kai|fang|pingfang|heiti|songti|jhenghei|noto.*cjk|source han|wenquanyi|hiragino|sthei/i;
    const preferred = all.filter((f) => (cjk ? cjkNames.test(f) : !cjkNames.test(f)));
    const rest = all.filter((f) => !preferred.includes(f));
    return [...preferred, ...GENERIC_FAMILIES, ...rest].slice(0, limit);
  }

  /** 默认推荐：中文优先中文字体，拉丁优先无衬线 */
  recommend(text = '') {
    const cands = this.candidates(text);
    return cands[0] || 'sans-serif';
  }

  has(family) {
    return !!family;
  }

  /** 转成可直接塞进 ctx.font 的 family 串（带引号防空格截断） */
  cssFor(family) {
    const f = family || 'sans-serif';
    if (GENERIC_FAMILIES.includes(f)) return f;
    return `"${f}", sans-serif`;
  }

  /** 找同族的更细字重变体（原文字比当前字体更细时用） */
  thinnerVariant(family) {
    const words = String(family).toLowerCase().split(/\s+/).filter((w) => !WEIGHT_WORDS.has(w));
    if (!words.length) return null;
    const head = words[0];
    for (const name of this.all()) {
      const low = name.toLowerCase();
      if (low.startsWith(head) && THIN_WORDS.some((w) => low.includes(w))) return name;
    }
    return null;
  }

  /** 判断字体能否渲染给定文本：逐字符测量宽度，缺失字形往往宽度异常 */
  async supports(family, text) {
    try {
      const css = this.cssFor(family);
      await document.fonts.load(`72px ${css}`, text);
      const ctx = probeCtx();
      ctx.font = `72px ${css}`;
      for (const ch of new Set(text)) {
        if (!ch.trim()) continue;
        const w = ctx.measureText(ch).width;
        if (!(w > 0)) return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }
}

/* ------------------------------------------------------------ 度量缓存
   字体匹配要为每个候选渲染一遍特征，几十个字体乘上重复调用很可观。
   缓存按 (family, text, bold, italic) 键存，与 Python 版一致。*/

export function makeMetricCache() {
  return new Map();
}

export function cacheKey(family, text, bold, italic) {
  return `${family}|${text}|${bold ? 1 : 0}|${italic ? 1 : 0}`;
}
