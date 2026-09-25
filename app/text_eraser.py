# -*- coding: utf-8 -*-
"""文字擦除：把原文字从图像中抹掉，不留灰边与补丁痕。

四种策略，按背景复杂度自动选择
------------------------------
fill    —— 纯色背景：直接用背景色填充（效果最完美，无任何痕迹）
linear  —— 渐变背景：沿最优方向做边界线性外推（横向/纵向渐变近乎完美）
inpaint —— 纹理背景：OpenCV Telea / NS 修复
blur    —— 兜底：邻域中值 + 高斯，配合透明度融合

关键细节
--------
* 掩膜必须覆盖**抗锯齿边缘**，否则原文字会留下灰色轮廓（最常见的"痕迹"来源）。
* 采样参考必须来自**框外**，否则修复器拿不到干净像素。因此统一在外扩 ROI 上操作。
"""
from __future__ import annotations

from typing import Optional, Tuple

import cv2
import numpy as np

from .style_analyzer import _estimate_bg_level, _keep_components, _text_mask


def _mask_in_roi(roi_bgr: np.ndarray, rect: dict, roi_xy: Tuple[int, int],
                 grow: int = 2, bg_level: Optional[float] = None) -> np.ndarray:
    """在 ROI 内生成覆盖原文字的掩膜（含抗锯齿边），并剔除相邻行的文字。"""
    gray = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2GRAY)
    if bg_level is None:
        bg_level = _estimate_bg_level(gray)

    m = _text_mask(gray, bg_level,
                   ref_size=min(int(rect["w"]), int(rect["h"])),
                   denoise=False)
    # 关键：只保留与目标框重叠的连通域，否则会把上下相邻行的文字一起擦掉
    rx = int(rect["x"]) - roi_xy[0]
    ry = int(rect["y"]) - roi_xy[1]
    m = _keep_components(m, (rx, ry, int(rect["w"]), int(rect["h"])))

    if grow > 0 and m.any():
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (grow * 2 + 1, grow * 2 + 1))
        m = cv2.dilate(m, k, iterations=1)
    if not m.any():
        # 没抓到墨迹 → 退化为整框填充，保证"擦干净"
        m = np.zeros(gray.shape, dtype=np.uint8)
        x0, y0 = max(0, rx), max(0, ry)
        m[y0:y0 + int(rect["h"]), x0:x0 + int(rect["w"])] = 255
    return m


# ------------------------------------------------------------------ 掩膜构建

def build_mask(image_bgr: np.ndarray, rect: dict, pad: int = 3,
               grow: int = 2, bg_level: Optional[float] = None) -> Tuple[np.ndarray, dict]:
    """构建覆盖原文字的掩膜（全图尺寸，uint8 0/255）。

    Args:
        rect: {x, y, w, h} 文字框。
        pad:  外扩像素（掩膜只在外扩区域内生成，保证边缘有参考背景）。
        grow: 掩膜膨胀像素，用于吃掉抗锯齿边。
    """
    H, W = image_bgr.shape[:2]
    x = max(0, int(rect["x"]) - pad)
    y = max(0, int(rect["y"]) - pad)
    x2 = min(W, int(rect["x"]) + int(rect["w"]) + pad)
    y2 = min(H, int(rect["y"]) + int(rect["h"]) + pad)

    roi = image_bgr[y:y2, x:x2]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    if bg_level is None:
        bg_level = _estimate_bg_level(gray)

    inner = _mask_in_roi(roi, rect, (x, y), grow=grow, bg_level=bg_level)

    mask = np.zeros((H, W), dtype=np.uint8)
    mask[y:y2, x:x2] = inner
    return mask, {"roi": (x, y, x2, y2), "bg_level": bg_level,
                  "mask_pixels": int(inner.sum() / 255)}


# ------------------------------------------------------------------ 各策略实现

def _fill(roi: np.ndarray, m: np.ndarray, bg_color_bgr: np.ndarray) -> np.ndarray:
    """纯色填充：用紧贴掩膜外圈的真实像素估计局部背景色后整块填充。

    背景是纯色时这一步就是"完美擦除"，不需要羽化——
    羽化反而会在本来完全一致的背景上造出可见的软边。
    """
    out = roi.copy()
    if not m.any():
        return out
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    ring = cv2.subtract(cv2.dilate(m, k), m)
    if int(ring.sum() / 255) >= 12:
        bg = np.median(roi[ring > 0], axis=0).astype(np.float32)
    else:
        bg = np.asarray(bg_color_bgr, dtype=np.float32).reshape(3)
    out[m > 0] = np.clip(bg, 0, 255).astype(np.uint8)
    return out


def _linear(roi: np.ndarray, m: np.ndarray) -> np.ndarray:
    """沿最优方向做边界线性外推：适合渐变背景。

    对每一列（或每一行），取掩膜上下（左右）外侧最近的真实像素做线性插值；
    若掩膜触到 ROI 边界，则用可用的那一侧做常数延展。
    """
    out = roi.astype(np.float32).copy()
    h, w = m.shape
    msk = m > 0

    def interp_axis(axis: int) -> np.ndarray:
        res = out.copy()
        n_outer = w if axis == 0 else h
        n_inner = h if axis == 0 else w
        for i in range(n_outer):
            col = msk[:, i] if axis == 0 else msk[i, :]
            if not col.any():
                continue
            idx = np.where(col)[0]
            a, b = int(idx[0]), int(idx[-1])

            def at(pos: int) -> Optional[np.ndarray]:
                if pos < 0 or pos >= n_inner:
                    return None
                return out[pos, i] if axis == 0 else out[i, pos]

            top = at(a - 1)
            bot = at(b + 1)
            count = b - a + 1
            if top is not None and bot is not None:
                t = (np.arange(count) + 1.0) / (count + 1.0)
                vals = top[None, :] * (1 - t[:, None]) + bot[None, :] * t[:, None]
            elif top is not None:
                vals = np.repeat(top[None, :], count, axis=0)
            elif bot is not None:
                vals = np.repeat(bot[None, :], count, axis=0)
            else:
                continue
            if axis == 0:
                res[a:b + 1, i] = vals
            else:
                res[i, a:b + 1] = vals
        return res

    def seam_score(img: np.ndarray) -> float:
        """掩膜边界处的梯度越小，说明外推结果与背景衔接得越自然。"""
        g = cv2.cvtColor(np.clip(img, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY)
        gy, gx = np.gradient(g.astype(np.float32))
        bound = cv2.subtract(cv2.dilate(m, np.ones((5, 5), np.uint8)), m)
        if not bound.any():
            return float("inf")
        return float(np.mean(np.sqrt(gx ** 2 + gy ** 2)[bound > 0]))

    cand_v = interp_axis(0)          # 按列插值（适合水平方向渐变）
    cand_h = interp_axis(1)          # 按行插值（适合垂直方向渐变）
    best = cand_v if seam_score(cand_v) <= seam_score(cand_h) else cand_h
    out = np.where(msk[..., None], best, out)
    return np.clip(out, 0, 255).astype(np.uint8)


def _inpaint(roi: np.ndarray, m: np.ndarray, radius: int, method: str) -> np.ndarray:
    flag = cv2.INPAINT_NS if method == "ns" else cv2.INPAINT_TELEA
    r = max(2, min(radius, 15))
    return cv2.inpaint(roi, m, r, flag)


def _blur_patch(roi: np.ndarray, m: np.ndarray, ksize: int = 9) -> np.ndarray:
    """中值/高斯混合，作为最终兜底。"""
    k = max(3, min(ksize | 1, 31))
    med = cv2.medianBlur(roi, k)
    soft = cv2.GaussianBlur(roi, (k, k), 0)
    patched = ((med.astype(np.uint16) + soft.astype(np.uint16)) // 2).astype(np.uint8)
    out = roi.copy()
    out[m > 0] = patched[m > 0]
    return out


def _apply_method(roi: np.ndarray, m: np.ndarray, method: str,
                  bg_color: np.ndarray, radius: int) -> np.ndarray:
    if method == "fill":
        return _fill(roi, m, bg_color)
    if method == "linear":
        return _linear(roi, m)
    if method in ("inpaint", "ns", "telea"):
        return _inpaint(roi, m, radius, "ns" if method == "ns" else "telea")
    if method == "blur":
        return _blur_patch(roi, m)
    raise ValueError(f"未知擦除方法: {method}")


def _edge_ratio(patched: np.ndarray, rect: dict, roi_xy: Tuple[int, int],
                band: int = 14) -> float:
    """残留自检：框内边缘能量 / 周边背景边缘能量。

    文字有强边缘，背景平坦。比值接近 1 说明擦干净了；偏高说明还有残留。
    """
    H, W = patched.shape[:2]
    rx = int(rect["x"]) - roi_xy[0]
    ry = int(rect["y"]) - roi_xy[1]
    x0, y0 = max(0, rx), max(0, ry)
    x1 = min(W, rx + int(rect["w"]))
    y1 = min(H, ry + int(rect["h"]))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return 1.0

    g = cv2.cvtColor(patched, cv2.COLOR_BGR2GRAY).astype(np.float32)
    inner = g[y0:y1, x0:x1]

    bx0, by0 = max(0, x0 - band), max(0, y0 - band)
    bx1, by1 = min(W, x1 + band), min(H, y1 + band)
    outer = g[by0:by1, bx0:bx1].copy()
    outer[y0 - by0:y1 - by0, x0 - bx0:x1 - bx0] = np.nan

    ei = float(np.mean(np.abs(cv2.Laplacian(inner, cv2.CV_32F))))
    eo = float(np.nanmean(np.abs(cv2.Laplacian(outer, cv2.CV_32F))))
    return ei / max(eo, 0.5)


# ------------------------------------------------------------------ 主入口

def erase(image_bgr: np.ndarray, rect: dict, style: Optional[dict] = None,
          method: str = "auto", grow: int = 2, inpaint_radius: int = 3,
          pad_ratio: float = 1.0) -> Tuple[np.ndarray, dict]:
    """擦除指定区域的文字，返回 (新图, 元信息)。

    Args:
        image_bgr: 原图（不会被就地修改）。
        rect:      文字框。
        style:     样式分析结果（用其 bg_type / bg_color 辅助选策略）。
        method:    auto | fill | linear | inpaint | ns | blur。
        grow:      掩膜膨胀，覆盖抗锯齿。
        inpaint_radius: inpaint 半径。
        pad_ratio: 外扩比例（取更大范围的参考背景）。

    Returns:
        (处理后的完整图像, {"method":..., "mask": np.ndarray, "box": (x,y,w,h)})
    """
    H, W = image_bgr.shape[:2]
    w, h = int(rect["w"]), int(rect["h"])
    # 外扩参考区按**框高**计算：单行文字只需要上下方向的参考像素，
    # 用长边算会把整行甚至相邻行都吞进 ROI，反而污染掩膜。
    pad = int(np.clip(round(pad_ratio * max(h, 10) * 0.9), 8, 48))
    x = max(0, int(rect["x"]) - pad)
    y = max(0, int(rect["y"]) - pad)
    x2 = min(W, int(rect["x"]) + w + pad)
    y2 = min(H, int(rect["y"]) + h + pad)
    if x2 - x < 3 or y2 - y < 3:
        return image_bgr.copy(), {"method": "none", "mask": None,
                                  "box": (x, y, max(x2 - x, 1), max(y2 - y, 1))}

    roi = image_bgr[y:y2, x:x2].copy()
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    bg_level = _estimate_bg_level(gray)

    bg_type = (style or {}).get("bg_type", "solid")
    # style 里的颜色统一是 RGB；像素级操作用 BGR，这里转换
    bg_rgb = (style or {}).get("bg_color", [255, 255, 255])
    bg_color = np.asarray(bg_rgb, dtype=np.float32).reshape(3)[::-1].copy()

    # ---- 策略选择 ----
    if method == "auto":
        method = {"solid": "fill", "gradient": "linear"}.get(bg_type, "inpaint")
    used = method

    # ---- 擦除 + 残留自检：逐轮加大掩膜膨胀，直到区域内边缘能量降到背景水平 ----
    best_patch, best_mask, best_score = None, None, None
    for extra in (0, 1, 2):
        m = _mask_in_roi(roi, rect, (x, y), grow=grow + extra, bg_level=bg_level)
        patch = _apply_method(roi, m, method, bg_color, inpaint_radius)
        score = _edge_ratio(patch, rect, (x, y))
        if best_score is None or score < best_score:
            best_patch, best_mask, best_score = patch, m, score
        if score <= 2.0:                     # 已经够干净，不再扩大掩膜
            break

    out = image_bgr.copy()
    out[y:y2, x:x2] = best_patch
    meta = {
        "method": used,
        "bg_type": bg_type,
        "mask_pixels": int(best_mask.sum() / 255),
        "residual": round(float(best_score), 3),
        "box": (x, y, x2 - x, y2 - y),
    }
    return out, meta
