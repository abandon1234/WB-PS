/* ==========================================================================
   改字右栏的两个页签：打码 / 翻译
   ---------------------------------------------------------------------------
   这两件事**不新开一套状态**。识别结果、edit 契约、预览重绘、导出通路
   全部复用改字那一条，这里只负责"算出该往 edits 里写什么"：

   - 打码：engine/mask.js 是纯函数（规则匹配），算出命中项。
           「抹字」把命中项的文字写空 —— 就是改字界面里"文字留空 = 仅擦除"
           那条老路，所以能擦干净、也能进列表被逐项撤销；
           色块 / 马赛克 / 模糊 交给 app.js 的遮盖层（它们不进引擎，导出时才烧）。
   - 翻译：译文写进 edits[id] = { text, auto_fit }，与手动改字用的是同一个字段，
           于是过宽自动缩字号等排版行为全部沿用现有实现，这里一行排版都不写。

   对外只暴露 onImageChanged / onPane / addManualRect 三个钩子，由 app.js 调。
   ========================================================================== */
window.WBPanels = (function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* 动态 import() 不会被 index.html 里的 ?v= 带上版本号 —— 必须自己拼，
     否则浏览器会吃到缓存里的旧模块（与 text.js 当初踩的是同一个坑）。
     版本号直接从本站 panels.js 自己的 <script src> 上读，保持一个来源。 */
  const VER = (() => {
    const s = document.querySelector('script[src*="/static/panels.js"]');
    const m = s && s.src.match(/[?&]v=([^&]+)/);
    return m ? m[1] : '';
  })();

  let maskMod = null, extractMod = null, loading = null;

  function loadEngine() {
    if (extractMod && maskMod) return Promise.resolve();
    if (loading) return loading;
    const u = (p) => p + (VER ? '?v=' + VER : '');
    loading = (async () => {
      // 业务层的**纯函数**模块：不碰 DOM、不下载模型，所以独立于引擎启动时机
      extractMod = await import(u('/static/engine/extract.js'));
      maskMod = await import(u('/static/engine/mask.js'));
      window.WBTextEngine = { extract: extractMod, mask: maskMod };  // 调试用
    })().catch((err) => { loading = null; throw err; });
    return loading;
  }

  const E = () => window.WBEdit;
  const fb = (msg) => { const e = E(); if (e && e.foot) e.foot(msg); };
  const st = (msg, kind, meta) => { const e = E(); if (e && e.status) e.status(msg, kind, meta); };

  const debounce = (fn, ms) => {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };

  /* ==================================================================
     一、打码
     ================================================================== */

  const MK = {
    rules: null,      // { ruleId: bool } 规则开关
    hits: [],         // 命中项：[{ id, key, kind, label, text, rect, lineId, on }]
    manual: [],       // 手动框选：[{ id, rect, on: true }]
    method: 'block',
    color: '#111111',
    eraseIds: new Set(),   // 被"抹字"写空的 item id，切走时要还回去
    eraseSig: '',          // 手动框抹字结果对应的矩形签名
    busy: false,
    erasing: false,
  };

  const hitKey = (h) => `${h.ruleId}|${h.text}|`
    + `${Math.round(h.rect.x)},${Math.round(h.rect.y)}`
    + `|${Math.round(h.rect.w)}x${Math.round(h.rect.h)}`;

  /**
   * /api/analyze 返回的 items 是 merge_lines 之后的**行级**框，
   * 而 findSensitive 要的是 { id, text, rect, items:[{ text, rect }] } 的行结构。
   * 这里把每个 item 同时当作"一行"和"它唯一的子框" —— 于是匹配精确到框，
   * 不会退化成整行兜底（兜底本来就是为了救"号码被 OCR 切成两半"，而合并之后
   * 一行本来就是一个框，不存在那个问题）。
   */
  function linesOf(items) {
    return (items || []).map((it) => ({
      id: it.id,
      text: it.text || '',
      rect: it.rect,
      items: [{ id: it.id, text: it.text || '', rect: it.rect }],
    }));
  }

  function rematch() {
    const items = (E() && E().items) || [];
    if (!maskMod || !items.length) {
      MK.hits = [];
      renderHits(); renderStats();
      return;
    }
    // 关掉过的项在重算后不该又开回来 —— 按 key 记住上一次的开关状态
    const prev = new Map(MK.hits.map((h) => [h.key, h.on !== false]));
    MK.hits = maskMod.findSensitive(linesOf(items), { enabled: MK.rules }).map((h) => {
      const k = hitKey(h);
      return { ...h, kind: 'auto', key: k, on: prev.has(k) ? prev.get(k) : true };
    });
    sync();
  }

  /** 把当前状态推给画布：改 edits（抹字）或改遮盖层（其余三档） */
  const sync = debounce(async function sync() {
    const api = E();
    if (!api) return;

    if (MK.method === 'erase') {
      // 命中项的抹字：走改字已有的擦除通路（文字留空 = 仅擦除）。
      // 先把"该擦的"算成集合，再把"上次擦过、这次不该擦的"还回去 ——
      // 否则在清单里取消勾选，文字不会回来。
      const want = new Set();
      const batch = {};
      for (const h of MK.hits) {
        if (h.kind !== 'auto' || h.on === false || h.lineId == null) continue;
        const id = String(h.lineId);
        want.add(id);
        if (api.edits[id] && api.edits[id].text === '') continue;   // 已经是空的
        batch[id] = { text: '' };
      }

      const give = [...MK.eraseIds].filter((id) => !want.has(id)).filter((id) => {
        const e = api.edits[id];
        return e && e.text === '' && Object.keys(e).length === 1;  // 只还我们写的那种
      });
      MK.eraseIds = want;
      if (give.length) { await api.revertEdits(give); api.markMasked(give, false); }
      if (Object.keys(batch).length) await api.applyEdits(batch);
      api.markMasked([...want], true);

      // 手动框没有对应的 item，只能请引擎按矩形擦
      api.setPicks(MK.manual.filter((m) => m.on !== false)
        .map((m) => ({ id: m.id, rect: m.rect, method: 'erase' })));
      ensureManualErase();
    } else {
      await restoreEraseEdits();
      const on = MK.hits.filter((h) => h.on !== false);
      const rects = (maskMod && on.length) ? maskMod.toRects(on, { pad: 2 }) : [];
      const picks = rects.map((r, i) => ({
        id: 'h' + i, rect: r, method: MK.method, color: MK.color,
      })).concat(MK.manual.filter((m) => m.on !== false).map((m) => ({
        id: m.id, rect: m.rect, method: MK.method, color: MK.color,
      })));
      api.setPicks(picks);
    }
    renderHits(); renderStats();
  }, 120);

  /** 把之前"抹字"写空的那些项还回去（只还确实是我们写的那种，别动用户自己改的） */
  async function restoreEraseEdits() {
    const api = E();
    if (!api || !MK.eraseIds.size) return;
    const ids = [...MK.eraseIds].filter((id) => {
      const e = api.edits[id];
      return e && e.text === '' && Object.keys(e).length === 1;
    });
    MK.eraseIds.clear();
    const rest = ids;              // markMasked 的清理
    if (rest.length) {
      await api.revertEdits(rest);
      api.markMasked(rest, false);
    }
  }

  /**
   * 手动框的"抹字"要引擎参与（把文字擦掉、保留背景），是异步且可能几秒的，
   * 所以结果按「当前开启的手动框签名」缓存 —— 只开关某一项时不用重算整张。
   */
  async function ensureManualErase() {
    const api = E();
    if (!api || MK.erasing || !maskMod) return;
    const rects = maskMod.toRects(MK.manual.filter((m) => m.on !== false), { pad: 0 });
    if (!rects.length) { api.setEraseImage(null, ''); return; }
    const sig = JSON.stringify(rects);
    if (api.eraseImage && sig === MK.eraseSig) return;

    MK.erasing = true;
    st('正在擦除文字…', 'busy');
    try {
      const L = await api.local();
      if (!L) throw new Error('本地引擎未就绪，请刷新页面重试');
      const fd = new FormData();
      fd.append('file', api.file, (api.file && api.file.name) || 'image.png');
      fd.append('rects', JSON.stringify(rects));
      fd.append('method', 'auto');
      const res = await L.handle('/api/text/erase', fd);
      if (!res || !res.image) throw new Error('本地引擎未提供擦除能力，请刷新页面重试');
      MK.eraseSig = sig;
      api.setEraseImage(await decode(res.image), sig);

      // 擦完还有残留就直说 —— 留了残影而用户以为盖好了，比不盖更糟。
      // 纯色底看"最大离背景偏移"（擦净 0~3，一道灰痕就上几十）；
      // 有纹理的底子那个数没有判别力，回退看灰度标准差（擦净 < 2）。
      const peaks = res.peaks || [], solids = res.solids || [], leftovers = res.leftovers || [];
      const bad = peaks.filter((v, i) => solids[i] && typeof v === 'number' && v > 16).length
        + leftovers.filter((v, i) => !solids[i] && v > 8).length;
      st(bad ? `有 ${bad} 处没擦净，这类内容建议改用色块` : '', bad ? 'err' : '');
    } catch (err) {
      st(`擦除失败：${String((err && err.message) || err)}`, 'err');
    } finally {
      MK.erasing = false;
    }
  }

  const decode = (src) => new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('擦除结果解码失败'));
    i.src = src;
  });

  const METHOD_HINT = {
    block: '色块最稳妥：盖住就彻底看不出来，也不存在被反推的可能。',
    mosaic: '马赛克：块取框高的 40%，小到眯眼也认不出字形。理论上存在被反推的可能。',
    blur: '模糊：看着自然，但理论上存在被反推的可能。敏感内容请改用色块。',
    erase: '抹字：把文字擦掉、保留背景，适合要"看不出被改过"的场合。',
  };

  function renderMethod() {
    document.querySelectorAll('#mkMethod .seg-btn').forEach((b) =>
      b.classList.toggle('on', b.dataset.m === MK.method));
    const hint = $('mkMethodHint');
    if (hint) hint.textContent = METHOD_HINT[MK.method] || '';
    const row = $('mkColorRow');
    if (row) {
      const on = MK.method === 'block';
      row.hidden = !on;
      row.style.display = on ? '' : 'none';
    }
  }

  function renderRules() {
    const host = $('mkRuleList');
    if (!host || !maskMod) return;
    if (!MK.rules) MK.rules = maskMod.defaultRuleState();
    host.innerHTML = maskMod.RULES.map((r) => `
      <label class="rule-row">
        <input type="checkbox" data-r="${esc(r.id)}" ${MK.rules[r.id] !== false ? 'checked' : ''}>
        <span>${esc(r.label)}</span>
        <span class="rule-n" data-c="${esc(r.id)}"></span>
      </label>`).join('');
    host.querySelectorAll('input[data-r]').forEach((cb) => {
      cb.addEventListener('change', () => {
        MK.rules[cb.dataset.r] = cb.checked;
        rematch();
      });
    });
  }

  /**
   * 清单上要显示的全部条目 = 规则命中的 + 手动框选的。
   *
   * 两者分开存（自动命中会被重算整批替换，手动框是用户一个个加的、不能被冲掉），
   * 但**显示与开关必须是同一份语义** —— 否则用户会觉得"清单里没有它，
   * 但图上却被盖住了"。所以这里合成一个视图，改开关时按 id 回到各自的数组。
   */
  function allHits() {
    return MK.hits.concat(MK.manual.map((m) => ({
      id: m.id, kind: 'manual', on: m.on !== false,
      rect: m.rect, text: '', label: '手动',
    })));
  }

  function findHit(id) {
    const a = MK.hits.find((x) => x.id === id);
    if (a) return a;
    const m = MK.manual.find((x) => x.id === id);
    if (!m) return null;
    return {
      get on() { return m.on !== false; },
      set on(v) { m.on = v; },
      kind: 'manual',
    };
  }

  function renderHits() {
    const host = $('mkHits');
    if (!host) return;
    const list = allHits();
    const has = (E() && E().items && E().items.length) || 0;
    if (!list.length) {
      host.innerHTML = `<div class="list-empty">${has
        ? '没有匹配到敏感信息。可以在画布上拖拽手动框选。'
        : '识别到文字后会自动匹配手机号、身份证这类的敏感信息'}</div>`;
      return;
    }
    host.innerHTML = list.map((h) => {
      const on = h.on !== false;
      const manual = h.kind === 'manual';
      const label = manual ? '手动' : (h.label || '');
      const text = h.text
        || (manual ? `框选 ${Math.round(h.rect.w)}×${Math.round(h.rect.h)}` : '');
      let pos = '';
      if (!manual) {
        const idx = (E().items || []).findIndex((it) => String(it.id) === String(h.lineId));
        pos = idx >= 0 ? `第 ${idx + 1} 项` : '';
      }
      return `<div class="hit-row${on ? ' on' : ''}${manual ? ' manual' : ''}" data-id="${esc(h.id)}">
        <input type="checkbox" ${on ? 'checked' : ''} aria-label="是否遮盖">
        <div class="hit-body">
          <div class="hit-text">${esc(text)}</div>
          <div class="hit-meta">${esc(label)}${pos ? ' · ' + pos : ''}</div>
        </div>
      </div>`;
    }).join('');

    host.querySelectorAll('.hit-row').forEach((el) => {
      const id = el.dataset.id;
      const cb = el.querySelector('input');
      const toggle = (v) => {
        const h = findHit(id);
        if (!h) return;
        h.on = v;
        el.classList.toggle('on', v);
        sync();
      };
      cb.addEventListener('change', (ev) => { ev.stopPropagation(); toggle(cb.checked); });
      el.addEventListener('click', (ev) => {
        if (ev.target === cb) return;
        cb.checked = !cb.checked;
        toggle(cb.checked);
      });
    });
  }

  function renderStats() {
    const list = allHits();
    const on = list.filter((h) => h.on !== false).length;
    const total = list.length;
    const manualOn = MK.manual.filter((m) => m.on !== false).length;

    const c = $('mkCount');
    if (c) {
      let t = total ? `遮盖 ${on} / ${total} 处` : '0 处';
      if (MK.method === 'erase' && on) t += ' · 走擦除';
      c.textContent = t;
    }
    const hc = $('mkHitCount'); if (hc) hc.textContent = String(total);
    const mc = $('mkManualCount'); if (mc) mc.textContent = String(manualOn);
    const clr = $('mkClearManual'); if (clr) clr.disabled = !manualOn;
    const all = $('mkAll'); if (all) all.disabled = !total;
    const none = $('mkNone'); if (none) none.disabled = !total;

    if (maskMod) {
      const sum = maskMod.summarize(MK.hits);
      const host = $('mkRuleList');
      if (host) host.querySelectorAll('.rule-n').forEach((s) => {
        const n = sum.by[s.dataset.c] || 0;
        s.textContent = n ? String(n) : '';
      });
      const rc = $('mkRuleCount'); if (rc) rc.textContent = String(sum.total);
    }
  }

  function renderManual() {
    const tip = $('mkManualTip');
    const n = MK.manual.length;
    if (tip) {
      tip.textContent = (E() && E().pane === 'mask')
        ? '在画布上按住拖拽，框住要遮盖的区域。（拖不动说明点到了文字框，换个位置起手）'
        : '在画布上按住拖拽，框住要遮盖的区域。';
    }
    renderStats();
  }

  function addManualRect(rect) {
    if (!rect || rect.w < 2 || rect.h < 2) return;
    const E0 = E();
    if (!E0) return;
    // 已经贴住某个文字框就别重复加：手动框的初衷是"框住没被规则命中的东西"
    MK.manual.push({ id: 'm' + Date.now().toString(36) + MK.manual.length, rect, on: true });
    renderManual();
    sync();
    fb(`已框选 ${rect.w}×${rect.h}，按当前「${
      ({ block: '色块', mosaic: '马赛克', blur: '模糊', erase: '抹字' })[MK.method]}」遮盖`);
  }

  function wireMask() {
    $('mkMethod').addEventListener('click', (e) => {
      const b = e.target.closest('.seg-btn');
      if (!b) return;
      const next = b.dataset.m;
      if (next === MK.method) return;
      const prev = MK.method;
      MK.method = next;
      renderMethod();
      // 从"抹字"切走：把写空的那些项还回去，否则文字会莫名其妙不见
      if (prev === 'erase' && next !== 'erase') restoreEraseEdits().then(sync);
      else sync();
    });

    $('mkColor').addEventListener('input', (e) => {
      MK.color = e.target.value;
      if (MK.method === 'block') sync();
    });

    $('mkRescan').addEventListener('click', () => rematch());

    $('mkAll').addEventListener('click', () => {
      MK.hits.forEach((h) => { h.on = true; });
      MK.manual.forEach((m) => { m.on = true; });
      sync();
    });
    $('mkNone').addEventListener('click', () => {
      MK.hits.forEach((h) => { h.on = false; });
      MK.manual.forEach((m) => { m.on = false; });
      sync();
    });

    $('mkClearManual').addEventListener('click', () => {
      MK.manual = [];
      renderManual();
      sync();
      fb('已清空手动框选');
    });
  }

  /* ==================================================================
     二、翻译
     ================================================================== */

  const TR = {
    pairs: [],        // [{ id, src, dst, on }]
    busy: false,
    from: 'zh', to: 'en',
    model: '',
    checked: false,
    serverReady: null,
    serverMsg: '',
  };

  const TR_MAX_DEPTH = 3;

  function buildPairs() {
    const items = (E() && E().items) || [];
    const old = new Map(TR.pairs.map((p) => [String(p.id), p]));
    TR.pairs = items.map((it) => {
      const o = old.get(String(it.id));
      // 已经译过的（含手改的）按 id 留着，免得重新识别后白翻一遍
      return { id: it.id, src: it.text || '', dst: o ? o.dst : '', on: o ? o.on !== false : true };
    });
    renderPairs(); renderStats2();
  }

  function renderPairs() {
    const host = $('trPairs');
    if (!host) return;
    const items = (E() && E().items) || [];
    if (!items.length) {
      host.innerHTML = '<div class="list-empty">识别到文字后会在这里逐行列出</div>';
      return;
    }
    if (!TR.pairs.length) {
      host.innerHTML = '<div class="list-empty">没有识别到文字。换一张更清晰的图试试（字太小、太糊都会识别不到）</div>';
      return;
    }
    host.innerHTML = TR.pairs.map((p, i) => `
      <div class="pair" data-i="${i}">
        <div class="pair-head">
          <input type="checkbox" ${p.on === false ? '' : 'checked'} aria-label="是否翻译这一行">
          <span class="pair-no">第 ${i + 1} 项</span>
        </div>
        <div class="pair-src">${esc(p.src)}</div>
        <textarea class="pair-dst" rows="1" spellcheck="false"
          placeholder="（还没翻译）" aria-label="第 ${i + 1} 项译文">${esc(p.dst)}</textarea>
      </div>`).join('');

    host.querySelectorAll('.pair').forEach((el) => {
      const i = Number(el.dataset.i);
      const p = TR.pairs[i];
      const cb = el.querySelector('input[type="checkbox"]');
      const ta = el.querySelector('textarea');
      autosize(ta);
      // 逐字改写不重渲染 —— 重渲染会把光标挤掉，所以只回写状态 + 去抖重绘
      ta.addEventListener('input', () => {
        autosize(ta);
        p.dst = ta.value;
        applySoon();
      });
      cb.addEventListener('change', () => { p.on = cb.checked; applySoon(); });
    });
  }

  function autosize(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  }

  const applySoon = debounce(() => { applyTranslations(); }, 400);

  /** 译文 → edits。只放 text 与 auto_fit，字体/颜色/描边交给引擎按原样式推断。 */
  async function applyTranslations() {
    const api = E();
    if (!api) return;
    const autoFit = $('trAutoFit') ? $('trAutoFit').checked : true;
    const batch = {};
    for (const p of TR.pairs) {
      if (p.on === false) continue;
      const t = String(p.dst || '');
      if (!t.trim()) continue;
      batch[String(p.id)] = { text: t, auto_fit: autoFit };
    }
    const ids = Object.keys(batch);
    if (!ids.length) return;
    await api.applyEdits(batch);
    renderStats2();
  }

  function renderStats2() {
    const el = $('trCount');
    if (el) el.textContent = String(TR.pairs.length);
    const done = TR.pairs.filter((p) => p.on !== false && String(p.dst || '').trim()).length;
    const run = $('trRun');
    if (run) {
      run.disabled = TR.busy || !TR.pairs.length;
      run.textContent = TR.busy ? '翻译中…' : (done ? '重新翻译' : '翻译');
    }
    const ap = $('trApply'); if (ap) ap.disabled = !done;
    const rv = $('trRevert'); if (rv) rv.disabled = !done;
  }

  async function reqTranslate(texts) {
    const r = await fetch('/api/text/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts, from: TR.from, to: TR.to }),
    });
    const txt = await r.text();
    let j = null;
    try { j = txt ? JSON.parse(txt) : null; } catch (_) { /* 下面统一报可读文案 */ }
    if (!r.ok) {
      // detail 可能是对象 {message,hint}（对齐 Python 侧形状），取可读字段
      let m = j && (j.detail || j.message);
      if (m && typeof m === 'object') m = m.message || m.hint || '';
      throw new Error(m || `HTTP ${r.status}`);
    }
    if (!j || !Array.isArray(j.texts) || j.texts.length !== texts.length) {
      throw new Error('译文行数与原文对不上');
    }
    if (j.model) TR.model = j.model;
    return j.texts.map((t) => (t == null ? '' : String(t)));
  }

  /**
   * 翻一批，失败就劈成两半各翻一次。
   * 行数对不上是这类调用最常见的失败（模型漏行、被截断），而"整批重来"在
   * 30 行时几乎必然再失败一次 —— 降半批能很快落到能成功的粒度。
   */
  async function translateChunk(texts, depth = 0) {
    try {
      return await reqTranslate(texts);
    } catch (err) {
      if (texts.length <= 1 || depth >= TR_MAX_DEPTH) throw err;
      const mid = Math.ceil(texts.length / 2);
      const a = await translateChunk(texts.slice(0, mid), depth + 1);
      const b = await translateChunk(texts.slice(mid), depth + 1);
      return [...a, ...b];
    }
  }

  /** 数据来源：/api/text/status。只探一次且失败静默 —— 纯静态托管下没有这个接口，
   *  提示一句"翻译不可用"只会让用户以为整个页面坏了；真正的失败留给点翻译时报。 */
  async function checkStatus() {
    if (TR.checked) return;
    TR.checked = true;
    try {
      const r = await fetch('/api/text/status');
      if (!r.ok) return;
      const j = await r.json();
      TR.serverReady = !!j.ready;
      TR.serverMsg = j.ready ? '' : [j.message, j.hint].filter(Boolean).join('　');
      renderStats2();
    } catch (_) { /* 离线 / 静态托管：不打扰 */ }
  }

  async function runTranslate() {
    if (TR.busy) return;
    const targets = TR.pairs.filter((p) => p.on !== false && String(p.src || '').trim());
    if (!targets.length) { fb('没有需要翻译的文字'); return; }

    TR.busy = true; renderStats2();
    st('正在翻译…', 'busy');
    // 把"实际发出去的内容"如实亮出来 —— 图片不出本机，但文字确实要出境
    const sent = $('trSentBox'), sentPre = $('trSent');
    if (sent && sentPre) {
      sent.hidden = false;
      sentPre.textContent = targets.map((p, i) => `${i + 1}. ${p.src}`).join('\n');
    }
    try {
      const out = await translateChunk(targets.map((p) => p.src));
      targets.forEach((p, i) => { p.dst = out[i] != null ? String(out[i]) : ''; });
      renderPairs(); renderStats2();
      await applyTranslations();
      st(`翻译完成 · ${targets.length} 项`, 'ok', TR.model ? `模型 ${esc(TR.model)}` : '');
      fb(`已翻译 ${targets.length} 项，可用「写回画布」单独重放`);
    } catch (err) {
      const msg = String((err && err.message) || err);
      st(`翻译失败：${msg}`, 'err');
      fb(`翻译失败：${msg}`);
    } finally {
      TR.busy = false;
      renderStats2();
    }
  }

  function wireTranslate() {
    $('trRun').addEventListener('click', runTranslate);

    $('trSwap').addEventListener('click', () => {
      const f = $('trFrom').value;
      $('trFrom').value = $('trTo').value;
      $('trTo').value = f;
      TR.from = $('trFrom').value; TR.to = $('trTo').value;
      fb(`翻译方向已改为 ${$('trFrom').selectedOptions[0].textContent} → ${$('trTo').selectedOptions[0].textContent}`);
    });

    $('trFrom').addEventListener('change', (e) => { TR.from = e.target.value; });
    $('trTo').addEventListener('change', (e) => { TR.to = e.target.value; });
    $('trAutoFit').addEventListener('change', () => applyTranslations());
    $('trApply').addEventListener('click', async () => {
      await applyTranslations();
      fb('译文已写回画布');
    });
    $('trRevert').addEventListener('click', async () => {
      const api = E();
      if (!api) return;
      const ids = TR.pairs.filter((p) => String(p.dst || '').trim()).map((p) => String(p.id));
      TR.pairs.forEach((p) => { p.dst = ''; });
      renderPairs(); renderStats2();
      await api.revertEdits(ids);
      fb('已撤销译文');
    });
  }

  /* ==================================================================
     三、取文字：复制全部 / 导出 txt
     ------------------------------------------------------------------
     「取文字」不需要单独一个功能 —— 改字界面的识别结果本来就是整页的字。
     这两个出口把它按**阅读顺序**重排后给出去（而不是按检测顺序），
     重排直接复用引擎里那套纯函数，不另写一份。
     ================================================================== */

  function orderedText() {
    const items = (E() && E().items) || [];
    if (!items.length) return '';
    if (extractMod) {
      try { return extractMod.extract(items).text || ''; } catch (_) { /* 退回朴素拼接 */ }
    }
    return items.map((it) => it.text).filter(Boolean).join('\n');
  }

  function syncCopyButtons() {
    const n = ((E() && E().items) || []).length;
    const c = $('btnCopyAll'); if (c) c.disabled = !n;
    const x = $('btnExportTxt'); if (x) x.disabled = !n;
  }

  async function copyAll() {
    const t = orderedText();
    if (!t) { fb('还没有识别到文字'); return; }
    try {
      await navigator.clipboard.writeText(t);
    } catch (_) {
      // 非安全上下文（http:// 局域网访问）下 clipboard 不可用，退回老办法
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e2) { fb('复制失败，请改用「导出 txt」'); ta.remove(); return; }
      ta.remove();
    }
    fb(`已复制 ${t.split('\n').filter(Boolean).length} 行文字`);
  }

  function exportTxt() {
    const t = orderedText();
    if (!t) { fb('还没有识别到文字'); return; }
    const api = E();
    const stem = ((api && api.file && api.file.name) || 'text').replace(/\.[^.]+$/, '');
    const blob = new Blob([t], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${stem}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    fb('已导出 ' + a.download);
  }

  function wireCopy() {
    const c = $('btnCopyAll'), x = $('btnExportTxt');
    if (c) c.addEventListener('click', copyAll);
    if (x) x.addEventListener('click', exportTxt);
    syncCopyButtons();
  }

  /* ==================================================================
     四、对外的三个钩子（由 app.js 调）
     ================================================================== */

  /** 换图 / 重新识别 / 还原之后：两边的清单都要按新的识别结果重建 */
  function onImageChanged() {
    MK.hits = []; MK.manual = []; MK.eraseIds = new Set();
    MK.eraseSig = '';
    TR.pairs = [];
    const api = E();
    if (api) api.setPicks([]);
    renderHits(); renderStats(); renderManual();
    renderPairs(); renderStats2();
    syncCopyButtons();

    if (!api || !api.items.length) return;
    loadEngine().then(() => {
      if (!MK.rules) MK.rules = maskMod.defaultRuleState();
      renderRules();
      rematch();            // 打码：按规则重新匹配
      buildPairs();         // 翻译：按新的 items 重建逐行对照
      renderMethod();
    }).catch((err) => {
      fb('打码规则模块加载失败：' + err.message);
    });
  }

  /** 切到某个页签时：把该页签该有的东西补齐 */
  function onPane(name) {
    if (name === 'mask') {
      renderManual();
      loadEngine().then(() => {
        renderRules();
        renderMethod();
        if (!MK.hits.length && !MK.manual.length) rematch();
        else { renderHits(); renderStats(); }
      }).catch((err) => fb('打码规则模块加载失败：' + err.message));
    } else if (name === 'translate') {
      checkStatus();
      if (!TR.pairs.length) buildPairs();
      else { renderPairs(); renderStats2(); }
      if (TR.serverReady === false && TR.serverMsg) {
        st(`翻译暂不可用：${TR.serverMsg}`, 'err');
      }
    }
  }

  function boot() {
    if (!$('mkMethod')) return;      // 骨架不对（老页面）就别初始化
    wireMask();
    wireTranslate();
    wireCopy();
    renderMethod();
    renderStats();
    onImageChanged();                // 直接带 hash 进来时，先把两边清空成空态
    const api = E();
    if (api) onPane(api.pane);       // 万一进来就停在打码/翻译页签上
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  return { onImageChanged, onPane, addManualRect, _state: { MK, TR } };
})();
