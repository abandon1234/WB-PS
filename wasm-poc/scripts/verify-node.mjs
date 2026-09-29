/**
 * Node 端验证：用与浏览器完全相同的 JS 实现跑一遍 OCR，跟 Python 基线逐框比对。
 *
 * 输入直接读 Python 导出的原始 BGR 字节，绕开图片解码，
 * 这样比对结果只反映「算法实现是否一致」，不掺杂解码器差异。
 *
 * 用法：cd wasm-poc && node scripts/verify-node.mjs [图片名]
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import * as ort from "onnxruntime-web";
import { OcrEngine } from "../src/engine.js";

const require = createRequire(import.meta.url);
const DIR = process.cwd();
const stem = (process.argv[2] || "test_card").replace(/\.\w+$/, "");

const B = (p) => resolve(DIR, p);

/* ------------------------------------------------------------------ 运行时 */

async function loadCv() {
  globalThis.self = globalThis;
  const mod = require(B("node_modules/@techstark/opencv-js/dist/opencv.js"));
  return await mod;                        // 该构建导出的是 Promise
}

/** 复刻 main.js 的比对逻辑，保持两侧口径一致 */
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

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  console.log(`\n=== 浏览器端 JS 实现 vs Python 基线 · ${stem} ===\n`);

  ort.env.wasm.wasmPaths = `file:///${DIR.replace(/\\/g, "/")}/node_modules/onnxruntime-web/dist/`;
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = "error";

  const cv = await loadCv();
  console.log(`opencv.js 就绪（cv.Mat=${typeof cv.Mat}）`);
  if (typeof cv.inpaint !== "function") {
    console.log("提示：cv.inpaint 不可用（本阶段未用到）");
  } else {
    console.log("cv.inpaint 可用");
  }

  const charList = JSON.parse(readFileSync(B("baseline/char_dict.json"), "utf8"));
  const engine = await OcrEngine.create(ort, cv, {
    base: ".",
    charList,
    onProgress: (m) => console.log(`  ${m}`),
  });

  const meta = JSON.parse(readFileSync(B(`baseline/${stem}.meta.json`), "utf8"));
  const raw = readFileSync(B(`baseline/${stem}.bgr`));
  const mat = new cv.Mat(meta.h, meta.w, cv.CV_8UC3);
  mat.data.set(raw);
  console.log(`输入 ${meta.w}×${meta.h}，${raw.length} 字节 BGR\n`);

  const t0 = Date.now();
  const out = await engine.run(mat);
  const ms = Date.now() - t0;
  mat.delete();

  const baseFile = process.argv.includes("--geom")
    ? `baseline/${stem}_geom.json` : `baseline/${stem}.json`;
  const base = JSON.parse(readFileSync(B(baseFile), "utf8")).rapidocr;
  const pred = out.items;

  /* ---- 比对 ---- */
  const n = Math.max(pred.length, base.length);
  console.log(`框数: JS ${pred.length} / Python ${base.length}`);
  console.log(`耗时: ${ms} ms\n`);

  const hdr = ["#", "Python 文本", "JS 文本", "一致", "Δ坐标", "rect(JS)"];
  const rows = [];
  let textOk = 0;
  let maxBox = 0;

  for (let i = 0; i < n; i++) {
    const p = pred[i];
    const b = base[i];
    const same = !!(p && b && p.text === b.text);
    if (same) textOk++;
    const d = p && b ? boxMaxDiff(p.box, b.box) : NaN;
    if (Number.isFinite(d)) maxBox = Math.max(maxBox, d);
    const r = p ? rectOf(p.box) : null;
    rows.push([
      String(i + 1),
      b ? b.text : "—",
      p ? p.text : "—",
      same ? "Y" : "N",
      Number.isFinite(d) ? d.toFixed(1) : "—",
      r ? `${r.x},${r.y} ${r.w}×${r.h}` : "—",
    ]);
  }

  const w = [3, 26, 26, 4, 7, 18];
  const line = (cells) => cells.map((c, k) => pad(c, w[k])).join(" | ");
  console.log(line(hdr));
  console.log(w.map((x) => "-".repeat(x)).join("-+-"));

  const onlyDiff = process.argv.includes("--diff");
  const shown = rows.filter((r) => !onlyDiff || r[3] === "N");
  shown.forEach((r) => console.log(line(r)));
  if (onlyDiff && shown.length === 0) console.log("(无差异)");

  // 差异分类：文本不同 vs 只是配对错位（文本在对方位置存在）
  const textSet = new Set(base.map((b) => b.text));
  const realTextMiss = [];
  const misplaced = [];
  rows.filter((r) => r[3] === "N").forEach((r) => {
    const predText = r[2];
    (textSet.has(predText) ? misplaced : realTextMiss).push(r);
  });

  const diffs = rows.map((r) => Number(r[4])).filter(Number.isFinite).sort((a, b) => a - b);
  const med = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 0;

  console.log("");
  console.log(`文本一致: ${textOk}/${n}`);
  console.log(`坐标偏差: 中位数 ${med.toFixed(1)} px / 最大 ${maxBox.toFixed(2)} px`);
  console.log(`差异分类: 顺序错位 ${misplaced.length} 项 / 识别文本不同 ${realTextMiss.length} 项`);
  if (realTextMiss.length) {
    console.log("\n识别文本不同的项：");
    realTextMiss.forEach((r) => console.log(`  #${r[0]}  Python「${r[1]}」  JS「${r[2]}」`));
  }

  const scoreDrift = pred.reduce((m, p, i) => {
    const b = base[i];
    return b ? Math.max(m, Math.abs(p.score - b.score)) : m;
  }, 0);
  console.log(`置信度最大偏差: ${scoreDrift.toFixed(4)}`);
  console.log(`\n结论: ${textOk === n && pred.length === base.length ? "✅ 与 Python 端一致" : "❌ 存在差异，需排查"}\n`);

  process.exit(0);
}

function pad(s, n) {
  const str = String(s);
  let len = 0;
  for (const ch of str) len += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return str + " ".repeat(Math.max(0, n - len));
}

main().catch((e) => {
  console.error("运行失败:", e);
  process.exit(1);
});
