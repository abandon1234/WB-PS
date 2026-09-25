# -*- coding: utf-8 -*-
"""OCR 引擎：多后端自动探测，统一输出「文字 + 四点坐标」。

对外只暴露 detect()，返回结构固定，方便上层替换后端：
    {
        "box":   [[x,y] x4],           # 顺时针四点（左上起）
        "rect":  {x, y, w, h},         # 轴对齐外接矩形
        "text":  "识别文本",
        "score": 0.98,
        "angle": -1.2,                 # 倾斜角（度）
        "quad_axis": True              # 四点是否接近轴对齐矩形
    }
"""
from __future__ import annotations

import threading
from typing import Any, List, Optional

import cv2
import numpy as np

_lock = threading.Lock()
_engine: Any = None
_backend: Optional[str] = None
_load_error: Optional[str] = None


# ------------------------------------------------------------------ 后端加载

def _try_rapidocr_onnxruntime():
    from rapidocr_onnxruntime import RapidOCR  # type: ignore
    eng = RapidOCR()

    def run(img: np.ndarray):
        res, _elapse = eng(img)
        if not res:
            return []
        out = []
        for item in res:
            box, text, score = item[0], item[1], item[2]
            out.append((box, text, float(score)))
        return out

    return run, "rapidocr_onnxruntime"


def _try_rapidocr_new():
    from rapidocr import RapidOCR  # type: ignore
    eng = RapidOCR()

    def run(img: np.ndarray):
        res = eng(img)
        boxes = getattr(res, "boxes", None)
        txts = getattr(res, "txts", None)
        scores = getattr(res, "scores", None)
        if boxes is None or txts is None:
            return []
        if scores is None:
            scores = [1.0] * len(txts)
        return [(b, t, float(s)) for b, t, s in zip(boxes, txts, scores)]

    return run, "rapidocr"


def _try_paddleocr():
    from paddleocr import PaddleOCR  # type: ignore
    eng = PaddleOCR(use_angle_cls=True, lang="ch", show_log=False)

    def run(img: np.ndarray):
        res = eng.ocr(img, cls=True)
        out = []
        for page in (res or []):
            for line in (page or []):
                box, (text, score) = line[0], line[1]
                out.append((box, text, float(score)))
        return out

    return run, "paddleocr"


_BACKENDS = (_try_rapidocr_onnxruntime, _try_rapidocr_new, _try_paddleocr)


def get_engine():
    """惰性加载，线程安全。返回 (run_fn, backend_name)。"""
    global _engine, _backend, _load_error
    if _engine is not None:
        return _engine, _backend
    with _lock:
        if _engine is not None:
            return _engine, _backend
        errs = []
        for factory in _BACKENDS:
            try:
                run, name = factory()
                _engine, _backend, _load_error = run, name, None
                return _engine, _backend
            except Exception as exc:            # noqa: BLE001
                errs.append(f"{factory.__name__}: {exc}")
        _load_error = " | ".join(errs)
        raise RuntimeError(
            "未找到可用的 OCR 后端。请执行: pip install rapidocr-onnxruntime\n"
            f"加载详情: {_load_error}"
        )


def backend_name() -> str:
    try:
        _, name = get_engine()
        return name
    except Exception:                            # noqa: BLE001
        return "unavailable"


def backend_error() -> Optional[str]:
    return _load_error


# ------------------------------------------------------------------ 几何工具

def order_quad(pts: np.ndarray) -> np.ndarray:
    """四点排序：左上 → 右上 → 右下 → 左下。"""
    pts = np.asarray(pts, dtype=np.float32).reshape(4, 2)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).ravel()
    return np.array([
        pts[np.argmin(s)],   # 左上：x+y 最小
        pts[np.argmin(d)],   # 右上：y-x 最小
        pts[np.argmax(s)],   # 右下：x+y 最大
        pts[np.argmax(d)],   # 左下：y-x 最大
    ], dtype=np.float32)


def quad_metrics(quad: np.ndarray) -> dict:
    """计算轴对齐矩形与倾斜角。"""
    q = order_quad(quad)
    xs, ys = q[:, 0], q[:, 1]
    x0, x1 = float(xs.min()), float(xs.max())
    y0, y1 = float(ys.min()), float(ys.max())
    w, h = x1 - x0, y1 - y0

    top = q[1] - q[0]
    angle = float(np.degrees(np.arctan2(top[1], top[0])))
    if angle > 90:
        angle -= 180
    elif angle < -90:
        angle += 180

    # 四点与理论轴对齐矩形的偏差（判定是否被旋转）
    ideal = np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], dtype=np.float32)
    dev = float(np.abs(q - ideal).max())
    return {
        "rect": {"x": int(round(x0)), "y": int(round(y0)),
                 "w": int(round(w)), "h": int(round(h))},
        "angle": round(angle, 2),
        "quad_axis": dev <= max(2.0, 0.08 * max(w, h, 1)),
    }


# ------------------------------------------------------------------ 行合并

def merge_lines(items: List[dict], enabled: bool = True) -> List[dict]:
    """把同一行的多个检测框合并成一个「文本行」框。

    OCR 常把一行文字切成若干片段，合并后编辑体验和视觉还原都更自然。
    """
    if not enabled or len(items) <= 1:
        for i, it in enumerate(items):
            it["segments"] = [it["text"]]
            it["id"] = i
        return items

    items = sorted(items, key=lambda it: (it["rect"]["y"], it["rect"]["x"]))
    used = [False] * len(items)
    lines: List[dict] = []

    for i, base in enumerate(items):
        if used[i]:
            continue
        group = [base]
        used[i] = True
        br = base["rect"]
        b_cy = br["y"] + br["h"] / 2.0
        b_h = max(br["h"], 1)
        changed = True
        while changed:
            changed = False
            gx0 = min(g["rect"]["x"] for g in group)
            gx1 = max(g["rect"]["x"] + g["rect"]["w"] for g in group)
            gy0 = min(g["rect"]["y"] for g in group)
            gy1 = max(g["rect"]["y"] + g["rect"]["h"] for g in group)
            gh = max(gy1 - gy0, 1)
            for j, cand in enumerate(items):
                if used[j]:
                    continue
                cr = cand["rect"]
                c_cy = cr["y"] + cr["h"] / 2.0
                # 垂直：中心线接近 且 高度量级相近
                v_ok = (abs(c_cy - b_cy) < 0.45 * max(gh, b_h)
                        and 0.5 <= cr["h"] / max(gh, 1) <= 2.0)
                # 水平：间隙不超过 2.2 个字宽
                gap = max(gx0 - (cr["x"] + cr["w"]), cr["x"] - gx1, 0)
                h_ok = gap < 2.2 * gh
                # 样式接近（大小写混合/字号差异大的不强行合并）
                if v_ok and h_ok:
                    group.append(cand)
                    used[j] = True
                    b_h = max(b_h, cr["h"])
                    changed = True

        group.sort(key=lambda g: g["rect"]["x"])
        x0 = min(g["rect"]["x"] for g in group)
        y0 = min(g["rect"]["y"] for g in group)
        x1 = max(g["rect"]["x"] + g["rect"]["w"] for g in group)
        y1 = max(g["rect"]["y"] + g["rect"]["h"] for g in group)
        # 合并后的四点：默认取并集矩形（倾斜行留给上层按角度处理）
        max_angle = max(abs(g["angle"]) for g in group)
        lines.append({
            "box": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
            "rect": {"x": int(x0), "y": int(y0),
                     "w": int(max(x1 - x0, 1)), "h": int(max(y1 - y0, 1))},
            "text": " ".join(g["text"] for g in group) if group[0]["text"].isascii()
                    else "".join(g["text"] for g in group),
            "score": round(float(np.mean([g["score"] for g in group])), 4),
            "angle": round(float(np.mean([g["angle"] for g in group])), 2),
            "quad_axis": all(g["quad_axis"] for g in group),
            "segments": [g["text"] for g in group],
            "merged": len(group),
        })

    lines.sort(key=lambda it: (it["rect"]["y"], it["rect"]["x"]))
    for i, it in enumerate(lines):
        it["id"] = i
    return lines


# ------------------------------------------------------------------ 主入口

def detect(image_bgr: np.ndarray,
           merge: bool = True,
           min_score: float = 0.35,
           max_side: int = 2400) -> List[dict]:
    """对 BGR 图像做文字检测与识别。

    Args:
        image_bgr: OpenCV BGR 图像。
        merge:     是否合并同一行的碎框。
        min_score: 置信度过滤阈值。
        max_side:  长边上限，超限则等比缩小以加速（坐标会映射回原尺寸）。
    """
    run, _ = get_engine()

    h, w = image_bgr.shape[:2]
    scale = 1.0
    feed = image_bgr
    if max(h, w) > max_side:
        scale = max_side / float(max(h, w))
        feed = cv2.resize(image_bgr, None, fx=scale, fy=scale,
                          interpolation=cv2.INTER_AREA)

    raw = run(feed)
    results: List[dict] = []
    for box, text, score in raw:
        text = (text or "").strip()
        if not text or score < min_score:
            continue
        quad = order_quad(np.asarray(box, dtype=np.float32)) / scale
        m = quad_metrics(quad)
        if m["rect"]["w"] < 3 or m["rect"]["h"] < 3:
            continue
        results.append({
            "box": [[round(float(p[0]), 1), round(float(p[1]), 1)] for p in quad],
            "rect": m["rect"],
            "text": text,
            "score": round(float(score), 4),
            "angle": m["angle"],
            "quad_axis": m["quad_axis"],
        })

    return merge_lines(results, enabled=merge)
