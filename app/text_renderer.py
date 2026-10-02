# -*- coding: utf-8 -*-
"""文字重绘：把新文字按原样式"贴"回原位置。

无痕的四个关键点
----------------
1. **字号反推**：不是拍脑袋给字号，而是用目标墨迹高度 ÷ 字体的实测字面比例。
   同一段文字在不同字体下的字面高度差异很大，必须实测。
2. **超采样渲染**：4 倍分辨率绘制再缩回，得到接近系统级抗锯齿的平滑边缘。
3. **墨迹对齐**：对齐的是「墨迹外接框」而非 OCR 框，避免字体上升/下降部造成错位。
4. **清晰度匹配**：原图若经 JPEG 压缩、文字边缘偏糊，新文字会显突兀；
   因此按原图文字的边缘锐度对新文字做等量柔化。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from . import fonts

SS = 4                              # 超采样倍率
DEFAULT_SLOPE = 0.21                # 斜体错切比例
HARD_OVERFLOW = 1.80                # 未开启自适应时，超出此比例才强行收敛字号
FIT_FLOOR = 0.72                    # 字号收敛下限（相对原字号）


@dataclass
class RenderResult:
    image: np.ndarray
    box: Tuple[int, int, int, int]      # 实际绘制外接框 (x, y, w, h)
    font_size: int
    family: str
    fitted: bool                        # 是否因超宽触发了字号自适应
    warnings: List[str]
    stroke: dict = field(default_factory=dict)     # 笔画校准结果
    matched: dict = field(default_factory=dict)    # 字体度量匹配结果


# ------------------------------------------------------------------ 字体与度量

def _load_face(family: str, size: int, bold: bool, italic: bool):
    """返回 (字体对象, path, index)。"""
    fp = fonts.font_path_for(family, bold, italic)
    if fp is None:
        raise RuntimeError("系统未找到任何可用字体，请检查字体目录")
    path, index = fp
    return ImageFont.truetype(path, size, index=index), path, index


def _ref_char(text: str) -> str:
    """挑选用于校准字面比例的参考字符。"""
    if any("\u4e00" <= ch <= "\u9fff" for ch in text):
        return "国"                      # 满格汉字
    if any(ch.isupper() or ch.isdigit() for ch in text):
        return "H"                       # 大写高度
    if any("a" <= ch <= "z" for ch in text):
        return "x"                       # x-height
    return "H"


def _font_supports(font, text: str) -> bool:
    """粗判字体能否渲染 text 里的字符。

    PIL 对未映射字符会画 .notdef 字形（通常空白，少数是方框）。
    这里两路判断：渲染结果完全无墨迹，或与私有区字符的渲染完全一致 → 视为不支持。
    不做这层过滤，字体匹配会把中文文本"配"到 Calibri 这类纯拉丁字体上，
    随后墨迹度量全部失真（实测会把字号算成 1.7 倍）。
    """
    try:
        notdef = np.asarray(font.getmask("\uF8FF"))
    except Exception:                    # noqa: BLE001
        return True

    for ch in set(text):
        if ch.isspace():
            continue
        try:
            m = np.asarray(font.getmask(ch))
        except Exception:                # noqa: BLE001
            return False
        if not m.any():                  # 完全没有墨迹 → 该字形缺失
            return False
        if (notdef.any() and notdef.shape == m.shape
                and bool((notdef == m).all())):
            return False                 # 与 .notdef 一致 → 缺失
    return True


def _ink_ratio(family: str, bold: bool, italic: bool, text: str,
               probe: int = 240) -> float:
    """实测「参考字符墨迹高度 / 字号」，解决不同字体字面高差异。"""
    try:
        font, _p, _i = _load_face(family, probe, bold, italic)
    except Exception:                    # noqa: BLE001
        return 0.72
    canvas = Image.new("L", (probe * 4, probe * 4), 0)
    ImageDraw.Draw(canvas).text((probe, probe), _ref_char(text), font=font, fill=255)
    bbox = canvas.getbbox()
    if bbox is None:
        return 0.72
    return max((bbox[3] - bbox[1]) / probe, 0.05)


# ------------------------------------------------------------------ 图层绘制

def _draw_text_layer(text: str, font, path: str, index: int,
                     color: Tuple[int, int, int],
                     bold: bool, italic: bool,
                     stroke: float = 0.0,
                     shadow: Optional[dict] = None,
                     letter_spacing: float = 0.0) -> Image.Image:
    """在透明图层上以 SS 倍分辨率绘制一行文字，返回 1x 的 RGBA 图层。

    逐字符布局，因此支持字距调整；以 baseline 为锚点，保证跨字体基线一致。
    """
    size = font.size

    # 超采样字体
    try:
        big = ImageFont.truetype(path, max(4, int(round(size * SS))), index=index)
    except Exception:                    # noqa: BLE001
        big = font
        SS_eff = 1
    else:
        SS_eff = SS

    probe = ImageDraw.Draw(Image.new("L", (4, 4), 0))
    # 逐字符前进量（用超采样字体测量，保证精度）
    advances: List[float] = []
    for ch in text:
        try:
            adv = probe.textlength(ch, font=big)
        except Exception:                # noqa: BLE001
            adv = big.size * 0.6
        advances.append(adv)
    total_adv = sum(advances) + max(0.0, letter_spacing * SS_eff) * max(len(text) - 1, 0)

    if total_adv <= 0:
        return Image.new("RGBA", (1, 1), (0, 0, 0, 0))

    try:
        asc, desc = big.getmetrics()
    except Exception:                    # noqa: BLE001
        asc, desc = int(size * SS_eff * 0.86), int(size * SS_eff * 0.26)

    stroke_px = int(round(stroke * SS_eff))
    sh_dx = int(round((shadow or {}).get("dx", 2) * SS_eff)) if shadow else 0
    sh_dy = int(round((shadow or {}).get("dy", 2) * SS_eff)) if shadow else 0
    sh_extra = 2 * (abs(sh_dx) + abs(sh_dy) + stroke_px)

    pad = int(round(size * SS_eff * 0.35)) + stroke_px + sh_extra + 2
    W = int(np.ceil(total_adv)) + pad * 2
    H = asc + desc + pad * 2
    if italic:                           # 斜体向右倾，预留右侧空间
        W += int(DEFAULT_SLOPE * H) + 2

    layer = Image.new("RGBA", (max(W, 2), max(H, 2)), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    # 基线 y 坐标（所有字符共享同一条基线）
    baseline = pad + asc

    def emit(fill, dx, dy):
        x = pad
        for ch, adv in zip(text, advances):
            if ch.strip():
                draw.text((x + dx, baseline + dy), ch, font=big, fill=fill,
                          anchor="ls", stroke_width=stroke_px,
                          stroke_fill=fill)
            x += adv + letter_spacing * SS_eff

    if shadow:
        s_col = tuple(int(np.clip(c, 0, 255)) for c in shadow.get("color", (0, 0, 0)))
        a = int(np.clip(shadow.get("alpha", 90), 0, 255))
        emit(s_col + (a,), sh_dx, sh_dy)

    emit(tuple(color) + (255,), 0, 0)

    if italic:
        slope = DEFAULT_SLOPE
        # dest(x,y) = src(x + slope*(H - y), y)，基线附近几乎不动
        layer = layer.transform(
            layer.size, Image.AFFINE,
            (1, slope, -slope * (H - baseline), 0, 1, 0),
            resample=Image.BICUBIC,
        )

    layer = layer.resize((max(1, layer.width // SS_eff), max(1, layer.height // SS_eff)),
                         Image.LANCZOS)
    return layer


def _content_bbox(layer: Image.Image) -> Optional[Tuple[int, int, int, int]]:
    """图层内实际墨迹的外接框，返回 **(x, y, w, h)**。

    必须用 alpha 阈值而不是 `getbbox()`：LANCZOS 缩放会在字形轮廓外围
    产生极低 alpha 的振铃伪影（1~20 量级），`getbbox()` 把这些也算作"内容"，
    使测出的墨迹高度虚高——实测能多出 40px 以上，进而让垂直居中算错、
    整行文字上移。这里用 32 作为门槛滤掉振铃，同时保留真实抗锯齿边缘。
    """
    arr = np.asarray(layer.getchannel("A"))
    m = arr > 32
    if not m.any():
        return None
    ys, xs = np.where(m)
    return (int(xs.min()), int(ys.min()),
            int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1))


def _layer_stroke_width(layer: Image.Image) -> float:
    """测量渲染图层的笔画宽度（像素）。

    与 style_analyzer._stroke_width 采用同一套口径（距离变换 + 面积/周长），
    这样"原图笔画宽度"和"渲染笔画宽度"才可比较。
    """
    arr = np.asarray(layer)
    if arr.ndim != 3 or arr.shape[2] < 4:
        return 0.0
    m = (arr[..., 3] > 96).astype(np.uint8)
    area = float(m.sum())
    if area < 12:
        return 0.0

    dt = cv2.distanceTransform(m, cv2.DIST_L2, 5)
    vals = dt[dt > 0]
    dt_w = 0.0
    if vals.size:
        core = vals[vals >= np.percentile(vals, 80)]
        dt_w = float(np.median(core) * 2.0)

    ker = np.ones((3, 3), np.uint8)
    perim = float(cv2.morphologyEx(m, cv2.MORPH_GRADIENT, ker).sum())
    ap_w = 2.0 * area / perim if perim > 0 else 0.0

    if dt_w <= 0:
        return ap_w
    if ap_w <= 0:
        return dt_w
    if dt_w < 3.0:
        return 0.5 * (dt_w + ap_w)
    return 0.25 * ap_w + 0.75 * dt_w


# ------------------------------------------------------------------ 字体度量匹配

_METRIC_CACHE: dict = {}


def _text_metrics(family: str, text: str, bold: bool, italic: bool,
                  size: int = 180) -> Optional[dict]:
    """渲染文本，提取与字号无关的字形特征：宽高比 / 墨迹填充率 / 笔画比。

    三个特征都用同一口径度量，因此可以和原图分析出的同名特征直接比较。
    """
    key = (family, text, bold, italic)
    if key in _METRIC_CACHE:
        return _METRIC_CACHE[key] or None

    try:
        font, _p, _i = _load_face(family, size, bold, italic)
    except Exception:                    # noqa: BLE001
        _METRIC_CACHE[key] = None
        return None
    if not _font_supports(font, text):
        _METRIC_CACHE[key] = None
        return None

    probe = ImageDraw.Draw(Image.new("L", (4, 4), 0))
    try:
        tw = float(probe.textlength(text, font=font))
    except Exception:                    # noqa: BLE001
        tw = size * len(text) * 0.6

    W = int(tw) + size * 2
    H = size * 3
    if W < 8 or W > 20000 or H < 8:
        _METRIC_CACHE[key] = None
        return None

    canvas = Image.new("L", (W, H), 0)
    ImageDraw.Draw(canvas).text((size, size), text, font=font, fill=255)
    bbox = canvas.getbbox()
    if bbox is None:
        _METRIC_CACHE[key] = None
        return None

    arr = np.asarray(canvas)[bbox[1]:bbox[3], bbox[0]:bbox[2]]
    m = (arr > 128).astype(np.uint8)      # 与 style_analyzer 的 tight 掩膜同口径
    h, w = m.shape
    if w < 4 or h < 4:
        _METRIC_CACHE[key] = None
        return None
    area = float(m.sum())
    if area < 12:
        _METRIC_CACHE[key] = None
        return None

    dt = cv2.distanceTransform(m, cv2.DIST_L2, 5)
    vals = dt[dt > 0]
    stroke = float(np.median(vals[vals >= np.percentile(vals, 80)]) * 2.0) \
        if vals.size else 0.0

    res = {"aspect": w / h, "fill": area / float(w * h),
           "stroke_ratio": stroke / float(h)}
    _METRIC_CACHE[key] = res
    return res


def _rank_by_metrics(text: str, style: dict, bold: bool, italic: bool,
                     candidates: List[str]) -> List[Tuple[float, str, dict]]:
    """按字形特征误差升序排列候选字体。"""
    ink = style.get("ink_rect")
    if not isinstance(ink, dict) or int(ink.get("h", 0)) < 6 or not text.strip():
        return []

    target = {
        "aspect": float(ink["w"]) / float(ink["h"]),
        "fill": float(style.get("ink_fill") or 0.0),
        "stroke_ratio": float(style.get("stroke_ratio") or 0.0),
    }
    scored: List[Tuple[float, str, dict]] = []
    for fam in candidates:
        mt = _text_metrics(fam, text, bold, italic)
        if not mt:
            continue
        err = 0.60 * abs(mt["aspect"] - target["aspect"]) / max(target["aspect"], 0.1)
        if target["fill"] > 0.02:
            err += 0.22 * abs(mt["fill"] - target["fill"]) / target["fill"]
        if target["stroke_ratio"] > 0.01:
            err += 0.18 * abs(mt["stroke_ratio"] - target["stroke_ratio"]) \
                / target["stroke_ratio"]
        scored.append((err, fam, mt))
    scored.sort(key=lambda t: t[0])
    return scored


def match_family_by_metrics(image_bgr: np.ndarray, text: str, style: dict,
                            bold: bool = False, italic: bool = False,
                            candidates: Optional[List[str]] = None,
                            max_candidates: int = 22) -> Tuple[Optional[str], dict]:
    """仅按字形特征选字体（match_family 的第一阶段，保留作独立入口）。"""
    cands = list(candidates or
                 fonts.common_candidates(text, limit=max_candidates))[:max_candidates]
    ranked = _rank_by_metrics(text, style, bold, italic, cands)
    if not ranked:
        return None, {}
    err, fam, mt = ranked[0]
    ink = style.get("ink_rect") or {}
    target_aspect = float(ink.get("w", 1)) / max(float(ink.get("h", 1)), 1)
    return fam, {
        "stage": "metrics",
        "aspect": round(mt["aspect"], 3), "target_aspect": round(target_aspect, 3),
        "fill": round(mt["fill"], 4),
        "score": round(err, 4), "considered": len(ranked),
    }


# ------------------------------------------------------------------ 形状模板比对

_CANVAS_H, _CANVAS_W = 96, 420
_MASK_CACHE: dict = {}


def _norm_ink_mask(mask: Optional[np.ndarray]) -> Optional[np.ndarray]:
    """把墨迹掩膜裁到外接框后等比缩放，居中放进统一画布。"""
    if mask is None or mask.size == 0 or not mask.any():
        return None
    ys, xs = np.where(mask > 0)
    m = mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    h, w = m.shape
    if h < 4 or w < 4:
        return None
    scale = min(_CANVAS_H / float(h), _CANVAS_W / float(w))
    nh = max(1, int(round(h * scale)))
    nw = max(1, int(round(w * scale)))
    r = cv2.resize(m, (nw, nh), interpolation=cv2.INTER_AREA) > 96
    canvas = np.zeros((_CANVAS_H, _CANVAS_W), dtype=bool)
    oy, ox = (_CANVAS_H - nh) // 2, (_CANVAS_W - nw) // 2
    canvas[oy:oy + nh, ox:ox + nw] = r
    return canvas


def _shape_iou(a: Optional[np.ndarray], b: Optional[np.ndarray]) -> float:
    na, nb = _norm_ink_mask(a), _norm_ink_mask(b)
    if na is None or nb is None:
        return 0.0
    union = int(np.logical_or(na, nb).sum())
    return float(np.logical_and(na, nb).sum()) / union if union else 0.0


def _render_ink_mask(family: str, text: str, bold: bool, italic: bool,
                     size: int = 200) -> Optional[np.ndarray]:
    """渲染文本并返回墨迹二值掩膜（带缓存）。"""
    key = (family, text, bold, italic)
    if key in _MASK_CACHE:
        return _MASK_CACHE[key]

    mask = None
    try:
        font, _p, _i = _load_face(family, size, bold, italic)
        if not _font_supports(font, text):
            raise ValueError("字体不含所需字形")
        probe = ImageDraw.Draw(Image.new("L", (4, 4), 0))
        tw = float(probe.textlength(text, font=font))
        W, H = int(tw) + size * 2, size * 3
        if 8 <= W <= 20000:
            canvas = Image.new("L", (W, H), 0)
            ImageDraw.Draw(canvas).text((size, size), text, font=font, fill=255)
            m = (np.asarray(canvas) > 128).astype(np.uint8) * 255
            mask = m if m.any() else None
    except Exception:                    # noqa: BLE001
        mask = None

    _MASK_CACHE[key] = mask
    return mask


def _ink_mask_from_image(image_bgr: np.ndarray,
                         ink_rect: dict) -> Optional[np.ndarray]:
    """从**原图**裁出原文字的真实墨迹掩膜。"""
    from .style_analyzer import _estimate_bg_level, _text_mask   # 延迟导入避免环

    H, W = image_bgr.shape[:2]
    x0, y0 = max(0, int(ink_rect["x"])), max(0, int(ink_rect["y"]))
    x1 = min(W, x0 + int(ink_rect["w"]))
    y1 = min(H, y0 + int(ink_rect["h"]))
    if x1 - x0 < 6 or y1 - y0 < 6:
        return None
    roi = image_bgr[y0:y1, x0:x1]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    m = _text_mask(gray, _estimate_bg_level(gray),
                   ref_size=min(x1 - x0, y1 - y0), tight=True)
    return m if m.any() else None


def match_family(image_bgr: Optional[np.ndarray], source_text: str, style: dict,
                 rect: Optional[dict] = None, bold: bool = False,
                 italic: bool = False, shortlist: int = 6,
                 candidates: Optional[List[str]] = None) -> Tuple[Optional[str], dict]:
    """两阶段字体匹配。

    **阶段一** 用宽高比 / 墨迹填充率 / 笔画比，从常用字体里筛出 shortlist。
    **阶段二** 拿**原文字**在图中真实的墨迹形状，与候选字体的渲染形状做 IoU，
    决出最像的一个。

    为什么要两阶段：低维特征区分不了字形接近的字体
    （Segoe UI vs Trebuchet MS、Helvetica vs Calibri 得分几乎打平），
    而形状 IoU 能分辨——它是拿"真实笔画轮廓"直接比。
    注意阶段二必须用**原文字**（图里真实存在的那个），才能做模板比对。
    """
    text = (source_text or "").strip()
    if not text:
        return None, {}

    cands = list(candidates or fonts.common_candidates(text, limit=22))
    ranked = _rank_by_metrics(text, style, bold, italic, cands)
    if not ranked:
        return None, {}

    top = ranked[:max(2, shortlist)]
    ink = style.get("ink_rect")

    if image_bgr is None or not isinstance(ink, dict) or len(top) == 1:
        err, fam, mt = top[0]
        return fam, {"stage": "metrics", "score": round(err, 4),
                     "considered": len(ranked)}

    target = _ink_mask_from_image(image_bgr, ink)
    if target is None:
        err, fam, mt = top[0]
        return fam, {"stage": "metrics", "score": round(err, 4),
                     "considered": len(ranked)}

    best_iou, best_fam = -1.0, None
    detail: List[dict] = []
    for err, fam, _mt in top:
        cand_mask = _render_ink_mask(fam, text, bold, italic)
        iou = _shape_iou(target, cand_mask)
        detail.append({"family": fam, "iou": round(iou, 3)})
        if iou > best_iou:
            best_iou, best_fam = iou, fam

    if best_fam is None:
        err, fam, _mt = top[0]
        return fam, {"stage": "metrics", "score": round(err, 4),
                     "considered": len(ranked)}

    detail.sort(key=lambda d: -d["iou"])
    return best_fam, {"stage": "shape", "iou": round(best_iou, 3),
                      "shortlist": detail[:4], "considered": len(ranked)}


_WEIGHT_WORDS = {"light", "thin", "regular", "bold", "italic", "medium",
                 "semibold", "black", "extralight", "ultralight", "oblique"}
_THIN_WORDS = ("light", "thin", "extralight", "ultralight", "hairline")


def _thinner_variant(family: str, italic: bool = False) -> Optional[str]:
    """找同族的更细字重变体（如 Microsoft YaHei → Microsoft YaHei Light）。

    原文字比当前字体更细时用得上；找不到就返回 None，由调用方给提示。
    """
    fams = fonts.load_fonts()
    words = [w for w in family.lower().split() if w not in _WEIGHT_WORDS]
    if not words:
        return None
    head = words[0]
    for name in fams:
        low = name.lower()
        if low.startswith(head) and any(w in low for w in _THIN_WORDS):
            return name
    return None


# ------------------------------------------------------------------ 清晰度匹配

def _source_blur_sigma(image_bgr: np.ndarray, rect: dict) -> float:
    """估计原文字的边缘柔化程度，返回建议的额外高斯 sigma。"""
    H, W = image_bgr.shape[:2]
    x, y = max(0, int(rect["x"])), max(0, int(rect["y"]))
    x2, y2 = min(W, x + int(rect["w"])), min(H, y + int(rect["h"]))
    if x2 - x < 8 or y2 - y < 6:
        return 0.0
    g = cv2.cvtColor(image_bgr[y:y2, x:x2], cv2.COLOR_BGR2GRAY).astype(np.float32)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    mag = np.sqrt(gx ** 2 + gy ** 2)
    if mag.size == 0 or float(mag.max()) < 1e-6:
        return 0.0
    contrast = float(g.max() - g.min())
    if contrast < 12:
        return 0.0
    sharp = float(np.percentile(mag, 97)) / max(contrast, 1.0)
    if sharp >= 0.30:
        return 0.0
    return float(np.clip((0.30 - sharp) * 3.2, 0.0, 1.1))


# ------------------------------------------------------------------ 合成

def _paste_layer(image_bgr: np.ndarray, layer: Image.Image,
                 x: int, y: int) -> np.ndarray:
    """RGBA 图层 alpha 合成到 BGR 图像（自动裁剪越界部分）。"""
    H, W = image_bgr.shape[:2]
    lw, lh = layer.width, layer.height
    sx0, sy0 = max(0, -x), max(0, -y)
    dx0, dy0 = max(0, x), max(0, y)
    dw = min(lw - sx0, W - dx0)
    dh = min(lh - sy0, H - dy0)
    if dw <= 0 or dh <= 0:
        return image_bgr

    lay = np.asarray(layer, dtype=np.float32)[sy0:sy0 + dh, sx0:sx0 + dw]
    alpha = lay[..., 3:4] / 255.0
    if float(alpha.max()) <= 0:
        return image_bgr
    rgb = lay[..., 2::-1]                       # RGBA → BGR
    dst = image_bgr[dy0:dy0 + dh, dx0:dx0 + dw].astype(np.float32)
    merged = dst * (1 - alpha) + rgb * alpha
    out = image_bgr.copy()
    out[dy0:dy0 + dh, dx0:dx0 + dw] = np.clip(merged, 0, 255).astype(np.uint8)
    return out


# ------------------------------------------------------------------ 主入口

def render(image_bgr: np.ndarray, rect: dict, text: str, style: dict,
           family: Optional[str] = None, font_size: Optional[int] = None,
           fg_color: Optional[list] = None, bold: Optional[bool] = None,
           italic: bool = False, align: Optional[str] = None,
           valign: str = "bottom",
           offset: Tuple[int, int] = (0, 0),
           letter_spacing: float = 0.0,
           auto_fit: bool = False, max_width_ratio: float = 1.15,
           match_sharpness: bool = True, match_stroke: bool = True,
           auto_family: bool = True,
           match_source: Optional[np.ndarray] = None,
           source_text: Optional[str] = None,
           shadow: Optional[dict] = None,
           stroke_bias: float = 0.0) -> RenderResult:
    """在原位置绘制新文字。

    Args:
        image_bgr:       底图（应已擦除原文字）。
        rect:            原文字框 {x, y, w, h}。
        text:            新文字（支持 \\n 多行）。
        style:           样式分析结果（ink_rect / ink_height / fg_color ...）。
        family:          字体族名。None 且 auto_family=True 时按字形比例自动匹配。
        font_size:       字号，None 则由墨迹高度反推。
        fg_color:        [r,g,b]，None 用分析结果。
        bold / italic:   None 表示沿用分析结果。
        align:           left|center|right（水平）。
        valign:          bottom|center|top（垂直基准）。
                         **默认 bottom**：文字底部（无降部时即基线）与原文字对齐。
                         阅读时的视觉锚点是基线，按基线对齐最不容易看出被改过；
                         居中则会在新旧文字墨迹高度不同时把基线整体推走。
        offset:          (dx, dy) 微调像素。
        letter_spacing:  额外字距（像素，最终尺寸）。
        auto_fit:        文字过宽时是否缩小字号以压回原宽度。
                         **默认关闭**——字号变小比"略超出原位置"更显眼，
                         只有溢出到 HARD_OVERFLOW 以上才会强行收敛。
        match_sharpness: 是否按原图锐度柔化新文字。
        match_stroke:    是否按原图实测笔画宽度校准粗细（想保持「一眼像」时很关键）。
        auto_family:     是否按字形自动匹配字体族。
        match_source:    未擦除的原图，用于按真实字形轮廓匹配字体。
        source_text:     原文字，作为字形匹配的模板。
        stroke_bias:     人工粗细微调，相对字号的描边偏移（正 = 加粗，负 = 变细）。
                         叠加在 match_stroke 的自动校准结果之上；0 = 完全自动。
                         前端「笔画粗细」滑块的每一档 = 0.005。
    """
    warnings: List[str] = []
    lines = str(text).split("\n")
    if not any(ln.strip() for ln in lines):
        return RenderResult(image_bgr, (0, 0, 0, 0), 0, family or "", False, ["文本为空"])

    style = style or {}
    if bold is None:
        bold = bool(style.get("bold", False))
    if fg_color is None:
        fg_color = list(style.get("fg_color", [17, 17, 17]))
    fg_rgb = tuple(int(np.clip(c, 0, 255)) for c in list(fg_color)[:3])
    if align is None:
        align = style.get("align", "left")

    # ---- 字体族：优先用户指定，其次按字形自动匹配 ----
    matched_info: dict = {}
    if family is None:
        if auto_family:
            matched, matched_info = match_family(
                match_source, source_text or (lines[0] if len(lines) == 1 else text),
                style, rect, bool(bold), italic)
            family = matched
        if not family:
            family = (fonts.recommend(text) or ["Arial"])[0]

    # 兜底：显式指定的字体若渲染不出待绘文字（如纯拉丁字体画中文），
    # 会让墨迹度量与最终绘制全部失真，这里回退到能渲染的字体。
    try:
        _f, _p, _i = _load_face(family, 24, bool(bold), italic)
        if not _font_supports(_f, text):
            fallback = (fonts.recommend(text) or ["Arial"])[0]
            if fallback != family:
                warnings.append(f"字体 {family} 不含所需字形，已回退到 {fallback}")
                family = fallback
    except Exception:                    # noqa: BLE001
        pass

    # ---- 目标墨迹框（无墨迹信息时退化为 OCR 框）----
    ink = style.get("ink_rect")
    if isinstance(ink, dict) and int(ink.get("h", 0)) > 2:
        target_x, target_y = int(ink["x"]), int(ink["y"])
        target_w = int(ink["w"])
        target_h_ref = int(style.get("ink_height") or ink["h"])
    else:
        target_x, target_y = int(rect["x"]), int(rect["y"])
        target_w = int(rect["w"])
        target_h_ref = int(style.get("ink_height") or rect["h"])

    # ---- 字号反推 ----
    per_line_h = target_h_ref / max(len(lines), 1)
    fitted = False
    if font_size is None:
        ratio = _ink_ratio(family, bool(bold), italic, lines[0])
        font_size = max(6, int(round(per_line_h / max(ratio, 0.05))))
    font_size = int(max(6, min(font_size, 600)))

    # 额外描边量以「相对字号的比例」保存，这样自动缩放字号后仍等比成立
    stroke_rel = [0.0]
    # 人工粗细微调：相对字号的描边偏移（正 = 加粗，负 = 变细），0 = 完全自动。
    #
    # 关键点：它**不进 build()**，而是等自动笔画校准跑完才并进 stroke_rel。
    # 早期版本把它塞进 build()，自动闭环测到的笔画里就含了人工偏移，于是把它
    # 当成"误差"反向补偿掉 —— 微调白做，还会吐出"已校准为 X"的错读数。
    # 并进 stroke_rel 之后，后续任何重建（含过宽缩字号）都自动带上它且只叠一次。
    bias = float(stroke_bias or 0.0)

    def build(size: int):
        face = fonts.resolve(family, bool(bold), italic)
        f, path, index = _load_face(family, size, bool(bold), italic)
        stroke = max(0.0, stroke_rel[0] * size)
        warn: List[str] = []
        # 字体族没有真正的 Bold 变体时，用轻微描边模拟加粗。
        # 但用户明确要求「更细」时不再补这一层，否则微调等于没生效。
        if bold and face is not None and not face.is_bold and stroke <= 0 and bias >= 0:
            stroke = max(0.4, size * 0.026)
            warn.append("该字体无粗体变体，已用描边模拟加粗")
        lays = [_draw_text_layer(ln, f, path, index, fg_rgb, bool(bold), italic,
                                 stroke=stroke, shadow=shadow,
                                 letter_spacing=letter_spacing)
                for ln in lines]
        return lays, warn

    layers, warns = build(font_size)
    warnings.extend(warns)

    # ---- 笔画粗细校准 ----
    # 字重档位（regular/medium/bold）只能"猜"，字体本身也可能比原图细。
    # 这里直接拿原图实测的笔画宽度做闭环：渲染 → 测笔画 → 补描边 → 再测，迭代收敛。
    stroke_info: dict = {}
    target_stroke = float(style.get("stroke_width") or 0.0)
    if match_stroke:
        if target_stroke >= 0.8:
            probe = _layer_stroke_width(layers[0])
            if probe > 0.1:
                for _ in range(2):
                    delta = target_stroke - probe
                    if abs(delta) <= 0.45:
                        break
                    if delta > 0:
                        stroke_rel[0] = min(
                            stroke_rel[0] + (delta / 2.0) / max(font_size, 1), 0.10)
                        layers, _ = build(font_size)
                        probe = _layer_stroke_width(layers[0])
                    else:
                        thin = _thinner_variant(family, bool(italic))
                        if thin and thin != family:
                            warnings.append(f"原文字笔画更细，已切换字体变体：{thin}")
                            family, stroke_rel[0] = thin, 0.0
                            layers, _ = build(font_size)
                            probe = _layer_stroke_width(layers[0])
                        else:
                            warnings.append(
                                f"原文字笔画约 {target_stroke:.1f}px，比当前字体更细，"
                                "已按最接近的字重渲染")
                            break
                stroke_info = {"target": round(target_stroke, 2),
                               "rendered": round(probe, 2),
                               "stroke_added": round(stroke_rel[0] * font_size, 2)}
                if abs(target_stroke - probe) > 1.2:
                    warnings.append(
                        f"笔画宽度已校准：原图 {target_stroke:.1f}px → 渲染 {probe:.1f}px")

    # ---- 人工粗细微调：并进 stroke_rel，再重建 ----
    # 放在自动闭环**之后**：自动那步负责"把字体调到与原图同一量级"，
    # 微调只负责在结果上再挪一点点。
    if bias != 0.0:
        rel = max(0.0, stroke_rel[0] + bias)
        # 想更细但没有描边可减 → 换更细的字重变体。
        # PIL 的 stroke_width 只能向外扩，没法腐蚀笔画，"更细"的最后手段是换字体。
        if bias < 0 and rel <= 0:
            thin = _thinner_variant(family, bool(italic))
            if thin and thin != family:
                family = thin
                warnings.append(f"笔画调细：已切换到更细的字重变体 {thin}")
            elif stroke_rel[0] <= 0.001:
                warnings.append("该字体已是最细字重，无法再变细（可改选更细的字体）")
        stroke_rel[0] = rel               # 并入后不再需要单独处理
        layers, warns = build(font_size)
        warnings.extend(warns)
        if layers:
            probe = _layer_stroke_width(layers[0])
            merged = dict(stroke_info)
            merged.update({
                "rendered": round(probe, 2),
                "stroke_added": round(stroke_rel[0] * font_size, 2),
                "bias": round(bias, 4),
                "family": family,
            })
            stroke_info = merged

    line_gap = int(round(font_size * 0.22))

    def refresh_stroke_info() -> None:
        """字号变过之后重测一次笔画，刷新 stroke_info。

        缩放前测出的像素值放在缩放后就是错的读数（界面拿它显示"笔画 X→Ypx"）。
        """
        nonlocal stroke_info
        if not layers or not stroke_info:
            return
        probe = _layer_stroke_width(layers[0])
        stroke_info = dict(stroke_info)
        stroke_info["rendered"] = round(probe, 2)
        stroke_info["stroke_added"] = round(stroke_rel[0] * font_size, 2)

    def layout(ls: List[Image.Image]):
        """计算墨迹布局：(总墨迹宽, 总墨迹高, 各行墨迹bbox, 各行图层原点y)。

        必须用**墨迹 bbox** 而不是图层画布尺寸：图层左右各带约 0.35×字号的
        透明 padding，拿画布宽度去和原墨迹宽度比较会凭空多出几十像素，
        导致"过宽自适应"几乎每次都误触发、字号被无故缩小。
        """
        boxes = [_content_bbox(l) or (0, 0, l.width, l.height) for l in ls]
        origins: List[int] = []
        y = 0
        for l in ls:
            origins.append(y)
            y += l.height + line_gap
        widths = [b[2] for b in boxes]                      # w
        top = boxes[0][1]                                   # 首行墨迹顶（图层坐标）
        bottom = origins[-1] + boxes[-1][1] + boxes[-1][3]  # 末行墨迹底（图层坐标）
        return ((max(widths) if widths else 0), max(bottom - top, 1), boxes, origins)

    ink_w, ink_h, boxes, origins = layout(layers)

    # ---- 宽度处理 ----
    # 默认**不**因为原框宽度而改字号：字变小比"略超出原位置"更容易被看出来，
    # 而实际场景里文字旁边多半是空白。只有溢出到会盖住相邻内容才强行收敛。
    overflow = (ink_w / float(target_w)) if target_w > 0 else 1.0
    limit_ratio = max_width_ratio if auto_fit else HARD_OVERFLOW
    if target_w > 0 and ink_w > target_w * limit_ratio:
        ratio = max(limit_ratio / max(overflow, 1e-6), FIT_FLOOR)
        new_size = max(6, int(round(font_size * ratio)))
        if new_size < font_size:
            font_size = new_size
            layers, _ = build(font_size)
            line_gap = int(round(font_size * 0.22))
            ink_w, ink_h, boxes, origins = layout(layers)
            fitted = True
            warnings.append(
                f"新文字比原文宽 {int((overflow - 1) * 100)}%，"
                f"已收敛为 {font_size}px（不低于原字号的 {int(FIT_FLOOR * 100)}%）")
            refresh_stroke_info()
    elif target_w > 0 and overflow > 1.08:
        warnings.append(
            f"新文字比原文宽约 {int((overflow - 1) * 100)}%，已保持原字号"
            "（如想压回原宽度，可勾选「过宽时缩字号」）")

    # ---- 定位：按墨迹对齐，消除图层 padding 造成的偏移 ----
    if align == "center":
        ink_left = target_x + (target_w - ink_w) / 2.0
    elif align == "right":
        ink_left = target_x + target_w - ink_w
    else:
        ink_left = float(target_x)
    # 垂直基准：默认按底部（基线）对齐，而不是居中——居中对齐会在
    # 新旧文字墨迹高度不同时把基线整体推走，看起来就是"字往上/下跑了"。
    if valign == "top":
        ink_top = float(target_y)
    elif valign == "center":
        ink_top = target_y + (target_h_ref - ink_h) / 2.0
    else:                                   # bottom
        ink_top = float(target_y + target_h_ref - ink_h)
    ink_left += int(offset[0])
    ink_top += int(offset[1])

    # ---- 合成 ----
    sigma = _source_blur_sigma(image_bgr, rect) if match_sharpness else 0.0
    out = image_bgr.copy()
    y_shift = ink_top - boxes[0][1]         # 让第一行墨迹顶部落在 ink_top
    for i, lay in enumerate(layers):
        if sigma > 0.05:
            lay = lay.filter(ImageFilter.GaussianBlur(sigma))
        b = boxes[i]
        row_w = b[2]                        # 墨迹宽（bbox 已返回 w）
        if align == "center":
            row_left = target_x + (target_w - row_w) / 2.0 + int(offset[0])
        elif align == "right":
            row_left = target_x + target_w - row_w + int(offset[0])
        else:
            row_left = ink_left
        # 图层原点 = 墨迹目标位置 − 墨迹在图层内的左偏移
        draw_x = int(round(row_left - b[0]))
        draw_y = int(round(y_shift + origins[i]))
        out = _paste_layer(out, lay, draw_x, draw_y)

    return RenderResult(out, (int(ink_left), int(ink_top), int(ink_w), int(ink_h)),
                        font_size, family, fitted, warnings, stroke_info, matched_info)


def measure_box(rect: dict, text: str, style: dict,
                family: Optional[str] = None, font_size: Optional[int] = None,
                bold: Optional[bool] = None, italic: bool = False,
                letter_spacing: float = 0.0) -> dict:
    """只做度量，不合成图像。用于前端预览尺寸提示。"""
    probe = np.zeros((4, 4, 3), dtype=np.uint8)
    res = render(probe, rect, text, style, family=family, font_size=font_size,
                 bold=bold, italic=italic, letter_spacing=letter_spacing,
                 align="left", auto_fit=False, match_sharpness=False,
                 match_stroke=False, auto_family=(family is None),
                 match_source=None, source_text=None)
    return {
        "width": res.box[2], "height": res.box[3],
        "font_size": res.font_size, "family": res.family,
        "overflow": res.box[2] > int(rect.get("w", 0)) * 1.05,
    }
