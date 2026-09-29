/**
 * 本地开发服务器（纯静态，零依赖）。
 *
 * 与生产环境的差别只有一个：这里用 Node 起静态文件，
 * 线上是 Cloudflare 静态资源。响应头刻意对齐，避免"本地好好的、线上炸"。
 *
 * 两个 MIME 是硬要求，配错必然出问题：
 *   .wasm → application/wasm   （否则 ort 用不了流式编译）
 *   .mjs  → text/javascript    （否则动态 import 直接失败）
 *
 *   node tools/serve_dev.mjs [--port 8777]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB = path.join(ROOT, 'web');

const arg = process.argv.indexOf('--port');
const PORT = arg > -1 ? Number(process.argv[arg + 1]) : 8777;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/** 目录挂载表：URL 前缀 → 磁盘目录。顺序即优先级。 */
const MOUNTS = [
  ['/samples/', path.join(ROOT, 'samples')],
  ['/assets/', path.join(WEB, 'assets')],
  // 页面里引用的是 /static/xxx.js，与线上（Cloudflare public/static/）保持同一结构
  ['/static/', WEB],
  ['/', WEB],
];

function resolveFile(pathname) {
  const clean = decodeURIComponent(pathname.split('?')[0]);
  for (const [prefix, dir] of MOUNTS) {
    if (clean.startsWith(prefix)) {
      const rel = clean.slice(prefix.length);
      const abs = path.join(dir, rel);
      // 防目录穿越
      if (!abs.startsWith(dir)) continue;
      if (existsSync(abs)) {
        try {
          if (stat) return { abs, prefix };
        } catch (_) { /* 继续找下一个挂载点 */ }
      }
      if (rel === '' || rel.endsWith('/')) {
        const idx = path.join(dir, rel, 'index.html');
        if (existsSync(idx)) return { abs: idx, prefix };
      }
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = url.pathname;

  // 首页指向真实的改字页（自检页仍可直接访问 /engine-test.html）
  if (pathname === '/') pathname = '/index.html';

  const hit = resolveFile(pathname);
  if (!hit) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404 ${pathname}`);
    return;
  }

  let info;
  try {
    info = await stat(hit.abs);
    if (info.isDirectory()) throw new Error('is dir');
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404 ${pathname}`);
    return;
  }

  const ext = path.extname(hit.abs).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': info.size,
    'X-Content-Type-Options': 'nosniff',
  };

  // /assets/ 走长缓存 + immutable（与线上一致，让 HTTP 缓存与 SW 缓存叠加生效）；
  // 其余一律 no-store，避免改完代码刷新看不到变化。
  headers['Cache-Control'] = pathname.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-store';

  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }

  try {
    res.end(await readFile(hit.abs));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`500 ${err.message}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`WB-PS 开发服务器  →  http://127.0.0.1:${PORT}/`);
  console.log(`  自检页           →  http://127.0.0.1:${PORT}/engine-test.html`);
  console.log(`  资源挂载         →  /assets/ · /samples/ · web/`);
});
