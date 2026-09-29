// 跨语言兼容性测试：这套 WebCrypto 实现必须与 Python 版 admin_auth.py 字节级一致。
// 基准值由 Python 侧 py 脚本生成，见 tests/fixtures.json。
//
// 跑法：node tests/compat.test.mjs

import { readFileSync } from "node:fs";
import {
  derive, sign, issueToken, verifyToken, randomHex, roundsSupported, ADMIN,
} from "../src/crypto.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf-8"));

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}`);
  if (!ok) {
    console.log(`        期望: ${expected}`);
    console.log(`        实际: ${actual}`);
    fail++;
  } else {
    pass++;
  }
}

console.log("\n[1] PBKDF2-HMAC-SHA256 与 Python hashlib.pbkdf2_hmac 对齐");
// fixtures 里有两份基准：hash_100k（10 万轮，当前默认值）与 hash（12 万轮，Python 版历史值）。
// 用默认轮数比 —— 线上登录校验走的就是这条。两边都是 RFC 8018 标准实现，
// 只要轮数相同就必然逐字节相同。
check("derive(password, saltHex) 全等（默认轮数 = 10 万）",
  await derive(fx.pw, fx.salt), fx.hash_100k);

// Workers 的 WebCrypto 硬上限是 10 万轮，超了直接抛错（线上表现为登录 500）。
check("默认轮数不超 Workers 上限", ADMIN.PBKDF2_ROUNDS <= ADMIN.PBKDF2_MAX_ROUNDS, true);
check("默认轮数就是 10 万", ADMIN.PBKDF2_ROUNDS, 100000);
check("roundsSupported(120000) 为 false（库本身能算，Workers 不能）",
  roundsSupported(120000), false);
check("roundsSupported(100000) 为 true", roundsSupported(100000), true);
check("roundsSupported(undefined) 为 false", roundsSupported(undefined), false);

let threw = "";
try {
  await derive(fx.pw, fx.salt, 120000);
} catch (e) {
  threw = String(e.message || e);
}
check("超过上限的轮数会抛出可读错误（而不是交给运行时抛底层文案）",
  /超过 Workers 上限/.test(threw), true);

console.log("\n[2] HMAC-SHA256 base64url(无 padding) 与 Python hmac.new 对齐");
check("sign(secret, payload) 全等", await sign(fx.secret, fx.payload), fx.token_sig);

console.log("\n[3] 令牌签发 → 校验 往返");
const tok = await issueToken(fx.secret, 3600);
check("verifyToken 接受自己签发的令牌", await verifyToken(fx.secret, tok), true);
check("verifyToken 拒绝错误密钥", await verifyToken(randomHex(32), tok), false);
check("verifyToken 拒绝空令牌", await verifyToken(fx.secret, ""), false);
check("verifyToken 拒绝无点号的串", await verifyToken(fx.secret, "abcdef"), false);

console.log("\n[4] 过期令牌必须失效");
const expired = await issueToken(fx.secret, -10); // 负 ttl = 已过期
check("verifyToken 拒绝过期令牌", await verifyToken(fx.secret, expired), false);

console.log("\n[5] 空 secret 不应放行");
check("verifyToken 空密钥返回 false", await verifyToken("", tok), false);

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
