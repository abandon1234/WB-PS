# -*- coding: utf-8 -*-
"""字体匹配 + 笔画校准的针对性验证。

做法：用已知字体在图上写 "-500.00"，再要求把它改成 "-700.00"，
然后和「用同一字体直接写 -700.00」的参考图做形状比对（IoU）。
IoU 越接近 1，说明替换后越像"本来就长这样"。
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cv2                                                        # noqa: E402
import numpy as np                                                # noqa: E402
from PIL import Image, ImageDraw, ImageFont                       # noqa: E402

from app import fonts as fontlib                                  # noqa: E402
from app import pipeline                                          # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "samples", "out")
SIZE = 72
SRC_TEXT = "-500.00"
DST_TEXT = "-700.00"
CASES = ["Arial", "Segoe UI", "Verdana", "Tahoma", "Consolas",
         "Times New Roman", "Calibri", "Trebuchet MS", "Comic Sans MS"]

PANEL_H = 88          # 掩膜可视化统一高度


def draw_probe(family: str, text: str, size: int = SIZE) -> np.ndarray:
    """白底 + 指定字体写 text，返回 BGR 图。"""
    fp = fontlib.font_path_for(family, False, False)
    if not fp:
        raise RuntimeError(f"字体不可用: {family}")
    path, index = fp
    font = ImageFont.truetype(path, size, index=index)

    W, H = 900, 220
    im = Image.new("RGB", (W, H), (255, 255, 255))
    ImageDraw.Draw(im).text((70, 70), text, font=font, fill=(26, 26, 30))
    return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)


def ink_mask_of(img: np.ndarray, rect: dict | None = None) -> np.ndarray:
    """取区域内的墨迹二值掩膜，裁剪到墨迹外接框。"""
    x, y, w, h = (rect["x"], rect["y"], rect["w"], rect["h"]) if rect \
        else (0, 0, img.shape[1], img.shape[0])
    x, y = max(0, x), max(0, y)
    g = cv2.cvtColor(img[y:y + h, x:x + w], cv2.COLOR_BGR2GRAY)
    m = (g < 170).astype(np.uint8) * 255
    if not m.any():
        return m
    ys, xs = np.where(m > 0)
    return m[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def iou(a: np.ndarray, b: np.ndarray) -> float:
    """两张掩膜归一到同尺寸后算交并比。"""
    if a.size == 0 or b.size == 0:
        return 0.0
    H, W = 96, 384
    ra = cv2.resize(a, (W, H), interpolation=cv2.INTER_AREA) > 96
    rb = cv2.resize(b, (W, H), interpolation=cv2.INTER_AREA) > 96
    union = np.logical_or(ra, rb).sum()
    return float(np.logical_and(ra, rb).sum()) / float(union) if union else 0.0


def aspect_of(mask: np.ndarray) -> float:
    return mask.shape[1] / max(mask.shape[0], 1)


def norm_mask(m: np.ndarray, box_w: int = 380, box_h: int = PANEL_H) -> np.ndarray:
    """等比缩放并居中放进固定画布。

    注意必须固定画布尺寸：若各图按自身比例缩放后并排，
    宽高比不同的两张图会看起来"字距不同"，产生视觉误导。
    """
    canvas = np.full((box_h, box_w), 255, np.uint8)
    if m.size == 0:
        return canvas
    h, w = m.shape
    s = min(box_w / float(w), box_h / float(h))
    nw, nh = max(1, int(round(w * s))), max(1, int(round(h * s)))
    r = cv2.resize(m, (nw, nh), interpolation=cv2.INTER_AREA)
    oy, ox = (box_h - nh) // 2, (box_w - nw) // 2
    canvas[oy:oy + nh, ox:ox + nw] = 255 - r
    return canvas


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    print("=" * 100)
    print(f"字体匹配 + 笔画校准验证      把 {SRC_TEXT} 改成 {DST_TEXT}")
    print("=" * 100)
    print(f"\n{'原字体':<16}{'自动匹配到':<22}{'宽高比 真值/结果':>18}"
          f"{'形状IoU':>9}{'笔画 真值/结果':>17}")
    print("-" * 100)

    rows, panels = [], []
    for fam in CASES:
        try:
            src = draw_probe(fam, SRC_TEXT)
            truth = draw_probe(fam, DST_TEXT)
        except Exception as exc:                     # noqa: BLE001
            print(f"{fam:<16} 跳过：{exc}")
            continue

        truth_mask = ink_mask_of(truth)
        res = pipeline.analyze(src, merge_lines=False)
        if not res["items"]:
            print(f"{fam:<16} OCR 未识别到，跳过")
            continue
        item = res["items"][0]

        png, info = pipeline.preview_item(src, item, {"text": DST_TEXT})
        out = pipeline.decode_image(png)
        rg = info["region"]
        out_mask = ink_mask_of(out, {"x": rg[0], "y": rg[1], "w": rg[2], "h": rg[3]})

        matched = info.get("family") or "?"
        score = iou(truth_mask, out_mask)
        st = info.get("stroke") or {}
        hit = matched.split()[0].lower() == fam.split()[0].lower()
        rows.append((fam, matched, score, hit))
        panels.append(np.hstack([
            norm_mask(truth_mask), np.full((PANEL_H, 10), 200, np.uint8),
            norm_mask(out_mask),
        ]))

        aspect_txt = f"{aspect_of(truth_mask):.2f} / {aspect_of(out_mask):.2f}"
        stroke_txt = f"{float(st.get('target') or 0):.1f} / {float(st.get('rendered') or 0):.1f}"
        hit_mark = "✔" if hit else "·"

        print(f"{fam:<16}{matched:<22}{aspect_txt:>18}{score:>9.3f}"
              f"{stroke_txt:>17}  {hit_mark}")

    if panels:
        width = max(p.shape[1] for p in panels)
        padded = []
        for p in panels:
            pad = np.full((PANEL_H, width - p.shape[1]), 255, np.uint8)
            padded.append(np.hstack([p, pad]))
        grid = np.vstack(padded)
        path = os.path.join(OUT, "font_match.png")
        cv2.imwrite(path, grid)
        print(f"\n可视化（每行：参考形状 -700.00 ｜ 工具结果 -700.00）")
        print(f"  {path}")

    avg = float(np.mean([r[2] for r in rows])) if rows else 0.0
    hits = sum(1 for r in rows if r[3])
    print(f"\n字体命中 {hits}/{len(rows)}    平均形状 IoU = {avg:.3f}"
          f"    IoU≥0.60 的样本 {sum(1 for r in rows if r[2] >= 0.60)}/{len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
