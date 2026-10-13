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

   第三个细节（第 2 期的实拍反馈补的）：
   * 掩膜永远不可能 100% 贴住字形（低对比度、被缩放过的截图尤其），而填充色
     一旦被外圈的灰边拖偏，结果就是"字没了、却留一片灰影"。所以纯色底上
     额外做一层**残影清扫**（sweepResidue）：在"离原文字够近"的范围内，
     只要不是背景色就归到背景色。范围不外扩到整个框，是为了不误伤
     框比字高时压进来的邻行内容。
   ========================================================================== */
import { clamp, pyRound, histogram, histMode } from './num.js';
import {
  rm, grayOf, grayData, emptyMask, ellipseKernel, rectKernel, countNonZero, cropMat,
} from './cvutil.js';
import { estimateBgLevel, textMask, keepComponents } from './style.js';

const int = (v) => Math.trunc(v || 0);
const byte = (v) => Math.max(0, Math.min(255, Math.round(v)));

/* 「算不算背景」的灰度容差，同时是残影清扫的判断阈值 */
const BG_TOL = 12;
/* 归属背景主峰簇的灰度窗口 */
const BG_WINDOW = 10;
/* 取参考背景时向外扩多少像素（只取框外那圈，框里的字不参与估计） */
const BG_PAD = 5;
/* 参考背景里落在主峰簇内的比例下限，低于它就不认这是纯色底 */
const BG_SHARE = 0.80;
/* 掩膜外圈自己落在主峰簇内的比例下限，低于它就改用 ROI 级兜底色 */
const RING_SHARE = 0.70;
/* 残影清扫范围：原文字掩膜（已含 grow）再外扩这么多像素 */
const SWEEP_GROW = 5;

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

/* ------------------------------------------------------------ 背景体检与残影清扫 */

/**
 * 掩膜外圈真实像素估出的背景色。
 *
 * 关键是取**主峰所在簇的均值**，不是外圈的中位数：外圈紧贴字形，常常混进
 * 抗锯齿的灰边，中位数被那些灰像素一拖就偏灰，整块填出来是一条淡灰带 ——
 * 「字没了、但留一片灰影」最常见的来源就是它。先找主峰、再只对落在主峰附近的
 * 像素求均值，抗干扰从「容忍一半污染」变成「只要污染是少数派就没事」。
 *
 * 还要再验一道「外圈自己像不像背景」：主峰簇占比不到七成，说明这一圈大半
 * 是墨（框紧贴邻行的字时就是这样），这时不能拿它当底色，退回 ROI 级估计。
 */
function ringBgColor(cv, roi, m, fallback) {
  const k = ellipseKernel(cv, 7);
  const dil = new cv.Mat();
  cv.dilate(m, dil, k);
  const ring = new cv.Mat();
  cv.subtract(dil, m, ring);
  rm(dil, k);

  const rd = ring.data;                 // 掩膜是单通道、连续，平铺安全
  const W = roi.cols, HH = roi.rows;
  const hist = new Float64Array(256);
  const seen = [];
  for (let y = 0; y < HH; y++) {
    const row = roi.ptr(y);             // roi 可能是非连续 Mat，必须逐行取
    const base = y * W;
    for (let x = 0; x < W; x++) {
      if (!rd[base + x]) continue;
      const j = x * 3;
      const lum = 0.114 * row[j] + 0.587 * row[j + 1] + 0.299 * row[j + 2];
      hist[clamp(Math.round(lum), 0, 255)]++;
      seen.push([y, x]);
    }
  }
  rm(ring);
  if (seen.length < 12) return fallback;

  const mode = histMode(hist, 9);
  let near = 0;
  for (let v = Math.max(0, mode - BG_WINDOW); v <= Math.min(255, mode + BG_WINDOW); v++) {
    near += hist[v];
  }
  if (near / seen.length < RING_SHARE) return fallback;
  return clusterMean(roi, seen, mode, fallback);
}

/**
 * 主峰附近那一小簇像素的均值颜色。
 *
 * 先收 ±2 的**紧簇**：纯色底的像素值本来就集中在主峰上，紧簇的均值几乎等于
 * 真实底色。用 ±BG_WINDOW 那种宽簇会把 245 这类边上像素一起平均进去，
 * 填出来比周围背景低一两个灰阶 —— 单看不出来，但整块是个"比周围略暗的平面"，
 * 恰恰是最容易被看出动过手脚的形态。
 */
function clusterMean(mat, idxList, mode, fallback) {
  for (const win of [2, BG_WINDOW]) {
    let bs = 0, gs = 0, rs = 0, n = 0;
    for (const [y, x] of idxList) {
      const row = mat.ptr(y);           // 逐行取，避开非连续 Mat 的平铺错位
      const j = x * 3;
      const lum = 0.114 * row[j] + 0.587 * row[j + 1] + 0.299 * row[j + 2];
      if (Math.abs(lum - mode) > win) continue;
      bs += row[j]; gs += row[j + 1]; rs += row[j + 2]; n++;
    }
    if (n >= 12) return [bs / n, gs / n, rs / n];
  }
  return fallback;
}

/**
 * 全 ROI 级别的背景色。
 *
 * ROI 的高度是框的三倍上下，里面绝大多数像素是背景，所以主峰簇的均值就是这
 * 一块的底色。它是「外圈样本不可信」时的兜底 —— 尤其是「框里一个字都没抓到、
 * 退化成整框填充」那种情况：那时紧贴框外的那圈很可能正压在邻行的字上，
 * 用它取色会把整框刷成灰色。实拍见过这个灰带，所以这里必须有一层兜底。
 */
function roiBgColor(cv, grayRoi, roiBgr, fallback) {
  const d = grayData(grayRoi);          // 灰度是单通道、连续，平铺安全
  const level = histMode(histogram(d), 9);
  const W = roiBgr.cols, H = roiBgr.rows;
  for (const win of [2, BG_WINDOW]) {
    let bs = 0, gs = 0, rs = 0, n = 0;
    for (let y = 0; y < H; y++) {
      const row = roiBgr.ptr(y);        // 逐行取，避开非连续 Mat 的平铺错位
      const base = y * W;
      for (let x = 0; x < W; x++) {
        if (Math.abs(d[base + x] - level) > win) continue;
        const j = x * 3;
        bs += row[j]; gs += row[j + 1]; rs += row[j + 2]; n++;
      }
    }
    if (n >= 12) return [bs / n, gs / n, rs / n];
  }
  return fallback;
}

/**
 * 背景体检：底色主峰在哪儿、纯不纯、框里有多少墨。
 *
 * 关键是用**框外那一圈**当参考，而不是框内：OCR 的框常常紧贴字形，框里
 * 大半都是笔画，用框内统计去判"底色纯不纯"会被墨自己带偏（实测紧框的
 * 密排中文框内背景占比只有 0.43，看着像纹理底）。框外那圈基本只有背景，
 * 用它算主峰和占比才稳。
 *
 * 只有纯色底才敢做残影清扫 —— 有纹理或渐变的底子强行归一化会擦出一块假平面。
 */
function boxProbe(cv, grayRoi, rect, roiXY) {
  const W = grayRoi.cols, H = grayRoi.rows;
  const bx0 = int(clamp(int(rect.x) - roiXY[0], 0, Math.max(0, W - 1)));
  const by0 = int(clamp(int(rect.y) - roiXY[1], 0, Math.max(0, H - 1)));
  const bx1 = int(clamp(bx0 + Math.max(1, int(rect.w)), 1, W));
  const by1 = int(clamp(by0 + Math.max(1, int(rect.h)), 1, H));

  const rx0 = Math.max(0, bx0 - BG_PAD), ry0 = Math.max(0, by0 - BG_PAD);
  const rx1 = Math.min(W, bx1 + BG_PAD), ry1 = Math.min(H, by1 + BG_PAD);

  const outer = cropMat(cv, grayRoi, rx0, ry0, rx1 - rx0, ry1 - ry0);
  const od = grayData(outer);
  const ow = outer.cols, oh = outer.rows;

  const ringHist = new Float64Array(256);
  const boxHist = new Float64Array(256);
  let ringN = 0, boxN = 0;
  for (let y = 0; y < oh; y++) {
    const gy = ry0 + y;
    for (let x = 0; x < ow; x++) {
      const v = od[y * ow + x];
      const gx = rx0 + x;
      if (gx >= bx0 && gx < bx1 && gy >= by0 && gy < by1) { boxHist[v]++; boxN++; }
      else { ringHist[v]++; ringN++; }
    }
  }
  rm(outer);

  // 参考区太小就退回框内统计：宁可不清扫，也不要拿噪声当判据
  const useRing = ringN >= 40;
  const level = histMode(useRing ? ringHist : boxHist, 9);
  const refHist = useRing ? ringHist : boxHist;
  const refN = useRing ? ringN : boxN;

  let near = 0;
  for (let v = Math.max(0, level - BG_WINDOW); v <= Math.min(255, level + BG_WINDOW); v++) {
    near += refHist[v];
  }
  let ink = 0;
  for (let v = 0; v < 256; v++) {
    if (Math.abs(v - level) > BG_TOL) ink += boxHist[v];
  }

  return {
    level,
    ringN,
    bgShare: refN ? near / refN : 0,
    inkRatio: boxN ? ink / boxN : 0,
    solid: useRing && refN > 0 && near / refN >= BG_SHARE,
  };
}

/** 清扫范围：原文字掩膜外扩 SWEEP_GROW、且不出框。返回框内的 0/1 标记 + 几何。 */
function sweepReach(cv, m, rect, roiXY) {
  const W = m.cols, H = m.rows;
  const x0 = int(clamp(int(rect.x) - roiXY[0], 0, Math.max(0, W - 1)));
  const y0 = int(clamp(int(rect.y) - roiXY[1], 0, Math.max(0, H - 1)));
  const x1 = int(clamp(x0 + Math.max(1, int(rect.w)), 1, W));
  const y1 = int(clamp(y0 + Math.max(1, int(rect.h)), 1, H));

  const k = ellipseKernel(cv, SWEEP_GROW * 2 + 1);
  const reach = new cv.Mat();
  cv.dilate(m, reach, k);
  rm(k);

  const bw = x1 - x0, bh = y1 - y0;
  const flags = new Uint8Array(bw * bh);
  const rd = reach.data;
  for (let y = 0; y < bh; y++) {
    const row = (y0 + y) * W;
    for (let x = 0; x < bw; x++) flags[y * bw + x] = rd[row + x0 + x] ? 1 : 0;
  }
  rm(reach);
  return { flags, x0, y0, w: bw, h: bh, W };
}

/**
 * 残影清扫：在清扫范围内把偏离背景超过 tol 的像素直接归到背景色。
 *
 * 为什么需要它：textMask 在低对比度、被缩放过的截图上往往只抓得住笔画核心，
 * 抗锯齿那一圈灰边会漏在掩膜之外 —— 擦完就是「字没了、却留着一片灰影」。
 * 补上这层之后，纯色底上的抹字不可能再留残影：范围内只要不是背景色，一律归位。
 *
 * 范围限制在掩膜外扩 SWEEP_GROW 之内、且不出框，理由是 OCR 行框常常比字高，
 * 用整个框会把框里"离目标文字很远"的东西（比如邻行的字头）一起抹掉。
 *
 * 刻意不做的一件事：保护恰好压在范围内的表格线。试过按"横贯整行"识别它，
 * 但判据做不到既可靠又不留残影 —— 而留残影正是这里要修的问题，
 * 所以取舍是：宁可少一道线，也不要留一片灰。
 */
function sweepResidue(cv, patch, m, rect, roiXY, level, paintBgr, tol) {
  const { flags, x0, y0, w: bw, h: bh } = sweepReach(cv, m, rect, roiXY);
  const gray = grayOf(cv, patch);
  const b = byte(paintBgr[0]), g = byte(paintBgr[1]), r = byte(paintBgr[2]);
  let n = 0;
  for (let y = 0; y < bh; y++) {
    const grow = gray.ptr(y0 + y);
    const prow = patch.ptr(y0 + y);      // 写 patch 必须逐行（非连续 Mat）
    for (let x = 0; x < bw; x++) {
      if (!flags[y * bw + x]) continue;
      const px = x0 + x;
      if (Math.abs(grow[px] - level) <= tol) continue;
      const o = px * 3;
      prow[o] = b; prow[o + 1] = g; prow[o + 2] = r;
      n++;
    }
  }
  rm(gray);
  return n;
}

/** 清扫范围内还能看出的最大偏离（0~255）—— 「到底擦干净没有」的判据。 */
function residuePeak(cv, patch, m, rect, roiXY, level) {
  const { flags, x0, y0, w: bw, h: bh } = sweepReach(cv, m, rect, roiXY);
  const gray = grayOf(cv, patch);
  let peak = 0;
  for (let y = 0; y < bh; y++) {
    const grow = gray.ptr(y0 + y);
    for (let x = 0; x < bw; x++) {
      if (!flags[y * bw + x]) continue;
      const dv = Math.abs(grow[x0 + x] - level);
      if (dv > peak) peak = dv;
    }
  }
  rm(gray);
  return peak;
}

/* ------------------------------------------------------------ 各策略实现 */

/** 纯色填充：把掩膜内整块刷成背景色。
 *  背景是纯色时这就是"完美擦除"，不要羽化 —— 羽化反而会在
 *  本来完全一致的背景上造出可见软边。背景色由 erase() 统一估（见 ringBgColor）。 */
function fillPatch(cv, roi, m, bgColorBgr) {
  const out = roi.clone();
  const b = byte(bgColorBgr[0]), g = byte(bgColorBgr[1]), r = byte(bgColorBgr[2]);
  const h = out.rows, w = out.cols;
  // 必须走 ptr(row) 逐行 —— crop/clone 出来的多通道 Mat 实测 isContinuous() 为 false，
  // 而 data.length 又恰好等于 rows*cols*ch，按平铺下标读写会整体错位（写不进目标像素、
  // 读出来也全是假值）。这个坑在本项目里已经踩过一次（见 cvutil.planeData 的注释）。
  for (let y = 0; y < h; y++) {
    const mrow = m.ptr(y);
    const orow = out.ptr(y);
    for (let x = 0; x < w; x++) {
      if (!mrow[x]) continue;
      const o = x * 3;
      orow[o] = b; orow[o + 1] = g; orow[o + 2] = r;
    }
  }
  return out;
}

/** 沿某方向线性外推：对每一列（行），取掩膜上下（左右）外侧最近的真实像素做插值。
 *  掩膜触到 ROI 边界时，用可用的那一侧做常数延展。 */
function interpAxis(roi, m, axis) {
  const h = m.rows, w = m.cols;
  const md = m.data;                    // 掩膜是单通道、连续，平铺安全
  const nOuter = axis === 0 ? w : h;
  const nInner = axis === 0 ? h : w;

  const out = new Float32Array(w * h * 3);
  // 逐行拷贝：roi 可能是非连续 Mat（isContinuous() 为 false，见 fillPatch 的注释），
  // 直接对 data 平铺读会整体错位。
  for (let y = 0; y < h; y++) out.set(roi.ptr(y), y * w * 3);

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
  const md = m.data;                    // 掩膜单通道，平铺安全
  for (let y = 0; y < h; y++) {
    const orow = out.ptr(y);
    const base = y * w;
    for (let x = 0; x < w; x++) {
      if (!md[base + x]) continue;
      const o = x * 3, k = (base + x) * 3;   // best 是平铺 Float32Array
      orow[o] = byte(best[k]);
      orow[o + 1] = byte(best[k + 1]);
      orow[o + 2] = byte(best[k + 2]);
    }
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
  const mk = m.data;                    // 掩膜单通道，平铺安全
  const h = m.rows, w = m.cols;
  for (let y = 0; y < h; y++) {
    const mrow = med.ptr(y), srow = soft.ptr(y), orow = out.ptr(y);
    const base = y * w;
    for (let x = 0; x < w; x++) {
      if (!mk[base + x]) continue;
      const o = x * 3;
      orow[o] = (mrow[o] + srow[o]) >> 1;
      orow[o + 1] = (mrow[o + 1] + srow[o + 1]) >> 1;
      orow[o + 2] = (mrow[o + 2] + srow[o + 2]) >> 1;
    }
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
 * @param cleanup  纯色底上的残影清扫（见 sweepResidue）
 * @returns { image, meta } image 为**新 Mat**（调用方负责 delete）
 */
export function erase(cv, imageBgr, rect, style = null, {
  method = 'auto', grow = 2, inpaintRadius = 3, padRatio = 1.0, cleanup = true,
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

  const bgType = (style || {}).bg_type || 'solid';
  const bgRgb = (style || {}).bg_color || [255, 255, 255];
  // style 里的颜色统一 RGB；像素级操作用 BGR
  const styleBg = [bgRgb[2], bgRgb[1], bgRgb[0]];

  const roi = cropMat(cv, imageBgr, x, y, x2 - x, y2 - y);
  const gray = grayOf(cv, roi);
  const bgLevel = estimateBgLevel(cv, gray);
  const probe = boxProbe(cv, gray, rect, [x, y]);
  const roiBg = roiBgColor(cv, gray, roi, styleBg);
  rm(gray);

  let used = method;
  if (used === 'auto') {
    // 有 style 就听它的；style 缺席时（文字工坊的"抹字"就是这种情况）
    // 不要一律当成纯色底 —— 先体检这块框自己的底色，纯色才填充，
    // 有纹理就交给 inpaint，否则会在照片上糊出一块假的平面。
    used = style && style.bg_type
      ? (({ solid: 'fill', gradient: 'linear' })[style.bg_type] || 'inpaint')
      : (probe.solid ? 'fill' : 'inpaint');
  }

  // 擦除 + 残留自检：逐轮加大掩膜膨胀，直到区域内边缘能量降到背景水平
  let bestPatch = null, bestMask = null, bestScore = null;
  let paintBgr = roiBg;
  for (const extra of [0, 1, 2]) {
    const m = maskInRoi(cv, roi, rect, [x, y], grow + extra, bgLevel);
    // 第一轮就把"底到底是什么颜色"定下来：外圈主峰簇的均值（外圈不像背景时退回 roiBg）
    if (bestMask === null) paintBgr = ringBgColor(cv, roi, m, roiBg);
    const patch = applyMethod(cv, roi, m, used, paintBgr, inpaintRadius);
    const score = edgeRatio(cv, patch, rect, [x, y]);

    if (bestScore === null || score < bestScore) {
      rm(bestPatch, bestMask);
      bestPatch = patch; bestMask = m; bestScore = score;
    } else {
      rm(patch, m);
    }
    if (score <= 2.0) break;          // 已经够干净，不再扩大掩膜
  }

  const maskPixels = countNonZero(bestMask);
  // 残影清扫 + 残留度量。
  // 墨几乎占满整框（>90%）说明框里根本没什么背景可归位，这时不碰。
  const sweepable = cleanup && probe.solid && maskPixels > 0 && probe.inkRatio <= 0.9;
  const swept = sweepable
    ? sweepResidue(cv, bestPatch, bestMask, rect, [x, y], probe.level, paintBgr, BG_TOL)
    : 0;
  const peak = sweepable
    ? residuePeak(cv, bestPatch, bestMask, rect, [x, y], probe.level)
    : null;

  // ── 自查：bestPatch 框内的灰度极值（只在纯色底上有意义）──
  // 度量「到底擦干净没有」最终落到 real memory 上：擦干净时这里就该等于 bg_level。
  const gx0 = Math.max(0, int(rect.x) - x), gy0 = Math.max(0, int(rect.y) - y);
  const gx1 = Math.min(bestPatch.cols, gx0 + int(rect.w));
  const gy1 = Math.min(bestPatch.rows, gy0 + int(rect.h));
  let pMin = 255, pMax = 0;
  {
    const pg = grayOf(cv, bestPatch);
    for (let yy = gy0; yy < gy1; yy++) {
      const grow = pg.ptr(yy);
      for (let xx = gx0; xx < gx1; xx++) {
        const v = grow[xx];
        if (v < pMin) pMin = v;
        if (v > pMax) pMax = v;
      }
    }
    rm(pg);
  }

  const out = imageBgr.clone();
  // 同样的坑：两边都用 ptr(row) 搬运，别用 data 平铺（bestPatch 非连续）。
  for (let yy = 0; yy < y2 - y; yy++) {
    const srow = bestPatch.ptr(yy);
    const drow = out.ptr(y + yy);
    for (let xx = 0; xx < x2 - x; xx++) {
      const so = xx * 3, dofs = (x + xx) * 3;
      drow[dofs] = srow[so];
      drow[dofs + 1] = srow[so + 1];
      drow[dofs + 2] = srow[so + 2];
    }
  }

  rm(roi, bestPatch, bestMask);

  return {
    image: out,
    meta: {
      method: used,
      bg_type: bgType,
      bg_solid: probe.solid,
      bg_level: Math.round(probe.level),
      bg_ink: Math.round(probe.inkRatio * 1000) / 1000,
      mask_pixels: maskPixels,
      residual: Math.round(bestScore * 1000) / 1000,
      swept_pixels: swept,
      // 清扫范围内还剩多少偏离背景（0~255）。纯色底才有意义，非纯色底给 null。
      leftover_max: peak === null ? null : Math.round(peak),
      // 诊断三段：bestPatch 框内灰度极值 / patch 尺寸 / mask 尺寸
      patch_box_min: pMin, patch_box_max: pMax,
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
