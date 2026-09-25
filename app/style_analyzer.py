# -*- coding: utf-8 -*-
"""文字样式分析：从原图反推字体色、背景色、字号、粗细、笔宽。

设计要点
--------
* 颜色提取不用简单平均值——抗锯齿像素会把颜色"拉灰"。
  做法：以背景色为基准，取偏离最大的那批像素（真实墨迹核心）的中位数。
* 字号由**墨迹高度**反推，而不是 OCR 框高度（框含 padding，不可靠）。
* 粗细用**笔画宽度 / 墨迹高度**的比值判定，不依赖字体元数据。
"""
from __future__ import annotations

from typing import Optional, Tuple

import cv2
import numpy as np


# ------------------------------------------------------------------ 基础工具

def _border_pixels(gray: np.ndarray, band: int = 3) -> np.ndarray:
    """取外圈边界像素（用于估计背景色）。"""
    b = max(1, min(band, min(gray.shape[:2]) // 4))
    return np.concatenate([
        gray[:b, :].ravel(), gray[-b:, :].ravel(),
        gray[:, :b].ravel(), gray[:, -b:].ravel(),
    ])


def _estimate_bg_level(gray: np.ndarray, band: int = 3) -> float:
    """估计背景亮度。

    文字是笔画状的少数派，但 OCR 框常紧贴文字、边缘也可能被文字占据。
    因此融合两个信号并做一致性判定：
      1) 外圈边界像素中位数（框外扩后基本落在背景上）
      2) 灰度直方图平滑后的主峰（背景通常是众数）
    两者接近时取均值更稳，冲突时以 Otsu 双类中心做仲裁。
    """
    border = float(np.median(_border_pixels(gray, band)))

    hist = np.bincount(gray.ravel(), minlength=256).astype(np.float32)
    hs = np.convolve(hist, np.ones(9, dtype=np.float32) / 9.0, mode="same")
    mode = float(np.argmax(hs))

    if abs(mode - border) <= 40:
        return 0.5 * (mode + border)

    # 冲突：用 Otsu 把亮度归到两个类中心，看哪个更接近主峰
    th, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    dark = gray[gray <= th]
    light = gray[gray > th]
    d_mean = float(dark.mean()) if dark.size else border
    l_mean = float(light.mean()) if light.size else border
    d_cnt, l_cnt = int(dark.size), int(light.size)
    # 两类的"纯度"：类内方差越小越可能是平整的背景
    d_std = float(dark.std()) if d_cnt > 4 else 1e9
    l_std = float(light.std()) if l_cnt > 4 else 1e9
    return d_mean if d_std < l_std else l_mean


def _text_mask(gray: np.ndarray, bg_level: Optional[float] = None,
               ref_size: Optional[int] = None, tight: bool = False,
               denoise: bool = True) -> np.ndarray:
    """生成文字（前景墨迹）掩膜，二值 uint8 0/255。

    用**局部背景图**做差分，而不是全局单一阈值：
      * 文字比背景暗 → 形态学闭运算填掉笔画，与闭运算结果之差即文字
      * 文字比背景亮 → 形态学开运算抹掉笔画，与开运算结果之差即文字

    只走其中一个方向很关键：若两个方向取较大值，
    开运算会把笔画之间那些细窄的背景条整片"掏空"，
    使噪声基准被顶到接近 255，阈值随之失效。

    Args:
        ref_size: 参考尺寸（一般取文字框短边），决定形态学核大小——
                  核必须大于笔画宽度，否则笔画会被背景图自己"吃掉"。
        tight:    True  → 用 Otsu 收紧边界（适合**度量**字号/颜色，边界更贴真实墨迹）
                  False → 用较低的噪声下限（适合**擦除**，多覆盖一点抗锯齿更安全）
        denoise:  是否按连通域面积去噪。**擦除时必须关闭**——
                  文字顶/底部的抗锯齿碎片常是面积很小的孤立连通域，
                  一旦被当作噪点剔除，擦除后就会残留一圈淡淡的轮廓。
    """
    h, w = gray.shape[:2]
    limit = min(h, w)
    if limit < 5:
        return np.zeros_like(gray)

    ref = int(ref_size or limit)
    k = int(np.clip(ref / 3.0, 9, 41))
    k = min(k | 1, (limit - 1) | 1)
    if k < 3:
        return np.zeros_like(gray)
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))

    if bg_level is None:
        bg_level = _estimate_bg_level(gray)

    def direction(dark_is_fg: bool) -> np.ndarray:
        if dark_is_fg:
            bg_map = cv2.morphologyEx(gray, cv2.MORPH_CLOSE, ker)
            return cv2.subtract(bg_map, gray)
        bg_map = cv2.morphologyEx(gray, cv2.MORPH_OPEN, ker)
        return cv2.subtract(gray, bg_map)

    def binarize(diff: np.ndarray) -> np.ndarray:
        noise = float(np.percentile(diff, 45))
        floor = max(9.0, noise * 2.2)
        if tight:
            th, m = cv2.threshold(diff, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            if float(th) >= floor:
                return m
        return (diff.astype(np.float32) > floor).astype(np.uint8) * 255

    # 用 Otsu 把亮度归到两类中心，离背景更远的那一侧就是文字
    th, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    dark_px, light_px = gray[gray <= th], gray[gray > th]
    d_mean = float(dark_px.mean()) if dark_px.size else bg_level
    l_mean = float(light_px.mean()) if light_px.size else bg_level
    dark_is_fg = abs(d_mean - bg_level) > abs(l_mean - bg_level)

    m = binarize(direction(dark_is_fg))
    if m.sum() < 8:                       # 方向判反时反向再试一次
        m = binarize(direction(not dark_is_fg))
    if not m.any() or not denoise:
        return m

    # 去孤立噪点（度量用途；擦除用途必须保留细节，见 denoise 说明）
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    keep = np.zeros_like(m)
    min_area = max(3, int(0.0006 * m.size))
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= min_area:
            keep[labels == i] = 255
    return keep if keep.any() else m


def _dominant_color(roi_bgr: np.ndarray, mask: np.ndarray,
                    quant: int = 20) -> Optional[Tuple[int, int, int]]:
    """掩膜内像素的众数颜色（量化后取众数，再回原像素求中位数）。

    **返回 RGB 顺序** —— 上层（前端 / PIL 渲染）统一按 RGB 处理，
    OpenCV 的 BGR 只在像素级操作内部转换。
    """
    sel = roi_bgr[mask > 0]
    if sel.size == 0:
        return None
    q = (sel // quant).astype(np.int32)
    keys = q[:, 0] * 10000 + q[:, 1] * 100 + q[:, 2]
    uniq, counts = np.unique(keys, return_counts=True)
    top = uniq[np.argmax(counts)]
    near = sel[keys == top]
    med = np.median(near, axis=0)
    return int(med[2]), int(med[1]), int(med[0])          # BGR → RGB


def _stroke_width(mask: np.ndarray) -> float:
    """估计笔画宽度（像素）。

    两种方法交叉验证：
      1) 距离变换峰值 —— 对粗笔画准，细笔画会被量化到整数、误差大
      2) 面积/周长比 2·area/perimeter —— 对细笔画更稳，但抗锯齿会略微低估
    细笔画时偏向面积法，粗笔画时偏向距离变换。
    """
    m = (mask > 0).astype(np.uint8)
    area = float(m.sum())
    if area < 8:
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
    if dt_w < 3.0:                       # 细笔画：距离变换量化误差明显
        return 0.5 * (dt_w + ap_w)
    return 0.25 * ap_w + 0.75 * dt_w


def weight_class(stroke_ratio: float, ink_density: float = 0.0) -> str:
    """把「笔画宽度 ÷ 墨迹高度」映射到字重档位。

    实测参考（PIL 渲染、无抗锯齿干扰）：
      regular 无衬线体约 0.07~0.11，medium 约 0.12~0.15，bold 约 0.16 以上。
    这是渲染时做「笔画校准」的输入，比单纯布尔 bold 精确得多。
    """
    r = stroke_ratio
    if r >= 0.185:
        return "black"
    if r >= 0.150:
        return "bold"
    if r >= 0.120:
        return "medium"
    if r >= 0.098:
        return "regular" if ink_density < 0.26 else "medium"
    return "light"


def _bg_type(roi_bgr: np.ndarray, bg_mask: np.ndarray) -> Tuple[str, float, float]:
    """判断背景是纯色 / 渐变 / 纹理，返回 (类型, 灰度标准差, 局部梯度中位数)。

    判据：局部梯度大 → 纹理；整体方差小 → 纯色；介于两者 → 渐变。
    """
    if not bg_mask.any():
        return "solid", 0.0, 0.0
    sel = roi_bgr[bg_mask > 0].astype(np.float32)
    if sel.shape[0] < 12:
        return "solid", 0.0, 0.0
    g = sel @ np.array([0.114, 0.587, 0.299], dtype=np.float32)   # BGR 亮度
    std = float(g.std())

    ys, xs = np.where(bg_mask > 0)
    if len(ys) > 50:
        gray = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2GRAY)
        gy, gx = np.gradient(gray.astype(np.float32))
        grad = np.sqrt(gx ** 2 + gy ** 2)[ys, xs]
        gstd = float(np.median(grad))
    else:
        gstd = 0.0

    if gstd >= 0.8:          # 局部就有可见梯度 → 纹理
        return "texture", std, gstd
    if std <= 4.0:           # 整体足够平坦 → 纯色（含轻微压缩噪声）
        return "solid", std, gstd
    return "gradient", std, gstd


def _keep_components(mask: np.ndarray, rect: Tuple[int, int, int, int]) -> np.ndarray:
    """只保留与目标框有足够重叠的连通域。

    Otsu 是全局阈值，扩边后常把相邻行的文字一起抓进来，
    导致墨迹高度被高估、字号算大。这里按连通域与框的重叠比例过滤。
    """
    if not mask.any():
        return mask
    n, labels, stats, _ = cv2.connectedComponentsWithStats(
        (mask > 0).astype(np.uint8), 8)
    if n <= 2:
        return mask

    rx, ry, rw, rh = rect
    rx2, ry2 = rx + rw, ry + rh
    out = np.zeros_like(mask)
    kept = False
    for i in range(1, n):
        x, y, w, h, area = (int(stats[i, cv2.CC_STAT_LEFT]), int(stats[i, cv2.CC_STAT_TOP]),
                            int(stats[i, cv2.CC_STAT_WIDTH]), int(stats[i, cv2.CC_STAT_HEIGHT]),
                            int(stats[i, cv2.CC_STAT_AREA]))
        ix = max(0, min(x + w, rx2) - max(x, rx))
        iy = max(0, min(y + h, ry2) - max(y, ry))
        inter = ix * iy
        inside = (x >= rx and y >= ry and x + w <= rx2 and y + h <= ry2)
        if inside or inter >= 0.35 * max(area, 1):
            out[labels == i] = 255
            kept = True
    return out if kept else mask


# ------------------------------------------------------------------ 主入口

def _assumed_ink_ratio(text: str) -> float:
    """墨迹高度 / 字号 的先验比值（用于首次号估计）。

    数值来自实测（见 text_renderer._ink_ratio）：微软雅黑汉字 0.908、
    黑体 0.883、宋体 0.896；Arial 大写高 0.717、Times 大写高 0.663。
    实际渲染时会按所选字体再次实测校准，这里只用于给前端一个合理初值。
    """
    has_cjk = any("\u4e00" <= ch <= "\u9fff" for ch in text)
    has_lower = any("a" <= ch <= "z" for ch in text)
    has_upper = any("A" <= ch <= "Z" for ch in text) or any(ch.isdigit() for ch in text)
    if has_cjk:
        return 0.90          # 汉字字面高度约占 em 的 90%
    if has_upper:
        return 0.72          # 大写 / 数字：以 cap height 计
    if has_lower:
        return 0.52          # 纯小写：x-height
    return 0.72


def analyze(image_bgr: np.ndarray, rect: dict, text: str = "",
            pad: Optional[int] = None) -> dict:
    """分析单个文字区域的样式。

    Args:
        image_bgr: 整幅图像（BGR）。
        rect:      {x, y, w, h}，轴对齐外接矩形。
        text:      OCR 得到的文本（用于先验判断）。
        pad:       向外扩展的像素。默认按框高自适应，保证外圈能取到纯背景；
                   OCR 框通常紧贴文字，pad 过小会让边界像素全是文字。

    Returns:
        样式字典，直接喂给 text_renderer。
    """
    H, W = image_bgr.shape[:2]
    if pad is None:
        pad = int(np.clip(0.30 * min(int(rect["w"]), int(rect["h"])), 3, 24))
    pad = int(pad)
    x = max(0, int(rect["x"]) - pad)
    y = max(0, int(rect["y"]) - pad)
    x2 = min(W, int(rect["x"]) + int(rect["w"]) + pad)
    y2 = min(H, int(rect["y"]) + int(rect["h"]) + pad)
    if x2 - x < 2 or y2 - y < 2:
        return _fallback_style()

    roi = image_bgr[y:y2, x:x2]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

    # 背景亮度：边界中位数 + 直方图主峰融合（见 _estimate_bg_level）
    bg_level = _estimate_bg_level(gray)

    fg_mask = _text_mask(gray, bg_level,
                         ref_size=min(int(rect["w"]), int(rect["h"])),
                         tight=True)
    # 扩边后 Otsu 可能把相邻行也抓进来，按连通域与目标框的重叠过滤掉
    fg_mask = _keep_components(fg_mask, (int(rect["x"]) - x, int(rect["y"]) - y,
                                         int(rect["w"]), int(rect["h"])))
    if fg_mask.sum() < 8:                       # 没抓到文字，退化为整体估计
        return _fallback_style(bg_rgb=_dominant_color(roi, np.ones_like(gray)) or (255, 255, 255))

    bg_mask = (fg_mask == 0).astype(np.uint8) * 255

    # 目标框在 ROI 中的位置（多处在用，提前算好）
    box_x0 = int(rect["x"]) - x
    box_y0 = int(rect["y"]) - y
    box_w = max(int(rect["w"]), 1)
    box_h = max(int(rect["h"]), 1)

    # ---- 颜色 ----
    fg_color = _dominant_color(roi, fg_mask) or (0, 0, 0)
    bg_color = _dominant_color(roi, bg_mask) or (255, 255, 255)

    # ---- 墨迹几何 ----
    ys, xs = np.where(fg_mask > 0)
    ink_x0, ink_x1 = int(xs.min()), int(xs.max())
    ink_y0, ink_y1 = int(ys.min()), int(ys.max())
    ink_w = ink_x1 - ink_x0 + 1
    ink_h = ink_y1 - ink_y0 + 1

    # 用高度直方图修正：取墨迹行的 90 分位跨度，避开逗号、下伸部干扰
    row_span = fg_mask.sum(axis=1)
    rows = np.where(row_span > 0)[0]
    if rows.size > 3:
        thr = max(1, int(0.06 * row_span.max()))
        solid_rows = rows[row_span[rows] >= thr]
        if solid_rows.size >= 3:
            ink_h_ref = int(solid_rows.max() - solid_rows.min() + 1)
        else:
            ink_h_ref = ink_h
    else:
        ink_h_ref = ink_h

    ink_ratio = _assumed_ink_ratio(text) if text else 0.8
    font_size = max(6, int(round(ink_h_ref / ink_ratio)))

    # 墨迹在自身外接框内的填充率：反映字形饱满度，是字体匹配的强特征之一
    ink_area = float(fg_mask.sum() / 255.0)
    ink_fill = ink_area / max(float(ink_w * ink_h), 1.0)

    # ---- 粗细（档位 + 布尔，布尔仅用于兼容旧字段）----
    stroke = _stroke_width(fg_mask)
    stroke_ratio = stroke / max(ink_h_ref, 1)
    ink_density = float(fg_mask.mean() / 255.0)
    weight = weight_class(stroke_ratio, ink_density)
    bold = weight in ("bold", "black")

    # ---- 背景类型（只在文字框内判断，且只取确实落在背景上的像素）----
    box_roi = np.zeros_like(gray)
    bx0, by0 = max(0, box_x0), max(0, box_y0)
    bx1 = min(gray.shape[1], bx0 + box_w)
    by1 = min(gray.shape[0], by0 + box_h)
    box_roi[by0:by1, bx0:bx1] = 255
    near_bg = np.abs(gray.astype(np.int16) - int(round(bg_level))) <= 12
    bg_pure = cv2.bitwise_and(box_roi, near_bg.astype(np.uint8) * 255)
    if int(bg_pure.sum() / 255) < 25:            # 背景像素太少，放宽判据
        near_text = cv2.dilate(fg_mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
        bg_pure = cv2.bitwise_and(box_roi, (near_text == 0).astype(np.uint8) * 255)
    if int(bg_pure.sum() / 255) < 20:
        bg_pure = box_roi
    bg_kind, bg_std, bg_grad = _bg_type(roi, bg_pure)

    # ---- 对齐（依据墨迹在**原始 OCR 框**内的左右留白）----
    left_pad = max(0, ink_x0 - box_x0)
    right_pad = max(0, (box_x0 + box_w - 1) - ink_x1)
    center_off = (left_pad - right_pad) / box_w
    if abs(center_off) < 0.08:
        align = "center"
    elif center_off > 0:
        align = "right"
    else:
        align = "left"

    # ---- 前景/背景对比度，用于判断文字深浅色（RGB 顺序的亮度公式）----
    fg_lum = 0.299 * fg_color[0] + 0.587 * fg_color[1] + 0.114 * fg_color[2]
    bg_lum = 0.299 * bg_color[0] + 0.587 * bg_color[1] + 0.114 * bg_color[2]

    return {
        "fg_color": list(fg_color),
        "bg_color": list(bg_color),
        "bg_type": bg_kind,
        "bg_std": round(bg_std, 2),
        "bg_grad": round(bg_grad, 2),
        "font_size": font_size,
        "weight": weight,
        "bold": bool(bold),
        "stroke_width": round(stroke, 2),
        "stroke_ratio": round(stroke_ratio, 4),
        "ink_ratio": round(ink_density, 4),
        "ink_fill": round(ink_fill, 4),
        "ink_rect": {"x": x + ink_x0, "y": y + ink_y0, "w": ink_w, "h": ink_h},
        "ink_height": ink_h_ref,
        "align": align,
        "light_text": bool(fg_lum > bg_lum),
        "contrast": round(abs(fg_lum - bg_lum), 1),
    }


def _fallback_style(bg_rgb: Tuple[int, int, int] = (255, 255, 255)) -> dict:
    """分析失败时的保守默认值（按背景明暗决定文字取黑或白）。"""
    lum = 0.299 * bg_rgb[0] + 0.587 * bg_rgb[1] + 0.114 * bg_rgb[2]
    fg = (255, 255, 255) if lum < 128 else (17, 17, 17)
    return {
        "fg_color": list(fg),
        "bg_color": list(bg_rgb),
        "bg_type": "solid",
        "bg_std": 0.0,
        "font_size": 18,
        "weight": "regular",
        "bold": False,
        "stroke_width": 2.0,
        "stroke_ratio": 0.1,
        "ink_ratio": 0.2,
        "ink_rect": None,
        "ink_height": 16,
        "align": "left",
        "light_text": lum < 128,
        "contrast": abs(lum - (255 if lum < 128 else 17)),
    }


def analyze_many(image_bgr: np.ndarray, items: list) -> list:
    """批量分析，就地补充 `style` 字段。"""
    for it in items:
        it["style"] = analyze(image_bgr, it["rect"], it.get("text", ""))
    return items
