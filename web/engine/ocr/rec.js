/**
 * 裁剪 / 方向分类 / 文字识别。
 *
 * 逐行对齐：
 *   rapid_ocr_api.py                 (get_crop_img_list → get_rotate_crop_image)
 *   ch_ppocr_v2_cls/text_cls.py      (TextClassifier)
 *   ch_ppocr_v3_rec/text_recognize.py (TextRecognizer)
 *   ch_ppocr_v3_rec/utils.py         (CTCLabelDecode)
 */

const toTrunc = Math.trunc;

/* ------------------------------------------------------------------ 裁剪 */

/**
 * 复刻 get_rotate_crop_image：透视变换取正，竖排文本逆时针转 90°。
 * Python 用 np.rot90（逆时针），对应 transpose + 上下翻转。
 */
export function cropByBox(cv, bgrMat, box) {
  const norm = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const cw = toTrunc(Math.max(norm(box[0], box[1]), norm(box[2], box[3])));
  const ch = toTrunc(Math.max(norm(box[0], box[3]), norm(box[1], box[2])));

  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2,
    [box[0][0], box[0][1], box[1][0], box[1][1], box[2][0], box[2][1], box[3][0], box[3][1]]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, cw, 0, cw, ch, 0, ch]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);

  const dst = new cv.Mat();
  cv.warpPerspective(bgrMat, dst, M, new cv.Size(cw, ch), cv.INTER_CUBIC, cv.BORDER_REPLICATE);

  srcTri.delete();
  dstTri.delete();
  M.delete();

  if (dst.rows / dst.cols >= 1.5) {                 // 竖排 → np.rot90
    const t = new cv.Mat();
    cv.transpose(dst, t);
    cv.flip(t, t, 0);
    dst.delete();
    return t;
  }
  return dst;
}

/* ------------------------------------------------------------------ 归一化 */

/**
 * 共用的 resize + 归一化：(px/255 - 0.5) / 0.5，右侧零填充，输出 CHW。
 * cls 与 rec 的差别只有目标宽度。
 */
function resizeNormChw(cv, bgrMat, imgH, imgW, resizedW) {
  const resized = new cv.Mat();
  cv.resize(bgrMat, resized, new cv.Size(resizedW, imgH), 0, 0, cv.INTER_LINEAR);

  const src = resized.data;
  const hn = imgH * imgW;
  const out = new Float32Array(3 * hn);             // 零填充，pad 区保持 0
  for (let y = 0; y < imgH; y++) {
    for (let x = 0; x < resizedW; x++) {
      const si = (y * resizedW + x) * 3;
      const di = y * imgW + x;
      out[di] = (src[si] / 255 - 0.5) / 0.5;
      out[hn + di] = (src[si + 1] / 255 - 0.5) / 0.5;
      out[2 * hn + di] = (src[si + 2] / 255 - 0.5) / 0.5;
    }
  }
  resized.delete();
  return out;
}

/** 复刻 TextClassifier.resize_norm_img（shape 3x48x192） */
export function clsPreprocess(cv, bgrMat, imgC = 3, imgH = 48, imgW = 192) {
  const ratio = bgrMat.cols / bgrMat.rows;
  const needed = Math.ceil(imgH * ratio);
  const resizedW = needed > imgW ? imgW : toTrunc(needed);
  return { tensor: resizeNormChw(cv, bgrMat, imgH, imgW, resizedW), dims: [1, imgC, imgH, imgW] };
}

/** 复刻 TextRecognizer.resize_norm_img（shape 3x48x动态宽） */
export function recPreprocess(cv, bgrMat, maxWhRatio, imgC = 3, imgH = 48) {
  const imgW = toTrunc(imgH * maxWhRatio);
  const ratio = bgrMat.cols / bgrMat.rows;
  const needed = Math.ceil(imgH * ratio);
  const resizedW = needed > imgW ? imgW : toTrunc(needed);
  return { tensor: resizeNormChw(cv, bgrMat, imgH, imgW, resizedW), dims: [1, imgC, imgH, imgW] };
}

/* ------------------------------------------------------------------ 解码 */

/**
 * 复刻 CTCLabelDecode.__call__ + decode。
 * 注意置信度取 np.mean(conf_list + [1e-50])，分母是 n+1。
 */
export function ctcDecode(preds, T, C, charList) {
  const chars = [];
  const confs = [];
  let sum = 0;
  let prevIdx = -1;

  for (let t = 0; t < T; t++) {
    const base = t * C;
    let best = 0;
    let bestV = preds[base];
    for (let c = 1; c < C; c++) {
      const v = preds[base + c];
      if (v > bestV) { bestV = v; best = c; }
    }
    if (best === 0) { prevIdx = 0; continue; }       // blank
    if (best === prevIdx) continue;                  // 连续重复
    chars.push(charList[best] ?? "");
    confs.push(bestV);
    sum += bestV;
    prevIdx = best;
  }

  return { text: chars.join(""), score: (sum + 1e-50) / (confs.length + 1) };
}

/** 复刻 ClsPostProcess：二分类 argmax */
export function clsDecode(preds, labelList) {
  const n = labelList.length;
  let best = 0;
  let bestV = preds[0];
  for (let i = 1; i < n; i++) {
    if (preds[i] > bestV) { bestV = preds[i]; best = i; }
  }
  return { label: labelList[best], score: bestV };
}
