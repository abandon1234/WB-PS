// 端到端测试：用真实 Request/Response 打进 Worker，覆盖后台鉴权、配置 CRUD、
// 生成接口、无痕改字降级四条链路。
//
// 跑法：node tests/e2e.test.mjs

import worker from "../src/index.js";

// ---------------------------------------------------------------- 环境替身

class MockKV {
  constructor() { this.m = new Map(); this.ttl = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v, opt) { this.m.set(k, v); if (opt && opt.expirationTtl) this.ttl.set(k, opt.expirationTtl); }
  async delete(k) { this.m.delete(k); }
}

function makeEnv() {
  return {
    KV: new MockKV(),
    ASSETS: { fetch: async (req) => new Response(`STATIC:${new URL(req.url).pathname}`, { status: 200 }) },
    FRONTEND_ORIGIN: "*",
    MAX_UPSTREAM_TIMEOUT: 60,
  };
}

const ctx = { waitUntil: () => {} };

const call = (env, path, init = {}) => worker.fetch(new Request(`https://worker.test${path}`, init), env, ctx);

const jsonBody = (obj) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  const tail = cond ? "" : `  ← ${typeof extra === "function" ? extra() : extra}`;
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${tail}`);
  cond ? pass++ : fail++;
}

// ---------------------------------------------------------------- 1. 自检

console.log("\n[1] 自检与健康检查");
{
  const env = makeEnv();
  const r = await call(env, "/api/cf/health");
  const j = await r.json();
  ok("/api/cf/health 返回 200", r.status === 200, r.status);
  ok("标注运行为 cloudflare-workers", j.runtime === "cloudflare-workers", j.runtime);
  ok("运行版本已升到 2.x", typeof j.version === "string" && j.version.startsWith("2."), String(j.version));
  ok("健康检查标记改字为浏览器端", j.ocr_backend === "browser-wasm", j.ocr_backend);
}

// ---------------------------------------------------------------- 2. 页面路由

console.log("\n[2] 页面路由与静态回源");
{
  const env = makeEnv();
  // 无痕改字与图像生成已合并进 index.html，只剩两个真实页面
  for (const [path, file] of [["/", "index.html"], ["/admin", "admin.html"]]) {
    const r = await call(env, path);
    const t = await r.text();
    ok(`${path} → /static/${file}`, t === `STATIC:/static/${file}`, t);
  }

  // /image 退化成兼容入口：不能只丢一个 302 —— fragment 不会发给服务端，
  // 302 会让老书签（/image#projects）丢掉锚点。所以是浏览器端跳转。
  const rImg = await call(env, "/image");
  const html = await rImg.text();
  ok("/image 返回跳转页而非裸重定向", rImg.status === 200, String(rImg.status));
  ok("/image 的跳转保住 fragment（用 location.hash）",
    /location\.hash/.test(html) && /location\.replace/.test(html),
    html.slice(0, 120).replace(/\s+/g, " "));

  const r = await call(env, "/static/app.js");
  ok("/static/* 直接回源", (await r.text()) === "STATIC:/static/app.js");
}

// ---------------------------------------------------------------- 3. 后台初始化

console.log("\n[3] 后台初始化与登录");
const env = makeEnv();
let cookie = "";
{
  const r = await call(env, "/api/admin/status");
  const j = await r.json();
  ok("初始状态 needs_setup = true", j.needs_setup === true);
  ok("初始状态 authenticated = false", j.authenticated === false);

  const weak = await call(env, "/api/admin/setup", jsonBody({ password: "123" }));
  ok("弱密码被拒绝（<6 位）", weak.status === 400, weak.status);

  const r2 = await call(env, "/api/admin/setup", jsonBody({ password: "abc123456" }));
  const j2 = await r2.json();
  ok("初始化成功", r2.status === 200 && j2.ok === true);
  cookie = (r2.headers.get("Set-Cookie") || "").split(";")[0];
  ok("下发 HttpOnly Cookie", /HttpOnly/i.test(r2.headers.get("Set-Cookie") || ""));
  ok("下发 SameSite=Lax", /SameSite=Lax/i.test(r2.headers.get("Set-Cookie") || ""));

  const dup = await call(env, "/api/admin/setup", jsonBody({ password: "abc123456" }));
  ok("重复初始化被拒绝 409", dup.status === 409, dup.status);

  const r3 = await call(env, "/api/admin/status", { headers: { Cookie: cookie } });
  const j3 = await r3.json();
  ok("带 Cookie 后 authenticated = true", j3.authenticated === true);

  const noAuth = await call(env, "/api/admin/providers");
  ok("未登录访问配置被拒绝 401", noAuth.status === 401, noAuth.status);
}

// ---------------------------------------------------------------- 4. 登录限速

console.log("\n[4] 登录失败限速");
{
  const e = makeEnv();
  await call(e, "/api/admin/setup", jsonBody({ password: "abc123456" }));
  const codes = [];
  for (let i = 0; i < 8; i++) {
    codes.push((await call(e, "/api/admin/login", jsonBody({ password: "wrongpass" }))).status);
  }
  ok("前几次为 401", codes.slice(0, 5).every((c) => c === 401), codes.join(","));
  ok("超过阈值后变为 429", codes.slice(5).some((c) => c === 429), codes.join(","));
}

// ---------------------------------------------------------------- 5. 配置 CRUD

console.log("\n[5] 中转站配置 CRUD");
let pid = "";
{
  const H = () => ({ Cookie: cookie });
  const bad = await call(env, "/api/admin/providers", { ...jsonBody({ name: "x", base_url: "ftp://nope", api_key: "k" }), headers: H() });
  ok("非法地址（非 http）被拒绝 400", bad.status === 400, bad.status);

  const noKey = await call(env, "/api/admin/providers", { ...jsonBody({ name: "x", base_url: "https://a.com" }), headers: H() });
  ok("缺 API key 被拒绝 400", noKey.status === 400, noKey.status);

  const r = await call(env, "/api/admin/providers", {
    ...jsonBody({ name: "测试站", base_url: "https://api.test.com/v1", api_key: "sk-abcdefghijklmnop", model: "gpt-image-2" }),
    headers: H(),
  });
  const j = await r.json();
  pid = j.provider.id;
  ok("创建成功", r.status === 200 && !!pid);
  ok("/v1 后缀被剥离", j.provider.base_url === "https://api.test.com", j.provider.base_url);
  ok("API key 已打码下发", j.provider.api_key.startsWith("sk-abc") && j.provider.api_key.includes("*"), j.provider.api_key);
  ok("has_key 标记为真", j.provider.has_key === true);

  const up = await call(env, `/api/admin/providers/${pid}`, { ...jsonBody({ name: "改名了" }), method: "PUT", headers: H() });
  const ju = await up.json();
  ok("更新名称生效", ju.provider.name === "改名了", ju.provider.name);
  ok("未传 key 时保持原 key", ju.provider.api_key.startsWith("sk-abc"), ju.provider.api_key);

  const r2 = await call(env, "/api/admin/providers", { headers: H() });
  const j2 = await r2.json();
  // ensureSeed 会按设计播一条「默认中转站」，所以这里是 1 条种子 + 1 条新建
  ok("列表含种子配置与新建配置，共 2 条", j2.providers.length === 2, String(j2.providers.length));
  ok("未配置后台 mock 中转站时被识别为 active", j2.active_id === pid, j2.active_id);

  const st = await call(env, "/api/image/status");
  const jst = await st.json();
  ok("公开状态显示就绪", jst.ready === true, JSON.stringify(jst));
  ok("公开状态不泄露 key", !JSON.stringify(jst).includes("sk-"), "泄露了");
  ok("公开状态不泄露地址", !JSON.stringify(jst).includes("api.test.com"), "泄露了");
}

// ---------------------------------------------------------------- 6. 生成接口

console.log("\n[6] 生成接口（mock 上游）");
{
  const origFetch = globalThis.fetch;
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  async function withUpstream(handler) {
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("/v1/images/generations")) return handler(init, url);
      return new Response(JSON.stringify({ data: [{ id: "gpt-image-2" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
  }

  const fd = (extra = {}) => {
    const f = new FormData();
    f.append("prompt", "一只猫");
    Object.entries(extra).forEach(([k, v]) => f.append(k, v));
    return f;
  };

  // 6a. b64_json 带 data: URL 前缀（client.py 注释里点名的坑）
  await withUpstream(async () => new Response(JSON.stringify({
    data: [{ b64_json: "data:image/png;base64,iVBORw0KGgo=" }],
  }), { status: 200, headers: { "Content-Type": "application/json" } }));

  let r = await call(env, "/api/image/generate", { method: "POST", body: fd() });
  let j = await r.json();
  ok("带 data 前缀的 b64_json 能解析", r.status === 200 && j.count === 1, JSON.stringify(j).slice(0, 200));
  ok("图片字节数正确", j.images && j.images[0].bytes === PNG.length, JSON.stringify(j.images));

  // 6b. 纯 base64
  await withUpstream(async () => new Response(JSON.stringify({
    data: [{ b64_json: "iVBORw0KGgo=" }],
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  r = await call(env, "/api/image/generate", { method: "POST", body: fd() });
  j = await r.json();
  ok("纯 base64 也能解析", r.status === 200 && j.images[0].bytes === PNG.length, JSON.stringify(j).slice(0, 200));

  // 6c. 上游报错 → 中文提示 + 状态码透传
  await withUpstream(async () => new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }));
  r = await call(env, "/api/image/generate", { method: "POST", body: fd() });
  j = await r.json();
  ok("上游 401 被转成 401", r.status === 401, r.status);
  ok("401 给出 key 失效的中文提示", /API key/.test(j.detail.message), j.detail.message);
  // 回归：上游 JSON 里的 message 应被**提取**出来，而不是把整段 JSON 原文塞进来。
  // 之前 extractError 算出了 detail 却忘了返回，白白丢掉上游的具体原因。
  ok("透传上游原始错误信息（提取为消息本身，而非整段 JSON）",
     j.detail.detail === "invalid api key",
     () => `detail=${JSON.stringify(j.detail.detail)}`);

  // 6d. 空 data（内容审核场景）
  await withUpstream(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  r = await call(env, "/api/image/generate", { method: "POST", body: fd() });
  j = await r.json();
  ok("空 data 返回 400", r.status === 400, String(r.status));
  ok("空 data 在 hint 里提示内容审核", /审核|不支持/.test(`${j.detail.message} ${j.detail.hint}`), JSON.stringify(j.detail));

  // 6e. 流式：NDJSON 心跳 + 最终结果
  //     Cloudflare 边缘对"没有数据流动"的响应约 100s 就断 —— 出图慢必被掐
  //     （线上实测踩到「生成超时（超过 90s）」）。流式每 N 秒吐一行心跳保活，
  //     所以这条路径必须真的有心跳、且以 done 收尾。
  const envS = { ...env, MAX_STREAM_TIMEOUT: 120, STREAM_HEARTBEAT_MS: 100 };
  await withUpstream(async () => {
    await new Promise((res) => setTimeout(res, 350));      // 模拟慢上游
    return new Response(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgo=" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  });

  const parseNdjson = (text) => text.trim().split("\n")
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  r = await call(envS, "/api/image/generate", { method: "POST", body: fd({ stream: "1", timeout: "9999" }) });
  ok("流式返回 NDJSON", (r.headers.get("Content-Type") || "").includes("ndjson"),
    r.headers.get("Content-Type"));
  const lines = parseNdjson(await r.text());
  ok("首行是 start", lines[0] && lines[0].type === "start", JSON.stringify(lines[0]));
  ok("超时按部署方上限收口（客户端要 9999 → 实际 120）",
    lines[0] && lines[0].timeout === 120, String(lines[0] && lines[0].timeout));
  const ticks = lines.filter((m) => m.type === "tick");
  ok("等待期间有心跳（≥2 行 tick）", ticks.length >= 2, `${ticks.length} 行`);
  const lastLine = lines[lines.length - 1];
  ok("末行是 done 且带图片",
    lastLine && lastLine.type === "done" && lastLine.images && lastLine.images[0].bytes === PNG.length,
    JSON.stringify(lastLine && { type: lastLine.type, count: lastLine.count }));

  // 6f. 流式下的上游错误也以 error 行收尾（HTTP 状态自始至终是 200）
  await withUpstream(async () => new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }));
  r = await call(envS, "/api/image/generate", { method: "POST", body: fd({ stream: "1" }) });
  const elines = parseNdjson(await r.text());
  const eLast = elines[elines.length - 1];
  ok("流式错误以 error 行收尾", eLast && eLast.type === "error", String(eLast && eLast.type));
  ok("错误体保持 {message,hint,detail} 形状",
    eLast && eLast.error && typeof eLast.error.message === "string" && /API key/.test(eLast.error.message),
    JSON.stringify(eLast && eLast.error));

  // 6g. 不带 stream 时仍是老的一次性 JSON（给别的客户端留后路）
  await withUpstream(async () => new Response(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgo=" }] }), { status: 200 }));
  r = await call(env, "/api/image/generate", { method: "POST", body: fd() });
  ok("非流式仍返回 JSON", (r.headers.get("Content-Type") || "").includes("json"), r.headers.get("Content-Type"));

  globalThis.fetch = origFetch;
}

// ---------------------------------------------------------------- 7. 改字已迁到浏览器

console.log("\n[7] 无痕改字不再经过 Worker");
{
  // 改字接口已整体移除：模型与运行时作为 /assets/ 静态资源下发，
  // 由浏览器缓存并本地推理。这里断言它们确实不再被 Worker 处理
  // （一路落到静态资源），免得哪天有人又把降级逻辑加回来。
  const env2 = makeEnv();
  for (const p of ["/api/analyze", "/api/apply", "/api/fonts", "/api/health"]) {
    const r = await call(env2, p, jsonBody({}));
    const text = await r.text();
    ok(`${p} 落到静态资源（服务端不再实现）`, text.startsWith("STATIC:"), text.slice(0, 40));
  }

  const h = await call(env2, "/api/cf/health");
  const jh = await h.json();
  ok("健康检查标记改字为浏览器端", jh.ocr_backend === "browser-wasm", String(jh.ocr_backend));
  ok("不再暴露 heavy_backend 字段", jh.heavy_backend === undefined, String(jh.heavy_backend));
}

// ---------------------------------------------------------------- 8. 删配置

console.log("\n[8] 删除与收尾");
{
  const H = { Cookie: cookie };
  const r = await call(env, `/api/admin/providers/${pid}`, { method: "DELETE", headers: H });
  ok("删除配置成功", r.status === 200, String(r.status));
  const r2 = await call(env, "/api/admin/providers", { headers: H });
  const j2 = await r2.json();
  const remaining = j2.providers.filter((p) => p.id === pid);
  ok("删除后列表不含该配置", remaining.length === 0);

  const lo = await call(env, "/api/admin/logout", { method: "POST", headers: H });
  ok("退出登录返回 200", lo.status === 200);
  // 令牌是 HMAC 无状态签名令牌，logout 靠浏览器删 Cookie 生效，
  // 过期前令牌本身依然可用 —— 这与 Python 版行为一致，不是缺陷。
  ok("退出时下发 Max-Age=0 的过期 Cookie", /Max-Age=0/i.test(lo.headers.get("Set-Cookie") || ""), lo.headers.get("Set-Cookie"));
}

// ---------------------------------------------------------------- 9. 优化项回归

console.log("\n[9] 优化项回归");
{
  // 9a. 静态资源与页面也要带安全头（此前只有 API 响应带，静态资源裸奔）
  {
    const e9 = makeEnv();
    const st = await call(e9, "/static/app.js");
    ok("静态资源带 X-Content-Type-Options", st.headers.get("X-Content-Type-Options") === "nosniff",
       st.headers.get("X-Content-Type-Options"));
    ok("静态资源带 X-Frame-Options", st.headers.get("X-Frame-Options") === "SAMEORIGIN",
       st.headers.get("X-Frame-Options"));
    const pg = await call(e9, "/");
    ok("页面路由带 X-Frame-Options", pg.headers.get("X-Frame-Options") === "SAMEORIGIN",
       pg.headers.get("X-Frame-Options"));
  }

  // 9b. MAX_UPSTREAM_TIMEOUT 必须真正生效：部署方设 1s，客户端要 9999s 也只能等 1s。
  // 这个配置项此前写在 wrangler.toml 里却没人读，纯摆设。
  {
    const e9 = makeEnv();
    e9.MAX_UPSTREAM_TIMEOUT = 1;
    await e9.KV.put("providers", JSON.stringify({
      providers: [{ id: "p1", name: "t", base_url: "https://up.test", api_key: "k", model: "m", enabled: true }],
      active_id: "p1", version: 1,
    }));

    const origFetch = globalThis.fetch;
    // 上游永不返回，只响应 abort —— 用来观测实际生效的超时
    globalThis.fetch = (url, init) => new Promise((_, rej) => {
      const sig = init && init.signal;
      if (sig) sig.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        rej(e);
      });
    });

    const f9 = new FormData();
    f9.append("prompt", "一只猫");
    f9.append("timeout", "9999"); // 远大于上限
    const r9 = await call(e9, "/api/image/generate", { method: "POST", body: f9 });
    const j9 = await r9.json();
    globalThis.fetch = origFetch;

    ok("超时被钳到部署方上限（1s）", /超过 1s/.test(j9.detail.message || ""), () => JSON.stringify(j9.detail));
    ok("超时状态码为 504", r9.status === 504, String(r9.status));
  }

  // 9c. 缓存必须带 TTL：KV 被外部改动后，isolate 不能永远读旧值。
  // 这正是「改了中转站配置却不生效」类问题的根因防护。
  {
    const e9 = makeEnv();
    await e9.KV.put("providers", JSON.stringify({ providers: [], active_id: null, version: 1 }));

    const before = await (await call(e9, "/api/image/status")).json();
    ok("初始无可选中转站", before.ready === false, JSON.stringify(before));

    // 绕过 Worker 直接改 KV（模拟配置在别处被更新）
    await e9.KV.put("providers", JSON.stringify({
      providers: [{ id: "x", name: "n", base_url: "https://a.test", api_key: "k", model: "m", enabled: true }],
      active_id: "x", version: 1,
    }));

    const cached = await (await call(e9, "/api/image/status")).json();
    ok("TTL 内读缓存（仍是旧值）", cached.ready === false, JSON.stringify(cached));

    const realNow = Date.now;
    const t0 = realNow();
    Date.now = () => t0 + 31_000; // 把时钟推过 30s TTL
    try {
      const fresh = await (await call(e9, "/api/image/status")).json();
      ok("TTL 过期后读到新配置", fresh.ready === true, () => JSON.stringify(fresh));
    } finally {
      Date.now = realNow;
    }
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
