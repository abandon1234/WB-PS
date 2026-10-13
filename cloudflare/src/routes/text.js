// 文字工坊 · 图片翻译的上游代理，对齐 /api/text/*。
//
// 与 /api/image/* 的定位差别：
//   生成 → 图片要出网（中转站必须收到提示词与参照图）
//   翻译 → **只有从图里识别出来的那几行文本**出网，图片始终留在浏览器里
//          （识别、擦除、重绘全在本机，见 web/engine/localapi.js）
// 这个区别是「本机处理」叙事的关键，所以入参刻意只收 texts[]，收不到图。
//
// 上游走 OpenAI 兼容的 /v1/chat/completions（与生图共用同一份中转站配置），
// 模型取 provider.text_model —— 生图模型（gpt-image-*）不能拿来做文本翻译，
// 所以单独一个字段，没配就明确报"未配置文本模型"，不静默失败。

import { ApiError, json } from "../resp.js";
import * as store from "../store.js";
import { extractError } from "../gen.js";

// 一次请求最多打包多少行。上限由**前端**按批次切（超了前端会降半批重试），
// 这里只做一个防滥用的硬闸，比前端批次大，免得正常批次被误伤。
const MAX_TEXTS = 120;
const MAX_TEXT_LEN = 4000;
const MAX_TOTAL_CHARS = 40000;

// 第一期只认真实需要的中 ↔ 英（现装 OCR 是 ch_PP-OCRv3，中英）。
// 其余语言放行也无意义 —— 识别不出来就没什么可翻的，等换多语言模型再说。
const LANGS = {
  zh: "中文（简体）",
  en: "English",
};

const SYS_PROMPT = [
  "You are a professional image-text translator.",
  "You receive a JSON array of strings OCR-ed from an image, and you translate every item.",
  "Rules:",
  "1. Output ONLY a JSON array of strings — same length, same order. No prose, no code fence.",
  "2. Translate each item naturally; keep it short enough to fit where the original was.",
  "3. Do NOT translate: numbers, prices, dates, URLs, emails, phone numbers, ID numbers, SKUs — keep them as-is.",
  "4. If an item is already in the target language, return it unchanged.",
  "5. Never merge or split items; one input item = one output item.",
].join("\n");

function readJsonBody(request) {
  return request.json().catch(() => null);
}

/** 从模型输出里抠出 JSON 数组。容忍 ```json 围栏与前后多余文字。 */
function parseArray(content, expected) {
  if (typeof content !== "string") return null;
  let s = content.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf("[");
  const b = s.lastIndexOf("]");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);

  let arr = null;
  try {
    arr = JSON.parse(s);
  } catch {
    // 退一步：按行拆。有些模型中转会把数组摊成一行一条。
    const lines = s.split("\n")
      .map((l) => l.replace(/^\s*(?:[-*]|\d+[.、)])\s*/, "").trim())
      .filter((l) => l.length);
    if (lines.length === expected) arr = lines;
  }
  if (!Array.isArray(arr)) return null;
  const out = arr.map((v) => (v == null ? "" : String(v)));
  // 长度对不上宁可让前端降半批重试，也不猜 —— 错位的译文贴错位置比不翻更糟
  return out.length === expected ? out : null;
}

export async function handleText(request, env, path) {
  if (path === "/api/text/status" && request.method === "GET") {
    const active = await store.activeProvider(env.KV);
    const model = active ? (active.text_model || "") : "";
    return json({
      ready: !!(active && model),
      model: model || "",
      message: active
        ? (model ? "就绪" : "当前中转站未配置文本模型")
        : "后台尚未启用任何中转站",
      hint: active && !model ? "请在后台「中转站配置」里填写文本模型（翻译用）" : "",
    });
  }

  if (path === "/api/text/translate" && request.method === "POST") {
    const provider = await store.activeProvider(env.KV);
    if (!provider) {
      throw new ApiError(400, "后台尚未配置可用的中转站", { hint: "请联系管理员在后台完成配置" });
    }
    const textModel = String(provider.text_model || "").trim();
    if (!textModel) {
      throw new ApiError(400, "未配置文本模型", {
        hint: "翻译需要一个对话模型。请在后台「中转站配置」里为当前配置填写「文本模型」，例如 gpt-4o-mini",
      });
    }

    const body = await readJsonBody(request);
    if (!body || typeof body !== "object") {
      throw new ApiError(400, "请求格式有误", { hint: "需要 application/json" });
    }

    const from = String(body.from || "zh").toLowerCase();
    const to = String(body.to || "en").toLowerCase();
    if (!LANGS[from] || !LANGS[to]) {
      throw new ApiError(400, `暂不支持的语言方向：${from} → ${to}`, { hint: "本期只支持中 ↔ 英" });
    }
    if (from === to) throw new ApiError(400, "源语言与目标语言相同");

    const raw = Array.isArray(body.texts) ? body.texts : [];
    const texts = raw.map((t) => (t == null ? "" : String(t)));
    if (!texts.length) throw new ApiError(400, "没有需要翻译的文本");
    if (texts.length > MAX_TEXTS) throw new ApiError(400, `一次最多翻译 ${MAX_TEXTS} 行`);
    if (texts.some((t) => t.length > MAX_TEXT_LEN)) {
      throw new ApiError(400, `单行文本过长（上限 ${MAX_TEXT_LEN} 字符）`);
    }
    const total = texts.reduce((n, t) => n + t.length, 0);
    if (total > MAX_TOTAL_CHARS) throw new ApiError(400, `本次文本总量过大（${total} 字符）`, { hint: "少选几行再试" });

    const cap = parseInt(String(env.MAX_UPSTREAM_TIMEOUT || ""), 10) || 90;
    const asked = parseInt(String(body.timeout || ""), 10) || cap;
    const timeout = Math.max(1, Math.min(asked, cap));

    const base = (provider.base_url || "").replace(/\/+$/, "");
    const key = (provider.api_key || "").trim();
    if (!base) throw new ApiError(400, "中转站地址未配置");
    if (!key) throw new ApiError(400, "API key 未配置", { hint: "请在「中转站配置」里更新 key" });

    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout * 1000);

    let resp;
    try {
      resp = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "WB-PS-TextTranslate/1.0-cf",
        },
        body: JSON.stringify({
          model: textModel,
          temperature: 0,
          // 刻意**不带** response_format：部分中转站不认这个字段、会直接回 400，
          // 那是一次硬失败；而多数模型本来就能按提示词吐 JSON，解析端也做了
          // 宽松处理（剥 ``` 围栏、认 {"texts":[...]} 与裸数组两种形状）。
          messages: [
            { role: "system", content: SYS_PROMPT },
            {
              role: "user",
              content: `Translate from ${LANGS[from]} to ${LANGS[to]}.\n`
                + `Return a JSON object {"texts": [...]} with exactly ${texts.length} items.\n\n`
                + JSON.stringify(texts),
            },
          ],
        }),
      });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === "AbortError") {
        throw new ApiError(504, `翻译超时（超过 ${timeout}s）`, { hint: "少选几行再试" });
      }
      throw new ApiError(502, "无法连接中转站", { detail: String((err && err.message) || err) });
    }
    clearTimeout(timer);

    const rawText = await resp.text();
    if (!resp.ok) {
      const e = extractError(resp.status, rawText);
      throw new ApiError(resp.status >= 400 && resp.status < 600 ? resp.status : 400, e.message, { detail: e.detail });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new ApiError(502, "中转站返回的不是合法 JSON", { detail: rawText.slice(0, 300) });
    }

    const choice = (data.choices && data.choices[0]) || null;
    const content = choice && choice.message ? choice.message.content : "";
    // 有些中转站即使要了 json_object 也会把数组直接放进 content 字符串里，
    // 这里两种形状都认：{"texts":[...]} 与裸数组。
    let arr = null;
    try {
      const j = JSON.parse(String(content).replace(/^```(?:json)?|```$/g, "").trim());
      if (j && Array.isArray(j.texts)) arr = j.texts.map((v) => (v == null ? "" : String(v)));
    } catch { /* 落到下面的宽松解析 */ }
    if (!arr) arr = parseArray(content, texts.length);

    if (!arr) {
      throw new ApiError(502, "译文解析失败", {
        detail: String(content).slice(0, 300),
        hint: "模型没有按要求返回 JSON 数组，重试或换一个文本模型",
      });
    }
    if (arr.length !== texts.length) {
      throw new ApiError(502, `译文行数对不上（要 ${texts.length} 行，返回 ${arr.length} 行）`, {
        hint: "已自动降半批重试，若持续失败请换用更稳定的文本模型",
      });
    }

    return json({
      texts: arr,
      from,
      to,
      model: textModel,
      finish_reason: (choice && choice.finish_reason) || "",
      // 上游被截断（max_tokens 打满）时行数可能仍然够但内容不全，前端据此降半批重试
      truncated: String((choice && choice.finish_reason) || "") === "length",
      elapsed_ms: Date.now() - t0,
    });
  }

  return null;
}
