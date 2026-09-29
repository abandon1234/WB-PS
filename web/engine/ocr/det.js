/**
 * PP-OCRv3 文字检测：预处理 + DB 后处理。
 *
 * 逐行对齐 rapidocr_onnxruntime 的实现：
 *   ch_ppocr_v3_det/text_detect.py  (TextDetector)
 *   ch_ppocr_v3_det/utils.py        (DetResizeForTest / NormalizeImage / ToCHWImage / DBPostProcess)
 *
 * 两处刻意保持与 Python 一致、容易被"顺手改对"的地方：
 *   1. 通道顺序是 **BGR**（Python 用 cv2.imread 后直接归一化，mean/std 虽按 RGB 写但喂的是 BGR）
 *   2. resize 走 opencv.js 的 cv.resize，与 cv2.resize 是同一份 C++ 源码，插值结果一致
 *
 * unclip 在原实现里用 pyclipper 做多边形偏移，浏览器没有该库。由于此处输入恒为
 * minAreaRect 得到的矩形，偏移后的外接旋转矩形恰为 (w+2d, h+2d)，故用几何扩张精确等价替代。
 */

/** 与 Python 的 round() 对齐（银行家舍入：.5 进位到偶数） */
export function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** cv.RotatedRect.points 在不同构建里可能是 {x,y} 或 [x,y]，统一成数组 */
const toXY = (p) => (Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]);

export const DET_CONFIG = {
  limitSideLen: 736,
  limitType: "min",
  thresh: 0.3,
  boxThresh: 0.5,
  maxCandidates: 1000,
  unclipRatio: 1.6,
  minSize: 3,
  useDilation: true,
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
};

/* ------------------------------------------------------------------ 预处理 */

/** 复刻 DetResizeForTest.resize_image_type0（limit_type='min'） */
export function calcDetResize(h, w, cfg = DET_CONFIG) {
  let ratio;
  if (cfg.limitType === "max") {
    ratio = Math.max(h, w) > cfg.limitSideLen ? cfg.limitSideLen / Math.max(h, w) : 1;
  } else {
    ratio = Math.min(h, w) < cfg.limitSideLen ? cfg.limitSideLen / Math.min(h, w) : 1;
  }
  const rh = pyRound((h * ratio) / 32) * 32;
  const rw = pyRound((w * ratio) / 32) * 32;
  return { rh, rw, ratioH: rh / h, ratioW: rw / w };
}

/**
 * BGR Mat → 检测网络输入张量 [1,3,H,W]，归一化 (px/255 - mean) / std。
 * 注意 mean/std 按 RGB 顺序取自配置，但数据是 BGR —— 与 Python 行为一致。
 */
export function detNormalize(cv, bgrMat, rh, rw, cfg = DET_CONFIG) {
  const resized = new cv.Mat();
  cv.resize(bgrMat, resized, new cv.Size(rw, rh), 0, 0, cv.INTER_LINEAR);

  const src = resized.data;                 // Uint8Array, HWC, BGR
  const n = rh * rw;
  const out = new Float32Array(3 * n);
  const [m0, m1, m2] = cfg.mean;
  const [s0, s1, s2] = cfg.std;
  for (let i = 0; i < n; i++) {
    out[i] = (src[i * 3] / 255 - m0) / s0;
    out[n + i] = (src[i * 3 + 1] / 255 - m1) / s1;
    out[2 * n + i] = (src[i * 3 + 2] / 255 - m2) / s2;
  }
  resized.delete();
  return out;
}

/* ------------------------------------------------------------------ 后处理 */

/** 复刻 DBPostProcess.get_mini_boxes */
function getMiniBoxes(cv, contour) {
  const rect = cv.minAreaRect(contour);
  const points = cv.RotatedRect.points(rect).map(toXY).sort((a, b) => a[0] - b[0]);

  let i1, i4, i2, i3;
  if (points[1][1] > points[0][1]) { i1 = 0; i4 = 1; } else { i1 = 1; i4 = 0; }
  if (points[3][1] > points[2][1]) { i2 = 2; i3 = 3; } else { i2 = 3; i3 = 2; }

  return [[points[i1], points[i2], points[i3], points[i4]],
          Math.min(rect.size.width, rect.size.height)];
}

/** 复刻 DBPostProcess.box_score_fast：polygon 内概率均值 */
function boxScoreFast(cv, prob, probW, probH, box) {
  const xs = box.map((p) => p[0]);
  const ys = box.map((p) => p[1]);
  const xmin = clamp(Math.floor(Math.min(...xs)), 0, probW - 1);
  const xmax = clamp(Math.ceil(Math.max(...xs)), 0, probW - 1);
  const ymin = clamp(Math.floor(Math.min(...ys)), 0, probH - 1);
  const ymax = clamp(Math.ceil(Math.max(...ys)), 0, probH - 1);
  const bw = xmax - xmin + 1;
  const bh = ymax - ymin + 1;

  // 与 Python 同样的 fillPoly 语义：坐标相对裁剪区后截断取整
  const flat = [];
  for (const p of box) {
    flat.push(Math.trunc(p[0] - xmin), Math.trunc(p[1] - ymin));
  }
  const pts = cv.matFromArray(4, 1, cv.CV_32SC2, flat);
  const mask = new cv.Mat(bh, bw, cv.CV_8UC1, new cv.Scalar(0));
  const mv = new cv.MatVector();
  mv.push_back(pts);
  cv.fillPoly(mask, mv, new cv.Scalar(1));

  let sum = 0;
  let cnt = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (mask.data[y * bw + x]) {
        sum += prob[(ymin + y) * probW + (xmin + x)];
        cnt++;
      }
    }
  }

  mv.delete();
  pts.delete();
  mask.delete();
  return cnt ? sum / cnt : 0;
}

/**
 * 复刻 DBPostProcess.unclip —— 几何等价替代 pyclipper。
 * distance = area * ratio / perimeter；矩形 perimeter = 2(w+h)。
 */
function unclipBox(cv, box, ratio) {
  const flat = [];
  for (const p of box) flat.push(p[0], p[1]);
  const mat = cv.matFromArray(4, 1, cv.CV_32FC2, flat);
  const rect = cv.minAreaRect(mat);
  mat.delete();

  const w = rect.size.width;
  const h = rect.size.height;
  const d = (w * h * ratio) / (2 * (w + h));
  const grown = {
    center: { x: rect.center.x, y: rect.center.y },
    size: { width: w + 2 * d, height: h + 2 * d },
    angle: rect.angle,
  };
  return cv.RotatedRect.points(grown).map(toXY);
}

/** 复刻 DBPostProcess.__call__ + boxes_from_bitmap */
export function detPostprocess(cv, prob, probW, probH, srcH, srcW, cfg = DET_CONFIG) {
  // 1) 二值化
  const bin = new cv.Mat(probH, probW, cv.CV_8UC1);
  for (let i = 0; i < prob.length; i++) bin.data[i] = prob[i] > cfg.thresh ? 1 : 0;

  // 2) 膨胀（use_dilation=True 时用 2x2 全 1 核）
  if (cfg.useDilation) {
    const k = cv.matFromArray(2, 2, cv.CV_8UC1, [1, 1, 1, 1]);
    cv.dilate(bin, bin, k);
    k.delete();
  }

  // 3) 轮廓
  const bin255 = new cv.Mat();
  bin.convertTo(bin255, cv.CV_8UC1, 255);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(bin255, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  const boxes = [];
  const total = Math.min(contours.size(), cfg.maxCandidates);
  for (let i = 0; i < total; i++) {
    const contour = contours.get(i);
    const [points, sside] = getMiniBoxes(cv, contour);
    if (sside < cfg.minSize) continue;

    const score = boxScoreFast(cv, prob, probW, probH, points);
    if (cfg.boxThresh > score) continue;

    const expanded = unclipBox(cv, points, cfg.unclipRatio);
    const flat = [];
    for (const p of expanded) flat.push(p[0], p[1]);
    const expMat = cv.matFromArray(4, 1, cv.CV_32FC2, flat);
    const [box2, sside2] = getMiniBoxes(cv, expMat);
    expMat.delete();
    if (sside2 < cfg.minSize + 2) continue;

    // 特征图坐标 → 原图坐标
    const mapped = box2.map((p) => [
      clamp(Math.round((p[0] / probW) * srcW), 0, srcW),
      clamp(Math.round((p[1] / probH) * srcH), 0, srcH),
    ]);
    boxes.push(mapped);
  }

  contours.delete();
  hierarchy.delete();
  bin255.delete();
  bin.delete();
  return boxes;
}

/** 复刻 TextDetector.order_points_clockwise + clip + 宽高过滤 */
export function filterDetBoxes(boxes, imgH, imgW) {
  const out = [];
  for (const pts of boxes) {
    // 按 x 排序，左右各两点再按 y 定上下
    const xs = pts.slice().sort((a, b) => a[0] - b[0]);
    const left = xs.slice(0, 2).sort((a, b) => a[1] - b[1]);
    const right = xs.slice(2, 4).sort((a, b) => a[1] - b[1]);
    const [tl, bl] = left;
    const [tr, br] = right;

    const rect = [tl, tr, br, bl].map((p) => [
      clamp(Math.trunc(p[0]), 0, imgW - 1),
      clamp(Math.trunc(p[1]), 0, imgH - 1),
    ]);

    const norm = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const rw = Math.trunc(norm(rect[0], rect[1]));
    const rh = Math.trunc(norm(rect[0], rect[3]));
    if (rw <= 3 || rh <= 3) continue;
    out.push(rect);
  }
  return out;
}

/** 复刻 RapidOCR.sorted_boxes：按左上角 y→x 排序，并修正同一行内的左右顺序 */
export function sortedBoxes(boxes) {
  const list = boxes.slice().sort((a, b) => (a[0][1] - b[0][1]) || (a[0][0] - b[0][0]));
  for (let i = 0; i < list.length - 1; i++) {
    if (Math.abs(list[i + 1][0][1] - list[i][0][1]) < 10 &&
        list[i + 1][0][0] < list[i][0][0]) {
      const t = list[i];
      list[i] = list[i + 1];
      list[i + 1] = t;
    }
  }
  return list;
}
