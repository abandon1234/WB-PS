// 统一响应工具。
//
// ⚠️ 本项目里错误体的 detail 有**两种形状**，按模块区分，别改错：
//   - 图像生成（app/image_gen/routes.py）：detail 是对象 {message, hint, detail}
//   - 无痕改字（app/main.py 用 HTTPException(503, str(exc))）：detail 是**字符串**
// 前端 web/image.js 与 web/app.js 分别按对应形状消费。
// ApiError 走的是前者（对象形状）。无痕改字已迁到浏览器端本地推理，不再有服务端降级响应。

import { ADMIN } from "./crypto.js";

const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // 用 SAMEORIGIN 而非 DENY：够防点击劫持，又不妨碍同源 iframe 场景
  "X-Frame-Options": "SAMEORIGIN",
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...BASE_HEADERS, ...extraHeaders },
  });
}

/** 业务错误。shape 对齐 FastAPI 的 {"detail": {message, hint, detail}} */
export class ApiError extends Error {
  constructor(status, message, { hint = "", detail = "" } = {}) {
    super(message);
    this.status = status;
    this.payload = { message, hint, detail };
  }
}

export function fail(status, message, opt) {
  return new ApiError(status, message, opt);
}

/** 把 ApiError 渲染成 FastAPI 同款响应体 */
export function errorResponse(err) {
  if (err instanceof ApiError) return json({ detail: err.payload }, err.status);
  return json({ detail: { message: "服务端内部错误", hint: "", detail: String(err && err.message ? err.message : err) } }, 500);
}

export function corsHeaders(origin) {
  if (!origin || origin === "*") return { "Access-Control-Allow-Origin": "*" };
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}

export function adminCookie(token, maxAge) {
  return [
    `${ADMIN.COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

/** 退出登录：同名的空 Cookie + 立即过期 */
export function expiredAdminCookie() {
  return `${ADMIN.COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`; 
}
