# -*- coding: utf-8 -*-
"""图片生成 —— 后台管理鉴权。

设计要点：

* 管理密码只以 **PBKDF2-HMAC-SHA256** 哈希落盘（`data/admin.json`），
  明文既不落盘也不回传；接口只回答「是否已初始化」「当前是否已登录」这类布尔量。
* 登录成功后签发 **HMAC 签名令牌**，塞进 `HttpOnly; SameSite=Lax` 的 Cookie。
  前端 JS 读不到这个 Cookie，即便页面出现 XSS 也拿不走凭证。
* 所有 `/api/admin/*` 接口一律经 `require_admin` 校验，key 的下发一律打码。
* **不预置任何默认口令**：首次访问由使用者自己设定密码。忘记密码时删除
  `data/admin.json` 即可重新初始化（服务端没有任何后门入口）。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_DIR = os.path.join(ROOT, "data")
ADMIN_FILE = os.path.join(DATA_DIR, "admin.json")

COOKIE_NAME = "wb_admin"
SESSION_TTL = 12 * 3600              # 令牌有效期：12 小时
PBKDF2_ROUNDS = 120_000
MIN_PASSWORD_LEN = 6

MAX_FAILS = 6                        # 同一 IP 在窗口内的失败上限
FAIL_WINDOW = 300                    # 失败计数窗口：5 分钟
MAX_TRACKED_IPS = 512                # 防止内存无上限增长

_lock = threading.RLock()
_fails: Dict[str, List[float]] = {}


# ------------------------------------------------------------------ 存取

def _blank() -> Dict[str, Any]:
    return {"password_hash": "", "salt": "", "secret": "", "updated_at": 0.0}


def load_admin() -> Dict[str, Any]:
    with _lock:
        if not os.path.isfile(ADMIN_FILE):
            return _blank()
        try:
            with open(ADMIN_FILE, "r", encoding="utf-8") as fp:
                data = json.load(fp)
            if not isinstance(data, dict):
                return _blank()
            out = _blank()
            out.update({k: data.get(k, out[k]) for k in out})
            return out
        except Exception:                     # noqa: BLE001
            return _blank()


def save_admin(data: Dict[str, Any]) -> None:
    with _lock:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = ADMIN_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fp:
            json.dump(data, fp, ensure_ascii=False, indent=2)
        os.replace(tmp, ADMIN_FILE)
        try:
            os.chmod(ADMIN_FILE, 0o600)
        except Exception:                     # noqa: BLE001
            pass                              # Windows 上不总是生效，忽略


# ------------------------------------------------------------------ 口令

def needs_setup() -> bool:
    """是否尚未设定管理密码。"""
    return not (load_admin().get("password_hash") or "")


def _derive(password: str, salt: str) -> str:
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                             bytes.fromhex(salt), PBKDF2_ROUNDS)
    return dk.hex()


def set_password(password: str) -> None:
    """设置/重置管理密码（会同时轮换签名密钥，旧会话全部失效）。"""
    pw = (password or "").strip()
    if len(pw) < MIN_PASSWORD_LEN:
        raise ValueError(f"密码至少 {MIN_PASSWORD_LEN} 位")
    if len(pw) > 128:
        raise ValueError("密码过长")
    salt = secrets.token_hex(16)
    data = {
        "password_hash": _derive(pw, salt),
        "salt": salt,
        "secret": secrets.token_hex(32),
        "updated_at": round(time.time(), 1),
    }
    save_admin(data)


def verify_password(password: str) -> bool:
    data = load_admin()
    stored = data.get("password_hash") or ""
    salt = data.get("salt") or ""
    if not stored or not salt:
        return False
    try:
        calc = _derive(password or "", salt)
    except Exception:                         # noqa: BLE001
        return False
    return hmac.compare_digest(calc, stored)


def change_password(old: str, new: str) -> None:
    if not verify_password(old):
        raise ValueError("当前密码不正确")
    set_password(new)


# ------------------------------------------------------------------ 令牌

def _sign(secret: str, payload: str) -> str:
    mac = hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256)
    return base64.urlsafe_b64encode(mac.digest()).decode().rstrip("=")


def issue_token(ttl: int = SESSION_TTL) -> str:
    data = load_admin()
    secret = data.get("secret") or ""
    if not secret:                            # 尚未初始化时不签发
        raise RuntimeError("后台尚未初始化")
    exp = int(time.time()) + int(ttl)
    payload = f"{exp}"
    return f"{payload}.{_sign(secret, payload)}"


def verify_token(token: Optional[str]) -> bool:
    if not token or "." not in token:
        return False
    payload, _, sig = token.partition(".")
    if not payload.isdigit():
        return False
    if int(payload) < time.time():
        return False
    data = load_admin()
    secret = data.get("secret") or ""
    if not secret:
        return False
    return hmac.compare_digest(_sign(secret, payload), sig)


def token_from_request(request) -> str:
    """优先读 HttpOnly Cookie；其次读请求头，方便命令行/脚本调用。"""
    try:
        tok = request.cookies.get(COOKIE_NAME) or ""
    except Exception:                         # noqa: BLE001
        tok = ""
    if not tok:
        try:
            tok = request.headers.get("X-Admin-Token") or ""
        except Exception:                     # noqa: BLE001
            tok = ""
    return tok


# ------------------------------------------------------------------ 登录限速

def _prune(now: float) -> None:
    if len(_fails) <= MAX_TRACKED_IPS:
        return
    for ip in [k for k, v in _fails.items()
               if not [t for t in v if now - t < FAIL_WINDOW]][:MAX_TRACKED_IPS // 2]:
        _fails.pop(ip, None)


def locked_seconds(ip: str) -> int:
    """返回该 IP 还需等待的秒数，0 表示未锁定。"""
    now = time.time()
    with _lock:
        _prune(now)
        hits = [t for t in _fails.get(ip, []) if now - t < FAIL_WINDOW]
        _fails[ip] = hits
        if len(hits) < MAX_FAILS:
            return 0
        return max(1, int(FAIL_WINDOW - (now - hits[-1])))


def record_failure(ip: str) -> None:
    now = time.time()
    with _lock:
        hits = [t for t in _fails.get(ip, []) if now - t < FAIL_WINDOW]
        hits.append(now)
        _fails[ip] = hits
        _prune(now)


def remaining_attempts(ip: str) -> int:
    """本窗口内还剩几次尝试机会。"""
    now = time.time()
    with _lock:
        hits = [t for t in _fails.get(ip, []) if now - t < FAIL_WINDOW]
        return max(0, MAX_FAILS - len(hits))


def clear_failures(ip: str) -> None:
    with _lock:
        _fails.pop(ip, None)


def state() -> Dict[str, Any]:
    """给前端的非敏感状态。绝不含哈希、盐、密钥。"""
    data = load_admin()
    return {
        "needs_setup": not bool(data.get("password_hash")),
        "min_password_len": MIN_PASSWORD_LEN,
        "session_hours": SESSION_TTL // 3600,
    }
