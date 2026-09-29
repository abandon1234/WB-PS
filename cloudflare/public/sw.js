/* ==========================================================================
   WB-PS · Service Worker —— 模型与运行时缓存

   职责单一：把 /assets/ 下的模型、wasm、字体缓存进浏览器，
   让页面第二次打开时直接从本地读，完全不碰网络。

   为什么是 Cache Storage 而不是 IndexedDB
   ---------------------------------------
   onnxruntime-web 从 URL 加载模型（InferenceSession.create('/assets/models/x.onnx')），
   由运行时自己发 fetch。用 SW 在中间拦一道，那行代码一个字都不用改。
   走 IndexedDB 的话得先把 11MB 的识别模型整块读成 ArrayBuffer 再喂进去，
   凭空多一次全量内存拷贝，而且版本管理、并发、清理全得自己写。

   所以这里的分工是：
     SW       → 管「字节怎么存、怎么取」（浏览器原生，不吃 JS 堆）
     manifest → 管「该有哪些、版本对不对」（modelstore.js 读它）
   ========================================================================== */

const VERSION = '1';
const CACHE_NAME = `wb-ps-assets-v${VERSION}`;

// 只接管这些前缀的请求，其余（页面、API、图片生成）一概放行，
// 免得把接口响应也缓存了 —— 那是线上事故的常见来源。
const MANAGED_PREFIXES = ['/assets/'];

// 安装时顺手取的小文件：字典 45KB、清单几 KB，省一次往返
const PRELOAD = ['/assets/manifest.json', '/assets/char_dict.json'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(PRELOAD.map(async (url) => {
      try {
        // cache: 'reload' 绕开 HTTP 缓存，确保拿到的是服务端当前版本
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (_) { /* 缺文件不该让安装失败 */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 版本号变了就清掉旧桶：VERSION 一改，所有模型重新取一遍
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith('wb-ps-assets-') && k !== CACHE_NAME)
          .map((k) => caches.delete(k)),
    );
    await self.clients.claim();
  })());
});

function isManaged(url) {
  return MANAGED_PREFIXES.some((p) => url.pathname.startsWith(p));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 跨域不碰
  if (!isManaged(url)) return;                       // 非 assets 不碰

  event.respondWith(cacheFirst(event, req));
});

/* 缓存优先：
   - 命中 → 直接回，0 网络
   - 未命中 → 回源，成功后写进缓存

   写缓存的 clone() 必须在返回前同步完成，写入动作本身挂到 waitUntil ——
   否则页面读完就跳转，写入会被当成"无主任务"掐掉，模型下次还得重下。 */
async function cacheFirst(event, req) {
  const cache = await caches.open(CACHE_NAME);

  const hit = await cache.match(req);
  if (hit) return hit;

  let resp;
  try {
    resp = await fetch(req);
  } catch (err) {
    // 断网且没缓存：给出可读的错误，而不是让页面收到一个莫名的 TypeError
    return new Response(`离线且未缓存：${new URL(req.url).pathname}`, {
      status: 504,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  if (resp && resp.ok && resp.status === 200 && resp.type !== 'opaque') {
    const copy = resp.clone();
    event.waitUntil(cache.put(req, copy).catch(() => {}));
  }
  return resp;
}

/* 页面可以通过 postMessage 指挥 SW：
   - SKIP_WAITING：立刻接管，不等旧页面关掉
   - CLEAR：清掉资源缓存（「清除模型缓存」按钮走这里） */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'CLEAR') {
    event.waitUntil((async () => {
      await caches.delete(CACHE_NAME);
      if (event.source) event.source.postMessage({ type: 'CLEARED' });
    })());
  }
});
