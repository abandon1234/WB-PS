# -*- coding: utf-8 -*-
"""图片生成 —— 中转站 API 客户端。

实测得到的两条重要结论（针对 OpenAI 兼容中转站）：

1. **参照图走 `generations` 接口的 `image` 字段**（data URL 字符串），
   而不是标准 `/v1/images/edits`——后者在很多中转站上直接返回空 data。
   已用"洋红底 + 中央白方块"的强特征参照图验证过：生成结果洋红占比 85.8%，
   证明确实作为条件输入生效。

2. **`b64_json` 返回的是 data URL**（带 `data:image/png;base64,` 前缀），
   不是纯 base64；直接 b64decode 会因长度非 4 的倍数而报错。
   这里统一剥离前缀并补齐 padding。
"""
from __future__ import annotations

import base64
import json
import os
import ssl
import time
import urllib.error
import urllib.request
import uuid
from typing import Any, Dict, List, Optional, Tuple

DEFAULT_TIMEOUT = 300
MAX_PROMPT_LEN = 4000
MAX_REFERENCES = 4
MAX_REF_BYTES = 8 * 1024 * 1024


class GenError(RuntimeError):
    """带用户可读信息的生成错误。"""

    def __init__(self, message: str, *, status: Optional[int] = None,
                 detail: str = "", hint: str = ""):
        super().__init__(message)
        self.message = message
        self.status = status
        self.detail = detail
        self.hint = hint

    def to_dict(self) -> Dict[str, Any]:
        return {"message": self.message, "status": self.status,
                "detail": self.detail, "hint": self.hint}


# ------------------------------------------------------------------ 工具

def _opener(proxy: str = ""):
    """构造不带环境代理的 opener。

    本机常驻代理环境变量会干扰对外请求，这里显式清理；
    需要走代理时由配置里的 proxy 字段单独指定。
    """
    handlers: List[Any] = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    else:
        handlers.append(urllib.request.ProxyHandler({}))
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    handlers.append(urllib.request.HTTPSHandler(context=ctx))
    return urllib.request.build_opener(*handlers)


def _decode_b64_field(value: str) -> bytes:
    """b64_json 可能是纯 base64，也可能是 data URL，统一解码。"""
    raw = value.split(",", 1)[1] if value.startswith("data:") else value
    raw = raw.strip()
    raw += "=" * (-len(raw) % 4)              # 补齐 padding
    return base64.b64decode(raw)


def _extract_error(status: int, body: bytes) -> Tuple[str, str]:
    """从中转站错误响应里提炼可读信息。"""
    text = body.decode("utf-8", "ignore").strip()
    detail = text[:500]
    try:
        j = json.loads(text)
        if isinstance(j, dict):
            err = j.get("error")
            if isinstance(err, dict):
                detail = err.get("message") or j.get("message") or detail
            elif isinstance(err, str):
                detail = err
            else:
                detail = j.get("message") or j.get("detail") or detail
    except Exception:                         # noqa: BLE001
        pass

    hints = {
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
    }
    msg = hints.get(status, f"中转站返回 HTTP {status}")
    return msg, detail


# ------------------------------------------------------------------ 主流程

def generate(provider: Dict[str, Any], prompt: str,
             size: str = "1024x1024", n: int = 1,
             references: Optional[List[Tuple[bytes, str]]] = None,
             timeout: int = DEFAULT_TIMEOUT) -> Dict[str, Any]:
    """调用中转站生成图片。

    Args:
        provider:   配置项（含 base_url / api_key / model / proxy）。
        prompt:     提示词。
        size:       尺寸，如 1024x1024。
        n:          生成数量（1~4）。
        references: [(图片字节, 文件名), ...]，传入则作为条件输入；
                    多张会以数组形式一起下发。

    Returns:
        {"images": [...], "elapsed": ..., "used_reference": bool, ...}
    """
    base = (provider.get("base_url") or "").rstrip("/")
    key = (provider.get("api_key") or "").strip()
    model = (provider.get("model") or "gpt-image-2").strip()
    proxy = (provider.get("proxy") or "").strip()

    if not base:
        raise GenError("未配置中转站地址", hint="请在「中转站配置」里填写地址")
    if not key:
        raise GenError("未配置 API key", hint="请在「中转站配置」里填写 key")

    prompt = (prompt or "").strip()
    if not prompt:
        raise GenError("提示词不能为空", hint="描述你想生成的画面")
    if len(prompt) > MAX_PROMPT_LEN:
        raise GenError(f"提示词过长（{len(prompt)} 字，上限 {MAX_PROMPT_LEN}）")

    n = max(1, min(int(n or 1), 4))
    size = (size or "1024x1024").strip()

    payload: Dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "n": n,
        "size": size,
    }

    # 参照图：走 generations 的 image 字段（标准 edits 接口多数中转站未实现）
    refs = [r for r in (references or []) if r and r[0]][:MAX_REFERENCES]
    used_ref = False
    if refs:
        urls: List[str] = []
        for data, _fn in refs:
            if len(data) > MAX_REF_BYTES:
                raise GenError(f"参照图过大（{len(data) / 1048576:.1f}MB，上限 8MB）",
                               hint="请压缩后再试")
            ext = "jpeg" if data[:2] == b"\xff\xd8" else "png"
            urls.append(f"data:image/{ext};base64," + base64.b64encode(data).decode())
        payload["image"] = urls[0] if len(urls) == 1 else urls
        used_ref = True

    url = f"{base}/v1/images/generations"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "WB-PS-ImageGen/1.0",
    })

    op = _opener(proxy)
    t0 = time.time()
    try:
        with op.open(req, timeout=timeout) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as exc:
        msg, detail = _extract_error(exc.code, exc.read())
        raise GenError(msg, status=exc.code, detail=detail) from exc
    except urllib.error.URLError as exc:
        reason = str(getattr(exc, "reason", exc))
        raise GenError("无法连接中转站", detail=reason,
                       hint="检查地址是否正确、本机网络或 DNS 是否可达") from exc
    except TimeoutError as exc:
        raise GenError(f"生成超时（超过 {timeout}s）", status=408,
                       hint="图片生成较慢，可稍后重试或换用更小的尺寸") from exc
    except OSError as exc:
        raise GenError("请求发送失败", detail=str(exc)) from exc

    elapsed = time.time() - t0

    try:
        data = json.loads(raw.decode("utf-8", "ignore"))
    except Exception as exc:                  # noqa: BLE001
        raise GenError("中转站返回的不是合法 JSON", status=status,
                       detail=raw[:300].decode("utf-8", "ignore")) from exc

    items = data.get("data") or []
    if not isinstance(items, list) or not items:
        # 有的中转站在"内容被拦截"时返回空 data
        m365 = data.get("m365") or {}
        extra = f"（网关附加信息：{json.dumps(m365, ensure_ascii=False)}）" if m365 else ""
        raise GenError("中转站未返回图片", status=status,
                       detail=json.dumps(data, ensure_ascii=False)[:400],
                       hint="可能触发了内容审核，或该模型/尺寸不被支持" + extra)

    images: List[Dict[str, Any]] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        b64 = it.get("b64_json") or ""
        png: Optional[bytes] = None
        if b64:
            try:
                png = _decode_b64_field(b64)
            except Exception:                 # noqa: BLE001
                png = None
        entry = {
            "url": it.get("url") or it.get("image_url") or "",
            "revised_prompt": it.get("revised_prompt") or "",
            "bytes": len(png) if png else 0,
        }
        if png:
            entry["data_url"] = "data:image/png;base64," + base64.b64encode(png).decode()
        images.append(entry)

    if not images:
        raise GenError("中转站返回的数据里没有可用图片", status=status,
                       detail=json.dumps(data, ensure_ascii=False)[:400])

    return {
        "images": images,
        "elapsed": round(elapsed, 1),
        "used_reference": used_ref,
        "reference_count": len(refs),
        "endpoint": "/v1/images/generations",
        "model": model,
        "size": size,
        "count": len(images),
        "provider": {"id": provider.get("id"), "name": provider.get("name"),
                     "base_url": base},
    }


def ping(provider: Dict[str, Any], timeout: int = 30) -> Dict[str, Any]:
    """连通性测试：拉模型列表，并确认目标模型是否存在。"""
    base = (provider.get("base_url") or "").rstrip("/")
    key = (provider.get("api_key") or "").strip()
    model = (provider.get("model") or "").strip()
    if not base:
        raise GenError("未配置中转站地址")
    if not key:
        raise GenError("未配置 API key")

    req = urllib.request.Request(f"{base}/v1/models", headers={
        "Authorization": f"Bearer {key}", "Accept": "application/json"})
    op = _opener((provider.get("proxy") or "").strip())
    t0 = time.time()
    try:
        with op.open(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        msg, detail = _extract_error(exc.code, exc.read())
        raise GenError(msg, status=exc.code, detail=detail) from exc
    except urllib.error.URLError as exc:
        raise GenError("无法连接中转站", detail=str(getattr(exc, "reason", exc)),
                       hint="检查地址、网络与 DNS") from exc
    except TimeoutError as exc:
        raise GenError(f"连接超时（{timeout}s）") from exc

    elapsed = time.time() - t0
    try:
        data = json.loads(raw.decode("utf-8", "ignore"))
        ids = [m.get("id") for m in (data.get("data") or []) if isinstance(m, dict)]
    except Exception:                         # noqa: BLE001
        ids = []

    return {
        "ok": True,
        "elapsed": round(elapsed, 1),
        "model_count": len(ids),
        "model_found": (model in ids) if model else None,
        "matched": sorted([i for i in ids if model and model in str(i)])[:10],
    }
