# -*- coding: utf-8 -*-
"""图片生成模块的端到端测试。

覆盖：配置增删改查 / 启用禁用 / 连通性测试 / 页面可访问 / 真实生成。

用法：
    python tools/image_api_test.py                     # 用内置的测试参数
    python tools/image_api_test.py --base <url> --no-generate
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "samples", "out")

# 用户提供的测试参数
TEST_BASE = "https://code.linlong520.com"
TEST_KEY = "sk-BSp8b8Rx1jeiHriYSqyeHV9rYfMrGSOLnl1VezHHVQGBr4si"
TEST_PROMPT = "生成一个小狗"

PASS, FAIL = [], []


def check(name: str, ok: bool, detail: str = "") -> bool:
    (PASS if ok else FAIL).append(name)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))
    return ok


class Client:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.op = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def get(self, path: str, timeout: int = 30):
        with self.op.open(self.base + path, timeout=timeout) as r:
            ct = r.headers.get("Content-Type", "")
            raw = r.read()
            return json.loads(raw) if "json" in ct else raw

    def send(self, path: str, method: str, payload=None, timeout: int = 600):
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Content-Type": "application/json"}, method=method)
        try:
            with self.op.open(req, timeout=timeout) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read())
            except Exception:                 # noqa: BLE001
                return e.code, {}

    def post_form(self, path: str, fields: dict, files: dict = None,
                  timeout: int = 600):
        bd = "----wb" + uuid.uuid4().hex
        parts = []
        for k, v in fields.items():
            parts.append(f'--{bd}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
        for k, (fn, data, ct) in (files or {}).items():
            parts.append(f'--{bd}\r\nContent-Disposition: form-data; name="{k}"; '
                         f'filename="{fn}"\r\nContent-Type: {ct}\r\n\r\n'.encode())
            parts.append(data)
            parts.append(b"\r\n")
        parts.append(f"--{bd}--\r\n".encode())
        req = urllib.request.Request(
            self.base + path, data=b"".join(parts),
            headers={"Content-Type": f"multipart/form-data; boundary={bd}"}, method="POST")
        try:
            with self.op.open(req, timeout=timeout) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read())
            except Exception:                 # noqa: BLE001
                return e.code, {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--url", default=TEST_BASE, help="被测中转站地址")
    ap.add_argument("--key", default=TEST_KEY)
    ap.add_argument("--prompt", default=TEST_PROMPT)
    ap.add_argument("--no-generate", action="store_true", help="跳过真实生成（省额度）")
    ap.add_argument("--keep", action="store_true", help="测试后保留配置")
    args = ap.parse_args()

    c = Client(args.base)
    print("=" * 78)
    print(f"图片生成模块端到端测试   服务={args.base}")
    print("=" * 78)

    # 1. 页面与静态资源
    print("\n[1] 页面与静态资源")
    try:
        html = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
            args.base + "/image", timeout=20).read().decode("utf-8", "ignore")
        check("独立页面 /image 可访问", "<html" in html.lower(), f"{len(html)} 字节")
        check("含提示词输入区", 'id="prompt"' in html)
        check("含参照图上传区", 'id="dropzone"' in html and 'id="refInput"' in html)
        check("含结果展示区", 'id="result"' in html and 'id="resultImg"' in html)
        check("含加载状态", 'id="stateLoading"' in html)
        check("含错误提示", 'id="stateError"' in html and 'id="errMsg"' in html)
    except Exception as exc:                  # noqa: BLE001
        check("独立页面 /image 可访问", False, str(exc))
    for asset in ("/static/image.css", "/static/image.js"):
        try:
            b = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
                args.base + asset, timeout=20).read()
            check(f"{os.path.basename(asset)} 可加载", len(b) > 500, f"{len(b)} 字节")
        except Exception as exc:              # noqa: BLE001
            check(f"{os.path.basename(asset)} 可加载", False, str(exc))

    # 2. 概览
    print("\n[2] 配置概览")
    ov = c.get("/api/image/overview")
    check("返回配置列表", isinstance(ov.get("providers"), list),
          f"{len(ov.get('providers') or [])} 条")
    check("返回默认模型", ov.get("default_model") == "gpt-image-2", ov.get("default_model"))
    before_ids = {p["id"] for p in (ov.get("providers") or [])}

    # 3. 新增配置
    print("\n[3] 新增配置")
    st, res = c.send("/api/image/providers", "POST", {
        "name": "测试中转站", "base_url": args.url, "api_key": args.key,
        "model": "gpt-image-2", "note": "自动化测试创建", "enabled": True,
    })
    ok = check("新增成功", st in (200, 201), f"HTTP {st}")
    p = (res or {}).get("provider") or {}
    pid = p.get("id")
    check("返回配置 id", bool(pid), pid)
    check("地址已规整（去掉尾部 / 与 /v1）",
          (p.get("base_url") or "").rstrip("/").endswith("linlong520.com"), p.get("base_url"))
    check("key 已保存", bool(p.get("has_key")))
    if not pid:
        print("\n配置创建失败，无法继续")
        return 2

    # 4. 编辑 / 启用禁用 / 设为使用
    print("\n[4] 编辑 · 启用禁用 · 设为使用")
    st, res = c.send(f"/api/image/providers/{pid}", "PUT", {"name": "测试中转站（已改名）"})
    new_name = (res.get("provider") or {}).get("name", "")
    check("编辑名称", st == 200 and "已改名" in new_name, new_name)
    st, res = c.send(f"/api/image/providers/{pid}", "PUT", {"api_key": ""})
    check("api_key 传空表示不修改", st == 200 and (res.get("provider") or {}).get("has_key"))

    st, res = c.send(f"/api/image/providers/{pid}/toggle", "POST", {"enabled": False})
    check("禁用", st == 200 and (res.get("provider") or {}).get("enabled") is False)
    st, res = c.send(f"/api/image/providers/{pid}/toggle", "POST", {"enabled": True})
    check("启用", st == 200 and (res.get("provider") or {}).get("enabled") is True)
    st, res = c.send(f"/api/image/providers/{pid}/activate", "POST", {})
    check("设为当前使用", st == 200 and res.get("active_id") == pid, res.get("active_id"))

    # 5. 连通性
    print("\n[5] 连通性测试")
    st, res = c.send(f"/api/image/providers/{pid}/test", "POST", {}, timeout=60)
    info = (res or {}).get("result") or {}
    if st == 200:
        check("中转站可达", True,
              f"耗时 {info.get('elapsed')}s · 模型 {info.get('model_count')} 个")
        check("模型 gpt-image-2 存在", info.get("model_found") is True,
              f"匹配 {info.get('matched')}")
    else:
        check("中转站可达", False,
              json.dumps((res or {}).get("detail"), ensure_ascii=False)[:220])

    # 6. 文生图
    print("\n[6] 文生图（真实生成）")
    if args.no_generate:
        print("  跳过（--no-generate）")
    else:
        t0 = time.time()
        st, res = c.post_form("/api/image/generate", {
            "prompt": args.prompt, "size": "1024x1024", "n": "1",
        }, timeout=600)
        dt = time.time() - t0
        if st == 200 and res.get("images"):
            imgs = res["images"]
            check("生成成功", True, f"{len(imgs)} 张 · {dt:.1f}s")
            check("返回 data_url", str(imgs[0].get("data_url", "")).startswith("data:image/"))
            check("返回字节数", (imgs[0].get("bytes") or 0) > 10000,
                  f"{imgs[0].get('bytes')} 字节")
            os.makedirs(OUT_DIR, exist_ok=True)
            out = os.path.join(OUT_DIR, "gen_api_test.png")
            payload = imgs[0]["data_url"].split(",", 1)[1]
            payload += "=" * (-len(payload) % 4)
            open(out, "wb").write(base64.b64decode(payload))
            print(f"    已保存 {out}")
        else:
            check("生成成功", False,
                  json.dumps((res or {}).get("detail"), ensure_ascii=False)[:300])

    # 7. 参照图生成
    print("\n[7] 参照图生图（真实生成）")
    ref_path = os.path.join(OUT_DIR, "gen_api_test.png")
    if args.no_generate or not os.path.isfile(ref_path):
        print("  跳过（无参照图或 --no-generate）")
    else:
        ref = open(ref_path, "rb").read()
        st, res = c.post_form("/api/image/generate", {
            "prompt": "把画面主色调改成蓝色", "size": "1024x1024", "n": "1",
        }, files={"reference": ("ref.png", ref, "image/png")}, timeout=600)
        if st == 200 and res.get("images"):
            check("参照图模式成功", res.get("used_reference") is True,
                  f"用时 {res.get('elapsed')}s")
        else:
            check("参照图模式成功", False,
                  json.dumps((res or {}).get("detail"), ensure_ascii=False)[:300])

    # 8. 错误处理
    print("\n[8] 错误处理")
    st, res = c.post_form("/api/image/generate", {"prompt": "", "size": "1024x1024", "n": "1"},
                          timeout=60)
    check("空提示词被拒", st == 400, f"HTTP {st}")
    st, res = c.send("/api/image/providers", "POST",
                     {"name": "坏配置", "base_url": "not-a-url", "api_key": "x"})
    check("非法地址被拒", st == 400, f"HTTP {st}")
    st, res = c.send("/api/image/providers", "POST",
                     {"name": "空key", "base_url": "https://example.com", "api_key": ""})
    check("空 API key 被拒", st == 400, f"HTTP {st}")
    st, res = c.send("/api/image/providers/not-exist-id", "PUT", {"name": "x"})
    check("编辑不存在的配置 → 404", st == 404, f"HTTP {st}")

    # 9. 清理
    print("\n[9] 清理")
    if args.keep:
        print(f"  保留配置 {pid}（--keep）")
    else:
        st, res = c.send(f"/api/image/providers/{pid}", "DELETE")
        check("删除配置", st == 200, f"剩余 {len(res.get('providers') or [])} 条")
    ov2 = c.get("/api/image/overview")
    left = {p["id"] for p in (ov2.get("providers") or [])} - before_ids
    check("未残留测试数据", not left or args.keep, f"新增 {len(left)} 条")

    print("\n" + "=" * 78)
    print(f"通过 {len(PASS)} 项，失败 {len(FAIL)} 项")
    if FAIL:
        print("失败项：" + "、".join(FAIL))
    print("结果：" + ("全部通过 ✅" if not FAIL else "存在问题 ⚠️"))
    return 0 if not FAIL else 2


if __name__ == "__main__":
    raise SystemExit(main())
