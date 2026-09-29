/**
 * 生成 web/assets/manifest.json —— 浏览器端「该有哪些资源」的唯一出处。
 *
 * 扫描 web/assets/ 下的模型、运行时、字体与字典，算大小与 sha256，
 * 并把 sw.js 里的 VERSION 抠出来写进清单 —— 这样「缓存桶名」和
 * 「清单版本」不会各说各话（两处手写版本号迟早会对不上）。
 *
 *   node tools/gen_assets_manifest.mjs
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ASSETS = path.join(ROOT, 'web', 'assets');
const SW = path.join(ROOT, 'web', 'sw.js');
const OUT = path.join(ASSETS, 'manifest.json');

/** 每档资源的说明与优先级。core 先下（页面能早点动），model/font 随后。 */
const KNOWN = {
  'char_dict.json': { kind: 'core', label: '识别字典' },
  'vendor/opencv.js': { kind: 'core', label: 'OpenCV 运行时' },
  'vendor/ort.wasm.min.js': { kind: 'core', label: 'ONNX Runtime' },
  'vendor/ort-wasm-simd-threaded.mjs': { kind: 'core', label: 'ONNX Runtime glue' },
  'vendor/ort-wasm-simd-threaded.wasm': { kind: 'core', label: 'ONNX Runtime WASM' },
  'models/ch_PP-OCRv3_det_infer.onnx': { kind: 'model', label: '文字检测模型' },
  'models/ch_ppocr_mobile_v2.0_cls_infer.onnx': { kind: 'model', label: '方向分类模型' },
  'models/ch_PP-OCRv3_rec_infer.onnx': { kind: 'model', label: '文字识别模型' },
};

function classify(rel) {
  if (KNOWN[rel]) return KNOWN[rel];
  if (rel.startsWith('fonts/')) {
    return { kind: 'font', label: `字体 ${path.basename(rel, path.extname(rel))}` };
  }
  if (rel.startsWith('models/')) return { kind: 'model', label: path.basename(rel) };
  return { kind: 'core', label: path.basename(rel) };
}

async function walk(dir, prefix = '') {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(abs, rel));
    else if (entry.isFile()) {
      if (entry.name === 'manifest.json') continue;   // 自己不算资源
      out.push({ rel, abs });
    }
  }
  return out;
}

async function readSwVersion() {
  try {
    const src = await readFile(SW, 'utf8');
    const m = src.match(/const\s+VERSION\s*=\s*['"]([^'"]+)['"]/);
    return m ? m[1] : '1';
  } catch (_) {
    return '1';
  }
}

async function main() {
  if (!existsSync(ASSETS)) {
    console.error(`资源目录不存在：${ASSETS}`);
    process.exit(1);
  }

  const found = await walk(ASSETS);
  if (!found.length) {
    console.error('web/assets/ 是空的 —— 先跑 npm run assets:vendor 收拢模型与运行时');
    process.exit(1);
  }

  const files = [];
  let totalBytes = 0;

  for (const { rel, abs } of found.sort((a, b) => a.rel.localeCompare(b.rel))) {
    const buf = await readFile(abs);
    const { size } = await stat(abs);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const meta = classify(rel);
    files.push({
      path: `/assets/${rel}`,
      bytes: size,
      sha256,
      kind: meta.kind,
      label: meta.label,
    });
    totalBytes += size;
    console.log(`  ${meta.kind.padEnd(6)} ${rel.padEnd(44)} ${(size / 1024 / 1024).toFixed(2).padStart(7)} MB`);
  }

  const version = await readSwVersion();
  const manifest = {
    version,
    generatedAt: new Date().toISOString(),
    totalBytes,
    fileCount: files.length,
    files,
  };

  await writeFile(OUT, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`\nmanifest.json 已生成：${files.length} 个文件，合计 ${(totalBytes / 1024 / 1024).toFixed(2)} MB（version=${version}）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
