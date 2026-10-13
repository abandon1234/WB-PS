# -*- coding: utf-8 -*-
"""图片翻译的文本上游（本地 dev / 无 Worker 时的同构实现）。

与 Cloudflare 版 cloudflare/src/routes/text.js **行为对齐**，包括：
  * 只收 texts[]，图片不出网（识别 / 擦除 / 重绘都在浏览器本机完成）
  * 模型取 provider 的 text_model；没配就明确报错，不静默失败
  * 只允许中 ↔ 英（现装 OCR 是 ch_PP-OCRv3，其余语言识别不出来）
  * 宽松解析模型输出（剥 ``` 围栏，认 {"texts":[...]} 与裸数组）

刻意复用 image_gen.client 的 _opener / _extract_error：
TLS 校验关闭与"不走环境代理"这两条是本机环境的既有约定，
各自再写一份早晚会漂移。
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, List

from .image_gen.client import GenError, _extract_error, _opener

MAX_TEXTS = 120
MAX_TEXT_LEN = 4000
MAX_TOTAL_CHARS = 40000

LANGS = {"zh": "中文（简体）", "en": "English"}

SYS_PROMPT = "\n".join([
    "You are a professional image-text translator.",
    "You receive a JSON array of strings OCR-ed from an image, and you translate every item.",
    "Rules:",
    "1. Output ONLY a JSON array of strings — same length, same order. No prose, no code fence.",
    "2. Translate each item naturally; keep it short enough to fit where the original was.",
    "3. Do NOT translate: numbers, prices, dates, URLs, emails, phone numbers, ID numbers, SKUs — keep them as-is.",
    "4. If an item is already in the target language, return it unchanged.",
    "5. Never merge or split items; one input item = one output item.",
])


def _parse_array(content: Any, expected: int) -> List[str] | None:
    """从模型输出里抠出 JSON 数组。容忍 ```json 围栏与前后多余文字。"""
    if not isinstance(content, str):
        return None
    s = content.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[-1]
        if s.endswith("```"):
            s = s[:-3]
        s = s.strip()
    a, b = s.find("["), s.rfind("]")
    if a >= 0 and b > a:
        s = s[a:b + 1]

    arr = None
    try:
        arr = json.loads(s)
    except Exception:                         # noqa: BLE001
        lines = [ln.strip(" \t-*0123456789.、)") for ln in s.split("\n")]
        lines = [ln for ln in lines if ln]
        if len(lines) == expected:
            arr = lines
    if not isinstance(arr, list):
        return None
    out = ["" if v is None else str(v) for v in arr]
    # 长度对不上宁可让前端降半批重试，也不猜 —— 错位的译文贴错位置比不翻更糟
    return out if len(out) == expected else None


def translate(provider: Dict[str, Any], texts: List[str],
              from_lang: str = "zh", to_lang: str = "en",
              timeout: int = 90) -> Dict[str, Any]:
    base = (provider.get("base_url") or "").rstrip("/")
    key = (provider.get("api_key") or "").strip()
    model = (provider.get("text_model") or "").strip()

    if not base:
        raise GenError("中转站地址未配置")
    if not key:
        raise GenError("API key 未配置", hint="请在「中转站配置」里更新 key")
    if not model:
        raise GenError("未配置文本模型", hint="请在后台「中转站配置」里填写「文本模型」，例如 gpt-4o-mini")

    src, dst = (from_lang or "zh").lower(), (to_lang or "en").lower()
    if src not in LANGS or dst not in LANGS:
        raise GenError(f"暂不支持的语言方向：{src} → {dst}", hint="本期只支持中 ↔ 英")
    if src == dst:
        raise GenError("源语言与目标语言相同")

    if not texts:
        raise GenError("没有需要翻译的文本")
    if len(texts) > MAX_TEXTS:
        raise GenError(f"一次最多翻译 {MAX_TEXTS} 行")
    if any(len(t) > MAX_TEXT_LEN for t in texts):
        raise GenError(f"单行文本过长（上限 {MAX_TEXT_LEN} 字符）")
    total = sum(len(t) for t in texts)
    if total > MAX_TOTAL_CHARS:
        raise GenError(f"本次文本总量过大（{total} 字符）", hint="少选几行再试")

    payload = {
        "model": model,
        "temperature": 0,
        # 刻意不带 response_format：部分中转站不认这个字段、会直接回 400。
        "messages": [
            {"role": "system", "content": SYS_PROMPT},
            {"role": "user", "content":
                f"Translate from {LANGS[src]} to {LANGS[dst]}.\n"
                f'Return a JSON object {{"texts": [...]}} with exactly {len(texts)} items.\n\n'
                + json.dumps(texts, ensure_ascii=False)},
        ],
    }

    req = urllib.request.Request(
        f"{base}/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "WB-PS-TextTranslate/1.0-py",
        },
        method="POST",
    )

    op = _opener((provider.get("proxy") or "").strip())
    try:
        with op.open(req, timeout=timeout) as resp:
            body = resp.read()
    except urllib.error.HTTPError as exc:
        msg, detail = _extract_error(exc.code, exc.read())
        raise GenError(msg, status=exc.code, detail=detail) from exc
    except Exception as exc:                  # noqa: BLE001
        raise GenError("无法连接中转站", detail=str(exc)) from exc

    try:
        data = json.loads(body.decode("utf-8", "ignore"))
    except Exception as exc:                  # noqa: BLE001
        raise GenError("中转站返回的不是合法 JSON", detail=body[:300].decode("utf-8", "ignore")) from exc

    choices = data.get("choices") or []
    choice = choices[0] if choices else {}
    content = ((choice.get("message") or {}).get("content")) or ""

    arr = None
    try:
        j = json.loads(str(content).strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip())
        if isinstance(j, dict) and isinstance(j.get("texts"), list):
            arr = ["" if v is None else str(v) for v in j["texts"]]
    except Exception:                          # noqa: BLE001
        pass
    if arr is None:
        arr = _parse_array(content, len(texts))

    if arr is None:
        raise GenError("译文解析失败", detail=str(content)[:300],
                       hint="模型没有按要求返回 JSON 数组，重试或换一个文本模型")
    if len(arr) != len(texts):
        raise GenError(f"译文行数对不上（要 {len(texts)} 行，返回 {len(arr)} 行）",
                       hint="已自动降半批重试，若持续失败请换用更稳定的文本模型")

    finish = choice.get("finish_reason") or ""
    return {"texts": arr, "from": src, "to": dst, "model": model,
            "finish_reason": finish, "truncated": finish == "length"}
