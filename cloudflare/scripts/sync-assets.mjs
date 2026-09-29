// 把 ../web 同步到 ./public
//
// 与旧版的区别（改字迁到浏览器端之后必须同步的东西变多了）：
//   /static/**  ← web/ 下的页面与脚本，含 engine/ 子目录（递归）
//   /sw.js      ← Service Worker，必须在**根作用域**才能接管 /assets/
//   /assets/**  ← 模型 + 运行时 + 字体（约 40MB），浏览器缓存的就是这些
//
// 页面里引用的是 /static/xxx.js，正好对应这里 public/static/ 的结构。

import { readdir, mkdir, rm, copyFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "..", "web");
const OUT = path.join(root, "public");

const KEEP = new Set([".html", ".css", ".js", ".mjs", ".svg", ".png", ".ico", ".webmanifest"]);

// 内部诊断页，不对外发布（它会把缓存状态、模型清单、日志都摊开给人看）
const EXCLUDE = new Set(["engine-test.html"]);

const bytes = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

async function copyTree(from, to, { filter, acc = { files: 0, bytes: 0 } } = {}) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyTree(src, dst, { filter, acc });
    } else if (entry.isFile()) {
      if (filter && !filter(entry.name)) continue;
      await copyFile(src, dst);
      acc.files++;
      acc.bytes += (await stat(dst)).size;
    }
  }
  return acc;
}

async function main() {
  if (!existsSync(SRC)) {
    console.error(`源目录不存在：${SRC}`);
    process.exit(1);
  }

  const withAssets = !process.argv.includes("--no-assets");

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // 1) 页面与脚本 → public/static/（递归，engine/ 子目录一并带上）
  const skip = new Set(["assets", "sw.js"]);
  const statAcc = { files: 0, bytes: 0 };
  await mkdir(path.join(OUT, "static"), { recursive: true });
  for (const entry of await readdir(SRC, { withFileTypes: true })) {
    if (skip.has(entry.name) || EXCLUDE.has(entry.name)) continue;
    const src = path.join(SRC, entry.name);
    const dst = path.join(OUT, "static", entry.name);
    if (entry.isDirectory()) {
      await copyTree(src, dst, { filter: (n) => KEEP.has(path.extname(n).toLowerCase()), acc: statAcc });
    } else if (KEEP.has(path.extname(entry.name).toLowerCase())) {
      await copyFile(src, dst);
      statAcc.files++;
      statAcc.bytes += (await stat(dst)).size;
    }
  }
  console.log(`页面与脚本 → public/static/    ${statAcc.files} 个文件，${bytes(statAcc.bytes)}`);

  // 2) Service Worker → public/sw.js（根作用域）
  const sw = path.join(SRC, "sw.js");
  if (existsSync(sw)) {
    await copyFile(sw, path.join(OUT, "sw.js"));
    console.log("Service Worker → public/sw.js");
  }

  // 3) 模型与运行时 → public/assets/
  const assets = path.join(SRC, "assets");
  if (!existsSync(assets)) {
    console.warn("web/assets/ 不存在 —— 先跑 node tools/gen_assets_manifest.mjs");
  } else if (!withAssets) {
    console.warn("已跳过 assets（--no-assets）：线上将没有模型，改字无法本地运行");
  } else {
    const acc = await copyTree(assets, path.join(OUT, "assets"));
    console.log(`模型与运行时 → public/assets/    ${acc.files} 个文件，${bytes(acc.bytes)}`);
    console.log("  （约 40MB，部署时会上传；浏览器侧由 Service Worker 缓存，只下一次）");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
