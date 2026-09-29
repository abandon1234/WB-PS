/**
 * 本地静态服务器（仅用于 PoC 验证）。
 * 根目录 = 项目根，页面地址 http://127.0.0.1:8777/wasm-poc/
 *
 * 加 COOP/COEP 头是为了让 SharedArrayBuffer 可用（onnxruntime 多线程所需）；
 * 全部资源同源，不会引发跨源加载问题。
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");          // 项目根
const PORT = Number(process.env.POC_PORT || 8777);
const HOST = "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname);
  let filePath = join(ROOT, normalize(urlPath).replace(/^([/\\])+/, ""));

  // 目录 → index.html
  try {
    const st = await stat(filePath);
    if (st.isDirectory()) filePath = join(filePath, "index.html");
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`404 Not Found: ${urlPath}`);
    return;
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`500 ${err.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`PoC 服务器已启动`);
  console.log(`  根目录 : ${ROOT}`);
  console.log(`  页面   : http://${HOST}:${PORT}/wasm-poc/`);
  console.log(`  自动跑 : http://${HOST}:${PORT}/wasm-poc/?auto=1`);
});
