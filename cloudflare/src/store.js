// KV 持久化层。
//
// Python 版把配置写在 data/admin.json 与 data/image_providers.json。
// Workers 的文件系统是 isolate 内、重启即失效的临时内存盘，所以换成 KV，
// 但**两份文档的字段结构保持原样**，好让旧环境能整体迁移过来。
//
// KV 是最终一致（读可能有最多 60s 陈旧窗口）。这里写入后立即回写一份到
// 模块级缓存，让「写完马上去读」这种场景拿到新鲜值，避免刚改完配置不生效。

import { ADMIN } from "./crypto.js";

const KEY_ADMIN = "admin";
const KEY_PROVIDERS = "providers";

// isolate 内的读缓存：写透、读优先，并带 TTL。
//
// 为什么必须有 TTL：KV 本身是最终一致（读最多可能落后 60s），如果缓存永不过期，
// 这个 isolate 会**在整个生命周期内**一直用陈旧数据——后台改了中转站 key，
// 落到这个 isolate 的请求可能几小时都在用旧 key，直到 isolate 被回收。
// 加 30s TTL 后最坏情况退化成 KV 自身的一致性窗口，行为可预期。
const CACHE_TTL_MS = 30_000;

// 按 KV 绑定分桶（WeakMap）：一个 isolate 里若同时挂着多套 KV（测试、或将来的多环境），
// 缓存不会互相串台；KV 实例被回收时桶也随之释放。
const caches = new WeakMap(); // KV -> Map<key, { value, exp }>

function bucket(kv) {
  let m = caches.get(kv);
  if (!m) {
    m = new Map();
    caches.set(kv, m);
  }
  return m;
}

function cachePut(kv, key, value) {
  bucket(kv).set(key, { value, exp: Date.now() + CACHE_TTL_MS });
}

function blankAdmin() {
  // rounds 记录这份口令是用多少轮 PBKDF2 算的。老记录（Python 侧写入）没有这个
  // 字段，默认为 Python 版的历史值 —— 而那个值在 Workers 上算不出来，
  // 登录时会给出明确提示，而不是莫名其妙地报"密码不正确"。
  return { password_hash: "", salt: "", secret: "", rounds: 120000, updated_at: 0 };
}

function blankProviders() {
  return { providers: [], active_id: null, version: 1 };
}

async function read(kv, key, fallback) {
  const hit = bucket(kv).get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  let data;
  try {
    const raw = await kv.get(key);
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (!data || typeof data !== "object") data = fallback();
  cachePut(kv, key, data);
  return data;
}

async function write(kv, key, data) {
  // 写透：本 isolate 立即读到新值，同时把 TTL 续上
  cachePut(kv, key, data);
  await kv.put(key, JSON.stringify(data));
}

// ---------------------------------------------------------------- 管理口令

export function loadAdmin(kv) {
  return read(kv, KEY_ADMIN, blankAdmin);
}

export async function saveAdmin(kv, data) {
  await write(kv, KEY_ADMIN, data);
}

/** 尚未设置管理密码 */
export async function needsSetup(kv) {
  const a = await loadAdmin(kv);
  return !a.password_hash;
}

export async function setAdminSecret(kv, { passwordHash, salt, secret, rounds }) {
  const data = {
    password_hash: passwordHash,
    salt,
    secret,
    rounds: rounds || 100000,
    updated_at: Math.round(Date.now() / 1000),
  };
  await saveAdmin(kv, data);
  return data;
}

export async function getSecret(kv) {
  const a = await loadAdmin(kv);
  return a.secret || "";
}

export async function getPwHash(kv) {
  const a = await loadAdmin(kv);
  return { hash: a.password_hash || "", salt: a.salt || "", rounds: a.rounds || 120000 };
}

// ---------------------------------------------------------------- 中转站配置

export function loadProviders(kv) {
  return read(kv, KEY_PROVIDERS, blankProviders);
}

export async function saveProviders(kv, data) {
  await write(kv, KEY_PROVIDERS, data);
}

export async function getProvider(kv, pid) {
  const d = await loadProviders(kv);
  return d.providers.find((p) => p.id === pid) || null;
}

export async function activeProvider(kv) {
  const d = await loadProviders(kv);
  const hit = (id) => d.providers.find((p) => p.id === id && p.enabled);
  return hit(d.active_id) || d.providers.find((p) => p.enabled) || null;
}

// ---------------------------------------------------------------- 登录限速
//
// 原实现用进程内存 dict。Workers 的每个 isolate 内存互不相通，
// 放 KV 才能跨实例生效；300s 窗口直接交给 KV 自带的 TTL 回收。

const FAIL_WINDOW = 300;
const MAX_FAILS = 6;
const KEY_FAIL = (ip) => `loginfail:${ip}`;

export async function failStats(kv, ip) {
  if (!ip) return { hits: 0, wait: 0, left: MAX_FAILS };
  const now = Date.now() / 1000;
  let hits = [];
  try {
    const raw = await kv.get(KEY_FAIL(ip));
    if (raw) hits = JSON.parse(raw).filter((t) => now - t < FAIL_WINDOW);
  } catch {
    hits = [];
  }
  const wait = hits.length >= MAX_FAILS ? Math.max(1, Math.ceil(FAIL_WINDOW - (now - Math.max(...hits)))) : 0;
  return { hits, wait, left: Math.max(0, MAX_FAILS - hits.length) };
}

export async function recordFail(kv, ip) {
  if (!ip) return;
  const { hits } = await failStats(kv, ip);
  hits.push(Date.now() / 1000);
  await kv.put(KEY_FAIL(ip), JSON.stringify(hits.slice(-MAX_FAILS)), { expirationTtl: FAIL_WINDOW });
}

export async function clearFails(kv, ip) {
  if (ip) await kv.delete(KEY_FAIL(ip));
}

export { ADMIN, FAIL_WINDOW, MAX_FAILS };
