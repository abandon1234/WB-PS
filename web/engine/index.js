/* ==========================================================================
   WB-PS · 本地引擎（移植自 app/pipeline.py + app/ocr_engine.py 的编排部分）

   与 Python 侧的三条核心约定保持一字不差：
     * **无状态**：每次从原图重新算，结果可复现、可回滚
     * **擦除上下文固定**：所有擦除都基于同一张原图，避免先后顺序污染 inpaint
     * **逐框独立**：每框的擦除与重绘互不影响，所以局部预览与最终结果必然一致

   对外产出的 items 结构与 Python 侧完全同构（box 四点 + rect + text + score + id），
   这样前端 web/app.js 只需要换掉那一层 api()，UI 逻辑一行都不用动。
   ========================================================================== */
import { pyRound, mean } from './num.js';
import { rm, imageDataToBgrMat, matToImageData, cropMat, emptyMask, countNonZero } from './cvutil.js';
import { loadRuntimes } from './runtime.js';
import { FontRegistry } from './fonts.js';
import { OcrEngine } from './ocr/engine.js';
import * as styleMod from './style.js';
import * as eraseMod from './erase.js';
import * as renderMod from './render.js';

const int = (v) => Math.trunc(v || 0);
const r1 = (v) => Math.round(v * 10) / 10;
const r4 = (v) => Math.round(v * 10000) / 10000;

/* ------------------------------------------------------------ 几何 */

/** 四点排序：左上 → 右上 → 右下 → 左下 */
export function orderQuad(pts) {
  const p = pts.map((q) => [q[0], q[1]]);
  const sum = p.map((q) => q[0] + q[1]);
  const diff = p.map((q) => q[1] - q[0]);
  const argmin = (a) => a.indexOf(Math.min(...a));
  const argmax = (a) => a.indexOf(Math.max(...a));
  return [p[argmin(sum)], p[argmin(diff)], p[argmax(sum)], p[argmax(diff)]];
}

export function quadMetrics(quad) {
  const q = orderQuad(quad);
  const xs = q.map((p) => p[0]);
  const ys = q.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const w = x1 - x0, h = y1 - y0;

  const top = [q[1][0] - q[0][0], q[1][1] - q[0][1]];
  let angle = (Math.atan2(top[1], top[0]) * 180) / Math.PI;
  if (angle > 90) angle -= 180;
  else if (angle < -90) angle += 180;

  const ideal = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  let dev = 0;
  for (let i = 0; i < 4; i++) {
    dev = Math.max(dev, Math.abs(q[i][0] - ideal[i][0]), Math.abs(q[i][1] - ideal[i][1]));
  }

  return {
    rect: { x: pyRound(x0), y: pyRound(y0), w: pyRound(w), h: pyRound(h) },
    angle: Math.round(angle * 100) / 100,
    quad_axis: dev <= Math.max(2.0, 0.08 * Math.max(w, h, 1)),
  };
}

/* ------------------------------------------------------------ 行合并 */

/**
 * 把同一行的多个检测框合并成一个「文本行」框。
 * OCR 常把一行文字切成若干片段，合并后编辑体验和视觉还原都更自然。
 */
export function mergeLines(items, enabled = true) {
  if (!enabled || items.length <= 1) {
    items.forEach((it, i) => { it.segments = [it.text]; it.id = i; });
    return items;
  }

  const arr = [...items].sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x));
  const used = new Array(arr.length).fill(false);
  const lines = [];

  for (let i = 0; i < arr.length; i++) {
    if (used[i]) continue;
    const base = arr[i];
    const group = [base];
    used[i] = true;

    let bCy = base.rect.y + base.rect.h / 2.0;
    let bH = Math.max(base.rect.h, 1);
    let changed = true;
    while (changed) {
      changed = false;
      let gx0 = Infinity, gx1 = -Infinity, gy0 = Infinity, gy1 = -Infinity;
      for (const g of group) {
        gx0 = Math.min(gx0, g.rect.x);
        gx1 = Math.max(gx1, g.rect.x + g.rect.w);
        gy0 = Math.min(gy0, g.rect.y);
        gy1 = Math.max(gy1, g.rect.y + g.rect.h);
      }
      const gh = Math.max(gy1 - gy0, 1);

      for (let j = 0; j < arr.length; j++) {
        if (used[j]) continue;
        const cr = arr[j].rect;
        const cCy = cr.y + cr.h / 2.0;
        // 垂直：中心线接近 且 高度量级相近
        const vOk = Math.abs(cCy - bCy) < 0.45 * Math.max(gh, bH)
          && cr.h / Math.max(gh, 1) >= 0.5 && cr.h / Math.max(gh, 1) <= 2.0;
        // 水平：间隙不超过 2.2 个字宽
        const gap = Math.max(gx0 - (cr.x + cr.w), cr.x - gx1, 0);
        const hOk = gap < 2.2 * gh;
        if (vOk && hOk) {
          group.push(arr[j]);
          used[j] = true;
          bH = Math.max(bH, cr.h);
          bCy = bCy;
          changed = true;
        }
      }
    }

    group.sort((a, b) => a.rect.x - b.rect.x);
    const x0 = Math.min(...group.map((g) => g.rect.x));
    const y0 = Math.min(...group.map((g) => g.rect.y));
    const x1 = Math.max(...group.map((g) => g.rect.x + g.rect.w));
    const y1 = Math.max(...group.map((g) => g.rect.y + g.rect.h));

    const firstText = group[0].text || '';
    const joinWith = /^[\x00-\x7F]*$/.test(firstText) ? ' ' : '';
    lines.push({
      box: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
      rect: { x: int(x0), y: int(y0), w: int(Math.max(x1 - x0, 1)), h: int(Math.max(y1 - y0, 1)) },
      text: group.map((g) => g.text).join(joinWith),
      score: r4(mean(group.map((g) => g.score))),
      angle: Math.round(mean(group.map((g) => g.angle)) * 100) / 100,
      quad_axis: group.every((g) => g.quad_axis),
      segments: group.map((g) => g.text),
      merged: group.length,
    });
  }

  lines.sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x));
  lines.forEach((it, i) => { it.id = i; });
  return lines;
}

/* ------------------------------------------------------------ 检测 + 样式分析 */

/**
 * 对 BGR 图像做文字检测与识别（含超长图降采样）。
 * @param maxSide 长边上限，超限等比缩小以加速（坐标会映射回原尺寸）
 */
export async function detect(cv, ocr, imageBgr, { merge = true, minScore = 0.35, maxSide = 2400 } = {}) {
  const h = imageBgr.rows, w = imageBgr.cols;
  let scale = 1.0;
  let feed = imageBgr;

  if (Math.max(h, w) > maxSide) {
    scale = maxSide / Math.max(h, w);
    feed = new cv.Mat();
    cv.resize(imageBgr, feed, new cv.Size(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))), 0, 0, cv.INTER_AREA);
  }

  let raw;
  try {
    raw = await ocr.run(feed, { useDet: true, textScore: minScore });
  } finally {
    if (feed !== imageBgr) rm(feed);
  }

  const results = [];
  for (const it of raw.items) {
    const text = (it.text || '').trim();
    if (!text || it.score < minScore) continue;
    const quad = orderQuad(it.box).map((p) => [p[0] / scale, p[1] / scale]);
    const m = quadMetrics(quad);
    if (m.rect.w < 3 || m.rect.h < 3) continue;
    results.push({
      box: quad.map((p) => [r1(p[0]), r1(p[1])]),
      rect: m.rect,
      text,
      score: r4(it.score),
      angle: m.angle,
      quad_axis: m.quad_axis,
    });
  }

  return mergeLines(results, merge);
}

/** 检测 + 样式分析，返回与 Python /api/analyze 同构的结果 */
export async function analyze(cv, ocr, fonts, imageBgr, { mergeLines: doMerge = true, minScore = 0.35 } = {}) {
  const items = await detect(cv, ocr, imageBgr, { merge: doMerge, minScore });
  styleMod.analyzeMany(cv, imageBgr, items);
  return {
    width: imageBgr.cols,
    height: imageBgr.rows,
    backend: 'browser-wasm',
    count: items.length,
    items,
  };
}

/* ------------------------------------------------------------ 编辑参数 */

/** 把前端 edit 对象翻译成 renderer 的入参 */
function editParams(item, edit) {
  const style = item.style || {};
  const rect = item.rect;

  let bold = edit.bold;
  if (bold === null || bold === undefined) bold = style.bold ?? false;
  let fg = edit.fg_color;
  if (fg === null || fg === undefined) fg = style.fg_color;

  let font_size = edit.font_size;
  if (font_size === null || font_size === undefined || font_size === 0 || font_size === '') {
    const ratio = Number(edit.font_scale || 1.0);
    if (Math.abs(ratio - 1.0) > 1e-6) {
      const base = style.font_size || Math.max(int(rect.h * 0.86), 8);
      font_size = Math.max(6, pyRound(base * ratio));
    } else {
      font_size = null;
    }
  }

  return {
    family: edit.family || null,
    font_size,
    fg_color: fg,
    bold,
    italic: !!edit.italic,
    align: edit.align || style.align || 'left',
    valign: edit.valign || 'bottom',
    offset: [int(edit.offset_x || 0), int(edit.offset_y || 0)],
    letter_spacing: Number(edit.letter_spacing || 0),
    auto_fit: !!edit.auto_fit,
    match_sharpness: edit.match_sharpness !== false,
    match_stroke: edit.match_stroke !== false,
    auto_family: edit.auto_family !== false,
    shadow: edit.shadow || null,
  };
}

function eraseMethodOf(edit) {
  const m = String((edit && edit.erase_method) || 'auto').toLowerCase();
  return ['auto', 'fill', 'linear', 'inpaint', 'ns', 'telea', 'blur'].includes(m) ? m : 'auto';
}

/** 判断该编辑是否真的需要动图（避免无意义的擦除重绘） */
function isDirty(edit, item) {
  // 显式关闭的项直接跳过，连擦除都不做
  if (edit.enabled === false) return false;

  const newText = edit.text;
  if (newText !== undefined && newText !== null && String(newText) !== String(item.text || '')) return true;
  if (edit.force) return true;

  const style = item.style || {};
  const checks = [
    ['family', null], ['font_size', null], ['font_scale', 1.0],
    ['fg_color', style.fg_color], ['bold', style.bold], ['align', style.align],
    ['valign', 'bottom'], ['erase_method', 'auto'],
  ];
  for (const [key, def] of checks) {
    if (!(key in edit)) continue;
    const v = edit[key];
    if (v === null || v === '' || v === undefined) continue;
    if (key === 'fg_color' && Array.isArray(v) && Array.isArray(def) && v.join() === def.join()) continue;
    if (v === def) continue;
    return true;
  }
  for (const key of ['italic', 'offset_x', 'offset_y', 'letter_spacing']) {
    const v = edit[key];
    if (v !== null && v !== undefined && v !== 0 && v !== false) return true;
  }
  const switches = { auto_fit: false, match_sharpness: true, auto_family: true, match_stroke: true };
  for (const [key, def] of Object.entries(switches)) {
    if (key in edit && !!edit[key] !== def) return true;
  }
  return false;
}

/* ------------------------------------------------------------ 应用编辑 */

function unionBox(a, b) {
  const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
  const x1 = Math.max(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.max(a[1] + a[3], b[1] + b[3]);
  return [x0, y0, Math.max(x1 - x0, 1), Math.max(y1 - y0, 1)];
}

/** 批量擦除。所有擦除都基于同一张原图，结果互不污染。 */
function eraseAll(cv, imageBgr, targets) {
  const base = imageBgr.clone();
  for (const [item, edit] of targets) {
    const rect = item.rect;
    const style = item.style || {};
    let erased;
    try {
      erased = eraseMod.erase(cv, imageBgr, rect, style, {
        method: eraseMethodOf(edit),
        grow: int(edit.erase_grow || 2),
      });
    } catch (_) {
      continue;
    }
    const [x, y, w, h] = erased.meta.box;
    const od = base.data, ed = erased.image.data;
    const W = base.cols;
    for (let yy = y; yy < y + h; yy++) {
      const src = (yy * erased.image.cols + x) * 3;
      const dst = (yy * W + x) * 3;
      for (let k = 0; k < w * 3; k++) od[dst + k] = ed[src + k];
    }
    rm(erased.image);
  }
  return base;
}

/**
 * 执行全部编辑，返回 { image, stats }。
 * @param items    原始检测结果（含 rect / text / style）
 * @param edits    {item_id: edit}，只处理 enabled 且真正有变化的项
 * @param newItems 用户手动新增的文字
 */
export function applyEdits(cv, fonts, imageBgr, items, edits, newItems = null) {
  edits = edits || {};
  const targets = [];
  for (const it of items) {
    const edit = edits[String(it.id)] || edits[it.id];
    if (!edit) continue;
    if (isDirty(edit, it)) targets.push([it, edit]);
  }

  let out = targets.length ? eraseAll(cv, imageBgr, targets) : imageBgr.clone();

  const log = [];
  // 按 y 再按 x 绘制，保证叠压顺序符合直觉
  const sorted = [...targets].sort((a, b) => (a[0].rect.y - b[0].rect.y) || (a[0].rect.x - b[0].rect.x));

  for (const [it, edit] of sorted) {
    let newText = edit.text;
    newText = newText === null || newText === undefined ? (it.text || '') : String(newText);
    const record = { id: it.id, origin: it.text || '', text: newText };

    if (!newText.trim()) {                 // 文本被清空 → 只擦不画
      record.action = 'erase';
      log.push(record);
      continue;
    }

    const params = editParams(it, edit);
    try {
      const res = renderMod.render(cv, fonts, out, it.rect, newText, it.style || {}, {
        ...params, match_source: imageBgr, source_text: it.text || '',
      });
      // render 返回的是新 Mat（底图未被修改），换掉旧的
      rm(out);
      out = res.image;
      record.action = 'replace';
      record.font_size = res.font_size;
      record.family = res.family;
      record.fitted = res.fitted;
      record.stroke = res.stroke;
      record.matched = res.matched;
      record.box = res.box;
      if (res.warnings && res.warnings.length) record.warnings = res.warnings;
      log.push(record);
    } catch (err) {
      record.action = 'error';
      // 带上堆栈：仅凭 message 定位不到是哪个 Mat 被提前释放了
      record.error = String((err && (err.stack || err.message)) || err).split('\n').slice(0, 3).join(' | ');
      log.push(record);
    }
  }

  /* ---- 手动新增文字 ---- */
  (newItems || []).forEach((add, i) => {
    const rect = add.rect;
    const text = String(add.text || '');
    if (!rect || !text.trim()) return;

    const style = { ...(add.style || {}) };
    // 未指定颜色时，按背景明暗取对比色
    if (!style.fg_color) style.fg_color = style.light_text ? [255, 255, 255] : [17, 17, 17];
    if (style.ink_rect === undefined) style.ink_rect = null;
    if (style.ink_height === undefined) style.ink_height = int(rect.h * 0.86);
    if (style.align === undefined) style.align = 'left';

    const edit = { text, auto_fit: false };
    for (const k of ['family', 'font_size', 'fg_color', 'bold', 'italic', 'align',
      'offset_x', 'offset_y', 'letter_spacing']) {
      if (k in add) edit[k] = add[k];
    }

    try {
      const res = renderMod.render(cv, fonts, out, rect, text, style, {
        ...editParams({ rect, style }, edit), auto_fit: false,
      });
      rm(out);
      out = res.image;
      log.push({ id: `new-${i}`, action: 'insert', text, font_size: res.font_size, family: res.family });
    } catch (err) {
      log.push({ id: `new-${i}`, action: 'error', error: String((err && err.message) || err) });
    }
  });

  return {
    image: out,
    stats: {
      erased: targets.length,
      rendered: log.filter((r) => r.action === 'replace' || r.action === 'insert').length,
      log,
    },
  };
}

/* ------------------------------------------------------------ 单框预览 */

/** 只处理一个文字框，返回局部 patch 的 data URL，供前端实时预览 */
export function previewItem(cv, fonts, imageBgr, item, edit, { pad = 10 } = {}) {
  const rect = item.rect;
  const style = item.style || {};

  let erased;
  try {
    erased = eraseMod.erase(cv, imageBgr, rect, style, { method: eraseMethodOf(edit), grow: int(edit.erase_grow || 2) });
  } catch (_) {
    erased = { image: imageBgr.clone(), meta: { box: [rect.x, rect.y, rect.w, rect.h] } };
  }

  const base = imageBgr.clone();
  const [ex, ey, ew, eh] = erased.meta.box;
  {
    const bd = base.data, ed = erased.image.data;
    const W = base.cols;
    for (let yy = ey; yy < ey + eh; yy++) {
      const src = (yy * erased.image.cols + ex) * 3;
      const dst = (yy * W + ex) * 3;
      for (let k = 0; k < ew * 3; k++) bd[dst + k] = ed[src + k];
    }
  }
  rm(erased.image);

  let newText = edit.text;
  newText = newText === null || newText === undefined ? (item.text || '') : String(newText);

  const info = { font_size: style.font_size, family: null, fitted: false, warnings: [], stroke: {}, matched: {} };
  let working = base;

  if (newText.trim()) {
    const params = editParams(item, edit);
    try {
      const res = renderMod.render(cv, fonts, base, rect, newText, style, {
        ...params, match_source: imageBgr, source_text: item.text || '',
      });
      rm(working);
      working = res.image;
      Object.assign(info, {
        font_size: res.font_size, family: res.family, fitted: res.fitted,
        warnings: res.warnings, stroke: res.stroke, matched: res.matched, render_box: res.box,
      });
    } catch (err) {
      info.warnings.push(String(err && err.message || err));
    }
  }

  let region = unionBox(erased.meta.box, [rect.x, rect.y, rect.w, rect.h]);
  if (info.render_box) region = unionBox(region, info.render_box);

  // 外扩裁出补丁
  const H = working.rows, W = working.cols;
  const px = Math.max(0, region[0] - pad), py = Math.max(0, region[1] - pad);
  const pw = Math.min(W - px, region[2] + pad * 2), ph = Math.min(H - py, region[3] + pad * 2);

  const patch = cropMat(cv, working, px, py, Math.max(1, pw), Math.max(1, ph));
  const dataUrl = matToDataUrl(cv, patch);
  rm(patch, working);

  info.region = [px, py, Math.max(1, pw), Math.max(1, ph)];
  info.erase_method = erased.meta.method;
  return { patch: dataUrl, info };
}

/** 判断给定区域能否安全擦除（给出背景类型与建议方法） */
export function detectMaskRegion(cv, imageBgr, rect) {
  const H = imageBgr.rows, W = imageBgr.cols;
  let x = int(rect.x), y = int(rect.y), w = int(rect.w), h = int(rect.h);
  x = Math.max(0, Math.min(x, W - 2));
  y = Math.max(0, Math.min(y, H - 2));
  w = Math.max(2, Math.min(w, W - x));
  h = Math.max(2, Math.min(h, H - y));

  const style = styleMod.analyze(cv, imageBgr, { x, y, w, h });
  const method = { solid: 'fill', gradient: 'linear' }[style.bg_type] || 'inpaint';
  return {
    rect: { x, y, w, h },
    bg_type: style.bg_type,
    bg_std: style.bg_std,
    suggest_method: method,
    style,
  };
}

/* ------------------------------------------------------------ 图像编解码 */

export function matToDataUrl(cv, mat, mime = 'image/png', quality = 0.95) {
  const canvas = document.createElement('canvas');
  canvas.width = mat.cols;
  canvas.height = mat.rows;
  canvas.getContext('2d').putImageData(matToImageData(cv, mat), 0, 0);
  return canvas.toDataURL(mime, quality);
}

export function imageDataOf(image) {
  const c = document.createElement('canvas');
  c.width = image.naturalWidth || image.width;
  c.height = image.naturalHeight || image.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

export { imageDataToBgrMat, matToImageData };

/* ------------------------------------------------------------ 引擎门面 */

export class LocalEngine {
  constructor(cv, ort, ocr, fonts) {
    this.cv = cv;
    this.ort = ort;
    this.ocr = ocr;
    this.fonts = fonts;
  }

  static async create({ base = '/assets', onProgress = () => {} } = {}) {
    const { cv, ort } = await loadRuntimes(onProgress);
    onProgress({ phase: 'models', label: 'OCR 模型' });
    const ocr = await OcrEngine.create(ort, cv, { base, onProgress });
    onProgress({ phase: 'fonts', label: '字体' });
    const fonts = await new FontRegistry({ base: `${base}/fonts` }).init();
    return new LocalEngine(cv, ort, ocr, fonts);
  }

  /** ImageData → { bgr Mat, analyze 结果 } */
  async analyzeImageData(imageData, opts) {
    const bgr = imageDataToBgrMat(this.cv, imageData);
    try {
      return await analyze(this.cv, this.ocr, this.fonts, bgr, opts);
    } finally {
      rm(bgr);
    }
  }
}
