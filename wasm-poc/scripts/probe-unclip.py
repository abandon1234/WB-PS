# -*- coding: utf-8 -*-
"""对照实验：把 Python 端的 unclip 换成与 JS 相同的「几何扩张」，看两侧能否完全对齐。

目的：确认当前差异是否全部来自 pyclipper 的实现细节（整数坐标 + 圆角近似），
而不是我的 JS 实现有逻辑错误。

产出：baseline/<stem>_geom.json —— 与 gen-baseline.py 同结构，供 verify-node 比对。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
POC = ROOT / "wasm-poc"
OUT = POC / "baseline"
OUT.mkdir(parents=True, exist_ok=True)


# ---- 打补丁：几何扩张替代 pyclipper ------------------------------------------
def _geom_unclip(self, box):
    """与 det.js 的 unclipBox 完全相同的算法。"""
    rect = cv2.minAreaRect(np.asarray(box, dtype=np.float32))
    (cx, cy), (w, h), ang = rect
    d = (w * h * self.unclip_ratio) / (2 * (w + h))
    return cv2.boxPoints(((cx, cy), (w + 2 * d, h + 2 * d), ang))


def patch_unclip():
    from rapidocr_onnxruntime.ch_ppocr_v3_det import utils as det_utils
    original = det_utils.DBPostProcess.unclip

    def wrapped(self, box):
        return _geom_unclip(self, box)

    det_utils.DBPostProcess.unclip = wrapped
    return original


def main():
    names = [n for n in sys.argv[1:] if not n.startswith("-")]
    if not names:
        names = ["samples/test_card.png", "samples/out/ui_11_edit_loaded.png"]

    patch_unclip()                      # 必须在 RapidOCR 实例化前打好

    from rapidocr_onnxruntime import RapidOCR
    eng = RapidOCR()

    for name in names:
        p = Path(name)
        if not p.is_absolute():
            p = ROOT / name
        if not p.exists():
            print(f"[skip] {p}")
            continue

        img = cv2.imread(str(p))
        res, _ = eng(img)
        items = []
        for box, text, score in (res or []):
            items.append({
                "box": [[float(q[0]), float(q[1])] for q in box],
                "text": text,
                "score": round(float(score), 4),
            })

        target = OUT / f"{p.stem}_geom.json"
        target.write_text(json.dumps({
            "image": p.name,
            "size": {"h": int(img.shape[0]), "w": int(img.shape[1])},
            "rapidocr": items,
            "note": "unclip 已替换为几何扩张，用于与 JS 侧对齐",
        }, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"[geom] {p.stem}: {len(items)} 框 -> baseline/{target.name}")


if __name__ == "__main__":
    main()
