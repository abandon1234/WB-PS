// 后台管理路由，逐条对齐 app/image_gen/routes.py 的 /api/admin/*。
//
// 鉴权模型完全沿用 Python 版：
//   密码 → PBKDF2-SHA256(120k) 存哈希；会话 → HMAC 签名的 exp.sig 令牌，
//   塞进 HttpOnly + SameSite=Lax 的 Cookie（前端 JS 读不到，防 XSS 窃取）。
//
// ⚠️ 一个必须改的点：原版用进程内存 dict 做登录限速。Workers 的每个 isolate
// 内存互不相通，恶意重试换个 isolate 就清零了，所以限速状态挪到 KV（见 store.js）。

import { ApiError, json, adminCookie, expiredAdminCookie } from "../resp.js";
import {
  ADMIN, derive, issueToken, verifyToken, randomHex, constantTimeEqual, roundsSupported,
} from "../crypto.js";
import * as store from "../store.js";
import * as providers from "../providers.js";
import { ping } from "../gen.js";

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "local";
}

/**
 * 口令状态：
 *   empty  —— 还没设过密码
 *   legacy —— 有密码，但轮数超出 Workers 上限（从 Python 侧迁移过来的记录）。
 *             这种记录在 Workers 上**算不出来**，登录必然失败，只能重设。
 *   ready  —— 正常可用
 * 把 legacy 也当作"待设置"，前端就会直接给设置表单，而不是让人对着一个
 * "密码不正确"百思不得其解 —— 这个坑实测踩过（表现是登录 500）。
 */
async function pwState(env) {
  const a = await store.loadAdmin(env.KV);
  if (!a.password_hash) return "empty";
  return roundsSupported(a.rounds) ? "ready" : "legacy";
}

function legacyRoundsError(rounds) {
  return new ApiError(409, "旧口令无法在本运行时校验", {
    hint: `该口令由 ${rounds} 轮 PBKDF2 生成，超过 Cloudflare Workers 的 10 万轮上限，请重新设置管理密码`,
  });
}

/** 统一守卫：未初始化 409 / 未登录 401，与 Python 版 require_admin 一致 */
async function requireAdmin(request, env) {
  const st = await pwState(env);
  if (st === "empty") {
    throw new ApiError(409, "后台尚未初始化", { hint: "请先在后台页面设置管理密码" });
  }
  if (st === "legacy") {
    const { rounds } = await store.getPwHash(env.KV);
    throw legacyRoundsError(rounds);
  }
  const token = tokenFromRequest(request);
  const secret = await store.getSecret(env.KV);
  if (!(await verifyToken(secret, token))) {
    throw new ApiError(401, "未登录或登录已过期", { hint: "请重新登录后台" });
  }
}

function tokenFromRequest(request) {
  const cookies = request.headers.get("Cookie") || "";
  const hit = cookies.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${ADMIN.COOKIE_NAME}=`));
  // Cookie 优先；请求头兜底，方便命令行/脚本调用
  return hit ? hit.slice(ADMIN.COOKIE_NAME.length + 1) : request.headers.get("X-Admin-Token") || "";
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

/** 写扇出新令牌：Cookie 给浏览器，响应体也给一份给命令行用 */
async function loginResponse(env, message) {
  const secret = await store.getSecret(env.KV);
  const token = await issueToken(secret, ADMIN.SESSION_TTL);
  return json(
    { ok: true, message, token, expires_in: ADMIN.SESSION_TTL },
    200,
    { "Set-Cookie": adminCookie(token, ADMIN.SESSION_TTL) },
  );
}

export async function handleAdmin(request, env, path, ctx) {
  const method = request.method;

  // ---- 会话 / 口令 ----------------------------------------------------

  if (path === "/api/admin/status" && method === "GET") {
    const st = await pwState(env);
    const authed = st === "ready"
      && (await verifyToken(await store.getSecret(env.KV), tokenFromRequest(request)));
    return json({
      needs_setup: st !== "ready",
      legacy_password: st === "legacy",
      min_password_len: ADMIN.MIN_PASSWORD_LEN,
      session_hours: ADMIN.SESSION_TTL / 3600,
      authenticated: authed,
    });
  }

  if (path === "/api/admin/setup" && method === "POST") {
    if ((await pwState(env)) === "ready") {
      throw new ApiError(409, "后台已初始化", { hint: "如需重置，请在 Cloudflare Dashboard 删除 KV 里的 admin 键" });
    }
    const body = await readJson(request);
    const pw = String(body.password || "").trim();
    if (pw.length < ADMIN.MIN_PASSWORD_LEN) throw new ApiError(400, `密码至少 ${ADMIN.MIN_PASSWORD_LEN} 位`);
    if (pw.length > 128) throw new ApiError(400, "密码过长");

    const salt = randomHex(16);
    await store.setAdminSecret(env.KV, {
      passwordHash: await derive(pw, salt, ADMIN.PBKDF2_ROUNDS),
      salt,
      secret: randomHex(32),
      rounds: ADMIN.PBKDF2_ROUNDS,
    });
    return loginResponse(env, "初始化完成，已自动登录");
  }

  if (path === "/api/admin/login" && method === "POST") {
    const st = await pwState(env);
    if (st === "empty") throw new ApiError(409, "后台尚未初始化", { hint: "请先设置管理密码" });
    if (st === "legacy") {
      const { rounds } = await store.getPwHash(env.KV);
      throw legacyRoundsError(rounds);
    }
    const ip = clientIp(request);
    const { wait, left } = await store.failStats(env.KV, ip);
    if (wait) throw new ApiError(429, `尝试次数过多，请 ${wait} 秒后再试`);

    const body = await readJson(request);
    const { hash, salt, rounds } = await store.getPwHash(env.KV);
    if (hash && !roundsSupported(rounds)) throw legacyRoundsError(rounds);
    const calc = salt ? await derive(String(body.password || ""), salt, rounds) : "";
    if (!hash || !salt || !constantTimeEqual(calc, hash)) {
      await store.recordFail(env.KV, ip);
      const again = await store.failStats(env.KV, ip);
      throw new ApiError(401, "密码不正确", { hint: again.left ? `还可尝试 ${again.left} 次` : "已达上限，请稍后再试" });
    }
    await store.clearFails(env.KV, ip);
    return loginResponse(env, "登录成功");
  }

  if (path === "/api/admin/logout" && method === "POST") {
    return json({ ok: true, message: "已退出登录" }, 200, { "Set-Cookie": expiredAdminCookie() });
  }

  if (path === "/api/admin/password" && method === "POST") {
    await requireAdmin(request, env);
    const body = await readJson(request);
    const { hash, salt, rounds } = await store.getPwHash(env.KV);
    if (hash && !roundsSupported(rounds)) throw legacyRoundsError(rounds);
    const oldCalc = salt ? await derive(String(body.old_password || ""), salt, rounds) : "";
    if (!hash || !constantTimeEqual(oldCalc, hash)) throw new ApiError(400, "当前密码不正确");

    const npw = String(body.new_password || "").trim();
    if (npw.length < ADMIN.MIN_PASSWORD_LEN) throw new ApiError(400, `密码至少 ${ADMIN.MIN_PASSWORD_LEN} 位`);
    if (npw.length > 128) throw new ApiError(400, "密码过长");

    const newSalt = randomHex(16);
    // 轮换 secret：改密码后旧令牌全部失效
    await store.setAdminSecret(env.KV, {
      passwordHash: await derive(npw, newSalt, ADMIN.PBKDF2_ROUNDS),
      salt: newSalt,
      secret: randomHex(32),
      rounds: ADMIN.PBKDF2_ROUNDS,
    });
    return loginResponse(env, "密码已更新，请在其他设备重新登录");
  }

  // ---- 中转站配置 ------------------------------------------------------

  if (path === "/api/admin/providers" && method === "GET") {
    await requireAdmin(request, env);
    const active = await store.activeProvider(env.KV);
    return json({
      providers: await providers.listProviders(env.KV, false),
      active_id: active ? active.id : null,
      default_model: providers.DEFAULT_MODEL,
      sizes: providers.ALLOWED_SIZES,
    });
  }

  if (path === "/api/admin/providers" && method === "POST") {
    await requireAdmin(request, env);
    const body = await readJson(request);
    const item = await providers.addProvider(env.KV, body);
    return json({ provider: providers.publicView(item), providers: await providers.listProviders(env.KV, false) });
  }

  let m = path.match(/^\/api\/admin\/providers\/([^/]+)$/);
  if (m) {
    const pid = m[1];
    if (method === "PUT") {
      await requireAdmin(request, env);
      const body = await readJson(request);
      const item = await providers.updateProvider(env.KV, pid, body);
      return json({ provider: providers.publicView(item), providers: await providers.listProviders(env.KV, false) });
    }
    if (method === "DELETE") {
      await requireAdmin(request, env);
      if (!(await providers.deleteProvider(env.KV, pid))) throw new ApiError(404, "配置不存在");
      const active = await store.activeProvider(env.KV);
      return json({
        deleted: pid,
        providers: await providers.listProviders(env.KV, false),
        active_id: active ? active.id : null,
      });
    }
  }

  m = path.match(/^\/api\/admin\/providers\/([^/]+)\/(toggle|activate|test)$/);
  if (m) {
    const [, pid, action] = m;
    await requireAdmin(request, env);
    if (action === "toggle") {
      const raw = await providers.getProviderRaw(env.KV, pid);
      if (!raw) throw new ApiError(404, "配置不存在");
      const body = request.method === "POST" ? await readJson(request) : {};
      const enabled = body.enabled == null ? !raw.enabled : !!body.enabled;
      const item = await providers.setEnabled(env.KV, pid, enabled);
      const active = await store.activeProvider(env.KV);
      return json({
        provider: providers.publicView(item),
        providers: await providers.listProviders(env.KV, false),
        active_id: active ? active.id : null,
      });
    }
    if (action === "activate") {
      const item = await providers.setActive(env.KV, pid);
      return json({ active_id: item.id, providers: await providers.listProviders(env.KV, false) });
    }
    if (action === "test") {
      const raw = await providers.getProviderRaw(env.KV, pid);
      if (!raw) throw new ApiError(404, "配置不存在");
      try {
        return json({ result: await ping(raw, 30) });
      } catch (err) {
        if (err && err.toDict) {
          const d = err.toDict();
          throw new ApiError(typeof d.status === "number" && d.status >= 400 ? d.status : 400, d.message, { hint: d.hint, detail: d.detail });
        }
        throw err;
      }
    }
  }

  // ---- 概览 ------------------------------------------------------------

  if (path === "/api/admin/system" && method === "GET") {
    await requireAdmin(request, env);
    const list = await providers.listProviders(env.KV, false);
    const active = await store.activeProvider(env.KV);
    return json({
      provider_count: list.length,
      enabled_count: list.filter((p) => p.enabled).length,
      active_name: active ? active.name : null,
      active_model: active ? active.model : null,
      config_file: "cloudflare-kv:providers",
      data_dir_exists: true,
      stores_generated_images: false,
      runtime: "cloudflare-workers",
    });
  }

  return null; // 未匹配，交给调用方继续走其他路由
}
