// 中转站 API 客户端，对齐 Python 版 app/image_gen/client.py。
//
// 三条实测结论在 Workers 版依然成立，务必保留：
//   1. 参照图走 generations 的 `image` 字段，不是标准 /v1/images/edits
//      （后者在多数中转站返回空 data）
//   2. b64_json 可能带 data:image/png;base64, 前缀，直接 atob 会炸，要剥前缀 + 补 padding
//   3. 中转站错误的 HTTP 状态码要翻译成中文提示，别把原始堆栈糊给用户
//
// ⚠️ 与 Python 版的两处差异（运行时限制，无法绕过）：
//   - Python 版关掉了 TLS 校验（check_hostname=False / CERT_NONE）。Workers 由
//     Cloudflare 统一管理证书，**不能**关，中转到自签证书的站点会直接失败。
//   - Python 版支持 provider.proxy。Workers 没有 HTTP 代理能力，该字段被忽略。

const MAX_REFERENCES = 4;
const MAX_REF_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_LEN = 4000;
const DEFAULT_TIMEOUT = 300;

export class GenError extends Error {
  constructor(message, { status = null, detail = "", hint = "" } = {}) {
    super(message);
    this.status = status;
    this.detail = detail;
    this.hint = hint;
  }
  toDict() {
    return { message: this.message, status: this.status, detail: this.detail, hint: this.hint };
  }
}

const STATUS_HINTS = {
  400: "请求参数被拒绝，可检查模型名与尺寸是否被该中转站支持",
  401: "API key 无效或已失效，请在「中转站配置」里更新",
  403: "该 key 没有访问此模型的权限",
  404: "接口路径不存在，请确认中转站地址是否填成了带 /v1 的形式",
  413: "参照图过大，建议压缩到 4MB 以内",
  429: "请求过于频繁或额度不足，稍后再试或检查账户余额",
  500: "中转站内部错误，可稍后重试",
  502: "中转站网关异常（Bad Gateway）",
  503: "中转站服务暂不可用",
  504: "中转站网关超时",
};

/**
 * 从错误响应里提炼可读信息。
 *
 * 与 Python 版 `_extract_error` 保持一致：返回 (可读文案, 上游原始详情) 两个值。
 * 之前这里只返回了文案，把上游的具体错误（如 "insufficient balance"）丢掉了，
 * 用户只能看到通用提示，排查时无从下手。
 */
function extractError(status, bodyText) {
  const text = (bodyText || "").trim();
  let detail = text.slice(0, 500);
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object") {
      const e = j.error;
      if (e && typeof e === "object") detail = e.message || j.message || detail;
      else if (typeof e === "string") detail = e;
      else detail = j.message || j.detail || detail;
    }
  } catch {
    /* 不是 JSON 就用原文 */
  }
  return { message: STATUS_HINTS[status] || `中转站返回 HTTP ${status}`, detail };
}

/** b64_json 兼容处理：可能是纯 base64，也可能是 data URL */
function decodeB64(value) {
  let raw = value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value;
  raw = raw.trim();
  while (raw.length % 4) raw += "=";
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function toDataUrl(bytes, mime) {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

function sniffMime(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return "image/webp";
  return "image/png";
}

/**
 * 调用中转站生成图片。
 * @param {object} provider  含 base_url / api_key / model
 * @param {object} opt       { prompt, size, n, references:[{bytes,filename}], timeout }
 */
export async function generate(provider, opt) {
  const base = (provider.base_url || "").replace(/\/+$/, "");
  const key = (provider.api_key || "").trim();
  const model = (provider.model || "gpt-image-2").trim();

  if (!base) throw new GenError("未配置中转站地址", { hint: "请在「中转站配置」里填写地址" });
  if (!key) throw new GenError("未配置 API key", { hint: "请在「中转站配置」里填写 key" });

  const prompt = (opt.prompt || "").trim();
  if (!prompt) throw new GenError("提示词不能为空", { hint: "描述你想生成的画面" });
  if (prompt.length > MAX_PROMPT_LEN) throw new GenError(`提示词过长（${prompt.length} 字，上限 ${MAX_PROMPT_LEN}）`);

  const n = Math.max(1, Math.min(parseInt(opt.n || 1, 10) || 1, 4));
  // 上下限都交给调用方（image.js 按 env.MAX_UPSTREAM_TIMEOUT 钳制），
  // 这里只保证是个正数：之前写死的下界 10 会把部署方设的 1s 顶回 10s，
  // 等于把新的上限配置架空了。
  const timeout = Math.max(parseInt(opt.timeout || DEFAULT_TIMEOUT, 10) || DEFAULT_TIMEOUT, 1);

  const payload = { model, prompt, n, size: (opt.size || "1024x1024").trim() };

  const refs = (opt.references || []).filter((r) => r && r.bytes && r.bytes.length).slice(0, MAX_REFERENCES);
  const usedRef = refs.length > 0;
  if (usedRef) {
    const urls = refs.map((r) => {
      if (r.bytes.length > MAX_REF_BYTES) {
        throw new GenError(`参照图过大（${(r.bytes.length / 1048576).toFixed(1)}MB，上限 8MB）`, { hint: "请压缩后再试" });
      }
      return toDataUrl(r.bytes, sniffMime(r.bytes));
    });
    payload.image = urls.length === 1 ? urls[0] : urls;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout * 1000);

  // 外部信号：流式响应当客户端断开（关页面/点取消）时，及时把上游也断掉，
  // 免得任务跑完却没人接收，白耗中转站额度。
  const external = opt.signal;
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener("abort", () => ctrl.abort(), { once: true });
  }

  const t0 = Date.now();

  let resp;
  try {
    resp = await fetch(`${base}/v1/images/generations`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "WB-PS-ImageGen/1.0-cf",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      throw new GenError(`生成超时（超过 ${timeout}s）`, { status: 408, hint: "图片生成较慢，可稍后重试或换用更小的尺寸" });
    }
    throw new GenError("无法连接中转站", { detail: String(err && err.message ? err.message : err), hint: "检查地址是否正确、网络或 DNS 是否可达" });
  }
  clearTimeout(timer);

  const raw = await resp.arrayBuffer();
  const text = new TextDecoder("utf-8", { fatal: false }).decode(raw);

  if (!resp.ok) {
    const e = extractError(resp.status, text);
    throw new GenError(e.message, { status: resp.status, detail: e.detail });
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new GenError("中转站返回的不是合法 JSON", { status: resp.status, detail: text.slice(0, 300) });
  }

  const items = Array.isArray(data.data) ? data.data : [];
  if (!items.length) {
    const extra = data.m365 ? `（网关附加信息：${JSON.stringify(data.m365)}）` : "";
    throw new GenError("中转站未返回图片", {
      status: resp.status,
      detail: JSON.stringify(data).slice(0, 400),
      hint: "可能触发了内容审核，或该模型/尺寸不被支持" + extra,
    });
  }

  const images = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    let bytes = null;
    if (it.b64_json) {
      try {
        bytes = decodeB64(it.b64_json);
      } catch {
        bytes = null;
      }
    }
    const entry = { url: it.url || it.image_url || "", revised_prompt: it.revised_prompt || "", bytes: bytes ? bytes.length : 0 };
    if (bytes) entry.data_url = toDataUrl(bytes, "image/png");
    images.push(entry);
  }

  if (!images.length) {
    throw new GenError("中转站返回的数据里没有可用图片", { status: resp.status, detail: JSON.stringify(data).slice(0, 400) });
  }

  return {
    images,
    elapsed: Number(((Date.now() - t0) / 1000).toFixed(1)),
    used_reference: usedRef,
    reference_count: refs.length,
    endpoint: "/v1/images/generations",
    model,
    size: payload.size,
    count: images.length,
    provider: { id: provider.id, name: provider.name, base_url: base },
  };
}

/** 连通性测试：拉模型列表并确认目标模型是否存在 */
export async function ping(provider, timeout = 30) {
  const base = (provider.base_url || "").replace(/\/+$/, "");
  const key = (provider.api_key || "").trim();
  const model = (provider.model || "").trim();
  if (!base) throw new GenError("未配置中转站地址");
  if (!key) throw new GenError("未配置 API key");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout * 1000);
  const t0 = Date.now();

  let resp;
  try {
    resp = await fetch(`${base}/v1/models`, {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") throw new GenError(`连接超时（${timeout}s）`);
    throw new GenError("无法连接中转站", { detail: String(err && err.message ? err.message : err), hint: "检查地址、网络与 DNS" });
  }
  clearTimeout(timer);

  const text = await resp.text();
  if (!resp.ok) {
    const e = extractError(resp.status, text);
    throw new GenError(e.message, { status: resp.status, detail: e.detail });
  }

  let ids = [];
  try {
    const data = JSON.parse(text);
    ids = (data.data || []).filter((m) => m && typeof m === "object").map((m) => m.id);
  } catch {
    ids = [];
  }

  return {
    ok: true,
    elapsed: Number(((Date.now() - t0) / 1000).toFixed(1)),
    model_count: ids.length,
    model_found: model ? ids.includes(model) : null,
    matched: model ? ids.filter((i) => String(i).includes(model)).sort().slice(0, 10) : [],
  };
}

export { MAX_REFERENCES, MAX_REF_BYTES, MAX_PROMPT_LEN, DEFAULT_TIMEOUT, sniffMime };
