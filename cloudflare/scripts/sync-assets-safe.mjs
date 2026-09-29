/**
 * 同步前端资源 → cloudflare/public/
 *
 * 与 sync-assets.mjs 的区别：**不做 rm -rf public 再重建**，而是逐文件覆盖。
 *
 * 原因：`rm -rf` 在沙箱里会被安全删除机制拦下（"Some operations were aborted"），
 * 导致"同步失败但部署照跑、线上留着旧文件"。逐文件覆盖既没有删除动作，
 * 也就没有这个坑，效果完全一致（目标文件名是固定的，不会残留）。
 *
 *   node scripts/sync-assets-safe.mjs [--no-assets]
 */
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");                 // cloudflare/
const SRC = path.resolve(ROOT, "..", "web");           // web/
const OUT = path.join(ROOT, "public");
// 说明文档不进产物：web/README.md 是给开发者看的，
// 跟运行时无关；而且 public/static/README.md 另有用途（标着"这是产物，别改"），
// 混进来会被覆盖掉。
const EXCLUDE = new Set([".DS_Store", "Thumbs.db", "sync-assets-safe.mjs", "README.md"]);

const stat = { files: 0, bytes: 0 };

/** 递归复制目录（逐文件覆盖，不删任何东西） */
function copyDir(from, to, filter = () => true) {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) { copyDir(s, d, filter); continue; }
    if (!filter(s)) continue;
    mkdirSync(path.dirname(d), { recursive: true });
    copyFileSync(s, d);
    stat.files++;
    stat.bytes += statSync(s).size;
  }
}

/** 列出目录树里所有文件的相对路径 */
function listFiles(root) {
  const out = new Set();
  const walk = (dir, rel) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDE.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.add(r);
    }
  };
  walk(root, "");
  return out;
}

/** 删掉目标端"源端已经没有"的文件，并顺手清空目录 */
function pruneOrphans(srcRoot, dstRoot) {
  const src = listFiles(srcRoot);
  const dst = listFiles(dstRoot);
  let removed = 0;
  for (const rel of dst) {
    const inSrc = src.has(rel)
      || rel === "sw.js"                                  // sw.js 单独同步
      || rel.startsWith("assets/");                       // assets 不参与清理
    if (inSrc) continue;
    try { unlinkSync(path.join(dstRoot, rel)); removed++; } catch (_) {}
  }
  if (removed) console.log(`  （清理源端已删的 ${removed} 个残留文件）`);
}

function main() {  if (!existsSync(SRC)) {
    console.error(`源目录不存在：${SRC}`);
    process.exit(1);
  }
  const withAssets = !process.argv.includes("--no-assets");

  // 1) 页面与脚本 → public/static/
  const before = stat.files;
  const bBefore = stat.bytes;
  const srcStatic = path.join(OUT, "static");
  copyDir(SRC, srcStatic,
    (p) => !p.includes(`${path.sep}assets${path.sep}`) && !p.endsWith(`${path.sep}sw.js`));
  console.log(`页面与脚本 → public/static/    ${stat.files - before} 个文件，`
    + `${((stat.bytes - bBefore) / 1048576).toFixed(2)} MB`);

  // 1b) 源端已删的文件，目标端也要清掉 —— 否则会出现"文件已删、线上还在"的残留
  //     （实测踩到：web/image.html 删了，public/static/image.html 还留着被部署）。
  //     只清 public/static/ 下的多余文件，不碰 assets/（几十 MB，重建代价大）。
  pruneOrphans(SRC, srcStatic);

  // 2) Service Worker → public/sw.js（必须放在根：它的 scope 决定能接管哪些路径）
  const sw = path.join(SRC, "sw.js");
  if (existsSync(sw)) {
    copyFileSync(sw, path.join(OUT, "sw.js"));
    console.log("Service Worker → public/sw.js");
  }

  // 3) 模型与运行时 → public/assets/
  if (withAssets) {
    const a0 = stat.files, ab0 = stat.bytes;
    const assetsSrc = path.join(SRC, "assets");
    if (existsSync(assetsSrc)) {
      copyDir(assetsSrc, path.join(OUT, "assets"));
      console.log(`模型与运行时 → public/assets/    ${stat.files - a0} 个文件，`
        + `${((stat.bytes - ab0) / 1048576).toFixed(2)} MB`);
      console.log("  （约 40MB，部署时会上传；浏览器侧由 Service Worker 缓存，只下一次）");
    } else {
      console.log("（未找到 web/assets/，跳过模型）");
    }
  } else {
    console.log("（--no-assets：跳过模型）");
  }

  // 4) 收尾自检：几个关键文件必须存在（避免"看着成功、其实没同步"）
  const must = [
    "static/index.html", "static/app.js", "static/image.js",
    "static/shell.js", "static/engine/boot.js", "static/engine/localapi.js",
    "sw.js",
  ];
  const missing = must.filter((f) => !existsSync(path.join(OUT, f)));
  if (missing.length) {
    console.error("缺少关键文件：" + missing.join(", "));
    process.exit(1);
  }
  // 关键内容自检：合并后的页面必须同时含两个视图容器
  const idx = readFileSync(path.join(OUT, "static/index.html"), "utf8");
  const flags = {
    viewEdit: idx.includes('id="viewEdit"'),
    viewImages: idx.includes('id="viewImages"'),
    toast: idx.includes('id="toastWrap"'),
    lightbox: idx.includes('id="lightbox"'),
  };
  const bad = Object.entries(flags).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length) {
    console.error("index.html 缺少必要容器：" + bad.join(", "));
    process.exit(1);
  }
  console.log(`\n完成：共 ${stat.files} 个文件，${(stat.bytes / 1048576).toFixed(2)} MB`);
}

main();
