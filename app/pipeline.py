# -*- coding: utf-8 -*-
"""编排层：把检测 → 样式分析 → 擦除 → 重绘 串成完整流水线。

核心约定
--------
* **无状态**：每次请求都从原图重新计算，结果可复现、可回滚。
* **擦除上下文固定**：所有擦除都基于同一张原图计算，避免"先后顺序"污染 inpaint 参考像素。
* **逐框独立**：每个文字框的擦除与重绘互不影响，因此前端局部预览与最终结果完全一致。
"""
from __future__ import annotations

from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np

from . import ocr_engine, style_analyzer, text_eraser, text_renderer


# ------------------------------------------------------------------ 工具

def decode_image(data: bytes) -> np.ndarray:
    """字节 → BGR 图像（支持中文路径无关，纯内存解码）。"""
    buf = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("无法解码图片，请确认文件格式（PNG/JPG/WEBP/BMP）")
    return img


def encode_image(img: np.ndarray, ext: str = ".png", quality: int = 95) -> bytes:
    """BGR 图像 → 字节。"""
    params = []
    if ext.lower() in (".jpg", ".jpeg"):
        params = [cv2.IMWRITE_JPEG_QUALITY, int(quality)]
    elif ext.lower() == ".webp":
        params = [cv2.IMWRITE_WEBP_QUALITY, int(quality)]
    ok, buf = cv2.imencode(ext, img, params)
    if not ok:
        raise ValueError("图片编码失败")
    return buf.tobytes()


def crop(img: np.ndarray, box: Tuple[int, int, int, int],
         pad: int = 0) -> Tuple[np.ndarray, Tuple[int, int, int, int]]:
    """裁剪并返回 (patch, 实际使用的 box)。"""
    H, W = img.shape[:2]
    x = max(0, int(box[0]) - pad)
    y = max(0, int(box[1]) - pad)
    x2 = min(W, int(box[0]) + int(box[2]) + pad)
    y2 = min(H, int(box[1]) + int(box[3]) + pad)
    return img[y:y2, x:x2].copy(), (x, y, x2 - x, y2 - y)


def union_box(a, b) -> Tuple[int, int, int, int]:
    x0 = min(a[0], b[0]); y0 = min(a[1], b[1])
    x1 = max(a[0] + a[2], b[0] + b[2])
    y1 = max(a[1] + a[3], b[1] + b[3])
    return (x0, y0, max(x1 - x0, 1), max(y1 - y0, 1))


# ------------------------------------------------------------------ 分析

def analyze(image_bgr: np.ndarray, merge_lines: bool = True,
            min_score: float = 0.35) -> dict:
    """检测文字并分析每个框的样式。"""
    items = ocr_engine.detect(image_bgr, merge=merge_lines, min_score=min_score)
    style_analyzer.analyze_many(image_bgr, items)
    H, W = image_bgr.shape[:2]
    return {
        "width": W,
        "height": H,
        "backend": ocr_engine.backend_name(),
        "count": len(items),
        "items": items,
    }


# ------------------------------------------------------------------ 编辑参数

def _edit_params(item: dict, edit: dict) -> dict:
    """把前端 edit 对象翻译成 renderer 的入参。"""
    style = item.get("style") or {}
    rect = item["rect"]

    family = edit.get("family") or None
    bold = edit.get("bold")
    if bold is None:
        bold = style.get("bold", False)
    fg = edit.get("fg_color")
    if fg is None:
        fg = style.get("fg_color")

    # 字号允许相对缩放（ratio）或绝对指定（font_size）
    font_size = edit.get("font_size")
    if font_size in (None, 0, ""):
        ratio = float(edit.get("font_scale") or 1.0)
        if abs(ratio - 1.0) > 1e-6:
            base = style.get("font_size") or max(int(rect["h"] * 0.86), 8)
            font_size = max(6, int(round(base * ratio)))
        else:
            font_size = None

    return {
        "family": family,
        "font_size": font_size,
        "fg_color": fg,
        "bold": bold,
        "italic": bool(edit.get("italic", False)),
        "align": edit.get("align") or style.get("align") or "left",
        "valign": edit.get("valign") or "bottom",
        "offset": (int(edit.get("offset_x") or 0), int(edit.get("offset_y") or 0)),
        "letter_spacing": float(edit.get("letter_spacing") or 0.0),
        "auto_fit": bool(edit.get("auto_fit", False)),
        "match_sharpness": bool(edit.get("match_sharpness", True)),
        "match_stroke": bool(edit.get("match_stroke", True)),
        "auto_family": bool(edit.get("auto_family", True)),
        "shadow": edit.get("shadow") or None,
    }


def _erase_method(edit: dict, style: dict) -> str:
    m = (edit.get("erase_method") or "auto").lower()
    if m not in ("auto", "fill", "linear", "inpaint", "ns", "telea", "blur"):
        m = "auto"
    return m


def _dirty(edit: dict, item: dict) -> bool:
    """判断该编辑是否真的需要动图（避免无意义的擦除重绘）。"""
    if not edit.get("enabled", True):
        return False
    new_text = edit.get("text")
    if new_text is not None and str(new_text) != str(item.get("text", "")):
        return True
    if edit.get("force"):
        return True
    style = item.get("style") or {}
    checks = (
        ("family", None),
        ("font_size", None),
        ("font_scale", 1.0),
        ("fg_color", style.get("fg_color")),
        ("bold", style.get("bold")),
        ("align", style.get("align")),
        ("valign", "bottom"),
        ("erase_method", "auto"),
    )
    for key, default in checks:
        if key in edit and edit[key] not in (None, "", default):
            # 颜色做数值比较
            if key == "fg_color" and default is not None:
                if list(edit[key]) == list(default):
                    continue
            return True
    for key in ("italic", "offset_x", "offset_y", "letter_spacing"):
        v = edit.get(key)
        if v not in (None, 0, 0.0, False):
            return True
    # 开关类字段：与默认值不同才需要重绘
    switches = {"auto_fit": False, "match_sharpness": True,
                "auto_family": True, "match_stroke": True}
    for key, default in switches.items():
        if key in edit and bool(edit[key]) != default:
            return True
    if edit.get("enabled") is False:
        return True
    return False


def _erase_all(image_bgr: np.ndarray, targets: List[Tuple[dict, dict]]) -> np.ndarray:
    """批量擦除。所有擦除都基于同一张原图，结果互不污染。"""
    base = image_bgr.copy()
    for item, edit in targets:
        rect = item["rect"]
        style = item.get("style") or {}
        try:
            erased, meta = text_eraser.erase(
                image_bgr, rect, style, method=_erase_method(edit, style),
                grow=int(edit.get("erase_grow") or 2),
            )
        except Exception:                    # noqa: BLE001
            continue
        x, y, w, h = meta["box"]
        base[y:y + h, x:x + w] = erased[y:y + h, x:x + w]
    return base


# ------------------------------------------------------------------ 应用

def apply_edits(image_bgr: np.ndarray, items: List[dict],
                edits: Dict[str, dict], new_items: Optional[List[dict]] = None
                ) -> Tuple[np.ndarray, dict]:
    """执行全部编辑，返回 (结果图, 统计)。

    Args:
        items:     原始检测结果（含 rect / text / style）。
        edits:     {item_id: edit}，只处理 enabled 且真正有变化的项。
        new_items: 用户手动新增的文字 [{rect, text, style?, ...}]。
    """
    edits = edits or {}

    targets: List[Tuple[dict, dict]] = []
    for it in items:
        edit = edits.get(str(it.get("id"))) or edits.get(it.get("id"))
        if not edit:
            continue
        if _dirty(edit, it):
            targets.append((it, edit))

    out = _erase_all(image_bgr, targets) if targets else image_bgr.copy()

    log: List[dict] = []
    # 按 y 再按 x 绘制，保证叠压顺序符合直觉
    for it, edit in sorted(targets, key=lambda t: (t[0]["rect"]["y"], t[0]["rect"]["x"])):
        new_text = edit.get("text")
        new_text = it.get("text", "") if new_text is None else str(new_text)
        record = {"id": it.get("id"), "origin": it.get("text", ""), "text": new_text}

        if not new_text.strip():             # 文本被清空 → 只擦不画
            record["action"] = "erase"
            log.append(record)
            continue

        params = _edit_params(it, edit)
        try:
            res = text_renderer.render(out, it["rect"], new_text,
                                       it.get("style") or {},
                                       match_source=image_bgr,
                                       source_text=it.get("text", ""),
                                       **params)
        except Exception as exc:             # noqa: BLE001
            record["action"] = "error"
            record["error"] = str(exc)
            log.append(record)
            continue
        out = res.image
        record.update({"action": "replace", "font_size": res.font_size,
                       "family": res.family, "fitted": res.fitted,
                       "stroke": res.stroke, "matched": res.matched,
                       "box": list(res.box)})
        if res.warnings:
            record["warnings"] = res.warnings
        log.append(record)

    # ---- 手动新增文字 ----
    for i, add in enumerate(new_items or []):
        rect = add.get("rect")
        text = str(add.get("text") or "")
        if not rect or not text.strip():
            continue
        style = dict(add.get("style") or {})
        # 新增文字若未指定颜色，用采样到的背景决定对比色
        if not style.get("fg_color"):
            style["fg_color"] = [17, 17, 17] if not style.get("light_text") else [255, 255, 255]
        style.setdefault("ink_rect", None)
        style.setdefault("ink_height", int(rect["h"] * 0.86))
        style.setdefault("align", "left")
        edit = {"text": text, "auto_fit": False, **{k: v for k, v in add.items()
                                                    if k in ("family", "font_size", "fg_color",
                                                             "bold", "italic", "align",
                                                             "offset_x", "offset_y",
                                                             "letter_spacing")}}
        params = _edit_params({"rect": rect, "style": style}, edit)
        params["auto_fit"] = False
        try:
            res = text_renderer.render(out, rect, text, style, **params)
        except Exception as exc:             # noqa: BLE001
            log.append({"id": f"new-{i}", "action": "error", "error": str(exc)})
            continue
        out = res.image
        log.append({"id": f"new-{i}", "action": "insert", "text": text,
                    "font_size": res.font_size, "family": res.family})

    stats = {
        "erased": len(targets),
        "rendered": sum(1 for r in log if r.get("action") in ("replace", "insert")),
        "log": log,
    }
    return out, stats


# ------------------------------------------------------------------ 单框预览

def preview_item(image_bgr: np.ndarray, item: dict, edit: dict,
                 pad: int = 10) -> Tuple[bytes, dict]:
    """只处理一个文字框，返回局部 patch 的 PNG 字节，供前端实时预览。"""
    rect = item["rect"]
    style = item.get("style") or {}

    # 擦除（基于原图，保证上下文一致）
    try:
        erased, meta = text_eraser.erase(
            image_bgr, rect, style, method=_erase_method(edit, style),
            grow=int(edit.get("erase_grow") or 2),
        )
    except Exception:                        # noqa: BLE001
        erased, meta = image_bgr.copy(), {"box": (rect["x"], rect["y"],
                                                  rect["w"], rect["h"])}

    base = image_bgr.copy()
    ex, ey, ew, eh = meta["box"]
    base[ey:ey + eh, ex:ex + ew] = erased[ey:ey + eh, ex:ex + ew]

    new_text = edit.get("text")
    new_text = item.get("text", "") if new_text is None else str(new_text)

    info: dict = {"font_size": style.get("font_size"), "family": None,
                  "fitted": False, "warnings": [], "stroke": {}, "matched": {}}
    if new_text.strip():
        params = _edit_params(item, edit)
        try:
            res = text_renderer.render(base, rect, new_text, style,
                                       match_source=image_bgr,
                                       source_text=item.get("text", ""),
                                       **params)
        except Exception as exc:             # noqa: BLE001
            info["warnings"].append(str(exc))
        else:
            base = res.image
            info.update({"font_size": res.font_size, "family": res.family,
                         "fitted": res.fitted, "warnings": res.warnings,
                         "stroke": res.stroke, "matched": res.matched,
                         "render_box": list(res.box)})

    region = union_box(meta["box"], (rect["x"], rect["y"], rect["w"], rect["h"]))
    rb = info.get("render_box")
    if rb:
        region = union_box(region, tuple(rb))
    patch, region = crop(base, region, pad=pad)
    info["region"] = list(region)
    info["erase_method"] = meta.get("method")
    return encode_image(patch, ".png"), info


# ------------------------------------------------------------------ 区域检测

def detect_mask_region(image_bgr: np.ndarray, rect: dict) -> dict:
    """判断给定区域能否安全擦除（给出背景类型与建议方法）。"""
    x, y = int(rect["x"]), int(rect["y"])
    w, h = int(rect["w"]), int(rect["h"])
    H, W = image_bgr.shape[:2]
    x = max(0, min(x, W - 2)); y = max(0, min(y, H - 2))
    w = max(2, min(w, W - x)); h = max(2, min(h, H - y))
    style = style_analyzer.analyze(image_bgr, {"x": x, "y": y, "w": w, "h": h})
    method = {"solid": "fill", "gradient": "linear"}.get(style["bg_type"], "inpaint")
    return {"rect": {"x": x, "y": y, "w": w, "h": h},
            "bg_type": style["bg_type"], "bg_std": style["bg_std"],
            "suggest_method": method, "style": style}
