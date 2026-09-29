// 把现有 Python 版的 data/*.json 导成 Cloudflare KV 的批量导入文件。
//
// 因为这里的 PBKDF2 / HMAC 实现与 Python 版字节级兼容，
// admin.json（密码哈希 + 签名密钥）可以**整体搬过来**：
// 密码不用重设，已经发出的会话令牌继续有效。
//
// 用法：
//   node scripts/migrate.mjs           # 生成 cloudflare/kv-bulk.json
//   npx wrangler kv bulk put --binding=KV kv-bulk.json

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(root, "..", "data");
const OUT = path.join(root, "kv-bulk.json");

const entries = [];

function textify(v) {
  return typeof v === "string" ? v : JSON.stringify(v);
}

const adminPath = path.join(DATA, "admin.json");
if (existsSync(adminPath)) {
  const admin = JSON.parse(readFileSync(adminPath, "utf-8"));
  if (admin.password_hash && admin.salt && admin.secret) {
    entries.push({ key: "admin", value: textify(admin) });
    console.log("已读取 data/admin.json —— 管理密码与会话密钥可无缝迁移");
  } else {
    console.log("跳过 data/admin.json —— 尚未初始化（无密码哈希）");
  }
} else {
  console.log("跳过 data/admin.json —— 文件不存在，届时在云端后台重新设密码即可");
}

const provPath = path.join(DATA, "image_providers.json");
if (existsSync(provPath)) {
  const providers = JSON.parse(readFileSync(provPath, "utf-8"));
  const n = (providers.providers || []).length;
  entries.push({ key: "providers", value: textify(providers) });
  console.log(`已读取 data/image_providers.json —— ${n} 条中转站配置（含明文 API key，仅本地流转）`);
} else {
  console.log("跳过 data/image_providers.json —— 文件不存在");
}

if (!entries.length) {
  console.log("\n没有可迁移的数据，无需执行 kv bulk put。");
  process.exit(0);
}

writeFileSync(OUT, JSON.stringify(entries, null, 2), "utf-8");
console.log(`\n已生成 ${path.relative(root, OUT)}，接下去执行：`);
console.log("  npx wrangler kv bulk put --binding=KV kv-bulk.json");
console.log("\n提醒：该文件含明文 API key，导入完成后请删除，切勿提交进版本库。");
