// 中转站配置的 CRUD，逐条对齐 Python 版 app/image_gen/config.py。
//
// 两个行为必须原样保留，否则前端会出问题：
//   1. api_key 一律打码下发（前端拿不到明文，只在服务端内部流转）
//   2. 更新时 api_key 传空串 = 不修改（前端拿的就是打码值，不能直接覆盖）

import { ApiError } from "./resp.js";
import { loadProviders, saveProviders, activeProvider } from "./store.js";

export const DEFAULT_MODEL = "gpt-image-2";
export const DEFAULT_SIZE = "1024x1024";
export const ALLOWED_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "auto",
  "512x512",
  "1792x1024",
  "1024x1792",
];

function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function cleanBaseUrl(url) {
  const u = (url || "").trim().replace(/\/+$/, "");
  if (!u) throw new ApiError(400, "中转站地址不能为空");
  if (!/^https?:\/\//i.test(u)) throw new ApiError(400, "中转站地址需以 http:// 或 https:// 开头");
  // 用户填带 /v1 的地址也能用：统一剥掉，调用时再拼回去
  return u.endsWith("/v1") ? u.slice(0, -3) : u;
}

function cleanModel(model) {
  const m = (model || "").trim() || DEFAULT_MODEL;
  if (m.length > 120) throw new ApiError(400, "模型名过长");
  return m;
}

function maskKey(key) {
  const k = key || "";
  if (!k) return "";
  if (k.length <= 12) return "*".repeat(k.length);
  return `${k.slice(0, 6)}${"*".repeat(6)}${k.slice(-4)}`;
}

/** 对外视图：默认打码，reveal=true 才给明文 */
export function publicView(p, reveal = false) {
  return { ...p, api_key: reveal ? p.api_key || "" : maskKey(p.api_key), has_key: !!(p.api_key || "").trim() };
}

export async function listProviders(kv, reveal = false) {
  const d = await loadProviders(kv);
  return d.providers.map((p) => publicView(p, reveal));
}

/** 生成页用的状态：刻意不含名称/地址/key */
export async function publicStatus(kv) {
  const active = await activeProvider(kv);
  if (!active) {
    const d = await loadProviders(kv);
    return {
      ready: false,
      model: DEFAULT_MODEL,
      sizes: ALLOWED_SIZES,
      message: d.providers.length ? "后台尚未启用任何中转站" : "后台尚未配置中转站",
      hint: "请前往后台管理完成配置",
    };
  }
  return { ready: true, model: active.model || DEFAULT_MODEL, sizes: ALLOWED_SIZES, message: "就绪", hint: "" };
}

async function persist(kv, mutate) {
  const d = await loadProviders(kv);
  const result = mutate(d);
  await saveProviders(kv, d);
  return result;
}

export async function addProvider(kv, { name, base_url, api_key, model = DEFAULT_MODEL, note = "", enabled = true }) {
  if (!String(api_key || "").trim()) throw new ApiError(400, "API key 不能为空");
  const now = Math.round(Date.now() / 1000);
  const item = {
    id: newId(),
    name: String(name || "").trim() || "未命名中转站",
    base_url: cleanBaseUrl(base_url),
    api_key: String(api_key || "").trim(),
    model: cleanModel(model),
    note: String(note || "").trim().slice(0, 200),
    enabled: !!enabled,
    created_at: now,
    updated_at: now,
  };
  await persist(kv, (d) => {
    d.providers.push(item);
    if (!d.active_id) d.active_id = item.id;
  });
  return item;
}

export async function updateProvider(kv, pid, fields) {
  let updated = null;
  let found = false;
  await persist(kv, (d) => {
    for (const p of d.providers) {
      if (p.id !== pid) continue;
      found = true;
      if (fields.name) p.name = String(fields.name).trim() || p.name;
      if (fields.base_url) p.base_url = cleanBaseUrl(fields.base_url);
      if (fields.api_key) p.api_key = String(fields.api_key).trim(); // 空串 = 不修改
      if (fields.model) p.model = cleanModel(fields.model);
      if (fields.note != null) p.note = String(fields.note).trim().slice(0, 200);
      if (fields.enabled != null) p.enabled = !!fields.enabled;
      p.updated_at = Math.round(Date.now() / 1000);
      updated = p;
      break;
    }
  });
  if (!found) throw new ApiError(404, `配置不存在: ${pid}`);
  return updated;
}

export async function deleteProvider(kv, pid) {
  return persist(kv, (d) => {
    const before = d.providers.length;
    d.providers = d.providers.filter((p) => p.id !== pid);
    if (d.providers.length === before) return false;
    if (d.active_id === pid) {
      d.active_id = (d.providers.find((p) => p.enabled) || { id: null }).id;
    }
    return true;
  });
}

/** 禁用当前在用的配置时，自动切到下一个可用的 */
export async function setEnabled(kv, pid, enabled) {
  const p = await updateProvider(kv, pid, { enabled });
  if (!enabled) {
    const d = await loadProviders(kv);
    if (d.active_id === pid) {
      const next = d.providers.find((x) => x.enabled);
      if (next) await setActive(kv, next.id);
    }
  }
  return p;
}

export async function setActive(kv, pid) {
  const target = await getProviderRaw(kv, pid);
  if (!target) throw new ApiError(404, `配置不存在: ${pid}`);
  if (!target.enabled) throw new ApiError(400, "该配置已被禁用，请先启用");
  await persist(kv, (d) => {
    d.active_id = pid;
  });
  return target;
}

// 每个 KV 绑定只播种一次。
// Python 版是在进程启动时调一次 ensure_seed()，Worker 没有启动钩子；
// 原实现挂在每个请求上（连静态资源都触发），这里改成按 KV 记一次即可。
// 用 WeakSet 按 KV 分桶，与 store.js 的缓存分桶策略保持一致 ——
// 若用模块级布尔量，多套 KV（测试/多环境）之间会互相影响。
const seededKVs = new WeakSet();

/** 首次运行塞一条空白配置，方便在界面上直接填 */
export async function ensureSeed(kv) {
  if (seededKVs.has(kv)) return;
  const d = await loadProviders(kv);
  if (d.providers.length) {
    seededKVs.add(kv);
    return;
  }
  const now = Math.round(Date.now() / 1000);
  d.providers.push({
    id: newId(),
    name: "默认中转站",
    base_url: "https://code.linlong520.com",
    api_key: "",
    model: DEFAULT_MODEL,
    note: "",
    enabled: false,
    created_at: now,
    updated_at: now,
  });
  d.active_id = d.providers[0].id;
  await saveProviders(kv, d);
  seededKVs.add(kv);
}

/** 取原始配置（含明文 api_key），只在服务端内部用 */
export async function getProviderRaw(kv, pid) {
  const d = await loadProviders(kv);
  return d.providers.find((p) => p.id === pid) || null;
}

export { cleanBaseUrl, cleanModel, maskKey };
