# -*- coding: utf-8 -*-
"""端到端自检：识别 → 样式分析 → 擦除 → 重绘，并输出量化质量指标。

用法：
    python tools/selftest.py samples/test_card.png
    python tools/selftest.py            # 自动生成测试图
"""
from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cv2                                                        # noqa: E402
import numpy as np                                                # noqa: E402

from app import pipeline, style_analyzer, text_eraser, text_renderer   # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "samples", "out")

# 测试图里人为写死的样式真值（文字 → 预期 RGB / 预期背景类型）
TRUTH = {
    "产品使用说明书":                {"rgb": (32, 32, 36),   "bg": "solid", "size": 54},
    "Product User Manual":           {"rgb": (90, 96, 110),  "bg": "solid", "size": 24},
    "注意事项":                       {"rgb": (24, 90, 190),  "bg": "solid", "size": 30},
    "序列号":                         {"rgb": (70, 74, 84),   "bg": "solid", "size": 26},
    "限时优惠":                       {"rgb": (255, 255, 255), "bg": "gradient", "size": 40},
    "活动时间":                       {"rgb": (255, 255, 255), "bg": "gradient", "size": 24},
    "深圳市南山区科技园南区":          {"rgb": (38, 34, 30),   "bg": "texture", "size": 32},
    "联系电话":                       {"rgb": (52, 46, 40),   "bg": "texture", "size": 28},
    "Email":                          {"rgb": (60, 54, 46),   "bg": "texture", "size": 24},
}


def closest_truth(text: str):
    for k, v in TRUTH.items():
        if k in text or text in k:
            return v
    return None


def dist(a, b) -> float:
    return float(np.sqrt(sum((float(x) - float(y)) ** 2 for x, y in zip(a, b))))


def residual_score(image_bgr: np.ndarray, rect: dict, pad: int = 16) -> float:
    """擦除残留指标 = 区域内边缘能量 / 周边背景边缘能量。

    文字会带来强烈的边缘（Laplacian）响应，纯背景则很平坦。
    比值 ≈1 说明区域内已被抹平成背景；>2.2 说明仍有文字残留。
    """
    H, W = image_bgr.shape[:2]
    x0, y0 = max(0, int(rect["x"])), max(0, int(rect["y"]))
    x1 = min(W, x0 + int(rect["w"]))
    y1 = min(H, y0 + int(rect["h"]))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return 1.0
    g = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    inner = g[y0:y1, x0:x1]

    ox0, oy0 = max(0, x0 - pad), max(0, y0 - pad)
    ox1, oy1 = min(W, x1 + pad), min(H, y1 + pad)
    outer = g[oy0:oy1, ox0:ox1].copy()
    outer[y0 - oy0:y1 - oy0, x0 - ox0:x1 - ox0] = np.nan

    ei = float(np.mean(np.abs(cv2.Laplacian(inner, cv2.CV_32F))))
    eo = float(np.nanmean(np.abs(cv2.Laplacian(outer, cv2.CV_32F))))
    return ei / max(eo, 0.5)


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "samples", "test_card.png")

    if not os.path.isfile(src):
        print("未找到测试图，正在生成…")
        from tools import make_test_image          # type: ignore
        make_test_image.main()
    if not os.path.isfile(src):
        print(f"[FAIL] 测试图不存在: {src}")
        return 1

    data = open(src, "rb").read()
    img = pipeline.decode_image(data)
    print(f"\n图像: {src}  {img.shape[1]}x{img.shape[0]}")
    print("=" * 78)

    # ---------- 1. 识别 ----------
    t0 = time.time()
    res = pipeline.analyze(img, merge_lines=True)
    t_ocr = time.time() - t0
    print(f"[1] OCR 引擎={res['backend']}  识别 {res['count']} 处  耗时 {t_ocr:.2f}s\n")

    # ---------- 2. 样式准确性 ----------
    print("[2] 样式分析（颜色 / 字号 / 背景类型）")
    print(f"    {'识别文字':<26} {'颜色':<16} {'ΔRGB':>6} {'字号':>5} {'背景':<9} {'std':>6} {'grad':>5}")
    print("    " + "-" * 80)
    color_errs, size_errs, bg_hits = [], [], []
    for it in res["items"]:
        st = it["style"]
        truth = closest_truth(it["text"])
        de, ds = None, None
        if truth:
            de = dist(st["fg_color"], truth["rgb"])
            ds = abs(st["font_size"] - truth["size"])
            color_errs.append(de)
            size_errs.append(ds / truth["size"])
            if st["bg_type"] == truth["bg"]:
                bg_hits.append(1)
            else:
                bg_hits.append(0)
        col = f"{tuple(st['fg_color'])}"
        print(f"    {it['text'][:24]:<26} {col:<16} "
              f"{(f'{de:.1f}' if de is not None else ''):>6} "
              f"{st['font_size']:>5} {st['bg_type']:<9} "
              f"{st.get('bg_std', 0):>6.1f} {st.get('bg_grad', 0):>5.1f}"
              + ("" if not truth or st["bg_type"] == truth["bg"]
                 else f"   ← 期望 {truth['bg']}"))
    if color_errs:
        print(f"\n    颜色平均偏差 ΔRGB = {np.mean(color_errs):.1f}（<25 视为准确）")
        print(f"    字号平均相对误差 = {np.mean(size_errs) * 100:.1f}%")
        print(f"    背景类型命中率 = {sum(bg_hits)}/{len(bg_hits)}")

    # ---------- 3. 擦除质量 ----------
    print("\n[3] 擦除质量（区域内边缘能量 / 周边背景，≈1 最干净）")
    method_hits = {}
    ratios = []
    for it in res["items"]:
        erased, meta = text_eraser.erase(img, it["rect"], it["style"])
        r = residual_score(erased, it["rect"])
        before = residual_score(img, it["rect"])
        ratios.append(r)
        method_hits[meta["method"]] = method_hits.get(meta["method"], 0) + 1
        flag = "OK " if r < 1.8 else ("~  " if r < 2.6 else "BAD")
        print(f"    {flag} {it['text'][:20]:<22} 方法={meta['method']:<8} "
              f"擦前={before:>6.2f} → 擦后={r:>5.2f}")
    if ratios:
        print(f"    平均残留比 = {np.mean(ratios):.2f}（<1.8 视为无痕）")
    print(f"    策略分布: {method_hits}")

    # ---------- 4. 重绘与整体应用 ----------
    print("\n[4] 无痕替换（整图应用）")
    edits = {}
    for it in res["items"]:
        edits[str(it["id"])] = {
            "text": it["text"].replace("2026", "2099").replace("199", "299")
                    if any(c.isdigit() for c in it["text"]) else it["text"],
        }
    # 强制让几处发生替换，便于肉眼比对
    if res["items"]:
        res["items"][0]["edited"] = True
        edits[str(res["items"][0]["id"])]["text"] = "产品使用说明书（修订版）"
    if len(res["items"]) > 3:
        edits[str(res["items"][3]["id"])]["text"] = "序列号 SN-2099-0101-Z9"

    out, stats = pipeline.apply_edits(img, res["items"], edits)
    print(f"    擦除 {stats['erased']} 处，重绘 {stats['rendered']} 处")
    for rec in stats["log"]:
        if rec.get("action") == "error":
            print(f"    [ERROR] {rec}")
        elif rec.get("warnings"):
            print(f"    [warn ] #{rec.get('id')} {rec['warnings']}")

    out_png = os.path.join(OUT_DIR, "result.png")
    pipeline.encode_image(out, ".png")
    cv2.imwrite(out_png, out)
    cv2.imwrite(os.path.join(OUT_DIR, "source.png"), img)

    # 拼接对比图（上：原图；下：结果）
    gap = np.full((14, img.shape[1], 3), 40, dtype=np.uint8)
    cv2.imwrite(os.path.join(OUT_DIR, "compare.png"),
                np.vstack([img, gap, out]))
    print(f"\n    结果: {out_png}")
    print(f"    对比: {os.path.join(OUT_DIR, 'compare.png')}")

    # ---------- 5. 字体与渲染自检 ----------
    print("\n[5] 字体与渲染自检")
    face = None
    try:
        from app import fonts
        fams = fonts.list_families()
        print(f"    可用字体族: {len(fams)}")
        face = fonts.resolve("Microsoft YaHei", bold=True)
        if face:
            print(f"    微软雅黑粗体 → {os.path.basename(face.path)} idx={face.index} "
                  f"style={face.style}")
    except Exception as exc:                     # noqa: BLE001
        print(f"    [FAIL] 字体加载异常: {exc}")

    if res["items"]:
        it = res["items"][0]
        rr = text_renderer.render(img, it["rect"], "版本 V3.0 已发布", it["style"])
        cv2.imwrite(os.path.join(OUT_DIR, "render_probe.png"), rr.image)
        print(f"    渲染探针: 字号={rr.font_size} 字体={rr.family} 自适应={rr.fitted}")

    print("\n" + "=" * 78)
    ok = bool(res["count"] > 0) and (not color_errs or np.mean(color_errs) < 25)
    print("自检结果：" + ("通过 ✅" if ok else "存在问题 ⚠️"))
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
