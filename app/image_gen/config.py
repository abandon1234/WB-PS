# -*- coding: utf-8 -*-
"""图片生成 —— 中转站配置存储。

配置落在项目根的 `data/image_providers.json`，内含 API key 等敏感信息，
已在 .gitignore 中排除，不会进版本库。

一份配置包含：名称、中转站地址、API key、模型名、启用状态。
多份配置里由 `active_id` 指定当前使用哪一个。
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_DIR = os.path.join(ROOT, "data")
CONFIG_FILE = os.path.join(DATA_DIR, "image_providers.json")

DEFAULT_MODEL = "gpt-image-2"
DEFAULT_SIZE = "1024x1024"
ALLOWED_SIZES = ("1024x1024", "1536x1024", "1024x1536", "auto", "512x512", "1792x1024", "1024x1792")

_lock = threading.RLock()

# 首次使用时预置的默认中转站（用户可直接在界面上改或删）
_SEED = {
    "name": "默认中转站",
    "base_url": "https://code.linlong520.com",
    "api_key": "",
    "model": DEFAULT_MODEL,
    "note": "",
}


# ------------------------------------------------------------------ 存取

def _blank() -> Dict[str, Any]:
    return {"providers": [], "active_id": None, "version": 1}


def load() -> Dict[str, Any]:
    with _lock:
        if not os.path.isfile(CONFIG_FILE):
            return _blank()
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as fp:
                data = json.load(fp)
            if not isinstance(data, dict):
                return _blank()
            data.setdefault("providers", [])
            data.setdefault("active_id", None)
            return data
        except Exception:                     # noqa: BLE001
            return _blank()


def save(data: Dict[str, Any]) -> None:
    with _lock:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = CONFIG_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fp:
            json.dump(data, fp, ensure_ascii=False, indent=2)
        os.replace(tmp, CONFIG_FILE)          # 原子替换，避免写一半损坏


# ------------------------------------------------------------------ 校验

def _clean_base_url(url: str) -> str:
    u = (url or "").strip().rstrip("/")
    if not u:
        raise ValueError("中转站地址不能为空")
    if not (u.startswith("http://") or u.startswith("https://")):
        raise ValueError("中转站地址需以 http:// 或 https:// 开头")
    # 允许用户填带 /v1 的地址，统一剥掉，调用时再拼
    if u.endswith("/v1"):
        u = u[:-3]
    return u


def _clean_model(model: str) -> str:
    m = (model or "").strip() or DEFAULT_MODEL
    if len(m) > 120:
        raise ValueError("模型名过长")
    return m


def _mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 12:
        return "*" * len(key)
    return f"{key[:6]}{'*' * 6}{key[-4:]}"


def public_view(p: Dict[str, Any], reveal: bool = True) -> Dict[str, Any]:
    """对外暴露的配置视图。reveal=False 时把 key 打码。"""
    out = dict(p)
    out["api_key"] = (p.get("api_key") or "") if reveal else _mask_key(p.get("api_key") or "")
    out["has_key"] = bool((p.get("api_key") or "").strip())
    return out


# ------------------------------------------------------------------ CRUD

def list_providers(reveal: bool = True) -> List[Dict[str, Any]]:
    data = load()
    return [public_view(p, reveal) for p in data.get("providers", [])]


def get_provider(pid: str) -> Optional[Dict[str, Any]]:
    for p in load().get("providers", []):
        if p.get("id") == pid:
            return p
    return None


def active_provider() -> Optional[Dict[str, Any]]:
    """返回当前应使用的配置：优先 active_id，其次第一个启用的。"""
    data = load()
    providers = data.get("providers", [])
    aid = data.get("active_id")
    for p in providers:
        if p.get("id") == aid and p.get("enabled"):
            return p
    for p in providers:
        if p.get("enabled"):
            return p
    return None


def add_provider(name: str, base_url: str, api_key: str,
                 model: str = DEFAULT_MODEL, note: str = "",
                 enabled: bool = True) -> Dict[str, Any]:
    item = {
        "id": uuid.uuid4().hex[:12],
        "name": (name or "").strip() or "未命名中转站",
        "base_url": _clean_base_url(base_url),
        "api_key": (api_key or "").strip(),
        "model": _clean_model(model),
        "note": (note or "").strip()[:200],
        "enabled": bool(enabled),
        "created_at": round(time.time(), 1),
        "updated_at": round(time.time(), 1),
    }
    if not item["api_key"]:
        raise ValueError("API key 不能为空")

    with _lock:
        data = load()
        data["providers"].append(item)
        if not data.get("active_id"):
            data["active_id"] = item["id"]
        save(data)
    return item


def update_provider(pid: str, **fields) -> Dict[str, Any]:
    with _lock:
        data = load()
        for p in data["providers"]:
            if p.get("id") != pid:
                continue
            if "name" in fields and fields["name"] is not None:
                p["name"] = (fields["name"] or "").strip() or p["name"]
            if "base_url" in fields and fields["base_url"]:
                p["base_url"] = _clean_base_url(fields["base_url"])
            # api_key 传空字符串表示"不修改"，避免前端拿到打码值后误覆盖
            if fields.get("api_key"):
                p["api_key"] = fields["api_key"].strip()
            if "model" in fields and fields["model"]:
                p["model"] = _clean_model(fields["model"])
            if "note" in fields and fields["note"] is not None:
                p["note"] = (fields["note"] or "").strip()[:200]
            if "enabled" in fields and fields["enabled"] is not None:
                p["enabled"] = bool(fields["enabled"])
            p["updated_at"] = round(time.time(), 1)
            save(data)
            return p
    raise KeyError(f"配置不存在: {pid}")


def delete_provider(pid: str) -> bool:
    with _lock:
        data = load()
        before = len(data["providers"])
        data["providers"] = [p for p in data["providers"] if p.get("id") != pid]
        if len(data["providers"]) == before:
            return False
        if data.get("active_id") == pid:
            nxt = next((p["id"] for p in data["providers"] if p.get("enabled")), None)
            data["active_id"] = nxt
        save(data)
    return True


def set_enabled(pid: str, enabled: bool) -> Dict[str, Any]:
    p = update_provider(pid, enabled=enabled)
    # 禁用掉当前使用的配置时，自动切到下一个可用的
    if not enabled:
        data = load()
        if data.get("active_id") == pid:
            nxt = next((x["id"] for x in data["providers"] if x.get("enabled")), None)
            if nxt:
                set_active(nxt)
    return p


def set_active(pid: str) -> Dict[str, Any]:
    with _lock:
        data = load()
        target = next((p for p in data["providers"] if p.get("id") == pid), None)
        if target is None:
            raise KeyError(f"配置不存在: {pid}")
        if not target.get("enabled"):
            raise ValueError("该配置已被禁用，请先启用")
        data["active_id"] = pid
        save(data)
        return target


def ensure_seed() -> None:
    """首次运行时写入一条空白配置，方便用户在界面上直接填写。"""
    data = load()
    if not data.get("providers"):
        try:
            item = dict(_SEED)
            item.update({
                "id": uuid.uuid4().hex[:12],
                "api_key": "",
                "enabled": False,
                "created_at": round(time.time(), 1),
                "updated_at": round(time.time(), 1),
            })
            data["providers"] = [item]
            data["active_id"] = item["id"]
            save(data)
        except Exception:                     # noqa: BLE001
            pass
