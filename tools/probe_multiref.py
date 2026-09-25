# -*- coding: utf-8 -*-
"""探测中转站是否支持「多张参照图」。

界面设计里参照图区是 0/4，但此前只验证过单张。
这里分别试 `image` 传数组、`images` 传数组两种形式，看哪种能被真正采纳。

判定方式用强特征图：洋红底白方块 + 青底黑三角，
若结果同时出现两种特征，说明两张都被采纳。
"""
from __future__ import annotations

import base64
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cv2                                              # noqa: E402
import numpy as np                                      # noqa: E402

BASE = "https://code.linlong520.com"
KEY = "sk-BSp8b8Rx1jeiHriYSqyeHV9rYfMrGSOLnl1VezHHVQGBr4si"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "samples", "out")


def opener():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                       urllib.request.HTTPSHandler(context=ctx))


def make_refs():
    """两张特征极强的参照图。"""
    a = np.zeros((512, 512, 3), np.uint8)
    a[:, :] = (255, 0, 255)                             # BGR 洋红
    cv2.rectangle(a, (176, 176), (336, 336), (255, 255, 255), -1)

    b = np.zeros((512, 512, 3), np.uint8)
    b[:, :] = (255, 255, 0)                             # BGR 青
    pts = np.array([[256, 80], [432, 400], [80, 400]], np.int32)
    cv2.fillPoly(b, [pts], (0, 0, 0))

    out = []
    for name, img in (("multi_a.png", a), ("multi_b.png", b)):
        p = os.path.join(OUT, name)
        cv2.imwrite(p, img)
        out.append("data:image/png;base64," +
                   base64.b64encode(cv2.imencode(".png", img)[1].tobytes()).decode())
    return out


def call(payload, timeout=300):
    op = opener()
    req = urllib.request.Request(
        f"{BASE}/v1/images/generations",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {KEY}",
                 "Content-Type": "application/json"},
        method="POST")
    t = time.time()
    try:
        with op.open(req, timeout=timeout) as resp:
            return resp.status, resp.read(), time.time() - t
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), time.time() - t
    except Exception as exc:                            # noqa: BLE001
        return "ERR", str(exc).encode(), time.time() - t


def analyse(raw: bytes, tag: str) -> None:
    try:
        d = json.loads(raw.decode("utf-8", "ignore"))
        items = d.get("data") or []
    except Exception:                                   # noqa: BLE001
        print(f"    {tag}: 非 JSON -> {raw[:200]!r}")
        return
    if not items:
        print(f"    {tag}: data 为空 -> {json.dumps(d, ensure_ascii=False)[:200]}")
        return
    b64 = items[0].get("b64_json") or ""
    if not b64:
        print(f"    {tag}: 无 b64_json，keys={list(items[0].keys())}")
        return
    raw_b = b64.split(",", 1)[1] if b64.startswith("data:") else b64
    raw_b += "=" * (-len(raw_b) % 4)
    img = cv2.imdecode(np.frombuffer(base64.b64decode(raw_b), np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        print(f"    {tag}: 解码失败")
        return
    p = os.path.join(OUT, f"multiref_{tag}.png")
    cv2.imwrite(p, img)
    s = cv2.resize(img, (96, 96)).astype(np.int32)
    B, G, R = s[..., 0], s[..., 1], s[..., 2]
    magenta = ((R > 140) & (B > 140) & (G < 110)).mean()
    cyan = ((G > 140) & (B > 140) & (R < 110)).mean()
    dark = (s.min(axis=2) < 70).mean()
    print(f"    {tag}: {img.shape[1]}x{img.shape[0]} -> {os.path.basename(p)}")
    print(f"      洋红 {magenta*100:.1f}%  青 {cyan*100:.1f}%  黑 {dark*100:.1f}%")


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    refs = make_refs()
    print("参照图已就绪（洋红底白方块 / 青底黑三角）\n")

    prompt = ("输出一张图，同时包含两张参考图的配色："
              "洋红色背景带白色方形，以及青色背景带黑色三角形")

    for tag, key, value in (("imageArray", "image", refs),
                            ("imagesArray", "images", refs)):
        print(f"[{tag}] {key}=[2 张 data URL]")
        body = {"model": "gpt-image-2", "prompt": prompt, "n": 1,
                "size": "1024x1024", key: value}
        st, raw, dt = call(body)
        print(f"    HTTP {st}  耗时 {dt:.1f}s  {len(raw)} 字节")
        analyse(raw, tag)
        print()


if __name__ == "__main__":
    main()
