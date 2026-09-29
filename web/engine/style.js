/* ==========================================================================
   WB-PS · 文字样式反推（移植自 app/style_analyzer.py）

   从原图反推：字色、背景色、背景类型、字号、粗细、笔宽、对齐。
   三条设计原则原样保留：

   * 颜色不用平均值 —— 抗锯齿像素会把颜色"拉灰"。以背景为基准，
     取偏离最大的那批（真实墨迹核心）的众数颜色。
   * 字号由**墨迹高度**反推，不是 OCR 框高度（框含 padding，不可靠）。
   * 粗细用「笔宽 ÷ 墨迹高度」判定，不依赖字体元数据。

   本模块同时对外提供 textMask / estimateBgLevel / keepComponents ——
   text_eraser 与 text_renderer 都靠它们，口径必须完全一致，
   否则"分析出来的字号"和"擦除时认定的墨迹"会对不上。
   ========================================================================== */
import { clamp, pyRound, median, percentile, std } from './num.js';
import {
  rm, grayData, planeData, grayOf, grayMatFrom, cropMat, emptyMask, ellipseKernel, countNonZero,
} from './cvutil.js';

/* ------------------------------------------------------------ 灰度直方图工具 */

function otsuFromHist(hist) {
  let total = 0, sum = 0;
  for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
  if (!total) return 0;
  let sumB = 0, wB = 0, best = -1, th = 0;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; th = i; }
  }
  return th;
}

function histCount(hist, lo, hi) {
  let n = 0;
  for (let i = lo; i <= hi; i++) n += hist[i];
  return n;
}

function histMeanRange(hist, lo, hi) {
  let s = 0, n = 0;
  for (let i = lo; i <= hi; i++) { s += hist[i] * i; n += hist[i]; }
  return n ? s / n : 0;
}

function histStdRange(hist, lo, hi) {
  const n = histCount(hist, lo, hi);
  if (!n) return 0;
  const mu = histMeanRange(hist, lo, hi);
  let v = 0;
  for (let i = lo; i <= hi; i++) { const d = i - mu; v += hist[i] * d * d; }
  return Math.sqrt(v / n);
}

/** 平滑后的直方图主峰（对应 Python 里 np.convolve 的 9 点移动平均） */
function histMode(hist, window = 9) {
  const half = window >> 1;
  let best = 0, bestVal = -Infinity;
  for (let i = 0; i < 256; i++) {
    let s = 0, n = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j > 255) continue;
      s += hist[j]; n++;
    }
    const v = n ? s / n : 0;
    if (v > bestVal) { bestVal = v; best = i; }
  }
  return best;
}

/** np.gradient 的等价实现（内部中心差分，边界单边差分） */
function gradient2d(data, w, h) {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (w === 1) gx[i] = 0;
      else if (x === 0) gx[i] = data[i + 1] - data[i];
      else if (x === w - 1) gx[i] = data[i] - data[i - 1];
      else gx[i] = (data[i + 1] - data[i - 1]) / 2;

      if (h === 1) gy[i] = 0;
      else if (y === 0) gy[i] = data[i + w] - data[i];
      else if (y === h - 1) gy[i] = data[i] - data[i - w];
      else gy[i] = (data[i + w] - data[i - w]) / 2;
    }
  }
  return { gx, gy };
}

/* ------------------------------------------------------------ 背景亮度估计 */

function borderPixels(data, w, h, band = 3) {
  const b = Math.max(1, Math.min(band, Math.floor(Math.min(w, h) / 4)));
  const out = [];
  for (let y = 0; y < b; y++) { const base = y * w; for (let x = 0; x < w; x++) out.push(data[base + x]); }
  for (let y = h - b; y < h; y++) { const base = y * w; for (let x = 0; x < w; x++) out.push(data[base + x]); }
  for (let y = 0; y < h; y++) { const base = y * w; for (let x = 0; x < b; x++) out.push(data[base + x]); }
  for (let y = 0; y < h; y++) { const base = y * w; for (let x = w - b; x < w; x++) out.push(data[base + x]); }
  return out;
}

/**
 * 估计背景亮度。融合两个信号：
 *   1) 外圈边界像素中位数（框外扩后基本落在背景上）
 *   2) 灰度直方图平滑后的主峰（背景通常是众数）
 * 两者接近取均值更稳；冲突时用 Otsu 双类中心仲裁，取"类内更平整"的那一类。
 */
export function estimateBgLevel(cv, grayMat, band = 3) {
  const w = grayMat.cols, h = grayMat.rows;
  const data = grayData(grayMat);
  const border = median(borderPixels(data, w, h, band));
  const hist = new Float64Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  const mode = histMode(hist, 9);

  if (Math.abs(mode - border) <= 40) return 0.5 * (mode + border);

  const th = otsuFromHist(hist);
  const dCnt = histCount(hist, 0, th);
  const lCnt = histCount(hist, th + 1, 255);
  const dMean = dCnt ? histMeanRange(hist, 0, th) : border;
  const lMean = lCnt ? histMeanRange(hist, th + 1, 255) : border;
  const dStd = dCnt > 4 ? histStdRange(hist, 0, th) : 1e9;
  const lStd = lCnt > 4 ? histStdRange(hist, th + 1, 255) : 1e9;
  return dStd < lStd ? dMean : lMean;
}

/* ------------------------------------------------------------ 文字掩膜 */

/**
 * 生成文字（前景墨迹）掩膜，0/255 的 CV_8UC1。
 *
 * 关键：用**局部背景图**做差分，而不是全局单一阈值。
 * 文字比背景暗 → 形态学闭运算填掉笔画，与闭运算之差即文字；
 * 文字比背景亮 → 开运算抹掉笔画，与开运算之差即文字。
 *
 * 只走其中一个方向很重要：若两个方向取较大值，开运算会把笔画之间
 * 那些细窄背景条整片掏空，噪声基准被顶到接近 255，阈值随之失效。
 *
 * @param refSize 参考尺寸（取文字框短边），决定形态学核大小 ——
 *                核必须大于笔画宽度，否则笔画会被背景图自己"吃掉"。
 * @param tight   true 用 Otsu 收紧边界（度量字号/颜色用）；
 *                false 用较低噪声下限（擦除用，多覆盖抗锯齿更安全）。
 * @param denoise 是否按连通域面积去噪。**擦除时必须关闭** ——
 *                文字顶/底部的抗锯齿碎片常是很小的孤立连通域，
 *                一旦被当噪点剔除，擦完会残留一圈淡轮廓。
 * @returns 新建的 Mat，调用方负责 delete
 */
export function textMask(cv, grayMat, { bgLevel = null, refSize = null, tight = false, denoise = true } = {}) {
  const h = grayMat.rows, w = grayMat.cols;
  const limit = Math.min(h, w);
  if (limit < 5) return emptyMask(cv, w, h);

  const ref = Math.trunc(refSize || limit);
  let k = Math.trunc(clamp(ref / 3.0, 9, 41));
  k = Math.min(k | 1, (limit - 1) | 1);
  if (k < 3) return emptyMask(cv, w, h);
  const ker = ellipseKernel(cv, k);

  const level = bgLevel === null ? estimateBgLevel(cv, grayMat) : bgLevel;

  const direction = (darkIsFg) => {
    const bgMap = new cv.Mat();
    cv.morphologyEx(grayMat, bgMap, darkIsFg ? cv.MORPH_CLOSE : cv.MORPH_OPEN, ker);
    const diff = new cv.Mat();
    if (darkIsFg) cv.subtract(bgMap, grayMat, diff);
    else cv.subtract(grayMat, bgMap, diff);
    rm(bgMap);
    return diff;
  };

  const binarize = (diffMat) => {
    const d = grayData(diffMat);
    const noise = percentile(d, 45);
    const floor = Math.max(9.0, noise * 2.2);
    if (tight) {
      const out = new cv.Mat();
      const th = cv.threshold(diffMat, out, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      if (th >= floor) return out;
      rm(out);
    }
    const out = new cv.Mat(diffMat.rows, diffMat.cols, cv.CV_8UC1);
    const od = out.data;
    for (let i = 0; i < d.length; i++) od[i] = d[i] > floor ? 255 : 0;
    return out;
  };

  // 用 Otsu 把亮度归到两类中心，离背景更远的一侧是文字
  const hist = new Float64Array(256);
  const gd = grayData(grayMat);
  for (let i = 0; i < gd.length; i++) hist[gd[i]]++;
  const th = otsuFromHist(hist);
  const dCnt = histCount(hist, 0, th);
  const lCnt = histCount(hist, th + 1, 255);
  const dMean = dCnt ? histMeanRange(hist, 0, th) : level;
  const lMean = lCnt ? histMeanRange(hist, th + 1, 255) : level;
  const darkIsFg = Math.abs(dMean - level) > Math.abs(lMean - level);

  let diff = direction(darkIsFg);
  let m = binarize(diff);
  rm(diff);

  if (countNonZero(m) === 0) {          // 方向判反时反向再试一次
    rm(m);
    diff = direction(!darkIsFg);
    m = binarize(diff);
    rm(diff);
  }

  rm(ker);
  if (countNonZero(m) === 0 || !denoise) return m;

  // 去孤立噪点（度量用途；擦除用途必须保留细节，见 denoise 说明）
  const labels = new cv.Mat(), stats = new cv.Mat(), centroids = new cv.Mat();
  const n = cv.connectedComponentsWithStats(m, labels, stats, centroids, 8, cv.CV_32S);
  const minArea = Math.max(3, Math.trunc(0.0006 * m.rows * m.cols));
  // 同 CV_32F 的坑：CV_32S 的 Mat.data 也是 Uint8Array 字节视图，必须走 data32S，
  // 否则 area 读出来是乱的，去噪与连通域过滤会整体失效。
  const sd = stats.data32S;
  const keepFlag = new Uint8Array(Math.max(n, 1));
  for (let i = 1; i < n; i++) if (sd[i * 5 + 4] >= minArea) keepFlag[i] = 1;

  const ld = labels.data32S;
  const keep = emptyMask(cv, w, h);
  const kd = keep.data;
  let kept = false;
  for (let p = 0; p < ld.length; p++) {
    const on = keepFlag[ld[p]] ? 255 : 0;
    kd[p] = on;
    if (on) kept = true;
  }
  rm(labels, stats, centroids);

  if (!kept) { rm(keep); return m; }
  rm(m);
  return keep;
}

/**
 * 只保留与目标框有足够重叠的连通域。
 * Otsu 是全局阈值，扩边后常把相邻行的字一起抓进来，
 * 会让墨迹高度被高估、字号算大。
 */
export function keepComponents(cv, mask, rect) {
  if (countNonZero(mask) === 0) return mask;

  const labels = new cv.Mat(), stats = new cv.Mat(), centroids = new cv.Mat();
  const n = cv.connectedComponentsWithStats(mask, labels, stats, centroids, 8, cv.CV_32S);
  if (n <= 2) { rm(labels, stats, centroids); return mask; }

  const [rx, ry, rw, rh] = rect;
  const rx2 = rx + rw, ry2 = ry + rh;
  const sd = stats.data32S;
  const keepFlag = new Uint8Array(n);
  let kept = false;
  for (let i = 1; i < n; i++) {
    const x = sd[i * 5], y = sd[i * 5 + 1], w = sd[i * 5 + 2], h = sd[i * 5 + 3], area = sd[i * 5 + 4];
    const ix = Math.max(0, Math.min(x + w, rx2) - Math.max(x, rx));
    const iy = Math.max(0, Math.min(y + h, ry2) - Math.max(y, ry));
    const inter = ix * iy;
    const inside = (x >= rx && y >= ry && x + w <= rx2 && y + h <= ry2);
    if (inside || inter >= 0.35 * Math.max(area, 1)) { keepFlag[i] = 1; kept = true; }
  }

  if (!kept) { rm(labels, stats, centroids); return mask; }

  const ld = labels.data32S;
  const out = emptyMask(cv, mask.cols, mask.rows);
  const od = out.data;
  for (let p = 0; p < ld.length; p++) od[p] = keepFlag[ld[p]] ? 255 : 0;
  rm(labels, stats, centroids);
  return out;
}

/* ------------------------------------------------------------ 颜色 / 笔宽 */

/**
 * 掩膜内像素的众数颜色（量化后取众数，回到原像素求中位数）。
 * **返回 RGB** —— 上层统一按 RGB 处理，BGR 只在像素级内部转换。
 */
export function dominantColor(cv, bgrMat, maskMat, quant = 20) {
  const m = grayData(maskMat);
  const W = bgrMat.cols;
  const H = bgrMat.rows;

  // ⚠️ 不要用 bgrMat.data 按 i*3 平铺索引。
  // 实测 crop/clone 出来的 Mat 虽然看着规整，isContinuous() 却为 false，
  // 此时按平铺下标读会整体错位。症状极具迷惑性：
  // 掩膜明明罩在文字上（像素数也对），取到的颜色却是背景色（白底黑字 → 取到白）。
  // 逐行取 ptr 一定正确，且只调用 H 次，开销可以忽略。
  const rows = [];
  for (let y = 0; y < H; y++) rows.push(bgrMat.ptr(y));

  const counts = new Map();
  const px = [];
  for (let i = 0; i < m.length; i++) {
    if (!m[i]) continue;
    const y = (i / W) | 0;
    const x = i - y * W;
    const row = rows[y];
    const b = row[x * 3], g = row[x * 3 + 1], r = row[x * 3 + 2];
    const key = Math.floor(b / quant) * 10000 + Math.floor(g / quant) * 100 + Math.floor(r / quant);
    counts.set(key, (counts.get(key) || 0) + 1);
    px.push([b, g, r, key]);
  }
  if (!px.length) return null;

  let topKey = -1, topCnt = -1;
  for (const [key, c] of counts) if (c > topCnt) { topCnt = c; topKey = key; }

  const bs = [], gs = [], rs = [];
  for (const [b, g, r, key] of px) {
    if (key !== topKey) continue;
    bs.push(b); gs.push(g); rs.push(r);
  }
  return [Math.trunc(median(rs)), Math.trunc(median(gs)), Math.trunc(median(bs))];
}

/**
 * 估计笔画宽度（像素）。两种方法交叉验证：
 *   距离变换峰值 —— 对粗笔画准，细笔画会被量化误差拖累
 *   面积/周长比 2·area/perimeter —— 对细笔画更稳，抗锯齿会略微低估
 * 细笔画偏面积法，粗笔画偏距离变换。
 */
export function strokeWidth(cv, maskMat) {
  // Python 侧把 mask 归一成 0/1 再统计，这里必须同口径：
  // 0/255 的梯度求和会比 0/1 大 255 倍，周长一错笔画宽度就全错。
  const areaPx = countNonZero(maskMat);
  if (areaPx < 8) return 0.0;

  const dt = new cv.Mat();
  cv.distanceTransform(maskMat, dt, cv.DIST_L2, 5);
  const vals = [];
  // CV_32F 的 Mat.data 是 Uint8Array 字节视图，必须走 data32F 才是浮点距离
  const dd = dt.data32F;
  for (let i = 0; i < dd.length; i++) if (dd[i] > 0) vals.push(dd[i]);
  let dtW = 0.0;
  if (vals.length) {
    const p80 = percentile(vals, 80);
    const core = vals.filter((v) => v >= p80);
    dtW = median(core) * 2.0;
  }
  rm(dt);

  const ker = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const grad = new cv.Mat();
  cv.morphologyEx(maskMat, grad, cv.MORPH_GRADIENT, ker);
  let perim = 0;
  const gd = grad.data;
  for (let i = 0; i < gd.length; i++) perim += gd[i];
  perim /= 255;                        // 回到 0/1 口径
  rm(grad, ker);
  const apW = perim > 0 ? 2.0 * areaPx / perim : 0.0;

  if (dtW <= 0) return apW;
  if (apW <= 0) return dtW;
  if (dtW < 3.0) return 0.5 * (dtW + apW);
  return 0.25 * apW + 0.75 * dtW;
}

/** 把「笔宽 ÷ 墨迹高度」映射到字重档位（实测参考见 Python 侧注释） */
export function weightClass(strokeRatio, inkDensity = 0.0) {
  const r = strokeRatio;
  if (r >= 0.185) return 'black';
  if (r >= 0.150) return 'bold';
  if (r >= 0.120) return 'medium';
  if (r >= 0.098) return inkDensity < 0.26 ? 'regular' : 'medium';
  return 'light';
}

/** 背景类型：局部梯度大 → 纹理；整体方差小 → 纯色；介于两者 → 渐变 */
export function bgType(cv, roiBgr, bgMaskMat) {
  const total = countNonZero(bgMaskMat);
  if (!total || total < 12) return ['solid', 0.0, 0.0];

  const m = grayData(bgMaskMat);
  const d = roiBgr.data;
  const lum = [];
  for (let i = 0; i < m.length; i++) {
    if (!m[i]) continue;
    // Python 侧是 BGR 权重 [0.114, 0.587, 0.299]
    lum.push(0.114 * d[i * 3] + 0.587 * d[i * 3 + 1] + 0.299 * d[i * 3 + 2]);
  }
  const st = std(lum);

  let gstd = 0.0;
  if (total > 50) {
    const gray = grayOf(cv, roiBgr);
    const gd = grayData(gray);
    const { gx, gy } = gradient2d(gd, roiBgr.cols, roiBgr.rows);
    const grads = [];
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      grads.push(Math.sqrt(gx[i] * gx[i] + gy[i] * gy[i]));
    }
    gstd = median(grads);
    rm(gray);
  }

  if (gstd >= 0.8) return ['texture', st, gstd];
  if (st <= 4.0) return ['solid', st, gstd];
  return ['gradient', st, gstd];
}

/* ------------------------------------------------------------ 主入口 */

/** 墨迹高度 / 字号 的先验比值（渲染时会按所选字体再实测校准） */
export function assumedInkRatio(text) {
  if (/[\u4e00-\u9fff]/.test(text)) return 0.90;
  if (/[A-Z]/.test(text) || /\d/.test(text)) return 0.72;
  if (/[a-z]/.test(text)) return 0.52;
  return 0.72;
}

function fallbackStyle(bgRgb = [255, 255, 255]) {
  const lum = 0.299 * bgRgb[0] + 0.587 * bgRgb[1] + 0.114 * bgRgb[2];
  const fg = lum < 128 ? [255, 255, 255] : [17, 17, 17];
  return {
    fg_color: fg,
    bg_color: [...bgRgb],
    bg_type: 'solid',
    bg_std: 0.0,
    bg_grad: 0.0,
    font_size: 18,
    weight: 'regular',
    bold: false,
    stroke_width: 2.0,
    stroke_ratio: 0.1,
    ink_ratio: 0.2,
    ink_fill: 0.0,
    ink_rect: null,
    ink_height: 16,
    align: 'left',
    light_text: lum < 128,
    contrast: Math.abs(lum - (lum < 128 ? 255 : 17)),
  };
}

/**
 * 分析单个文字区域的样式。
 * @param rect {x,y,w,h} 轴对齐外接矩形
 * @param text OCR 得到的文本（用于先验判断）
 * @param pad  外扩像素；默认按框高自适应，保证外圈能取到纯背景
 *             （OCR 框通常紧贴文字，pad 过小会让边界像素全是文字）
 * @returns 可直接喂给 renderer 的样式对象
 */
export function analyze(cv, imageBgr, rect, text = '', pad = null) {
  const H = imageBgr.rows, W = imageBgr.cols;
  const rw = Math.max(int(rect.w), 1);
  const rh = Math.max(int(rect.h), 1);

  if (pad === null) pad = Math.trunc(clamp(0.30 * Math.min(rw, rh), 3, 24));
  pad = Math.trunc(pad);

  const x = Math.max(0, int(rect.x) - pad);
  const y = Math.max(0, int(rect.y) - pad);
  const x2 = Math.min(W, int(rect.x) + rw + pad);
  const y2 = Math.min(H, int(rect.y) + rh + pad);
  if (x2 - x < 2 || y2 - y < 2) return fallbackStyle();

  const roi = cropMat(cv, imageBgr, x, y, x2 - x, y2 - y);
  const gray = grayOf(cv, roi);

  const bgLevel = estimateBgLevel(cv, gray);

  let fgMask = textMask(cv, gray, { bgLevel, refSize: Math.min(rw, rh), tight: true });
  const filtered = keepComponents(cv, fgMask, [int(rect.x) - x, int(rect.y) - y, rw, rh]);
  if (filtered !== fgMask) rm(fgMask);
  fgMask = filtered;

  if (countNonZero(fgMask) < 8) {
    const all = emptyMask(cv, gray.cols, gray.rows);
    all.data.fill(255);
    const bgAll = dominantColor(cv, roi, all) || [255, 255, 255];
    rm(all, fgMask, gray, roi);
    return fallbackStyle(bgAll);
  }

  // 背景掩膜 = 前景取反。
  //
  // 必须**新建**数组：grayData 在 Mat 连续时会直接返回它的内部缓冲，
  // 就地取反会把 fgMask 自己改掉 —— 之后的字色、笔宽、墨迹几何就全拿到"背景"了。
  // 症状很有辨识度：字色取成背景色（白底黑字 → 取到白色）、笔宽虚大、
  // 字号虚大（墨迹 bbox 撑满整个 ROI）。
  const fgArr = grayData(fgMask);
  const bgMaskArr = new Uint8Array(fgArr.length);
  for (let i = 0; i < fgArr.length; i++) bgMaskArr[i] = fgArr[i] ? 0 : 255;

  const boxX0 = int(rect.x) - x;
  const boxY0 = int(rect.y) - y;
  const boxW = rw, boxH = rh;

  /* ---- 颜色 ---- */
  const fgColor = dominantColor(cv, roi, fgMask) || [0, 0, 0];
  const bgMaskMat = grayMatFrom(cv, bgMaskArr, gray.cols, gray.rows);
  const bgColor = dominantColor(cv, roi, bgMaskMat) || [255, 255, 255];
  if (typeof window !== 'undefined' && window.__STYLE_DEBUG__) {
    // 临时诊断：绕开 dominantColor，直接统计掩膜内像素的平均 BGR
    const mm = grayData(fgMask);
    const dd = planeData(roi);
    let n = 0, sb = 0, sg = 0, sr = 0;
    for (let i = 0; i < mm.length; i++) {
      if (!mm[i]) continue;
      n++; sb += dd[i * 3]; sg += dd[i * 3 + 1]; sr += dd[i * 3 + 2];
    }
    dbg(`box=(${int(rect.x)},${int(rect.y)}) ${rw}x${rh} roiMat=${roi.cols}x${roi.rows} `
      + `roiCont=${roi.isContinuous()} mlen=${mm.length} dlen=${dd.length} `
      + `maskN=${n} avgBGR=${n ? `${Math.round(sb / n)},${Math.round(sg / n)},${Math.round(sr / n)}` : '-'} `
      + `fg=${JSON.stringify(fgColor)} bg=${JSON.stringify(bgColor)} lvl=${pyRound(bgLevel)}`);
  }

  /* ---- 墨迹几何 ---- */
  const gd = grayData(fgMask);
  let inkX0 = Infinity, inkY0 = Infinity, inkX1 = -1, inkY1 = -1;
  for (let yy = 0; yy < gray.rows; yy++) {
    const base = yy * gray.cols;
    for (let xx = 0; xx < gray.cols; xx++) {
      if (!gd[base + xx]) continue;
      if (xx < inkX0) inkX0 = xx;
      if (xx > inkX1) inkX1 = xx;
      if (yy < inkY0) inkY0 = yy;
      if (yy > inkY1) inkY1 = yy;
    }
  }
  const inkW = inkX1 - inkX0 + 1;
  const inkH = inkY1 - inkY0 + 1;

  // 用行像素数直方图修正：取墨迹行的跨度，避开逗号、下伸部干扰
  const rowSpan = new Float64Array(gray.rows);
  for (let yy = 0; yy < gray.rows; yy++) {
    const base = yy * gray.cols;
    let s = 0;
    for (let xx = 0; xx < gray.cols; xx++) s += gd[base + xx];
    rowSpan[yy] = s;
  }
  const rowsWith = [];
  for (let yy = 0; yy < gray.rows; yy++) if (rowSpan[yy] > 0) rowsWith.push(yy);
  let inkHRef = inkH;
  if (rowsWith.length > 3) {
    let maxSpan = 0;
    for (const yy of rowsWith) if (rowSpan[yy] > maxSpan) maxSpan = rowSpan[yy];
    const thr = Math.max(1, Math.trunc(0.06 * maxSpan));
    const solid = rowsWith.filter((yy) => rowSpan[yy] >= thr);
    if (solid.length >= 3) inkHRef = solid[solid.length - 1] - solid[0] + 1;
  }

  const inkRatioPrior = text ? assumedInkRatio(text) : 0.8;
  const fontSize = Math.max(6, pyRound(inkHRef / inkRatioPrior));

  const inkArea = countNonZero(fgMask);
  const inkFill = inkArea / Math.max(inkW * inkH, 1);

  /* ---- 粗细 ---- */
  const stroke = strokeWidth(cv, fgMask);
  const strokeRatio = stroke / Math.max(inkHRef, 1);
  const inkDensity = inkArea / (gray.rows * gray.cols);
  const weight = weightClass(strokeRatio, inkDensity);
  const bold = weight === 'bold' || weight === 'black';

  /* ---- 背景类型（只在文字框内判断，且只取确实落在背景上的像素）---- */
  const boxRoi = emptyMask(cv, gray.cols, gray.rows);
  const brd = boxRoi.data;
  const bx0 = Math.max(0, boxX0), by0 = Math.max(0, boxY0);
  const bx1 = Math.min(gray.cols, bx0 + boxW), by1 = Math.min(gray.rows, by0 + boxH);
  for (let yy = by0; yy < by1; yy++) {
    const base = yy * gray.cols;
    for (let xx = bx0; xx < bx1; xx++) brd[base + xx] = 255;
  }
  const bgRound = pyRound(bgLevel);
  const bgPure = new Uint8Array(gd.length);
  for (let i = 0; i < gd.length; i++) {
    bgPure[i] = (brd[i] && Math.abs(gd[i] - bgRound) <= 12) ? 255 : 0;
  }
  let pureCount = 0;
  for (let i = 0; i < bgPure.length; i++) if (bgPure[i]) pureCount++;

  if (pureCount < 25) {                 // 背景像素太少，放宽判据
    const ker5 = ellipseKernel(cv, 5);
    const nearText = new cv.Mat();
    cv.dilate(fgMask, nearText, ker5);
    const nd = nearText.data;
    pureCount = 0;
    for (let i = 0; i < nd.length; i++) {
      bgPure[i] = (brd[i] && !nd[i]) ? 255 : 0;
      if (bgPure[i]) pureCount++;
    }
    rm(nearText, ker5);
  }
  if (pureCount < 20) { for (let i = 0; i < bgPure.length; i++) bgPure[i] = brd[i]; }

  const bgPureMat = grayMatFrom(cv, bgPure, gray.cols, gray.rows);
  const [bgKind, bgStd, bgGrad] = bgType(cv, roi, bgPureMat);
  rm(bgPureMat);

  /* ---- 对齐（依据墨迹在原始 OCR 框内的左右留白）---- */
  const leftPad = Math.max(0, inkX0 - boxX0);
  const rightPad = Math.max(0, (boxX0 + boxW - 1) - inkX1);
  const centerOff = (leftPad - rightPad) / boxW;
  let align = 'left';
  if (Math.abs(centerOff) < 0.08) align = 'center';
  else if (centerOff > 0) align = 'right';

  const fgLum = 0.299 * fgColor[0] + 0.587 * fgColor[1] + 0.114 * fgColor[2];
  const bgLum = 0.299 * bgColor[0] + 0.587 * bgColor[1] + 0.114 * bgColor[2];

  rm(fgMask, bgMaskMat, boxRoi, gray, roi);

  return {
    fg_color: fgColor,
    bg_color: bgColor,
    bg_type: bgKind,
    bg_std: round2(bgStd),
    bg_grad: round2(bgGrad),
    font_size: fontSize,
    weight,
    bold,
    stroke_width: round2(stroke),
    stroke_ratio: round4(strokeRatio),
    ink_ratio: round4(inkDensity),
    ink_fill: round4(inkFill),
    ink_rect: { x: x + inkX0, y: y + inkY0, w: inkW, h: inkH },
    ink_height: inkHRef,
    align,
    light_text: fgLum > bgLum,
    contrast: Math.round(Math.abs(fgLum - bgLum) * 10) / 10,
  };
}

const int = (v) => Math.trunc(v || 0);
const round2 = (v) => Math.round(v * 100) / 100;
const round4 = (v) => Math.round(v * 10000) / 10000;

/** 诊断打点（同 render.js）：window.__STYLE_DEBUG__ = true 时输出 */
const dbg = (label) => {
  if (typeof window !== 'undefined' && window.__STYLE_DEBUG__) {
    console.log(`[style] ${label}`);
  }
};

/** 批量分析，就地补充 style 字段 */
export function analyzeMany(cv, imageBgr, items) {
  for (const it of items) {
    it.style = analyze(cv, imageBgr, it.rect, it.text || '');
  }
  return items;
}
