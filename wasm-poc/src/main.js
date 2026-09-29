/**
 * PoC 页面逻辑：加载运行时 → 跑识别 → 与 Python 基线逐框比对。
 *
 * 自动模式：?auto=1 时页面加载后自动跑，结果挂到 window.__POC_RESULT__，
 * 方便在无人工交互的情况下取结果。
 */
import { OcrEngine, imageDataToBgrMat } from "./engine.js";

const $ = (s) => document.querySelector(s);
const setStatus = (t) => { $("#status").textContent = t; };

/* ------------------------------------------------------------------ 运行时 */

async function waitOpenCV(timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let c = window.cv;
    if (c) {
      if (typeof c.then === "function") {            // 某些构建导出的是 Promise
        window.cv = await c;
        c = window.cv;
      }
      if (typeof c.Mat === "function") return c;
      if (!c.__pocHooked) {                          // 等 wasm runtime 初始化
        c.__pocHooked = true;
        c.onRuntimeInitialized = () => { c.__pocReady = true; };
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("opencv.js 加载超时");
}

function waitOrt(timeoutMs = 60000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (window.ort && window.ort.InferenceSession) return resolve(window.ort);
      if (Date.now() - t0 > timeoutMs) return reject(new Error("ort 加载超时"));
      setTimeout(tick, 100);
    };
    tick();
  });
}

/* ------------------------------------------------------------------ 图片 */

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`图片加载失败: ${url}`));
    img.src = url;
  });
}

function toImageData(img) {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

/* ------------------------------------------------------------------ 比对 */

function boxMaxDiff(a, b) {
  let m = 0;
  for (let i = 0; i < 4; i++) {
    m = Math.max(m, Math.abs(a[i][0] - b[i][0]), Math.abs(a[i][1] - b[i][1]));
  }
  return m;
}

function rectOf(box) {
  const xs = box.map((p) => p[0]);
  const ys = box.map((p) => p[1]);
  return {
    x: Math.round(Math.min(...xs)), y: Math.round(Math.min(...ys)),
    w: Math.round(Math.max(...xs) - Math.min(...xs)),
    h: Math.round(Math.max(...ys) - Math.min(...ys)),
  };
}

function compare(pred, base) {
  const n = Math.max(pred.length, base.length);
  const rows = [];
  let textOk = 0;
  let maxBox = 0;
  let scoreDrift = 0;

  for (let i = 0; i < n; i++) {
    const p = pred[i] || null;
    const b = base[i] || null;
    const same = !!(p && b && p.text === b.text);
    if (same) textOk++;
    const d = p && b ? boxMaxDiff(p.box, b.box) : NaN;
    if (Number.isFinite(d)) maxBox = Math.max(maxBox, d);
    const sd = p && b ? Math.abs(p.score - b.score) : NaN;
    if (Number.isFinite(sd)) scoreDrift = Math.max(scoreDrift, sd);
    rows.push({
      i,
      baseText: b ? b.text : "—",
      predText: p ? p.text : "—",
      same,
      boxDiff: d,
      baseScore: b ? b.score : null,
      predScore: p ? p.score : null,
      baseRect: b ? rectOf(b.box) : null,
      predRect: p ? rectOf(p.box) : null,
    });
  }

  return {
    baseCount: base.length,
    predCount: pred.length,
    countSame: base.length === pred.length,
    textOk,
    textTotal: n,
    allTextSame: textOk === n && n > 0,
    maxBoxDiff: maxBox,
    maxScoreDrift: scoreDrift,
    rows,
  };
}

/* ------------------------------------------------------------------ 绘制 */

function drawResult(canvas, img, items) {
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  ctx.lineWidth = 2;
  ctx.font = "13px ui-monospace, Consolas, monospace";
  ctx.textBaseline = "bottom";

  items.forEach((it, i) => {
    const r = rectOf(it.box);
    ctx.strokeStyle = "#e2453c";
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    const tag = `${i + 1}`;
    const tw = ctx.measureText(tag).width + 8;
    ctx.fillStyle = "#e2453c";
    ctx.fillRect(r.x, r.y - 17, tw, 17);
    ctx.fillStyle = "#fff";
    ctx.fillText(tag, r.x + 4, r.y - 3);
  });
}

/* ------------------------------------------------------------------ 渲染 */

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");

function renderReport(c) {
  const s = $("#summary");
  s.innerHTML = `
    <div>框数 <b>${c.predCount}</b> / 基线 <b>${c.baseCount}</b>
      ${c.countSame ? '<span class="pill ok">一致</span>' : '<span class="pill bad">不一致</span>'}</div>
    <div>文本相同 <b>${c.textOk}/${c.textTotal}</b>
      ${c.allTextSame ? '<span class="pill ok">全对</span>' : '<span class="pill bad">有差异</span>'}</div>
    <div>坐标最大偏差 <b>${fmt(c.maxBoxDiff, 1)}</b> px</div>
    <div>置信度最大偏差 <b>${fmt(c.maxScoreDrift, 4)}</b></div>`;

  const rows = c.rows.map((r) => `
    <tr>
      <td class="num">${r.i + 1}</td>
      <td>${escapeHtml(r.baseText)}</td>
      <td class="${r.same ? "ok" : "bad"}">${escapeHtml(r.predText)}</td>
      <td class="num">${r.predRect ? `${r.predRect.x},${r.predRect.y} ${r.predRect.w}×${r.predRect.h}` : "—"}</td>
      <td class="num ${r.boxDiff > 3 ? "warn" : ""}">${fmt(r.boxDiff, 1)}</td>
      <td class="num">${r.baseScore !== null ? r.baseScore.toFixed(4) : "—"}<br>${r.predScore !== null ? r.predScore.toFixed(4) : "—"}</td>
    </tr>`).join("");

  $("#report").innerHTML = `
    <table>
      <thead><tr><th>#</th><th>Python 基线</th><th>浏览器端</th><th>浏览器坐标 x,y w×h</th><th>Δ坐标</th><th>分数 基线/浏览器</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
}

/* ------------------------------------------------------------------ 主流程 */

let engine = null;

async function run() {
  const url = $("#imgSel").value;
  const baseStem = url.split("/").pop().replace(/\.\w+$/, "");

  $("#run").disabled = true;
  const result = { ok: false, url, baseStem, error: null };

  try {
    const t0 = performance.now();
    const img = await loadImage(url);
    const imageData = await toImageData(img);

    if (!engine) throw new Error("引擎未就绪");

    const bgr = imageDataToBgrMat(engine.cv, imageData);
    const t1 = performance.now();
    const out = await engine.run(bgr);
    const t2 = performance.now();
    bgr.delete();

    drawResult($("#preview"), img, out.items);

    const base = await fetch(`baseline/${baseStem}.json`).then((r) => r.json());
    const cmp = compare(out.items, base.rapidocr);
    renderReport(cmp);

    $("#timing").textContent =
      `图片 ${imageData.width}×${imageData.height} · 识别耗时 ${(t2 - t1).toFixed(0)} ms · 合计 ${(t2 - t0).toFixed(0)} ms`;

    result.ok = true;
    result.elapsedMs = { recognize: Math.round(t2 - t1), total: Math.round(t2 - t0) };
    result.pred = out.items.map((it) => ({ text: it.text, score: it.score, rect: rectOf(it.box) }));
    result.compare = {
      baseCount: cmp.baseCount, predCount: cmp.predCount,
      textOk: cmp.textOk, textTotal: cmp.textTotal,
      allTextSame: cmp.allTextSame, maxBoxDiff: Number(cmp.maxBoxDiff.toFixed(2)),
      maxScoreDrift: Number(cmp.maxScoreDrift.toFixed(4)),
    };
    setStatus(`完成 · 文本 ${cmp.textOk}/${cmp.textTotal} 一致`);
  } catch (err) {
    console.error(err);
    result.error = String(err && err.stack ? err.stack : err);
    $("#report").innerHTML = `<div class="err">${escapeHtml(result.error)}</div>`;
    setStatus("失败");
  } finally {
    $("#run").disabled = false;
    window.__POC_RESULT__ = result;
  }
  return result;
}

async function boot() {
  try {
    setStatus("加载 opencv.js…");
    const cv = await waitOpenCV();

    setStatus("加载 onnxruntime-web…");
    const ort = await waitOrt();
    // 浏览器里 ort 用动态 import() 加载 wasm glue，必须是可解析的绝对 URL，
    // 不能是裸路径 "vendor/"（Node 下无此限制，只有真浏览器会暴露）。
    ort.env.wasm.wasmPaths = new URL("vendor/", document.baseURI).href;
    ort.env.wasm.numThreads = self.crossOriginIsolated
      ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    ort.env.logLevel = "error";

    setStatus("初始化引擎（首次需下载 14MB 模型）…");
    engine = await OcrEngine.create(ort, cv, { base: ".", onProgress: setStatus });

    setStatus("就绪");
    $("#run").disabled = false;
    $("#run").addEventListener("click", run);

    const auto = new URLSearchParams(location.search).get("auto") === "1";
    if (auto || $("#autoRun").checked) await run();
  } catch (err) {
    console.error(err);
    setStatus("初始化失败");
    $("#report").innerHTML = `<div class="err">${escapeHtml(String(err && err.message || err))}</div>`;
    window.__POC_RESULT__ = { ok: false, error: String(err && err.stack || err) };
  }
}

boot();
