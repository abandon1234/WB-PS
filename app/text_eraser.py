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

# 「算不算背景」的灰度容差，同时是残影清扫的判断阈值
_BG_TOL = 12
# 归属背景主峰簇的灰度窗口
_BG_WINDOW = 10
# 取参考背景时向外扩多少像素（只取框外那圈，框里的字不参与估计）
_BG_PAD = 5
# 参考背景里落在主峰簇内的比例下限，低于它就不认这是纯色底
_BG_SHARE = 0.80
# 掩膜外圈自己落在主峰簇内的比例下限，低于它就改用 ROI 级兜底色
_RING_SHARE = 0.70
# 残影清扫范围：原文字掩膜（已含 grow）再外扩这么多像素
_SWEEP_GROW = 5


def _hist_mode(hist: np.ndarray, window: int = 9) -> int:
    """直方图主峰（带窗口平滑），与 web/engine/num.js 的 histMode 同口径。"""
    half = window >> 1
    best, best_val = 0, -1.0
    for i in range(256):
        lo, hi = max(0, i - half), min(255, i + half)
        v = float(hist[lo:hi + 1].mean()) if hi >= lo else 0.0
        if v > best_val:
            best_val, best = v, i
    return best


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


# ------------------------------------------------------- 背景体检与残影清扫

def _cluster_mean(px: np.ndarray, lum: np.ndarray, mode: int,
                  fallback: np.ndarray) -> np.ndarray:
    """主峰附近那一小簇像素的均值颜色。

    先收 ±2 的**紧簇**：纯色底的像素值本来就集中在主峰上，紧簇的均值几乎等于
    真实底色。用 ±_BG_WINDOW 那种宽簇会把 245 这类边上像素一起平均进去，
    填出来比周围背景低一两个灰阶 —— 单看不出来，但整块是个"比周围略暗的平面"，
    恰恰是最容易被看出动过手脚的形态。
    """
    for win in (2, _BG_WINDOW):
        sel = np.abs(lum - mode) <= win
        if int(sel.sum()) >= 12:
            return px[sel].mean(axis=0)
    return fallback


def _ring_bg_color(roi: np.ndarray, m: np.ndarray,
                   fallback: np.ndarray) -> np.ndarray:
    """掩膜外圈真实像素估出的背景色。

    关键是取**主峰所在簇的均值**，不是外圈的中位数：外圈紧贴字形，常常混进
    抗锯齿的灰边，中位数被那些灰像素一拖就偏灰，整块填出来是一条淡灰带 ——
    「字没了、但留一片灰影」最常见的来源就是它。先找主峰、再只对落在主峰附近的
    像素求均值，抗干扰从「容忍一半污染」变成「只要污染是少数派就没事」。

    还要再验一道「外圈自己像不像背景」：主峰簇占比不到七成，说明这一圈大半
    是墨（框紧贴邻行的字时就是这样），这时不能拿它当底色，退回 ROI 级估计。
    """
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    ring = cv2.subtract(cv2.dilate(m, k), m)
    idx = np.nonzero(ring.ravel())[0]
    if idx.size < 12:
        return fallback

    px = roi.reshape(-1, 3)[idx].astype(np.float32)
    lum = px @ np.array([0.114, 0.587, 0.299], dtype=np.float32)
    hist = np.bincount(np.clip(np.round(lum), 0, 255).astype(np.int32), minlength=256)
    mode = _hist_mode(hist, 9)

    lo, hi = max(0, mode - _BG_WINDOW), min(255, mode + _BG_WINDOW)
    if float(hist[lo:hi + 1].sum()) / px.shape[0] < _RING_SHARE:
        return fallback
    return _cluster_mean(px, lum, mode, fallback)


def _roi_bg_color(gray_roi: np.ndarray, roi_bgr: np.ndarray,
                  fallback: np.ndarray) -> np.ndarray:
    """全 ROI 级别的背景色。

    ROI 的高度是框的三倍上下，里面绝大多数像素是背景，所以主峰簇的均值就是这
    一块的底色。它是「外圈样本不可信」时的兜底 —— 尤其是「框里一个字都没抓到、
    退化成整框填充」那种情况：那时紧贴框外的那圈很可能正压在邻行的字上，
    用它取色会把整框刷成灰色。实拍见过这个灰带，所以这里必须有一层兜底。
    """
    gray = gray_roi.ravel()
    level = _hist_mode(np.bincount(gray, minlength=256).astype(np.float64), 9)
    return _cluster_mean(roi_bgr.reshape(-1, 3).astype(np.float32),
                         gray.astype(np.float32), level, fallback)


def _box_probe(gray_roi: np.ndarray, rect: dict,
               roi_xy: Tuple[int, int]) -> dict:
    """背景体检：底色主峰在哪儿、纯不纯、框里有多少墨。

    关键是用**框外那一圈**当参考，而不是框内：OCR 的框常常紧贴字形，框里
    大半都是笔画，用框内统计去判"底色纯不纯"会被墨自己带偏（实测紧框的
    密排中文框内背景占比只有 0.43，看着像纹理底）。框外那圈基本只有背景，
    用它算主峰和占比才稳。

    只有纯色底才敢做残影清扫 —— 有纹理或渐变的底子强行归一化会擦出一块假平面。
    """
    H, W = gray_roi.shape[:2]
    bx0 = int(np.clip(int(rect["x"]) - roi_xy[0], 0, max(0, W - 1)))
    by0 = int(np.clip(int(rect["y"]) - roi_xy[1], 0, max(0, H - 1)))
    bx1 = int(np.clip(bx0 + max(1, int(rect["w"])), 1, W))
    by1 = int(np.clip(by0 + max(1, int(rect["h"])), 1, H))

    rx0, ry0 = max(0, bx0 - _BG_PAD), max(0, by0 - _BG_PAD)
    rx1, ry1 = min(W, bx1 + _BG_PAD), min(H, by1 + _BG_PAD)
    outer = gray_roi[ry0:ry1, rx0:rx1]

    in_box = np.zeros(outer.shape, bool)
    in_box[by0 - ry0:by1 - ry0, bx0 - rx0:bx1 - rx0] = True

    box_hist = np.bincount(outer[in_box].ravel(), minlength=256).astype(np.float64)
    ring_hist = np.bincount(outer[~in_box].ravel(), minlength=256).astype(np.float64)
    box_n, ring_n = int(box_hist.sum()), int(ring_hist.sum())

    # 参考区太小就退回框内统计：宁可不清扫，也不要拿噪声当判据
    use_ring = ring_n >= 40
    ref_hist = ring_hist if use_ring else box_hist
    ref_n = ring_n if use_ring else box_n
    level = _hist_mode(ref_hist, 9)

    lo, hi = max(0, level - _BG_WINDOW), min(255, level + _BG_WINDOW)
    near = float(ref_hist[lo:hi + 1].sum())
    ink = float(box_hist[np.abs(np.arange(256) - level) > _BG_TOL].sum())

    return {"level": level, "ring_n": ring_n,
            "bg_share": (near / ref_n) if ref_n else 0.0,
            "ink_ratio": (ink / box_n) if box_n else 0.0,
            "solid": bool(use_ring and ref_n and near / ref_n >= _BG_SHARE)}


def _sweep_reach(m: np.ndarray, rect: dict, roi_xy: Tuple[int, int]) -> dict:
    """清扫范围：原文字掩膜外扩 _SWEEP_GROW、且不出框。"""
    H, W = m.shape[:2]
    x0 = int(np.clip(int(rect["x"]) - roi_xy[0], 0, max(0, W - 1)))
    y0 = int(np.clip(int(rect["y"]) - roi_xy[1], 0, max(0, H - 1)))
    x1 = int(np.clip(x0 + max(1, int(rect["w"])), 1, W))
    y1 = int(np.clip(y0 + max(1, int(rect["h"])), 1, H))

    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                  (_SWEEP_GROW * 2 + 1, _SWEEP_GROW * 2 + 1))
    reach = cv2.dilate(m, k)
    return {"flags": reach[y0:y1, x0:x1] > 0, "x0": x0, "y0": y0,
            "w": x1 - x0, "h": y1 - y0}


def _sweep_residue(patched: np.ndarray, m: np.ndarray, rect: dict,
                   roi_xy: Tuple[int, int], level: int,
                   paint_bgr: np.ndarray, tol: int) -> int:
    """残影清扫：在清扫范围内把偏离背景超过 tol 的像素直接归到背景色。

    why: _text_mask 在低对比度、被缩放过的截图上往往只抓得住笔画核心，
    抗锯齿那一圈灰边会漏在掩膜之外 —— 擦完就是「字没了、却留着一片灰影」。
    补上这层之后，纯色底上的抹字不可能再留残影：范围内只要不是背景色，一律归位。

    范围限制在掩膜外扩 _SWEEP_GROW 之内、且不出框，理由是 OCR 行框常常比字高，
    用整个框会把框里"离目标文字很远"的东西（比如邻行的字头）一起抹掉。

    刻意不做的一件事：保护恰好压在范围内的表格线。试过按"横贯整行"识别它，
    但判据做不到既可靠又不留残影 —— 而留残影正是这里要修的问题，
    所以取舍是：宁可少一道线，也不要留一片灰。
    """
    r = _sweep_reach(m, rect, roi_xy)
    flags, x0, y0, bw, bh = r["flags"], r["x0"], r["y0"], r["w"], r["h"]

    gray = cv2.cvtColor(patched, cv2.COLOR_BGR2GRAY)
    region = gray[y0:y0 + bh, x0:x0 + bw]
    hit = flags & (np.abs(region.astype(np.int16) - level) > tol)
    if not hit.any():
        return 0

    n = int(hit.sum())
    patched[y0:y0 + bh, x0:x0 + bw][hit] = np.clip(
        np.round(paint_bgr), 0, 255).astype(np.uint8)
    return n


def _residue_peak(patched: np.ndarray, m: np.ndarray, rect: dict,
                  roi_xy: Tuple[int, int], level: int) -> int:
    """清扫范围内还能看出的最大偏离（0~255）—— 「到底擦干净没有」的判据。"""
    r = _sweep_reach(m, rect, roi_xy)
    flags, x0, y0, bw, bh = r["flags"], r["x0"], r["y0"], r["w"], r["h"]
    gray = cv2.cvtColor(patched, cv2.COLOR_BGR2GRAY)
    region = gray[y0:y0 + bh, x0:x0 + bw]
    dv = np.abs(region.astype(np.int16) - level)
    return int(dv[flags].max()) if flags.any() else 0


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
    """纯色填充：把掩膜内整块刷成背景色。

    背景是纯色时这一步就是"完美擦除"，不需要羽化——
    羽化反而会在本来完全一致的背景上造出可见的软边。
    背景色由 erase() 统一估（见 _ring_bg_color），不在这里自己采样。
    """
    out = roi.copy()
    if m.any():
        # 必须 round 再转 uint8：astype 是**截断**，254.99 会变成 254，
        # 而 JS 那边 byte() 是四舍五入 → 255。差这一个灰阶，两端的块就看得出来了。
        out[m > 0] = np.clip(np.round(bg_color_bgr), 0, 255).astype(np.uint8)
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
          pad_ratio: float = 1.0, cleanup: bool = True) -> Tuple[np.ndarray, dict]:
    """擦除指定区域的文字，返回 (新图, 元信息)。

    Args:
        image_bgr: 原图（不会被就地修改）。
        rect:      文字框。
        style:     样式分析结果（用其 bg_type / bg_color 辅助选策略）。
        method:    auto | fill | linear | inpaint | ns | blur。
        grow:      掩膜膨胀，覆盖抗锯齿。
        inpaint_radius: inpaint 半径。
        pad_ratio: 外扩比例（取更大范围的参考背景）。
        cleanup:   纯色底上的残影清扫（见 _sweep_residue）。

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
    probe = _box_probe(gray, rect, (x, y))

    bg_type = (style or {}).get("bg_type", "solid")
    # style 里的颜色统一是 RGB；像素级操作用 BGR，这里转换
    bg_rgb = (style or {}).get("bg_color", [255, 255, 255])
    style_bg = np.asarray(bg_rgb, dtype=np.float32).reshape(3)[::-1].copy()
    roi_bg = _roi_bg_color(gray, roi, style_bg)

    # ---- 策略选择 ----
    if method == "auto":
        if style and style.get("bg_type"):
            method = {"solid": "fill", "gradient": "linear"}.get(bg_type, "inpaint")
        else:
            # style 缺席时（文字工坊的"抹字"就是这种情况）不要一律当成纯色底 ——
            # 先体检这块框自己的底色，纯色才填充，有纹理就交给 inpaint，
            # 否则会在照片上糊出一块假的平面。
            method = "fill" if probe["solid"] else "inpaint"
    used = method

    # ---- 擦除 + 残留自检：逐轮加大掩膜膨胀，直到区域内边缘能量降到背景水平 ----
    best_patch, best_mask, best_score = None, None, None
    paint_bgr = roi_bg
    for extra in (0, 1, 2):
        m = _mask_in_roi(roi, rect, (x, y), grow=grow + extra, bg_level=bg_level)
        # 第一轮就把"底到底是什么颜色"定下来：外圈主峰簇的均值（外圈不像背景时退回 roi_bg）
        if best_mask is None:
            paint_bgr = _ring_bg_color(roi, m, roi_bg)
        patch = _apply_method(roi, m, method, paint_bgr, inpaint_radius)
        score = _edge_ratio(patch, rect, (x, y))
        if best_score is None or score < best_score:
            best_patch, best_mask, best_score = patch, m, score
        if score <= 2.0:                     # 已经够干净，不再扩大掩膜
            break

    mask_pixels = int(best_mask.sum() / 255)
    # 残影清扫 + 残留度量。
    # 墨几乎占满整框（>90%）说明框里根本没什么背景可归位，这时不碰。
    sweepable = cleanup and probe["solid"] and mask_pixels > 0 and probe["ink_ratio"] <= 0.9
    swept = (_sweep_residue(best_patch, best_mask, rect, (x, y),
                            probe["level"], paint_bgr, _BG_TOL) if sweepable else 0)
    peak = (_residue_peak(best_patch, best_mask, rect, (x, y), probe["level"])
            if sweepable else None)

    out = image_bgr.copy()
    out[y:y2, x:x2] = best_patch
    meta = {
        "method": used,
        "bg_type": bg_type,
        "bg_solid": probe["solid"],
        "bg_level": int(probe["level"]),
        "bg_ink": round(float(probe["ink_ratio"]), 3),
        "mask_pixels": mask_pixels,
        "residual": round(float(best_score), 3),
        "swept_pixels": swept,
        # 清扫范围内还剩多少偏离背景（0~255）。纯色底才有意义，非纯色底给 None。
        "leftover_max": None if peak is None else int(peak),
        "box": (x, y, x2 - x, y2 - y),
    }
    return out, meta
