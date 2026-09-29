/* ==========================================================================
   WB-PS · 文字重绘（移植自 app/text_renderer.py，渲染后端由 PIL 换成 Canvas）

   无痕的四个关键点，原样保留：
     1. **字号反推**：目标墨迹高度 ÷ 字体的**实测**字面比例（不同字体差很多）
     2. **超采样**：4 倍分辨率绘制再缩回，边缘平滑度接近系统抗锯齿
     3. **墨迹对齐**：对齐「墨迹外接框」而非 OCR 框，消除字体上升/下降部的错位
     4. **清晰度匹配**：原图偏糊时对新文字做等量柔化，否则新字"太锐"会露馅

   后端替换带来的差异（已逐条对齐）：
     PIL ImageFont.truetype   → FontFace + canvas ctx.font（字体须先托管/探测）
     PIL stroke_width         → canvas lineWidth，取 2 倍（PIL 是向外扩 N px，
                                canvas 的 lineWidth 是内外各半）
     PIL AFFINE transform     → canvas setTransform，矩阵按"采样映射"反推
     LANCZOS 缩放             → drawImage + imageSmoothingQuality:'high'
   ========================================================================== */
import { clamp, pyRound, percentile, median } from './num.js';
import { rm, grayOf, grayData, cropMat, countNonZero } from './cvutil.js';
import { estimateBgLevel, textMask } from './style.js';

const SS = 4;                        // 超采样倍率
const DEFAULT_SLOPE = 0.21;          // 斜体错切比例
const HARD_OVERFLOW = 1.80;          // 未开自适应时，超出此比例才强行收敛字号
const FIT_FLOOR = 0.72;              // 字号收敛下限（相对原字号）

const int = (v) => Math.trunc(v || 0);

/** 诊断打点：`window.__RENDER_DEBUG__ = true` 时各阶段往 console 记一行。
 *  之所以走 console 而不是攒数组：主线程一旦被某步卡死，
 *  攒在内存里的进度读不出来，而 console 消息会即时推给调试端。 */
const dbg = (label) => {
  if (typeof window !== 'undefined' && window.__RENDER_DEBUG__) {
    console.log(`[render] ${label} @${Math.round(performance.now())}`);
  }
};

/* ------------------------------------------------------------ 画布工具 */

function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.floor(w));
  c.height = Math.max(1, Math.floor(h));
  return c;
}

function ctx2d(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true });
}

/** 图层内实际墨迹的外接框。
 *
 *  必须用 alpha 阈值而不是"非透明即内容"：缩小缩放会在字形轮廓外围
 *  留下极低 alpha 的振铃伪影（1~20 量级），把它们算进内容会让墨迹高度
 *  虚高 40px 以上，进而让垂直定位整体带偏。32 这个门槛滤掉振铃、
 *  又保留真实抗锯齿边缘。 */
function contentBBox(canvas) {
  const ctx = ctx2d(canvas);
  const { data, width: w, height: h } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) {
      if (data[(base + x) * 4 + 3] <= 32) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** 测量渲染图层的笔画宽度，与 style.strokeWidth 同口径（距离变换 + 面积/周长） */
function layerStrokeWidth(cv, canvas) {
  const ctx = ctx2d(canvas);
  const { data, width: w, height: h } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const m = new cv.Mat(h, w, cv.CV_8UC1);
  const md = m.data;
  let area = 0;
  for (let i = 0; i < w * h; i++) {
    const on = data[i * 4 + 3] > 96;
    md[i] = on ? 255 : 0;
    if (on) area++;
  }
  if (area < 12) { rm(m); return 0.0; }

  const dt = new cv.Mat();
  cv.distanceTransform(m, dt, cv.DIST_L2, 5);
  const vals = [];
  // opencv.js 里 CV_32F 的 Mat.data 给的是 Uint8Array（堆的字节视图），
  // 直接读拿到的是字节而不是浮点距离 —— 必须走 data32F。
  const dd = dt.data32F;
  for (let i = 0; i < dd.length; i++) if (dd[i] > 0) vals.push(dd[i]);
  let dtW = 0.0;
  if (vals.length) {
    const p80 = percentile(vals, 80);
    dtW = median(vals.filter((v) => v >= p80)) * 2.0;
  }
  rm(dt);

  const ker = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const grad = new cv.Mat();
  cv.morphologyEx(m, grad, cv.MORPH_GRADIENT, ker);
  let perim = 0;
  const gd = grad.data;
  for (let i = 0; i < gd.length; i++) perim += gd[i];
  perim /= 255;                       // 回到 0/1 口径（与 Python 一致）
  rm(grad, ker, m);

  const apW = perim > 0 ? 2.0 * area / perim : 0.0;
  if (dtW <= 0) return apW;
  if (apW <= 0) return dtW;
  if (dtW < 3.0) return 0.5 * (dtW + apW);
  return 0.25 * apW + 0.75 * dtW;
}

/* ------------------------------------------------------------ 图层绘制 */

function fontString(cssFamily, size, bold, italic) {
  return `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}${size}px ${cssFamily}`;
}

/**
 * 在透明图层上以 SS 倍分辨率绘制一行文字，返回已缩回 1x 的 canvas。
 * 逐字符布局（因此支持字距），以 baseline 为锚点（保证跨字体基线一致）。
 */
function drawTextLayer(fonts, text, family, size, color, {
  bold = false, italic = false, stroke = 0.0, shadow = null, letterSpacing = 0.0,
} = {}) {
  const css = fonts.cssFor(family);
  const bigSize = Math.max(4, pyRound(size * SS));

  const probe = ctx2d(newCanvas(8, 8));
  probe.font = fontString(css, bigSize, bold, italic);

  const chars = Array.from(text);
  const advances = chars.map((ch) => {
    try { return probe.measureText(ch).width; } catch (_) { return bigSize * 0.6; }
  });
  const totalAdv = advances.reduce((a, b) => a + b, 0)
    + Math.max(0, letterSpacing * SS) * Math.max(chars.length - 1, 0);
  if (totalAdv <= 0) return null;

  const met = probe.measureText(text);
  const asc = met.fontBoundingBoxAscent || bigSize * 0.86;
  const desc = met.fontBoundingBoxDescent || bigSize * 0.26;

  const strokePx = pyRound(stroke * SS);
  const shDx = shadow ? pyRound((shadow.dx ?? 2) * SS) : 0;
  const shDy = shadow ? pyRound((shadow.dy ?? 2) * SS) : 0;
  const shExtra = shadow ? 2 * (Math.abs(shDx) + Math.abs(shDy) + strokePx) : 0;

  const pad = pyRound(size * SS * 0.35) + strokePx + shExtra + 2;
  let W = Math.ceil(totalAdv) + pad * 2;
  const H = Math.ceil(asc + desc) + pad * 2;
  if (italic) W += int(DEFAULT_SLOPE * H) + 2;

  const big = newCanvas(W, H);
  const ctx = ctx2d(big);
  const baseline = pad + asc;

  const emit = (fill, dx, dy) => {
    ctx.font = fontString(css, bigSize, bold, italic);
    ctx.fillStyle = fill;
    ctx.strokeStyle = fill;
    // PIL 的 stroke_width 是"向外扩 N px"，canvas 的 lineWidth 内外各半 → 取 2 倍
    ctx.lineWidth = strokePx * 2;
    ctx.lineJoin = 'round';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    let x = pad;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch.trim()) {
        if (strokePx > 0) ctx.strokeText(ch, x + dx, baseline + dy);
        ctx.fillText(ch, x + dx, baseline + dy);
      }
      x += advances[i] + letterSpacing * SS;
    }
  };

  if (shadow) {
    const sc = shadow.color || [0, 0, 0];
    const a = clamp(shadow.alpha ?? 90, 0, 255) / 255;
    emit(`rgba(${int(sc[0])},${int(sc[1])},${int(sc[2])},${a})`, shDx, shDy);
  }
  emit(`rgb(${int(color[0])},${int(color[1])},${int(color[2])})`, 0, 0);

  let source = big;
  if (italic) {
    // PIL: dest(x,y) ← src(x + slope*y − slope*(H−baseline), y)
    // 反推正向映射 → canvas 矩阵 (1, 0, −slope, 1, slope*(H−baseline), 0)
    const skewed = newCanvas(W, H);
    const sk = skewed.getContext('2d', { willReadFrequently: true });
    sk.setTransform(1, 0, -DEFAULT_SLOPE, 1, DEFAULT_SLOPE * (H - baseline), 0);
    sk.drawImage(big, 0, 0);
    source = skewed;
  }

  const small = newCanvas(Math.floor(source.width / SS), Math.floor(source.height / SS));
  const sctx = sctxOf(small);
  sctx.drawImage(source, 0, 0, small.width, small.height);
  return small;
}

function sctxOf(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

/* ------------------------------------------------------------ 字形度量与匹配 */

const _metricCache = new Map();
const _maskCache = new Map();
const CANVAS_H = 96, CANVAS_W = 420;

/** 掩膜缓存写入（带容量淘汰）。
 *
 *  每个 mask 是 W×H 的 CV_8U，200px 字号下约 1MB，无限攒会吃光 emscripten 堆。
 *  淘汰时必须真释放 —— 这些内存不归 GC 管。 */
function putMaskCache(key, mask) {
  if (_maskCache.size >= 24) {
    const oldest = _maskCache.keys().next().value;
    rm(_maskCache.get(oldest));
    _maskCache.delete(oldest);
  }
  _maskCache.set(key, mask);
}

/** 渲染文本并提取与字号无关的字形特征：宽高比 / 墨迹填充率 / 笔画比。
 *  导出是为了便于单独计时诊断（字体匹配要对 20+ 候选各跑一遍）。 */
export function textMetrics(cv, fonts, family, text, bold, italic, size = 180) {
  const key = `${family}|${text}|${bold ? 1 : 0}|${italic ? 1 : 0}`;
  if (_metricCache.has(key)) return _metricCache.get(key);

  const fail = () => { _metricCache.set(key, null); return null; };
  if (!text.trim()) return fail();

  dbg(`tm[${family}] css`);
  const css = fonts.cssFor(family);
  const probe = ctx2d(newCanvas(8, 8));
  probe.font = fontString(css, size, bold, italic);
  const tw = probe.measureText(text).width;
  dbg(`tm[${family}] tw=${tw}`);

  const W = int(tw) + size * 2;
  const H = size * 3;
  if (W < 8 || W > 20000 || H < 8) return fail();

  const canvas = newCanvas(W, H);
  dbg(`tm[${family}] canvas=${canvas.width}x${canvas.height}`);
  const ctx = ctx2d(canvas);
  ctx.font = fontString(css, size, bold, italic);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  const asc = probe.measureText('H').fontBoundingBoxAscent || size * 0.8;
  ctx.fillText(text, size, size + asc);
  dbg(`tm[${family}] filled asc=${asc}`);

  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  dbg(`tm[${family}] imageData len=${data.length}`);

  const w = canvas.width, h = canvas.height;
  const mask = new Uint8Array(w * h);
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) {
      if (data[(base + x) * 4 + 3] <= 128) continue;
      mask[base + x] = 1;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  dbg(`tm[${family}] scanned bbox=${x0},${y0}-${x1},${y1}`);
  if (x1 < 0) return fail();

  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  if (bw < 4 || bh < 4) return fail();

  let area = 0;
  for (let y = y0; y <= y1; y++) {
    const base = y * w;
    for (let x = x0; x <= x1; x++) area += mask[base + x];
  }
  dbg(`tm[${family}] area=${area}`);
  if (area < 12) return fail();

  const m = new cv.Mat(bh, bw, cv.CV_8UC1);
  const md = m.data;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) md[y * bw + x] = mask[(y + y0) * w + (x + x0)] ? 255 : 0;
  }
  dbg(`tm[${family}] mat=${bh}x${bw} len=${md.length}`);

  const dt = new cv.Mat();
  cv.distanceTransform(m, dt, cv.DIST_L2, 5);

  const vals = [];
  // CV_32F 必须走 data32F：Mat.data 给的是 Uint8Array 字节视图
  const dd = dt.data32F;
  for (let i = 0; i < dd.length; i++) if (dd[i] > 0) vals.push(dd[i]);
  dbg(`tm[${family}] vals=${vals.length}`);

  dbg(`tm[${family}] p80 start`);
  const p80 = percentile(vals, 80);
  dbg(`tm[${family}] p80=${p80}`);
  const core = vals.filter((v) => v >= p80);
  dbg(`tm[${family}] core=${core.length}`);
  const med = median(core);
  dbg(`tm[${family}] med=${med}`);
  const stroke = core.length ? med * 2.0 : 0.0;
  dbg(`tm[${family}] stroke=${stroke}`);
  rm(m, dt);

  const res = { aspect: bw / bh, fill: area / (bw * bh), stroke_ratio: stroke / bh };
  _metricCache.set(key, res);
  return res;
}

/** 渲染文本 → 墨迹二值掩膜（0/255），供形状 IoU 使用 */
function renderInkMask(cv, fonts, family, text, bold, italic, size = 200) {
  const key = `${family}|${text}|${bold ? 1 : 0}|${italic ? 1 : 0}`;
  if (_maskCache.has(key)) return _maskCache.get(key);

  let mask = null;
  try {
    const css = fonts.cssFor(family);
    const probe = ctx2d(newCanvas(8, 8));
    probe.font = fontString(css, size, bold, italic);
    const tw = probe.measureText(text).width;
    const W = int(tw) + size * 2, H = size * 3;
    if (W >= 8 && W <= 20000) {
      const canvas = newCanvas(W, H);
      const ctx = ctx2d(canvas);
      ctx.font = fontString(css, size, bold, italic);
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#fff';
      const asc = probe.measureText('H').fontBoundingBoxAscent || size * 0.8;
      ctx.fillText(text, size, size + asc);
      const { data, width, height } = ctx.getImageData(0, 0, W, H);
      const m = new cv.Mat(height, width, cv.CV_8UC1);
      const md = m.data;
      let any = false;
      for (let i = 0; i < width * height; i++) {
        const on = data[i * 4 + 3] > 128;
        md[i] = on ? 255 : 0;
        if (on) any = true;
      }
      mask = any ? m : null;
      if (!any) rm(m);
    }
  } catch (_) {
    mask = null;
  }
  putMaskCache(key, mask);
  return mask;
}

/** 裁到外接框后等比缩放、居中放进统一画布 —— 消除尺寸差异，只比形状 */
function normInkMask(cv, mask) {
  if (!mask || !countNonZero(mask)) return null;
  const w = mask.cols, h = mask.rows;
  const md = grayData(mask);
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) {
      if (!md[base + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  if (bw < 4 || bh < 4) return null;

  const scale = Math.min(CANVAS_H / bh, CANVAS_W / bw);
  const nh = Math.max(1, pyRound(bh * scale));
  const nw = Math.max(1, pyRound(bw * scale));

  const src = new cv.Mat(bh, bw, cv.CV_8UC1);
  const sd = src.data;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) sd[y * bw + x] = md[(y + y0) * w + (x + x0)];
  }
  const dst = new cv.Mat();
  cv.resize(src, dst, new cv.Size(nw, nh), 0, 0, cv.INTER_AREA);
  rm(src);

  const canvas = new Uint8Array(CANVAS_H * CANVAS_W);
  const oy = (CANVAS_H - nh) >> 1, ox = (CANVAS_W - nw) >> 1;
  const dd = dst.data;
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      if (dd[y * nw + x] > 96) canvas[(oy + y) * CANVAS_W + (ox + x)] = 1;
    }
  }
  rm(dst);
  return canvas;
}

function shapeIou(cv, a, b) {
  const na = normInkMask(cv, a);
  const nb = normInkMask(cv, b);
  if (!na || !nb) return 0.0;
  let inter = 0, union = 0;
  for (let i = 0; i < na.length; i++) {
    if (na[i] || nb[i]) union++;
    if (na[i] && nb[i]) inter++;
  }
  return union ? inter / union : 0.0;
}

/** 按字形特征误差升序排列候选 */
function rankByMetrics(cv, fonts, text, style, bold, italic, candidates) {
  const ink = style.ink_rect;
  if (!ink || int(ink.h) < 6 || !text.trim()) return [];

  const target = {
    aspect: ink.w / Math.max(ink.h, 1),
    fill: style.ink_fill || 0.0,
    stroke_ratio: style.stroke_ratio || 0.0,
  };
  const scored = [];
  for (const fam of candidates) {
    dbg(`metrics ${fam}`);
    const mt = textMetrics(cv, fonts, fam, text, bold, italic);
    dbg(`metrics ${fam} -> ${mt ? 'ok' : 'null'}`);
    if (!mt) continue;
    let err = 0.60 * Math.abs(mt.aspect - target.aspect) / Math.max(target.aspect, 0.1);
    if (target.fill > 0.02) err += 0.22 * Math.abs(mt.fill - target.fill) / target.fill;
    if (target.stroke_ratio > 0.01) {
      err += 0.18 * Math.abs(mt.stroke_ratio - target.stroke_ratio) / target.stroke_ratio;
    }
    scored.push({ err, fam, mt });
  }
  scored.sort((a, b) => a.err - b.err);
  return scored;
}

/** 从**原图**裁出原文字的真实墨迹掩膜（形状匹配的模板） */
function inkMaskFromImage(cv, imageBgr, inkRect) {
  const H = imageBgr.rows, W = imageBgr.cols;
  const x0 = Math.max(0, int(inkRect.x)), y0 = Math.max(0, int(inkRect.y));
  const x1 = Math.min(W, x0 + int(inkRect.w)), y1 = Math.min(H, y0 + int(inkRect.h));
  if (x1 - x0 < 6 || y1 - y0 < 6) return null;

  const roi = cropMat(cv, imageBgr, x0, y0, x1 - x0, y1 - y0);
  const gray = grayOf(cv, roi);
  const level = estimateBgLevel(cv, gray);
  const m = textMask(cv, gray, { bgLevel: level, refSize: Math.min(x1 - x0, y1 - y0), tight: true });
  rm(roi, gray);
  if (!countNonZero(m)) { rm(m); return null; }
  return m;
}

/**
 * 两阶段字体匹配。
 *   阶段一：宽高比 / 墨迹填充率 / 笔画比，从候选池筛 shortlist
 *   阶段二：拿**原文字**在图中的真实墨迹轮廓，与候选渲染轮廓做 IoU
 *
 * 两阶段是必要的：低维特征区分不了 Segoe UI vs Trebuchet MS
 * （得分几乎打平），而形状 IoU 是拿真实笔画轮廓直接比，能分辨。
 * 阶段二必须用**原文字** —— 那才是图里真实存在的形状。
 */
export function matchFamily(cv, fonts, imageBgr, sourceText, style, {
  bold = false, italic = false, shortlist = 6, candidates = null,
} = {}) {
  const text = (sourceText || '').trim();
  if (!text) return { family: null, info: {} };

  dbg(`matchFamily start text="${text}"`);
  const cands = candidates || fonts.candidates(text, 22);
  const ranked = rankByMetrics(cv, fonts, text, style, bold, italic, cands);
  dbg(`ranked ${ranked.length}`);
  if (!ranked.length) return { family: null, info: {} };

  const top = ranked.slice(0, Math.max(2, shortlist));
  const ink = style.ink_rect;
  const byMetrics = () => ({ family: top[0].fam, info: { stage: 'metrics', score: Math.round(top[0].err * 10000) / 10000, considered: ranked.length } });

  if (!imageBgr || !ink || top.length === 1) return byMetrics();

  dbg('inkMaskFromImage');
  const target = inkMaskFromImage(cv, imageBgr, ink);
  dbg(`target ${target ? 'ok' : 'null'}`);
  if (!target) return byMetrics();

  let bestIou = -1, bestFam = null;
  const detail = [];
  for (const { fam } of top) {
    dbg(`renderInkMask ${fam}`);
    // renderInkMask 带缓存，返回的是**缓存里的那个 Mat** ——
    // 千万不能在这里 delete：删掉之后同 key 再命中就会拿到已释放的对象，
    // 访问它报 "cannot call emscripten binding method Mat.data getter"。
    // 这批缓存的释放交给 _maskCache 的容量淘汰。
    const cand = renderInkMask(cv, fonts, fam, text, bold, italic);
    dbg(`shapeIou ${fam}`);
    const iou = shapeIou(cv, target, cand);
    detail.push({ family: fam, iou: Math.round(iou * 1000) / 1000 });
    if (iou > bestIou) { bestIou = iou; bestFam = fam; }
  }
  rm(target);
  dbg(`matchFamily done -> ${bestFam}`);

  if (!bestFam) return byMetrics();
  detail.sort((a, b) => b.iou - a.iou);
  return {
    family: bestFam,
    info: { stage: 'shape', iou: Math.round(bestIou * 1000) / 1000, shortlist: detail.slice(0, 4), considered: ranked.length },
  };
}

/* ------------------------------------------------------------ 清晰度匹配 */

/** 估计原文字的边缘柔化程度，返回建议的额外高斯 sigma */
function sourceBlurSigma(cv, imageBgr, rect) {
  const H = imageBgr.rows, W = imageBgr.cols;
  const x = Math.max(0, int(rect.x)), y = Math.max(0, int(rect.y));
  const x2 = Math.min(W, x + int(rect.w)), y2 = Math.min(H, y + int(rect.h));
  if (x2 - x < 8 || y2 - y < 6) return 0.0;

  const roi = cropMat(cv, imageBgr, x, y, x2 - x, y2 - y);
  const gray = grayOf(cv, roi);
  const g = new cv.Mat();
  gray.convertTo(g, cv.CV_32F);
  const gx = new cv.Mat(), gy = new cv.Mat();
  cv.Sobel(g, gx, cv.CV_32F, 1, 0, 3);
  cv.Sobel(g, gy, cv.CV_32F, 0, 1, 3);

  const gxd = gx.data32F, gyd = gy.data32F;   // CV_32F 必须走 data32F，见 textMetrics 注释
  const mag = new Float32Array(gxd.length);
  let maxMag = 0;
  for (let i = 0; i < mag.length; i++) {
    mag[i] = Math.sqrt(gxd[i] * gxd[i] + gyd[i] * gyd[i]);
    if (mag[i] > maxMag) maxMag = mag[i];
  }
  const gd = grayData(gray);
  let gmin = 255, gmax = 0;
  for (let i = 0; i < gd.length; i++) {
    if (gd[i] < gmin) gmin = gd[i];
    if (gd[i] > gmax) gmax = gd[i];
  }
  const contrast = gmax - gmin;
  rm(roi, gray, g, gx, gy);

  if (maxMag < 1e-6) return 0.0;
  if (contrast < 12) return 0.0;
  const sharp = percentile(mag, 97) / Math.max(contrast, 1.0);
  if (sharp >= 0.30) return 0.0;
  return clamp((0.30 - sharp) * 3.2, 0.0, 1.1);
}

function blurCanvas(canvas, sigma) {
  if (sigma <= 0.05) return canvas;
  const out = newCanvas(canvas.width, canvas.height);
  const ctx = sctxOf(out);
  ctx.filter = `blur(${sigma}px)`;
  ctx.drawImage(canvas, 0, 0);
  ctx.filter = 'none';
  return out;
}

/* ------------------------------------------------------------ 合成 */

/** 把 RGBA 图层按 alpha 合成到 BGR Mat（原地修改传入的 out） */
function pasteLayer(imageBgr, canvas, x, y) {
  const H = imageBgr.rows, W = imageBgr.cols;
  const lw = canvas.width, lh = canvas.height;
  const sx0 = Math.max(0, -x), sy0 = Math.max(0, -y);
  const dx0 = Math.max(0, x), dy0 = Math.max(0, y);
  const dw = Math.min(lw - sx0, W - dx0);
  const dh = Math.min(lh - sy0, H - dy0);
  if (dw <= 0 || dh <= 0) return imageBgr;

  const ctx = ctx2d(canvas);
  const src = ctx.getImageData(sx0, sy0, dw, dh).data;
  const od = imageBgr.data;
  for (let yy = 0; yy < dh; yy++) {
    for (let xx = 0; xx < dw; xx++) {
      const si = (yy * dw + xx) * 4;
      const a = src[si + 3] / 255;
      if (a <= 0) continue;
      const di = ((dy0 + yy) * W + (dx0 + xx)) * 3;
      od[di] = clamp(od[di] * (1 - a) + src[si + 2] * a, 0, 255);        // B ← 源的 B
      od[di + 1] = clamp(od[di + 1] * (1 - a) + src[si + 1] * a, 0, 255); // G
      od[di + 2] = clamp(od[di + 2] * (1 - a) + src[si] * a, 0, 255);     // R ← 源的 R
    }
  }
  return imageBgr;
}

/* ------------------------------------------------------------ 主入口 */

/**
 * 在原位置绘制新文字。返回新 Mat（调用方负责 delete），底图不被修改。
 *
 * 参数语义与 Python 版一致，重点三条：
 *   valign  **默认 bottom**：按底部（无降部时即基线）对齐。阅读的视觉锚点是基线，
 *           居中会在新旧墨迹高度不同时把基线整体推走，看起来就是"字跑了"。
 *   auto_fit 默认关：字变小比"略超出原位置"更容易被看出来，
 *           只有溢出到 HARD_OVERFLOW 以上才强行收敛。
 */
export function render(cv, fonts, imageBgr, rect, text, style, {
  family = null, font_size = null, fg_color = null, bold = null, italic = false,
  align = null, valign = 'bottom', offset = [0, 0], letter_spacing = 0.0,
  auto_fit = false, max_width_ratio = 1.15, match_sharpness = true,
  match_stroke = true, auto_family = true, match_source = null, source_text = null,
  shadow = null,
} = {}) {
  const warnings = [];
  const lines = String(text).split('\n');
  if (!lines.some((ln) => ln.trim())) {
    return { image: imageBgr.clone(), box: [0, 0, 0, 0], font_size: 0, family: family || '', fitted: false, warnings: ['文本为空'], stroke: {}, matched: {} };
  }

  style = style || {};
  if (bold === null) bold = !!style.bold;
  if (fg_color === null) fg_color = style.fg_color || [17, 17, 17];
  const fgRgb = [int(fg_color[0]), int(fg_color[1]), int(fg_color[2])].map((c) => clamp(c, 0, 255));
  if (align === null) align = style.align || 'left';

  /* ---- 字体族：优先用户指定，其次按字形自动匹配 ---- */
  let matchedInfo = {};
  if (!family) {
    if (auto_family) {
      const probeText = source_text || (lines.length === 1 ? lines[0] : text);
      const m = matchFamily(cv, fonts, match_source, probeText, style, { bold: !!bold, italic });
      family = m.family;
      matchedInfo = m.info;
    }
    if (!family) family = fonts.recommend(text);
  }

  const ink = style.ink_rect;
  let targetX, targetY, targetW, targetHRef;
  if (ink && int(ink.h) > 2) {
    targetX = int(ink.x); targetY = int(ink.y);
    targetW = int(ink.w);
    targetHRef = int(style.ink_height || ink.h);
  } else {
    targetX = int(rect.x); targetY = int(rect.y);
    targetW = int(rect.w);
    targetHRef = int(style.ink_height || rect.h);
  }

  /* ---- 字号反推：用实测字面比例 ---- */
  const perLineH = targetHRef / Math.max(lines.length, 1);
  let fitted = false;
  if (font_size === null) {
    const ratio = inkRatio(fonts, family, bold, italic, lines[0]);
    font_size = Math.max(6, pyRound(perLineH / Math.max(ratio, 0.05)));
  }
  font_size = int(Math.max(6, Math.min(font_size, 600)));

  // 额外描边以「相对字号的比例」保存，缩放字号后仍等比成立
  const strokeRel = [0.0];

  const build = (size) => {
    const stroke = Math.max(0.0, strokeRel[0] * size);
    const warn = [];
    let useStroke = stroke;
    // 字体族没有真正的 Bold 变体时，用轻微描边模拟加粗
    if (bold && useStroke <= 0) {
      useStroke = Math.max(0.4, size * 0.026);
      warn.push('该字体无粗体变体，已用描边模拟加粗');
    }
    const lays = lines.map((ln) => drawTextLayer(fonts, ln, family, size, fgRgb, {
      bold: !!bold, italic, stroke: useStroke, shadow, letterSpacing: letter_spacing,
    })).filter(Boolean);
    return { lays, warn };
  };

  let built = build(font_size);
  let layers = built.lays;
  warnings.push(...built.warn);
  if (!layers.length) {
    return { image: imageBgr.clone(), box: [0, 0, 0, 0], font_size, family, fitted: false, warnings: [...warnings, '文字渲染为空'], stroke: {}, matched: matchedInfo };
  }

  /* ---- 笔画粗细校准：渲染 → 测笔画 → 补描边 → 再测，闭环收敛 ---- */
  let strokeInfo = {};
  if (match_stroke) {
    const targetStroke = Number(style.stroke_width || 0);
    if (targetStroke >= 0.8) {
      let probe = layerStrokeWidth(cv, layers[0]);
      if (probe > 0.1) {
        for (let round = 0; round < 2; round++) {
          const delta = targetStroke - probe;
          if (Math.abs(delta) <= 0.45) break;
          if (delta > 0) {
            strokeRel[0] = Math.min(strokeRel[0] + (delta / 2.0) / Math.max(font_size, 1), 0.10);
            built = build(font_size);
            layers = built.lays;
            probe = layerStrokeWidth(cv, layers[0]);
          } else {
            const thin = fonts.thinnerVariant(family);
            if (thin && thin !== family) {
              warnings.push(`原文字笔画更细，已切换字体变体：${thin}`);
              family = thin;
              strokeRel[0] = 0.0;
              built = build(font_size);
              layers = built.lays;
              probe = layerStrokeWidth(cv, layers[0]);
            } else {
              warnings.push(`原文字笔画约 ${targetStroke.toFixed(1)}px，比当前字体更细，已按最接近的字重渲染`);
              break;
            }
          }
        }
        strokeInfo = {
          target: Math.round(targetStroke * 100) / 100,
          rendered: Math.round(probe * 100) / 100,
          stroke_added: Math.round(strokeRel[0] * font_size * 100) / 100,
        };
        if (Math.abs(targetStroke - probe) > 1.2) {
          warnings.push(`笔画宽度已校准：原图 ${targetStroke.toFixed(1)}px → 渲染 ${probe.toFixed(1)}px`);
        }
      }
    }
  }

  let lineGap = pyRound(font_size * 0.22);

  /**
   * 计算墨迹布局。**必须用墨迹 bbox 而不是图层画布尺寸**：
   * 图层左右各带约 0.35×字号的透明 padding，拿画布宽度去和原墨迹宽度比
   * 会凭空多出几十像素，导致"过宽自适应"几乎每次都误触发、字号被无故缩小。
   */
  const layout = (ls) => {
    const boxes = ls.map((l) => contentBBox(l) || { x: 0, y: 0, w: l.width, h: l.height });
    const origins = [];
    let y = 0;
    for (const l of ls) { origins.push(y); y += l.height + lineGap; }
    const widths = boxes.map((b) => b.w);
    const top = boxes[0].y;
    const bottom = origins[origins.length - 1] + boxes[boxes.length - 1].y + boxes[boxes.length - 1].h;
    return { inkW: widths.length ? Math.max(...widths) : 0, inkH: Math.max(bottom - top, 1), boxes, origins };
  };

  let { inkW, inkH, boxes, origins } = layout(layers);

  /* ---- 宽度处理：默认不因原框宽度改字号 ---- */
  const overflow = targetW > 0 ? inkW / targetW : 1.0;
  const limitRatio = auto_fit ? max_width_ratio : HARD_OVERFLOW;
  if (targetW > 0 && inkW > targetW * limitRatio) {
    const ratio = Math.max(limitRatio / Math.max(overflow, 1e-6), FIT_FLOOR);
    const newSize = Math.max(6, pyRound(font_size * ratio));
    if (newSize < font_size) {
      font_size = newSize;
      layers = build(font_size).lays;
      lineGap = pyRound(font_size * 0.22);
      ({ inkW, inkH, boxes, origins } = layout(layers));
      fitted = true;
      warnings.push(`新文字比原文宽 ${int((overflow - 1) * 100)}%，已收敛为 ${font_size}px（不低于原字号的 ${int(FIT_FLOOR * 100)}%）`);
    }
  } else if (targetW > 0 && overflow > 1.08) {
    warnings.push(`新文字比原文宽约 ${int((overflow - 1) * 100)}%，已保持原字号（如想压回原宽度，可勾选「过宽时缩字号」）`);
  }

  /* ---- 定位：按墨迹对齐，消除图层 padding 造成的偏移 ---- */
  let inkLeft;
  if (align === 'center') inkLeft = targetX + (targetW - inkW) / 2.0;
  else if (align === 'right') inkLeft = targetX + targetW - inkW;
  else inkLeft = Number(targetX);

  let inkTop;
  if (valign === 'top') inkTop = Number(targetY);
  else if (valign === 'center') inkTop = targetY + (targetHRef - inkH) / 2.0;
  else inkTop = Number(targetY + targetHRef - inkH);      // bottom（默认）

  inkLeft += int(offset[0]);
  inkTop += int(offset[1]);

  /* ---- 合成 ---- */
  const sigma = match_sharpness ? sourceBlurSigma(cv, imageBgr, rect) : 0.0;
  const out = imageBgr.clone();
  const yShift = inkTop - boxes[0].y;

  for (let i = 0; i < layers.length; i++) {
    const lay = sigma > 0.05 ? blurCanvas(layers[i], sigma) : layers[i];
    const b = boxes[i];
    let rowLeft;
    if (align === 'center') rowLeft = targetX + (targetW - b.w) / 2.0 + int(offset[0]);
    else if (align === 'right') rowLeft = targetX + targetW - b.w + int(offset[0]);
    else rowLeft = inkLeft;
    // 图层原点 = 墨迹目标位置 − 墨迹在图层内的左偏移
    const drawX = pyRound(rowLeft - b.x);
    const drawY = pyRound(yShift + origins[i]);
    pasteLayer(out, lay, drawX, drawY);
  }

  return {
    image: out,
    box: [int(inkLeft), int(inkTop), int(inkW), int(inkH)],
    font_size,
    family,
    fitted,
    warnings,
    stroke: strokeInfo,
    matched: matchedInfo,
  };
}

/** 实测「参考字符墨迹高度 / 字号」，解决不同字体字面高差异 */
function inkRatio(fonts, family, bold, italic, text, probeSize = 240) {
  try {
    const refChar = /[\u4e00-\u9fff]/.test(text) ? '国'
      : (/[A-Z]/.test(text) || /\d/.test(text) ? 'H' : (/[a-z]/.test(text) ? 'x' : 'H'));
    const canvas = newCanvas(probeSize * 4, probeSize * 4);
    const ctx = ctx2d(canvas);
    ctx.font = fontString(fonts.cssFor(family), probeSize, bold, italic);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff';
    ctx.fillText(refChar, probeSize, probeSize + probeSize);
    const b = contentBBox(canvas);
    if (!b) return 0.72;
    return Math.max(b.h / probeSize, 0.05);
  } catch (_) {
    return 0.72;
  }
}

/** 只做度量，不合成图像。用于前端预览尺寸提示。 */
export function measureBox(cv, fonts, rect, text, style, opts = {}) {
  const probe = new cv.Mat(4, 4, cv.CV_8UC3);
  const res = render(cv, fonts, probe, rect, text, style, {
    ...opts, align: 'left', auto_fit: false, match_sharpness: false,
    match_stroke: false, auto_family: !opts.family,
    match_source: null, source_text: null,
  });
  rm(probe);
  rm(res.image);
  return {
    width: res.box[2],
    height: res.box[3],
    font_size: res.font_size,
    family: res.family,
    overflow: res.box[2] > int(rect.w) * 1.05,
  };
}
