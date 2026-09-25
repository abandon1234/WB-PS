# -*- coding: utf-8 -*-
"""生成用于验证的测试图：覆盖纯色 / 渐变 / 纹理背景与多种文字样式。

用法：python tools/make_test_image.py [输出路径]
"""
from __future__ import annotations

import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

OUT_DEFAULT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "samples", "test_card.png")

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\simsun.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
]


def load_font(size: int, bold: bool = False):
    idx = 1 if bold and "msyh.ttc" in FONT_CANDIDATES[0] else 0
    for p in FONT_CANDIDATES:
        if os.path.isfile(p):
            try:
                return ImageFont.truetype(p, size, index=0)
            except Exception:            # noqa: BLE001
                continue
    return ImageFont.load_default()


def gradient_bg(w: int, h: int) -> Image.Image:
    x = np.linspace(30, 210, w, dtype=np.float32)[None, :]
    y = np.linspace(0, 40, h, dtype=np.float32)[:, None]
    arr = np.zeros((h, w, 3), dtype=np.float32)
    arr[..., 0] = x * 0.35 + y * 0.2 + 40      # B
    arr[..., 1] = x * 0.9 + y * 0.5 + 30       # G
    arr[..., 2] = x * 1.0 + y * 0.3 + 20       # R
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def texture_bg(w: int, h: int) -> Image.Image:
    rng = np.random.default_rng(7)
    base = np.zeros((h, w, 3), dtype=np.float32)
    base[..., :] = np.array([196, 182, 160], dtype=np.float32)
    # 低频起伏模拟纸张/木纹
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    wave = (np.sin(xx / 37.0) * 8 + np.sin(yy / 23.0) * 6
            + np.sin((xx + yy) / 61.0) * 5)
    base += wave[..., None]
    base += rng.normal(0, 2.4, base.shape)
    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))


def build() -> Image.Image:
    W, H = 1000, 720
    img = Image.new("RGB", (W, H), (250, 250, 250))
    d = ImageDraw.Draw(img)

    # --- 区块 1：纯白底 + 深灰大字 ---
    d.rectangle([0, 0, W, 150], fill=(255, 255, 255))
    d.text((40, 40), "产品使用说明书", font=load_font(54), fill=(32, 32, 36))
    d.text((40, 108), "Product User Manual  V2.4", font=load_font(24), fill=(90, 96, 110))

    # --- 区块 2：浅灰底 + 蓝字 ---
    d.rectangle([0, 150, W, 300], fill=(242, 244, 248))
    d.text((40, 180), "注意事项：请勿在潮湿环境中使用", font=load_font(30), fill=(24, 90, 190))
    d.text((40, 232), "序列号 SN-2026-0918-A7", font=load_font(26), fill=(70, 74, 84))

    # --- 区块 3：横向渐变底 + 白字（对比擦除难度最高） ---
    grad = gradient_bg(W, 170)
    img.paste(grad, (0, 300))
    d.text((40, 340), "限时优惠 ￥199 起", font=load_font(40), fill=(255, 255, 255))
    d.text((40, 400), "活动时间 09/18 - 09/30", font=load_font(24), fill=(255, 255, 255))

    # --- 区块 4：纹理底 + 深字 ---
    tex = texture_bg(W, 230)
    img.paste(tex, (0, 470))
    d.text((40, 505), "深圳市南山区科技园南区", font=load_font(32), fill=(38, 34, 30))
    d.text((40, 560), "联系电话：0755-8888 6666", font=load_font(28), fill=(52, 46, 40))
    d.text((40, 615), "Email: support@example.com", font=load_font(24), fill=(60, 54, 46))

    return img


def main() -> None:
    out = sys.argv[1] if len(sys.argv) > 1 else OUT_DEFAULT
    os.makedirs(os.path.dirname(out), exist_ok=True)
    img = build()
    img.save(out)
    # 同时存一份 JPEG，用于验证压缩噪声下的表现
    jpg = os.path.splitext(out)[0] + ".jpg"
    img.save(jpg, quality=72)
    print(f"已生成: {out} ({img.width}x{img.height})")
    print(f"已生成: {jpg}")


if __name__ == "__main__":
    main()
