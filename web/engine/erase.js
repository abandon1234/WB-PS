/* ==========================================================================
   WB-PS · 文字擦除（移植自 app/text_eraser.py）

   四种策略，按背景复杂度自动选择：
     fill    纯色背景 —— 用紧贴掩膜外圈的真实像素估色后整块填充（最完美）
     linear  渐变背景 —— 沿最优方向做边界线性外推
     inpaint 纹理背景 —— OpenCV Telea / NS 修复
     blur    兜底     —— 邻域中值 + 高斯，按掩膜融合

   两个关键细节（决定"看不看得出动过手脚"）：
   * 掩膜必须覆盖**抗锯齿边缘**，否则原文字会留下灰色轮廓 —— 最常见的痕迹来源。
     所以 textMask 走 denoise=false，且这里还会按 grow 膨胀。
   * 采样参考必须来自**框外**，否则修复器拿不到干净像素。
     因此统一在外扩 ROI 上操作。
   ========================================================================== */
import { clamp, pyRound, median } from './num.js';
import {
  rm, grayOf, emptyMask, ellipseKernel, rectKernel, countNonZero, cropMat,
} from './cvutil.js';
import { estimateBgLevel, textMask, keepComponents } from './style.js';

const int = (v) => Math.trunc(v || 0);
const byte = (v) => Math.max(0, Math.min(255, Math.round(v)));

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

/* ------------------------------------------------------------ 掩膜构建 */

/**
 * 在 ROI 内生成覆盖原文字的掩膜（含抗锯齿边），并剔除相邻行的文字。
 * @returns 新建 Mat（0/255），调用方负责 delete
 */
export function maskInRoi(cv, roiBgr, rect, roiXY, grow = 2, bgLevel = null) {
  const W = roiBgr.cols, H = roiBgr.rows;
  const gray = grayOf(cv, roiBgr);
  const level = bgLevel === null ? estimateBgLevel(cv, gray) : bgLevel;

  let m = textMask(cv, gray, {
    bgLevel: level,
    refSize: Math.min(int(rect.w), int(rect.h)),
    denoise: false,                    // 擦除必须保留抗锯齿碎片
  });
  rm(gray);

  // 只保留与目标框重叠的连通域，否则会把上下相邻行的字一起擦掉
  const rx = int(rect.x) - roiXY[0];
  const ry = int(rect.y) - roiXY[1];
  const filtered = keepComponents(cv, m, [rx, ry, int(rect.w), int(rect.h)]);
  if (filtered !== m) rm(m);
  m = filtered;

  if (grow > 0 && countNonZero(m)) {
    const k = ellipseKernel(cv, grow * 2 + 1);
    const dil = new cv.Mat();
    cv.dilate(m, dil, k);
    rm(k, m);
    m = dil;
  }

  if (countNonZero(m) === 0) {
    // 没抓到墨迹 → 退化为整框填充，保证"擦干净"
    rm(m);
    m = emptyMask(cv, W, H);
    const md = m.data;
    const x0 = Math.max(0, rx), y0 = Math.max(0, ry);
    const x1 = Math.min(W, x0 + int(rect.w)), y1 = Math.min(H, y0 + int(rect.h));
    for (let y = y0; y < y1; y++) {
      const base = y * W;
      for (let x = x0; x < x1; x++) md[base + x] = 255;
    }
  }
  return m;
}

/* ------------------------------------------------------------ 各策略实现 */

/** 纯色填充：用紧贴掩膜外圈的真实像素估计局部背景色后整块填充。
 *  背景是纯色时这就是"完美擦除"，不要羽化 —— 羽化反而会在
 *  本来完全一致的背景上造出可见软边。 */
function fillPatch(cv, roi, m, bgColorBgr) {
  const out = roi.clone();
  if (countNonZero(m) === 0) return out;

  const k = ellipseKernel(cv, 7);
  const dil = new cv.Mat();
  cv.dilate(m, dil, k);
  const ring = new cv.Mat();
  cv.subtract(dil, m, ring);
  rm(dil, k);

  const rd = ring.data, od = roi.data;
  const bs = [], gs = [], rs = [];
  for (let i = 0; i < rd.length; i++) {
    if (!rd[i]) continue;
    bs.push(od[i * 3]); gs.push(od[i * 3 + 1]); rs.push(od[i * 3 + 2]);
  }
  const bg = bs.length >= 12
    ? [median(bs), median(gs), median(rs)]
    : bgColorBgr;
  rm(ring);

  const md = m.data, oo = out.data;
  for (let i = 0; i < md.length; i++) {
    if (!md[i]) continue;
    oo[i * 3] = byte(bg[0]);
    oo[i * 3 + 1] = byte(bg[1]);
    oo[i * 3 + 2] = byte(bg[2]);
  }
  return out;
}

/** 沿某方向线性外推：对每一列（行），取掩膜上下（左右）外侧最近的真实像素做插值。
 *  掩膜触到 ROI 边界时，用可用的那一侧做常数延展。 */
function interpAxis(roi, m, axis) {
  const h = m.rows, w = m.cols;
  const sd = roi.data;
  const md = m.data;
  const nOuter = axis === 0 ? w : h;
  const nInner = axis === 0 ? h : w;

  const out = new Float32Array(sd.length);
  for (let i = 0; i < sd.length; i++) out[i] = sd[i];

  const idxOf = (pos, i) => (axis === 0 ? pos * w + i : i * w + pos);

  for (let i = 0; i < nOuter; i++) {
    let a = -1, b = -1;
    for (let p = 0; p < nInner; p++) {
      if (md[idxOf(p, i)]) { if (a < 0) a = p; b = p; }
    }
    if (a < 0) continue;

    const grab = (pos) => {
      if (pos < 0 || pos >= nInner) return null;
      const k = idxOf(pos, i) * 3;
      return [out[k], out[k + 1], out[k + 2]];
    };
    const top = grab(a - 1);
    const bot = grab(b + 1);
    const count = b - a + 1;

    for (let n = 0; n < count; n++) {
      let c;
      if (top && bot) {
        const t = (n + 1.0) / (count + 1.0);
        c = [top[0] * (1 - t) + bot[0] * t,
             top[1] * (1 - t) + bot[1] * t,
             top[2] * (1 - t) + bot[2] * t];
      } else if (top) c = top;
      else if (bot) c = bot;
      else continue;

      const k = idxOf(a + n, i) * 3;
      out[k] = c[0]; out[k + 1] = c[1]; out[k + 2] = c[2];
    }
  }
  return out;
}

/** 外推结果与背景的衔接评分：掩膜边界处梯度越小越自然 */
function seamScore(cv, buf, w, h, m) {
  const gd = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const b = clamp(buf[i * 3], 0, 255);
    const g = clamp(buf[i * 3 + 1], 0, 255);
    const r = clamp(buf[i * 3 + 2], 0, 255);
    gd[i] = 0.114 * b + 0.587 * g + 0.299 * r;      // cv2 的 BGR2GRAY 权重
  }
  const { gx, gy } = gradient2d(gd, w, h);

  const k = rectKernel(cv, 5);
  const dil = new cv.Mat();
  cv.dilate(m, dil, k);
  const ring = new cv.Mat();
  cv.subtract(dil, m, ring);
  rm(dil, k);

  const rd = ring.data;
  let sum = 0, cnt = 0;
  for (let i = 0; i < rd.length; i++) {
    if (!rd[i]) continue;
    sum += Math.sqrt(gx[i] * gx[i] + gy[i] * gy[i]);
    cnt++;
  }
  rm(ring);
  return cnt ? sum / cnt : Infinity;
}

function linearPatch(cv, roi, m) {
  const w = m.cols, h = m.rows;
  const candV = interpAxis(roi, m, 0);
  const candH = interpAxis(roi, m, 1);
  const best = seamScore(cv, candV, w, h, m) <= seamScore(cv, candH, w, h, m) ? candV : candH;

  const out = roi.clone();
  const md = m.data, od = out.data;
  for (let i = 0; i < md.length; i++) {
    if (!md[i]) continue;
    od[i * 3] = byte(best[i * 3]);
    od[i * 3 + 1] = byte(best[i * 3 + 1]);
    od[i * 3 + 2] = byte(best[i * 3 + 2]);
  }
  return out;
}

function inpaintPatch(cv, roi, m, radius, method) {
  const flag = method === 'ns' ? cv.INPAINT_NS : cv.INPAINT_TELEA;
  const r = Math.max(2, Math.min(radius, 15));
  const out = new cv.Mat();
  cv.inpaint(roi, m, out, r, flag);
  return out;
}

function blurPatch(cv, roi, m, ksize = 9) {
  const k = Math.max(3, Math.min(ksize | 1, 31));
  const med = new cv.Mat();
  const soft = new cv.Mat();
  cv.medianBlur(roi, med, k);
  cv.GaussianBlur(roi, soft, new cv.Size(k, k), 0);

  const out = roi.clone();
  const md = med.data, sd = soft.data, od = out.data, mk = m.data;
  for (let i = 0; i < mk.length; i++) {
    if (!mk[i]) continue;
    od[i * 3] = (md[i * 3] + sd[i * 3]) >> 1;
    od[i * 3 + 1] = (md[i * 3 + 1] + sd[i * 3 + 1]) >> 1;
    od[i * 3 + 2] = (md[i * 3 + 2] + sd[i * 3 + 2]) >> 1;
  }
  rm(med, soft);
  return out;
}

function applyMethod(cv, roi, m, method, bgColorBgr, radius) {
  if (method === 'fill') return fillPatch(cv, roi, m, bgColorBgr);
  if (method === 'linear') return linearPatch(cv, roi, m);
  if (method === 'inpaint' || method === 'ns' || method === 'telea') {
    return inpaintPatch(cv, roi, m, radius, method === 'ns' ? 'ns' : 'telea');
  }
  if (method === 'blur') return blurPatch(cv, roi, m);
  throw new Error(`未知擦除方法: ${method}`);
}

/**
 * 残留自检：框内边缘能量 ÷ 周边背景边缘能量。
 * 文字有强边缘、背景平坦，比值接近 1 说明擦干净了，偏高说明还有残留。
 *
 * 与 Python 版的细微差异：那边靠把内区设成 NaN 让 Laplacian 自然跳过，
 * 这里改为"算完只统计外圈像素"。差异只在紧邻内区的一圈上，不影响量级判断。
 */
function edgeRatio(cv, patched, rect, roiXY, band = 14) {
  const H = patched.rows, W = patched.cols;
  const rx = int(rect.x) - roiXY[0];
  const ry = int(rect.y) - roiXY[1];
  const x0 = Math.max(0, rx), y0 = Math.max(0, ry);
  const x1 = Math.min(W, rx + int(rect.w)), y1 = Math.min(H, ry + int(rect.h));
  if (x1 - x0 < 4 || y1 - y0 < 4) return 1.0;

  const gray = grayOf(cv, patched);

  const inner = cropMat(cv, gray, x0, y0, x1 - x0, y1 - y0);
  const lapI = new cv.Mat();
  cv.Laplacian(inner, lapI, cv.CV_32F);
  // CV_32F 必须走 data32F（Mat.data 是 Uint8Array 字节视图）
  const li = lapI.data32F;
  let ei = 0;
  for (let i = 0; i < li.length; i++) ei += Math.abs(li[i]);
  ei /= Math.max(li.length, 1);
  rm(inner, lapI);

  const bx0 = Math.max(0, x0 - band), by0 = Math.max(0, y0 - band);
  const bx1 = Math.min(W, x1 + band), by1 = Math.min(H, y1 + band);
  const outer = cropMat(cv, gray, bx0, by0, bx1 - bx0, by1 - by0);
  const lapO = new cv.Mat();
  cv.Laplacian(outer, lapO, cv.CV_32F);
  const lo = lapO.data32F;
  const ow = outer.cols;
  let eo = 0, cnt = 0;
  for (let y = 0; y < outer.rows; y++) {
    for (let x = 0; x < ow; x++) {
      const gx = bx0 + x, gy = by0 + y;
      if (gx >= x0 && gx < x1 && gy >= y0 && gy < y1) continue;   // 跳过内区
      eo += Math.abs(lo[y * ow + x]);
      cnt++;
    }
  }
  eo = cnt ? eo / cnt : 0;
  rm(outer, lapO, gray);

  return ei / Math.max(eo, 0.5);
}

/* ------------------------------------------------------------ 主入口 */

/**
 * 擦除指定区域的文字。
 *
 * @param imageBgr 原图（不会被就地修改）
 * @param rect     文字框
 * @param style    样式分析结果（用 bg_type / bg_color 辅助选策略）
 * @param method   auto | fill | linear | inpaint | ns | telea | blur
 * @param grow     掩膜膨胀，覆盖抗锯齿
 * @param padRatio 外扩比例（取更大范围的参考背景）
 * @returns { image, meta } image 为**新 Mat**（调用方负责 delete）
 */
export function erase(cv, imageBgr, rect, style = null, {
  method = 'auto', grow = 2, inpaintRadius = 3, padRatio = 1.0,
} = {}) {
  const H = imageBgr.rows, W = imageBgr.cols;
  const w = int(rect.w), h = int(rect.h);

  // 外扩参考区按**框高**计算：单行文字只需要上下方向的参考像素，
  // 用长边算会把整行甚至相邻行都吞进 ROI，反而污染掩膜。
  let pad = pyRound(padRatio * Math.max(h, 10) * 0.9);
  pad = Math.trunc(clamp(pad, 8, 48));

  const x = Math.max(0, int(rect.x) - pad);
  const y = Math.max(0, int(rect.y) - pad);
  const x2 = Math.min(W, int(rect.x) + w + pad);
  const y2 = Math.min(H, int(rect.y) + h + pad);
  if (x2 - x < 3 || y2 - y < 3) {
    return { image: imageBgr.clone(), meta: { method: 'none', mask: null, box: [x, y, Math.max(x2 - x, 1), Math.max(y2 - y, 1)] } };
  }

  const roi = cropMat(cv, imageBgr, x, y, x2 - x, y2 - y);
  const gray = grayOf(cv, roi);
  const bgLevel = estimateBgLevel(cv, gray);
  rm(gray);

  const bgType = (style || {}).bg_type || 'solid';
  const bgRgb = (style || {}).bg_color || [255, 255, 255];
  // style 里的颜色统一 RGB；像素级操作用 BGR
  const bgColorBgr = [bgRgb[2], bgRgb[1], bgRgb[0]];

  let used = method;
  if (used === 'auto') {
    used = ({ solid: 'fill', gradient: 'linear' })[bgType] || 'inpaint';
  }

  // 擦除 + 残留自检：逐轮加大掩膜膨胀，直到区域内边缘能量降到背景水平
  let bestPatch = null, bestMask = null, bestScore = null;
  for (const extra of [0, 1, 2]) {
    const m = maskInRoi(cv, roi, rect, [x, y], grow + extra, bgLevel);
    const patch = applyMethod(cv, roi, m, used, bgColorBgr, inpaintRadius);
    const score = edgeRatio(cv, patch, rect, [x, y]);

    if (bestScore === null || score < bestScore) {
      rm(bestPatch, bestMask);
      bestPatch = patch; bestMask = m; bestScore = score;
    } else {
      rm(patch, m);
    }
    if (score <= 2.0) break;          // 已经够干净，不再扩大掩膜
  }

  const out = imageBgr.clone();
  const od = out.data, bd = bestPatch.data;
  for (let yy = y; yy < y2; yy++) {
    const srcBase = (yy - y) * (x2 - x) * 3;
    const dstBase = (yy * W + x) * 3;
    const len = (x2 - x) * 3;
    for (let k = 0; k < len; k++) od[dstBase + k] = bd[srcBase + k];
  }

  const maskPixels = countNonZero(bestMask);
  rm(roi, bestPatch, bestMask);

  return {
    image: out,
    meta: {
      method: used,
      bg_type: bgType,
      mask_pixels: maskPixels,
      residual: Math.round(bestScore * 1000) / 1000,
      box: [x, y, x2 - x, y2 - y],
    },
  };
}

/** 构建全图尺寸的掩膜（对外暴露，便于调试与复用） */
export function buildMask(cv, imageBgr, rect, { pad = 3, grow = 2, bgLevel = null } = {}) {
  const H = imageBgr.rows, W = imageBgr.cols;
  const x = Math.max(0, int(rect.x) - pad);
  const y = Math.max(0, int(rect.y) - pad);
  const x2 = Math.min(W, int(rect.x) + int(rect.w) + pad);
  const y2 = Math.min(H, int(rect.y) + int(rect.h) + pad);

  const roi = cropMat(cv, imageBgr, x, y, x2 - x, y2 - y);
  const gray = grayOf(cv, roi);
  const level = bgLevel === null ? estimateBgLevel(cv, gray) : bgLevel;
  rm(gray);

  const inner = maskInRoi(cv, roi, rect, [x, y], grow, level);
  const mask = emptyMask(cv, W, H);
  const md = mask.data;
  const id = inner.data;
  for (let yy = y; yy < y2; yy++) {
    for (let xx = x; xx < x2; xx++) {
      md[yy * W + xx] = id[(yy - y) * (x2 - x) + (xx - x)];
    }
  }
  const pixels = countNonZero(inner);
  rm(roi, inner);
  return { mask, meta: { roi: [x, y, x2, y2], bg_level: level, mask_pixels: pixels } };
}
