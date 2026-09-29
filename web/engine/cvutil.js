/* ==========================================================================
   WB-PS · OpenCV 辅助层

   Python 侧 numpy 可以直接切片、广播、`img[mask > 0] = color`；
   浏览器里的 opencv.js 没有这种便利，且 Mat 需要手工管理生命周期。
   这一层把最容易出错的三件事收敛到一处：

     1. 通道顺序 —— 算法内部统一 BGR（与 cv2.imread 对齐），对外统一 RGB
     2. 内存释放 —— emscripten 的堆内存不归 GC 管，漏 delete 会稳定泄漏
     3. 连续性   —— ROI 出来的 Mat 往往不连续，直接按 rows*cols 下标读会错位
   ========================================================================== */

/** 批量释放。已 delete 过或为 null 都不该抛错 —— 清理路径要足够钝 */
export function rm(...mats) {
  for (const m of mats) {
    if (!m) continue;
    try { m.delete(); } catch (_) { /* 已释放或不是 Mat */ }
  }
}

/** ImageData(RGBA) → BGR Mat，与 cv2.imread 的通道顺序一致 */
export function imageDataToBgrMat(cv, imageData) {
  const { width: w, height: h, data } = imageData;
  const mat = new cv.Mat(h, w, cv.CV_8UC3);
  const dst = mat.data;
  for (let i = 0, n = w * h; i < n; i++) {
    dst[i * 3] = data[i * 4 + 2];
    dst[i * 3 + 1] = data[i * 4 + 1];
    dst[i * 3 + 2] = data[i * 4];
  }
  return mat;
}

/** BGR / 灰度 Mat → ImageData，便于画到 canvas */
export function matToImageData(cv, mat) {
  const h = mat.rows, w = mat.cols, ch = mat.channels();
  const out = new Uint8ClampedArray(w * h * 4);
  const src = planeData(mat);
  for (let i = 0, n = w * h; i < n; i++) {
    if (ch >= 3) {
      out[i * 4] = src[i * ch + 2];
      out[i * 4 + 1] = src[i * ch + 1];
      out[i * 4 + 2] = src[i * ch];
    } else {
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = src[i * ch];
    }
    out[i * 4 + 3] = 255;
  }
  return new ImageData(out, w, h);
}

/** BGR Mat → RGBA 像素缓冲（要往 canvas 上叠东西时用） */
export function matToRgba(cv, mat) {
  const h = mat.rows, w = mat.cols, ch = mat.channels();
  const out = new Uint8ClampedArray(w * h * 4);
  const src = planeData(mat);
  for (let i = 0, n = w * h; i < n; i++) {
    if (ch >= 3) {
      out[i * 4] = src[i * ch + 2];
      out[i * 4 + 1] = src[i * ch + 1];
      out[i * 4 + 2] = src[i * ch];
    } else {
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = src[i * ch];
    }
    out[i * 4 + 3] = ch === 4 ? src[i * ch + 3] : 255;
  }
  return out;
}

/** BGR Mat → 灰度 Mat（调用方负责 delete） */
export function grayOf(cv, bgrMat) {
  const g = new cv.Mat();
  cv.cvtColor(bgrMat, g, cv.COLOR_BGR2GRAY);
  return g;
}

/**
 * 取单通道 Mat 的像素数据。
 *
 * 注意 opencv.js 的一个坑：`Mat.data` 对 CV_32F / CV_32S **不是**浮点/整型视图，
 * 而是指向同一块堆内存的 Uint8Array（字节视图），直接按像素下标读会读到字节。
 * 这类错误很隐蔽 —— 数字看着"有值"，只是全错。所以这里统一分派。
 *
 * ⚠️ Mat 连续时返回的是**内部缓冲的引用**（类似 numpy 的 asarray 返回视图）。
 *    只读完全没问题；一旦要就地修改，必须自己先拷一份 ——
 *    否则改的是源 Mat 本身，而且因为大家共用同一块内存，
 *    别处看似无关的读取会跟着一起出错，极难定位。
 *
 * ROI 出来的 Mat 带 stride，按 rows*cols 平铺还会错位，不连续时逐行搬一遍。
 */
export function grayData(mat) {
  const type = typeof mat.type === 'function' ? mat.type() : -1;
  if (type === CV_32F) return mat.data32F;
  if (type === CV_32S) return mat.data32S;
  return planeData(mat);
}

/**
 * 取 Mat 的像素数据，**保证连续**。
 *
 * 这是本项目最容易踩的坑之一：crop / roi 出来的 Mat 实测 `isContinuous()` 为 false，
 * 而 `data` 的长度看着又是精确的 rows×cols×ch —— 于是按平铺下标读会整体错位。
 * 它不抛异常、不报错，只是结果全错：掩膜明明罩在文字上（像素数也对），
 * 取颜色却取到背景（白底黑字会取到白色，改完的字就看不见了）。
 *
 * 不连续时逐行搬一份副本，调用方拿到的永远是安全数据。
 */
export function planeData(mat) {
  if (mat.isContinuous && mat.isContinuous()) return mat.data;
  const h = mat.rows, w = mat.cols;
  const ch = typeof mat.channels === 'function' ? mat.channels() : 1;
  const src = mat.data;
  const out = new src.constructor(h * w * ch);
  let k = 0;
  for (let y = 0; y < h; y++) {
    const row = mat.ptr(y);
    for (let x = 0; x < w * ch; x++) out[k++] = row[x];
  }
  return out;
}

/** OpenCV 的 type 编码：CV_8UC1=0 … CV_32SC1=4 … CV_32FC1=5 */
export const CV_32S = 4;
export const CV_32F = 5;

/** 灰度数据 → 单通道 Mat */
export function grayMatFrom(cv, data, w, h) {
  const m = new cv.Mat(h, w, cv.CV_8UC1);
  m.data.set(data);
  return m;
}

/** 裁 ROI，返回**连续副本**（原 Mat 不动，调用方管自己的） */
export function cropMat(cv, src, x, y, w, h) {
  const rect = new cv.Rect(x, y, w, h);
  const view = src.roi(rect);
  const copy = view.clone();
  view.delete();
  return copy;
}

/** 全零单通道掩膜 */
export function emptyMask(cv, w, h) {
  return new cv.Mat(h, w, cv.CV_8UC1, new cv.Scalar(0));
}

/** 椭圆结构元（cv2.getStructuringElement 的等价物） */
export function ellipseKernel(cv, size) {
  const s = Math.max(1, size | 1);
  return cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(s, s));
}

/** 矩形结构元 */
export function rectKernel(cv, size) {
  const s = Math.max(1, size | 1);
  return cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(s, s));
}

/** 统计掩膜里非零像素数 */
export function countNonZero(mat) {
  let n = 0;
  const d = mat.data;
  for (let i = 0; i < d.length; i++) if (d[i]) n++;
  return n;
}

/** 找掩膜的非零包围盒 {x,y,w,h}；全空返回 null */
export function maskBounds(mat) {
  const { rows: h, cols: w } = mat;
  const d = grayData(mat);
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) {
      if (!d[base + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** 逐元素比较后置 255（numpy 里 `gray <= th` 那种写法的替代品） */
export function maskFrom(data, len, pred) {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = pred(data[i]) ? 255 : 0;
  return out;
}

/** 在 BGR Mat 上按掩膜涂一个颜色（RGB 传入，内部转 BGR） */
export function paintMasked(cv, bgrMat, mask, rgb) {
  const { rows: h, cols: w } = bgrMat;
  const d = bgrMat.data;
  const m = grayData(mask);
  const b = rgb[2], g = rgb[1], r = rgb[0];
  for (let i = 0, n = h * w; i < n; i++) {
    if (!m[i]) continue;
    d[i * 3] = b; d[i * 3 + 1] = g; d[i * 3 + 2] = r;
  }
}
