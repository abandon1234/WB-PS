# -*- coding: utf-8 -*-
"""为浏览器端 OCR PoC 生成基准数据。

产出：
  wasm-poc/baseline/char_dict.json   识别字典（与 Python 端 CTCLabelDecode 完全一致）
  wasm-poc/baseline/<stem>.json      RapidOCR 原始输出 + 项目 pipeline 输出

用途：浏览器端跑完后逐项比对，定位差异来自检测后处理还是识别预处理。
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import cv2
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[2]
POC = ROOT / "wasm-poc"
MODELS = POC / "models"
OUT = POC / "baseline"
OUT.mkdir(parents=True, exist_ok=True)


def export_dict() -> int:
    """从 rec 模型 metadata 提取字典，按 CTCLabelDecode 的规则组装。"""
    rec = MODELS / "ch_PP-OCRv3_rec_infer.onnx"
    sess = ort.InferenceSession(str(rec), providers=["CPUExecutionProvider"])
    meta = sess.get_modelmeta().custom_metadata_map
    chars = meta["character"].splitlines()
    char_list = ["blank", *chars, " "]           # 对应 add_special_char + append(' ')
    (OUT / "char_dict.json").write_text(
        json.dumps(char_list, ensure_ascii=False), encoding="utf-8")
    return len(char_list)


def rapidocr_raw(img_path: Path):
    """RapidOCR 原始输出，不做行合并——浏览器端要对比的就是这一层。"""
    from rapidocr_onnxruntime import RapidOCR

    eng = RapidOCR()
    img = cv2.imread(str(img_path))
    if img is None:
        raise ValueError(f"无法读取图片: {img_path}")
    t0 = time.time()
    res, _ = eng(img)
    dt = time.time() - t0
    items = []
    for box, text, score in (res or []):
        items.append({
            "box": [[float(p[0]), float(p[1])] for p in box],
            "text": text,
            "score": round(float(score), 4),
        })
    return img.shape[:2], items, dt


def pipeline_result(img_path: Path):
    """项目自身 pipeline 的输出（含行合并），作为端到端参照。"""
    sys.path.insert(0, str(ROOT))
    from app import pipeline

    bgr = pipeline.decode_image(img_path.read_bytes())
    t0 = time.time()
    out = pipeline.analyze(bgr, merge_lines=True, min_score=0.35)
    dt = time.time() - t0
    slim = {
        "count": out.get("count"),
        "backend": out.get("backend"),
        "size": {"w": out.get("width"), "h": out.get("height")},
        "items": [
            {"id": it.get("id"), "text": it.get("text"),
             "rect": it.get("rect"), "score": it.get("score")}
            for it in out.get("items", [])
        ],
    }
    return slim, dt


def main():
    print(f"[dict] {export_dict()} 项 -> baseline/char_dict.json")

    names = sys.argv[1:] or ["samples/test_card.png"]
    for name in names:
        p = Path(name)
        if not p.is_absolute():
            p = ROOT / name
        if not p.exists():
            print(f"[skip] 不存在: {p}")
            continue

        shape, items, dt = rapidocr_raw(p)
        print(f"[rapidocr] {p.name}: {len(items)} 框 / {dt:.2f}s / {shape[0]}x{shape[1]}")

        try:
            pl, pdt = pipeline_result(p)
            print(f"[pipeline] {p.name}: {pl['count']} 行 / {pdt:.2f}s / {pl['backend']}")
        except Exception as exc:                                  # noqa: BLE001
            pl = {"error": str(exc)}
            print(f"[pipeline] 失败: {exc}")

        # 顺带导出原始 BGR 像素：JS 侧无需图片解码库，就能拿到与 cv2.imread 逐字节一致的输入，
        # 从而把"图片解码差异"从比对变量里彻底排除。
        raw_img = cv2.imread(str(p))
        (OUT / f"{p.stem}.bgr").write_bytes(raw_img.tobytes())
        (OUT / f"{p.stem}.meta.json").write_text(
            json.dumps({"h": int(raw_img.shape[0]), "w": int(raw_img.shape[1]), "c": 3}),
            encoding="utf-8")
        print(f"[raw] baseline/{p.stem}.bgr ({raw_img.nbytes} bytes)")

        doc = {
            "image": p.name,
            "rel_path": str(p.relative_to(ROOT)).replace("\\", "/"),
            "size": {"h": int(shape[0]), "w": int(shape[1])},
            "rapidocr": items,
            "pipeline": pl,
        }
        target = OUT / f"{p.stem}.json"
        target.write_text(json.dumps(doc, ensure_ascii=False, indent=1),
                          encoding="utf-8")
        print(f"[out] baseline/{target.name}")


if __name__ == "__main__":
    main()
