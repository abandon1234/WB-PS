/* ==========================================================================
   WB-PS · 运行时装配（opencv.js + onnxruntime-web）

   这两样都是几十 MB 的 WASM，加载方式还不一样：
     opencv.js  —— <script> 注入，挂到 window.cv，再等 wasm runtime 真正初始化
     ort        —— <script> 注入，挂到 window.ort，还得手工告诉它 wasm 产物在哪

   单独抽出来，是为了让「资源从哪来」这件事只有一个出处：
   走 /assets/vendor/ 就是走 SW 缓存，页面其他代码不必关心。
   ========================================================================== */

const VENDOR = '/assets/vendor';

let cvPromise = null;
let ortPromise = null;

/** 注入 <script>，返回加载完成（onload）的 promise */
function injectScript(src, { async = false, type = null } = {}) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = async;
    if (type) s.type = type;
    s.onload = () => resolve(s);
    s.onerror = () => reject(new Error(`脚本加载失败：${src}`));
    document.head.appendChild(s);
  });
}

/**
 * 加载 opencv.js。
 * 注意 cv 是个「先有壳、后有肉」的对象：脚本 onload 时 wasm 往往还没初始化完，
 * 必须再等 Mat 构造函数可用，否则后面 new cv.Mat() 会炸。
 */
export function loadOpenCV({ src = `${VENDOR}/opencv.js`, timeoutMs = 180000, onProgress } = {}) {
  if (cvPromise) return cvPromise;

  cvPromise = (async () => {
    if (window.cv && typeof window.cv.Mat === 'function') return window.cv;

    if (onProgress) onProgress({ phase: 'load', label: 'OpenCV 运行时' });
    await injectScript(src);

    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      let cv = window.cv;
      if (cv) {
        // 某些构建导出的是 Promise
        if (typeof cv.then === 'function') {
          cv = await cv;
          window.cv = cv;
        }
        if (typeof cv.Mat === 'function') return cv;
        if (!cv.__wbHooked) {
          cv.__wbHooked = true;
          cv.onRuntimeInitialized = () => { cv.__wbReady = true; };
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('OpenCV 初始化超时（opencv.js 可能未就绪）');
  })();

  return cvPromise;
}

/**
 * 加载 onnxruntime-web。
 * wasmPaths 必须是可解析的绝对 URL —— 裸相对路径 "vendor/" 在浏览器里
 * 会让 ort 解析成相对当前文档的路径，一旦页面有嵌套路由就 404。
 */
export function loadOrt({ src = `${VENDOR}/ort.wasm.min.js`, wasmPaths = `${VENDOR}/`, timeoutMs = 60000, onProgress } = {}) {
  if (ortPromise) return ortPromise;

  ortPromise = (async () => {
    if (!window.ort || !window.ort.InferenceSession) {
      if (onProgress) onProgress({ phase: 'load', label: 'ONNX Runtime' });
      await injectScript(src);

      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        if (window.ort && window.ort.InferenceSession) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!window.ort || !window.ort.InferenceSession) throw new Error('ONNX Runtime 加载超时');
    }

    const ort = window.ort;
    ort.env.wasm.wasmPaths = new URL(wasmPaths, document.baseURI).href;

    // 多线程需要 crossOriginIsolated（COOP/COEP 响应头）。
    // 没有这个环境就老实单线程 —— 硬开线程会被浏览器拒绝，直接抛错。
    ort.env.wasm.numThreads = (self.crossOriginIsolated && navigator.hardwareConcurrency)
      ? Math.min(4, navigator.hardwareConcurrency)
      : 1;
    ort.env.logLevel = 'error';

    return ort;
  })();

  return ortPromise;
}

/** 一次性把两个运行时都备好 */
export async function loadRuntimes(onProgress) {
  const cv = await loadOpenCV({ onProgress });
  const ort = await loadOrt({ onProgress });
  return { cv, ort };
}
