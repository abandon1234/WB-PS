/* ==========================================================================
   WB-PS · 数值工具

   移植 Python 算法时最容易被忽略的一类坑：**默认行为的细微差异**。
   最典型的就是 round —— Python 是银行家舍入，JS 是四舍五入进大。
   单次调用看不出差别，但样式反推要在几万个像素上做统计，
   偏差会一路累积到字号、笔宽这些"看起来就该是整数"的结果上。
   所以这里显式复刻 Python 的语义，而不是图省事用 Math.round。
   ========================================================================== */

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Python 的 round()：.5 向偶数取整（银行家舍入） */
export function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** 中位数。偶数个取中间两个的均值（与 numpy.median 一致）。 */
export function median(values) {
  const n = values.length;
  if (!n) return 0;
  const a = typeof values.slice === 'function' ? Array.prototype.slice.call(values) : Array.from(values);
  a.sort((x, y) => x - y);
  const mid = n >> 1;
  return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** 分位数，线性插值（与 numpy.percentile 默认行为一致）。 */
export function percentile(values, p) {
  const n = values.length;
  if (!n) return 0;
  const a = Array.prototype.slice.call(values);
  a.sort((x, y) => x - y);
  if (n === 1) return a[0];
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

export function mean(values) {
  const n = values.length;
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += values[i];
  return s / n;
}

export function std(values, m = null) {
  const n = values.length;
  if (!n) return 0;
  const mu = m === null ? mean(values) : m;
  let s = 0;
  for (let i = 0; i < n; i++) { const d = values[i] - mu; s += d * d; }
  return Math.sqrt(s / n);
}

/* ------------------------------------------------------------ 直方图统计
   灰度图动辄几十万像素，逐像素建数组排序很浪费。
   先落 256 桶的直方图，再在桶上算均值/方差，快一个量级。 */

export function histogram(data) {
  const h = new Float64Array(256);
  for (let i = 0; i < data.length; i++) h[data[i]]++;
  return h;
}

export function histTotal(hist) {
  let n = 0;
  for (let i = 0; i < 256; i++) n += hist[i];
  return n;
}

/** 直方图在 (lo, hi] 区间的均值 */
export function histMean(hist, lo, hi) {
  let sum = 0, cnt = 0;
  for (let i = lo; i <= hi; i++) { sum += hist[i] * i; cnt += hist[i]; }
  return cnt ? sum / cnt : 0;
}

/** 直方图在 [lo, hi] 区间的标准差 */
export function histStd(hist, lo, hi) {
  let sum = 0, cnt = 0;
  for (let i = lo; i <= hi; i++) { sum += hist[i] * i; cnt += hist[i]; }
  if (!cnt) return 0;
  const mu = sum / cnt;
  let v = 0;
  for (let i = lo; i <= hi; i++) { const d = i - mu; v += hist[i] * d * d; }
  return Math.sqrt(v / cnt);
}

/** 中位数（按累计计数找中点，偶数时线性插值） */
export function histMedian(hist) {
  const total = histTotal(hist);
  if (!total) return 0;
  const half = total / 2;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    const next = acc + hist[i];
    if (next > half) {
      // 命中即返；但若正好跨过中点且落在桶边界，取相邻桶插值
      if (acc === half && i > 0) return i - 0.5;
      return i;
    }
    if (next === half && i < 255) return i + 0.5;
    acc = next;
  }
  return 255;
}

/** 众数（主峰）。可传平滑窗口，模拟 np.convolve 的移动平均。 */
export function histMode(hist, smooth = 9) {
  if (smooth <= 1) {
    let best = 0;
    for (let i = 1; i < 256; i++) if (hist[i] > hist[best]) best = i;
    return best;
  }
  const half = smooth >> 1;
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

/** 两向量相乘后求和（BGR 亮度等） */
export function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** RGB → 感知亮度（0.299/0.587/0.114，注意本项目的 color 数组统一是 RGB） */
export function lumRgb(c) {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
}
