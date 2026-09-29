// WB-PS · Cloudflare Workers 入口
//
// 请求分流顺序：
//   OPTIONS 预检 → 健康/自检 → 后台 /api/admin/* → 生成 /api/image/*
//   → 页面路由 → 静态资源
//
// 注意这里**没有**「无痕改字」的接口了。改字全流程（识别→样式→擦除→重绘）
// 已经搬到浏览器端跑：模型与运行时作为 /assets/ 下的静态资源下发，
// 由 Service Worker 缓存在用户浏览器里，网页直接调用本地缓存推理。
// 因此 Worker 只剩两件事：托管静态资源、代理图片生成（key 必须留在服务端）。

import { json, errorResponse, corsHeaders } from "./resp.js";
import { handleAdmin } from "./routes/admin.js";
import { handleImage } from "./routes/image.js";
import * as providers from "./providers.js";

// 裸路径 → 静态页面。
//
// 注意 "/image"：无痕改字与图像生成已经合并到同一个页面（/）里，靠 hash 切视图，
// 所以 /image 退化成兼容入口 —— 老书签、老链接进来要还能用，直接跳到 /#create。
const PAGE_MAP = {
  "/": "/static/index.html",
  "/admin": "/static/admin.html",
};

// 兼容入口：老地址 → 主页面上的默认视图锚点。
// 值只用来兜底（用户没带 fragment 时用），真实锚点由浏览器端跳转时带上。
const LEGACY_PAGE = {
  "/image": "#create",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(env.FRONTEND_ORIGIN || "*"),
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    try {
      // 首次运行时把 KV 结构建起来（幂等）
      ctx.waitUntil(providers.ensureSeed(env.KV).catch(() => {}));

      if (path === "/api/cf/health") {
        const status = await providers.publicStatus(env.KV);
        return json({
          ok: true,
          runtime: "cloudflare-workers",
          // 改字不再依赖服务端：模型缓存在浏览器，本地 WASM 推理
          ocr_backend: "browser-wasm",
          image_ready: status.ready,
          image_model: status.model,
          version: "2.0.0-cf",
        });
      }

      let resp = await handleAdmin(request, env, path, ctx);
      if (resp) return finalize(resp, env);

      resp = await handleImage(request, env, path);
      if (resp) return finalize(resp, env);

      // 兼容入口：/image 已并入主页面 /
      //
      // 为什么不用 302：**fragment（#projects 这类）不会发给服务端**，
      // 302 时无从得知用户原本想去哪个工具，只能盲目跳到 #create，
      // 老书签（/image#projects）就会丢锚点。
      //
      // 所以这里返回一个极小 HTML，让**浏览器端**做跳转 ——
      // 此刻 location.hash 仍然在手上，锚点能完整带过去。
      // 用 replace 而非赋值：不留多余的历史记录，免得"后退"被卡住。
      if (LEGACY_PAGE[path]) {
        const html = `<!DOCTYPE html><meta charset="utf-8">
<title>正在跳转…</title>
<script>
(function () {
  var h = location.hash && location.hash !== "#" ? location.hash : "${LEGACY_PAGE[path]}";
  location.replace(${JSON.stringify(url.origin + "/")} + h);
})();
<\/script>
<noscript><a href="/">图片工具</a></noscript>`;
        return finalize(new Response(html, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        }), env);
      }

      // 页面路由
      const page = PAGE_MAP[path];
      if (page) {
        const u = new URL(request.url);
        u.pathname = page;
        return finalize(await env.ASSETS.fetch(new Request(u, request)), env);
      }

      // 其余一律回落到静态资源（含 /assets/ 下的模型与运行时）
      return finalize(await env.ASSETS.fetch(request), env, path);
    } catch (err) {
      return finalize(errorResponse(err), env);
    }
  },
};

// 所有出口统一收口：补 CORS + 安全头。
// 抽出来是因为静态资源（ASSETS 直出）默认不带这些头，页面与 API 应当一致，
// 也免得每个路由各处理一遍。
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "SAMEORIGIN",
};

function finalize(resp, env, path) {
  const out = new Response(resp.body, resp);
  for (const [k, v] of Object.entries(corsHeaders(env.FRONTEND_ORIGIN || "*"))) {
    out.headers.set(k, v);
  }
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!out.headers.has(k)) out.headers.set(k, v);
  }

  // 模型与运行时是内容稳定的大文件（39MB）。
  // 给 immutable 让浏览器 HTTP 缓存也生效，与 Service Worker 缓存叠加；
  // 真要换版本时改 sw.js 里的 VERSION 即可（那边有一套自己的淘汰逻辑）。
  if (path && path.startsWith("/assets/")) {
    out.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }
  return out;
}
