// 「图像工坊」生成模块的公开接口，对齐 /api/image/*。
//
// 这里刻意**只返回**模型名与"能否用"，中转站名称/地址/API key 一个都不下发——
// 生成页只需要知道能不能生成，真要连也是走这台 Worker 转发，key 永远留在服务端。

import { ApiError, json } from "../resp.js";
import * as providers from "../providers.js";
import * as store from "../store.js";
import { generate, GenError, MAX_REFERENCES } from "../gen.js";

const ALLOWED_REF_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/bmp"]);

const TOOL_NAMES = {
  create: "自由生成",
  combine: "图像融合",
  portrait: "人物写真",
  product: "商品图生成",
};

export async function handleImage(request, env, path) {
  if (path === "/api/image/status" && request.method === "GET") {
    return json(await providers.publicStatus(env.KV));
  }

  if (path === "/api/image/generate" && request.method === "POST") {
    // 取原始对象（含明文 api_key）——它是服务端内部流转用的，绝不进响应体
    const provider = await store.activeProvider(env.KV);
    if (!provider) {
      throw new ApiError(400, "后台尚未配置可用的中转站", { hint: "请联系管理员在后台完成配置" });
    }

    // multipart 里的空字符串会让某些解析器报缺字段，这里手动取值并交给业务层校验，
    // 好给出可读的中文提示，而不是一个干巴巴的 422。
    let form;
    try {
      form = await request.formData();
    } catch {
      throw new ApiError(400, "请求格式有误", { hint: "需要 multipart/form-data" });
    }

    const prompt = String(form.get("prompt") || "");
    const size = String(form.get("size") || providers.DEFAULT_SIZE);
    const n = parseInt(String(form.get("n") || "1"), 10) || 1;
    const tool = String(form.get("tool") || "").trim().slice(0, 32);

    // 流式模式：客户端读 NDJSON，服务端边等边吐心跳。
    //
    // 为什么需要它：Cloudflare 边缘对"没有数据流动"超过约 100 秒的响应会断开
    // （表现为 524）。一次性返回 JSON 的话，上游出图慢一点就被掐 —— 实测一次
    // 1024×1024/1 张要 57.7s，慢的提示词会超过 90s（线上实测踩到）。
    // 改成流式之后，每 5 秒一行心跳让连接保持活跃，实测 151 秒的流能完整送达，
    // 于是上游超时上限可以放宽到分钟级。
    const wantsStream = String(form.get("stream") || "") === "1"
      || (request.headers.get("Accept") || "").includes("application/x-ndjson");

    // 超时上限由部署方在 wrangler.toml 决定。
    // 非流式受边缘空闲上限约束（约 100s），流式可以放宽得多 —— 两者用不同的键。
    const capPlain = parseInt(String(env.MAX_UPSTREAM_TIMEOUT || ""), 10) || 90;
    const capStream = parseInt(String(env.MAX_STREAM_TIMEOUT || ""), 10) || 300;
    const cap = wantsStream ? capStream : capPlain;
    const asked = parseInt(String(form.get("timeout") || ""), 10) || cap;
    // 先保下界 1s，再按 cap 封顶 —— 客户端可以要求更短，但不能超过部署方上限
    const timeout = Math.max(1, Math.min(asked, cap));

    const references = [];
    const files = form.getAll("references").filter(Boolean);
    for (const f of files.slice(0, MAX_REFERENCES)) {
      if (typeof f === "string" || !f.name) continue;
      const ctype = (f.type || "").toLowerCase();
      if (ctype && !ALLOWED_REF_TYPES.has(ctype)) {
        throw new ApiError(400, `参照图格式不支持：${ctype}`, { hint: "请使用 PNG / JPG / WEBP / BMP" });
      }
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (bytes.length) references.push({ bytes, filename: f.name });
    }

    const opts = { prompt, size, n, references, timeout, tool };

    if (wantsStream) return streamGenerate(request, env, provider, opts);

    let result;
    try {
      result = await generate(provider, opts);
    } catch (err) {
      throw genErrorToApi(err);
    }

    // 响应里只留非敏感标识，不带中转站地址
    return json({ ...successPayload(result, provider, tool) });
  }

  return null;
}

/** 统一的结果载荷：流式与非流式用同一份，避免两边字段漂移 */
function successPayload(result, provider, tool) {
  return {
    ok: true,
    ...result,
    tool,
    tool_name: TOOL_NAMES[tool] || tool || "自由生成",
    provider: { name: provider.name, model: provider.model },
  };
}

function genErrorToApi(err) {
  if (err instanceof GenError) {
    const d = err.toDict();
    let status = typeof d.status === "number" && d.status >= 400 ? d.status : 400;
    if (status === 408 || status === 504) status = 504;
    return new ApiError(status, d.message, { hint: d.hint, detail: d.detail });
  }
  return err;
}

/**
 * 流式生成：立刻回一条 NDJSON 流，先发 start，然后每 5 秒一发心跳，
 * 上游出图后发 done（或 error）并收流。
 *
 * 客户端断开（关页面 / 点取消 / 网络断）时 cancel() 会触发：
 * 停掉心跳，并通过 AbortSignal 把上游请求也掐掉。
 */
function streamGenerate(request, env, provider, opts) {
  const enc = new TextEncoder();
  const t0 = Date.now();
  // 心跳间隔可配置：测试里调成 100ms 就不必真等 5 秒；线上保持 5 秒即可
  // （只要远小于边缘约 100s 的空闲上限，越小越稳，但也没必要太密）。
  const hbMs = Math.min(60000, Math.max(50, parseInt(String(env.STREAM_HEARTBEAT_MS || ""), 10) || 5000));
  let timer = null;
  let finished = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => {
        if (finished) return;
        try { controller.enqueue(enc.encode(JSON.stringify(obj) + "\n")); } catch (_) { /* 已断开 */ }
      };

      send({ type: "start", timeout: opts.timeout, elapsed: 0, heartbeat_ms: hbMs });
      timer = setInterval(() => {
        send({ type: "tick", elapsed: Math.round((Date.now() - t0) / 1000) });
      }, hbMs);

      try {
        const result = await generate(provider, { ...opts, signal: request.signal });
        send({ type: "done", ...successPayload(result, provider, opts.tool) });
      } catch (err) {
        // 错误体跟一次性路径保持一致：{message, hint, detail}
        let d;
        const api = genErrorToApi(err);
        if (api instanceof ApiError) d = api.payload;
        else d = { message: String((err && err.message) || err), hint: "", detail: "" };
        send({ type: "error", error: d });
      } finally {
        clearInterval(timer);
        timer = null;
        finished = true;
        try { controller.close(); } catch (_) { /* 已关闭 */ }
      }
    },
    cancel() {
      finished = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      // no-transform 提醒中间层不要为了压缩而缓冲 —— 缓冲就等于没有心跳
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
