/**
 * 把浏览器端运行时要用的产物收拢到 vendor/，避免页面直接引用 node_modules。
 * 只复制必需文件，跑完可整目录删除。
 */
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const VENDOR = join(ROOT, "vendor");

const FILES = [
  ["node_modules/@techstark/opencv-js/dist/opencv.js", "opencv.js"],
  ["node_modules/onnxruntime-web/dist/ort.wasm.min.js", "ort.wasm.min.js"],
  ["node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.mjs"],
  ["node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.wasm"],
];

mkdirSync(VENDOR, { recursive: true });

let ok = 0;
for (const [from, to] of FILES) {
  const src = join(ROOT, from);
  if (!existsSync(src)) {
    console.error(`  缺失: ${from}`);
    continue;
  }
  copyFileSync(src, join(VENDOR, to));
  const mb = (statSync(src).size / 1024 / 1024).toFixed(2);
  console.log(`  ${to.padEnd(34)} ${mb} MB`);
  ok++;
}

const total = FILES.reduce((n, [f]) => (existsSync(join(ROOT, f)) ? n + statSync(join(ROOT, f)).size : n), 0);
console.log(`\nvendor/ 就绪：${ok}/${FILES.length} 个文件，合计 ${(total / 1024 / 1024).toFixed(2)} MB`);
