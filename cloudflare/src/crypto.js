// WebCrypto 实现，刻意与 Python 版 admin_auth.py **字节级兼容**。
//
// 对应关系：
//   Python  hashlib.pbkdf2_hmac("sha256", pw, bytes.fromhex(salt), 120000).hex()
//   JS      crypto.subtle.deriveBits({PBKDF2, SHA-256, 120000}, ...).toHex()
//
//   Python  base64.urlsafe_b64encode(hmac.digest()).decode().rstrip("=")
//   JS      base64url(.sign()), 同样替换 +/ 并去掉尾部 =
//
// 两边都是 RFC 8018(PBKDF2) / RFC 2104(HMAC) 标准实现，结果一致。
// 好处：现有的 data/admin.json 可以整体迁移过来，密码不用重设，已登录会话继续有效。

// ⚠️ Workers 的 WebCrypto 对 PBKDF2 轮数有硬上限：**10 万轮**。
// 超过不是变慢，是直接抛 "Pbkdf2 failed: iteration counts above 100000
// are not supported" —— 表现为后台登录一律 500「服务端内部错误」。
//
// Python 版本用 120000 轮，迁移过来必须降到上限以内；因此轮数不再写死，
// 而是随密钥记录一起存（见 store.js 的 rounds 字段），校验时按记录里的
// 轮数复算 —— 这样以后想调轮数也不会让已有密码失效（前提是不超上限）。
const PBKDF2_ROUNDS = 100_000;
const PBKDF2_MAX_ROUNDS = 100_000;   // Workers 硬上限，超过必然抛错
const PBKDF2_LEGACY_ROUNDS = 120_000; // Python 版历史值：Workers 上算不出来
const SESSION_TTL = 12 * 3600;
const MIN_PASSWORD_LEN = 6;
const COOKIE_NAME = "wb_admin";

export const ADMIN = {
  PBKDF2_ROUNDS,
  PBKDF2_MAX_ROUNDS,
  PBKDF2_LEGACY_ROUNDS,
  SESSION_TTL,
  MIN_PASSWORD_LEN,
  COOKIE_NAME,
};

const enc = new TextEncoder();

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const clean = (hex || "").replace(/[^0-9a-f]/gi, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base64url(bytes) {
  let s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 生成随机 hex salt / secret */
export function randomHex(byteLen = 16) {
  const b = crypto.getRandomValues(new Uint8Array(byteLen));
  return bytesToHex(b);
}

/**
 * PBKDF2-HMAC-SHA256 → hex 字符串，与 Python 版算法一致。
 *
 * rounds 必须显式传入（默认取现行值）：校验旧密码时要用**当初写入时**的轮数，
 * 否则改了默认值就会把所有已存的密码判成错误。
 */
export async function derive(password, saltHex, rounds = PBKDF2_ROUNDS) {
  if (rounds > PBKDF2_MAX_ROUNDS) {
    // 提前拦下，抛可读的错误而不是让 WebCrypto 抛出底层文案
    throw new Error(`PBKDF2 轮数 ${rounds} 超过 Workers 上限 ${PBKDF2_MAX_ROUNDS}`);
  }
  const key = await crypto.subtle.importKey("raw", enc.encode(password || ""), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: rounds, hash: "SHA-256" },
    key,
    256,
  );
  return bytesToHex(bits);
}

/** 该轮数在本运行时能否算出（历史记录可能是 Python 侧 12 万轮写的） */
export function roundsSupported(rounds) {
  return Number.isFinite(rounds) && rounds > 0 && rounds <= PBKDF2_MAX_ROUNDS;
}

/** HMAC-SHA256 → base64url(无 padding)，与 Python 版完全一致 */
export async function sign(secret, payload) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(String(payload)));
  return base64url(mac);
}

/** 签发 exp.sig 令牌 */
export async function issueToken(secret, ttl = SESSION_TTL) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  return `${exp}.${await sign(secret, exp)}`;
}

/** 校验令牌；过期、签名不符、未初始化一律 false */
export async function verifyToken(secret, token) {
  if (!secret || !token) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const expStr = token.slice(0, dot);
  if (!/^\d+$/.test(expStr)) return false;
  if (Number(expStr) < Math.floor(Date.now() / 1000)) return false;
  return constantTimeEqual(await sign(secret, expStr), token.slice(dot + 1));
}

export { constantTimeEqual, base64url };
