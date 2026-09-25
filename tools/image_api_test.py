# -*- coding: utf-8 -*-
"""图片生成模块的端到端测试。

覆盖三大块：
  1. 页面与静态资源（生成页 /image、后台页 /admin、各自的 JS/CSS）
  2. **安全边界**——公开接口不得泄露中转站地址与 API Key；
     后台接口未登录必须拒绝；任何响应体里都不允许出现明文 key
  3. 后台配置增删改查、启用禁用、设为当前、连通性测试，以及真实生成

用法：
    python tools/image_api_test.py                    # 不碰后台密码，跳过需登录的部分
    python tools/image_api_test.py --password xxx     # 提供管理密码以跑完整流程
    python tools/image_api_test.py --no-generate      # 跳过真实生成（省额度）
    python tools/image_api_test.py --multi-ref        # 额外验证多参照图

注意：`--password` 在后台尚未初始化时会被用作**初始密码**并明确提示，
默认不带该参数时绝不会修改后台密码，避免把使用者锁在门外。
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
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
        self.token = ""

    def _headers(self, extra: dict = None) -> dict:
        h = {"Content-Type": "application/json"}
        if self.token:
            h["X-Admin-Token"] = self.token
        h.update(extra or {})
        return h

    def raw(self, path: str, timeout: int = 60, auth: bool = True) -> tuple:
        """返回 (status, bytes)；失败不抛异常。"""
        req = urllib.request.Request(self.base + path,
                                     headers=self._headers() if auth else {})
        try:
            with self.op.open(req, timeout=timeout) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except Exception as e:                    # noqa: BLE001
            return "ERR", str(e).encode()

    def get(self, path: str, timeout: int = 30, auth: bool = True):
        st, raw = self.raw(path, timeout, auth)
        try:
            return st, json.loads(raw)
        except Exception:                         # noqa: BLE001
            return st, raw

    def send(self, path: str, method: str, payload=None, timeout: int = 600,
             auth: bool = True):
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers=self._headers() if auth else {"Content-Type": "application/json"},
            method=method)
        try:
            with self.op.open(req, timeout=timeout) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read())
            except Exception:                     # noqa: BLE001
                return e.code, {}
        except Exception as e:                    # noqa: BLE001
            return "ERR", {"error": str(e)}

    def post_form(self, path: str, fields: dict, files: list = None,
                  timeout: int = 900):
        """files 为 [(字段名, 文件名, 字节, mime), ...]，同名多值即多参照图。"""
        bd = "----wb" + uuid.uuid4().hex
        parts = []
        for k, v in fields.items():
            parts.append(
                f'--{bd}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
        for name, fn, data, ct in (files or []):
            parts.append(f'--{bd}\r\nContent-Disposition: form-data; name="{name}"; '
                         f'filename="{fn}"\r\nContent-Type: {ct}\r\n\r\n'.encode())
            parts.append(data)
            parts.append(b"\r\n")
        parts.append(f"--{bd}--\r\n".encode())
        req = urllib.request.Request(
            self.base + path, data=b"".join(parts),
            headers={"Content-Type": f"multipart/form-data; boundary={bd}"},
            method="POST")
        try:
            with self.op.open(req, timeout=timeout) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read())
            except Exception:                     # noqa: BLE001
                return e.code, {}
        except Exception as e:                    # noqa: BLE001
            return "ERR", {"error": str(e)}


def save_data_url(data_url: str, out_path: str) -> int:
    payload = data_url.split(",", 1)[1]
    payload += "=" * (-len(payload) % 4)
    raw = base64.b64decode(payload)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "wb") as fp:
        fp.write(raw)
    return len(raw)


# ================================================================== 测试体

def t_pages(c: Client) -> None:
    print("\n[1] 页面与静态资源")
    st, html = c.raw("/image")
    page = html.decode("utf-8", "ignore")
    check("生成页 /image 可访问", st == 200 and "<html" in page.lower(), f"{len(page)} 字节")
    check("含提示词输入区", 'id="prompt"' in page)
    check("含参照图上传区（支持多张）", 'id="dropzone"' in page and "multiple" in page)
    check("含结果展示区", 'id="result"' in page and 'id="resultImg"' in page)
    check("含加载状态", 'id="stateLoading"' in page)
    check("含错误提示", 'id="stateError"' in page and 'id="errMsg"' in page)
    check("含作品库视图", 'id="viewProjects"' in page and 'id="projGrid"' in page)
    check("生成页无配置抽屉/密钥入口", "fKey" not in page and "api/image/providers" not in page)

    st, html = c.raw("/admin")
    apage = html.decode("utf-8", "ignore")
    check("后台页 /admin 可访问", st == 200 and "<html" in apage.lower(), f"{len(apage)} 字节")
    check("后台含登录门", 'id="gate"' in apage and 'id="gatePw"' in apage)
    check("后台含配置管理区", 'id="plist"' in apage and 'id="pform"' in apage)
    check("后台含安全设置", 'id="pwForm"' in apage)

    for asset in ("/static/image.css", "/static/image.js", "/static/store.js",
                  "/static/admin.css", "/static/admin.js"):
        st, raw = c.raw(asset)
        check(f"{os.path.basename(asset)} 可加载", st == 200 and len(raw) > 500,
              f"{len(raw)} 字节")


def t_no_leak(c: Client) -> None:
    print("\n[2] 公开接口的泄露检查")
    st, body = c.get("/api/image/status")
    check("状态接口可用", st == 200, f"HTTP {st}")
    text = json.dumps(body, ensure_ascii=False)
    check("状态接口不含 API key", TEST_KEY not in text and "sk-" not in text)
    check("状态接口不含中转站地址",
          not any(isinstance(v, str) and "http" in v for v in body.values()))
    check("状态接口不含配置列表", "providers" not in body)
    check("状态接口返回模型与尺寸", "model" in body and isinstance(body.get("sizes"), list),
          f"model={body.get('model')}")

    for path in ("/api/image/overview", "/api/image/providers"):
        st, raw = c.raw(path)
        check(f"旧接口 {path} 已移除", st == 404, f"HTTP {st}")


def t_auth(c: Client) -> None:
    print("\n[3] 未登录访问后台接口")
    for method, path in (("GET", "/api/admin/providers"),
                         ("GET", "/api/admin/system"),
                         ("POST", "/api/admin/providers"),
                         ("PUT", "/api/admin/providers/whatever"),
                         ("DELETE", "/api/admin/providers/whatever"),
                         ("POST", "/api/admin/providers/whatever/test")):
        st, _ = c.send(path, method, {} if method in ("POST", "PUT") else None,
                       timeout=30, auth=False)
        check(f"{method} {path} 未登录被拒", st in (401, 409), f"HTTP {st}")


def t_admin_flow(c: Client, args) -> str:
    """返回测试创建的配置 id；未登录时返回空串。"""
    print("\n[4] 后台登录")
    st, body = c.get("/api/admin/status")
    needs_setup = bool(body.get("needs_setup")) if isinstance(body, dict) else True
    check("状态接口不含敏感字段",
          isinstance(body, dict) and not {"password_hash", "salt", "secret"} & set(body))
    check("声明密码最小长度", (body.get("min_password_len") or 0) >= 6,
          f"min={body.get('min_password_len')}")

    if needs_setup:
        if not args.password:
            print("  后台尚未初始化，且未提供 --password，跳过需登录的用例")
            return ""
        st, res = c.send("/api/admin/setup", "POST", {"password": args.password})
        if st != 200:
            check("初始化后台", False, json.dumps(res, ensure_ascii=False)[:200])
            return ""
        check("初始化后台", True, "（已使用 --password 设定初始密码）")
    else:
        if not args.password:
            print("  后台已初始化但未提供 --password，跳过需登录的用例")
            return ""
        st, res = c.send("/api/admin/login", "POST", {"password": args.password})
        if st != 200:
            check("登录后台", False, f"HTTP {st}（密码是否正确？）")
            return ""
        check("登录后台", True)

    c.token = (res or {}).get("token") or ""
    check("下发会话令牌", bool(c.token))
    check("登录响应不含明文 key", TEST_KEY not in json.dumps(res, ensure_ascii=False))

    st, res = c.send("/api/admin/login", "POST", {"password": "definitely-wrong-pw"},
                     auth=False)
    check("错误密码被拒", st == 401, f"HTTP {st}")

    print("\n[5] 配置增删改查（已鉴权）")
    st, ov = c.get("/api/admin/providers")
    check("读取配置列表", st == 200 and isinstance(ov.get("providers"), list),
          f"{len(ov.get('providers') or [])} 条")
    before_ids = {p["id"] for p in (ov.get("providers") or [])}

    st, res = c.send("/api/admin/providers", "POST", {
        "name": "测试中转站", "base_url": args.url, "api_key": args.key,
        "model": "gpt-image-2", "note": "自动化测试创建", "enabled": True,
    })
    ok = check("新增配置", st in (200, 201), f"HTTP {st}")
    if not ok:
        print("  " + json.dumps(res, ensure_ascii=False)[:240])
        return ""
    p = (res or {}).get("provider") or {}
    pid = p.get("id") or ""
    check("返回配置 id", bool(pid), pid)
    check("地址已规整（去掉尾部斜杠与 /v1）",
          (p.get("base_url") or "").endswith("linlong520.com"), p.get("base_url"))
    check("key 已保存（has_key）", bool(p.get("has_key")))

    # --- 关键：明文 key 绝不出现 ---
    blob = json.dumps(res, ensure_ascii=False)
    check("新增响应不含明文 key", TEST_KEY not in blob)
    check("新增响应里的 key 是打码值",
          ("*" in (p.get("api_key") or "")) and p.get("api_key") != TEST_KEY,
          p.get("api_key"))

    st, res2 = c.get("/api/admin/providers")
    blob2 = json.dumps(res2, ensure_ascii=False)
    check("列表响应不含明文 key", TEST_KEY not in blob2)
    masked = next((x.get("api_key") for x in (res2.get("providers") or [])
                   if x["id"] == pid), "")
    check("列表里的 key 已打码", "*" in masked and masked != TEST_KEY, masked)

    st, res = c.send(f"/api/admin/providers/{pid}", "PUT", {"name": "测试中转站（已改名）"})
    check("编辑名称", st == 200 and "已改名" in ((res.get("provider") or {}).get("name") or ""),
          (res.get("provider") or {}).get("name"))
    st, res = c.send(f"/api/admin/providers/{pid}", "PUT", {"api_key": ""})
    check("key 传空串表示不修改",
          st == 200 and (res.get("provider") or {}).get("has_key") is True)
    check("编辑响应不含明文 key", TEST_KEY not in json.dumps(res, ensure_ascii=False))
    check("禁用时选择器已打码",
          "*" in ((res.get("provider") or {}).get("api_key") or ""))

    st, res = c.send(f"/api/admin/providers/{pid}/toggle", "POST", {"enabled": False})
    check("禁用配置", st == 200 and (res.get("provider") or {}).get("enabled") is False)
    st, res = c.send(f"/api/admin/providers/{pid}/toggle", "POST", {"enabled": True})
    check("启用配置", st == 200 and (res.get("provider") or {}).get("enabled") is True)
    st, res = c.send(f"/api/admin/providers/{pid}/activate", "POST", {})
    check("设为当前使用", st == 200 and res.get("active_id") == pid, res.get("active_id"))

    print("\n[6] 连通性测试")
    st, res = c.send(f"/api/admin/providers/{pid}/test", "POST", {}, timeout=60)
    info = (res or {}).get("result") or {}
    if st == 200:
        check("中转站可达", True,
              f"耗时 {info.get('elapsed')}s · 模型 {info.get('model_count')} 个")
        check("目标模型存在", info.get("model_found") is True, f"匹配 {info.get('matched')}")
    else:
        check("中转站可达", False,
              json.dumps((res or {}).get("detail"), ensure_ascii=False)[:220])

    return pid


def t_generate(c: Client, args) -> None:
    print("\n[7] 文生图（真实生成）")
    if args.no_generate:
        print("  跳过（--no-generate）")
        return
    t0 = time.time()
    st, res = c.post_form("/api/image/generate",
                          {"prompt": args.prompt, "size": "1024x1024", "n": "1"})
    dt = time.time() - t0
    if st != 200 or not res.get("images"):
        check("生成成功", False, json.dumps((res or {}).get("detail"),
                                          ensure_ascii=False)[:300])
        return
    imgs = res["images"]
    check("生成成功", True, f"{len(imgs)} 张 · {dt:.1f}s")
    check("返回 data_url", str(imgs[0].get("data_url", "")).startswith("data:image/"))
    check("返回字节数合理", (imgs[0].get("bytes") or 0) > 10000, f"{imgs[0].get('bytes')} 字节")
    check("响应不含中转站地址",
          "http" not in json.dumps(res.get("provider") or {}, ensure_ascii=False))
    check("响应不含 API key", TEST_KEY not in json.dumps(res, ensure_ascii=False))

    out = os.path.join(OUT_DIR, "gen_api_test.png")
    n = save_data_url(imgs[0]["data_url"], out)
    print(f"    已保存 {out}（{n} 字节）")

    print("\n[8] 参照图生图（真实生成）")
    ref = open(out, "rb").read()
    st, res = c.post_form("/api/image/generate",
                          {"prompt": "把画面主色调改成蓝色", "size": "1024x1024", "n": "1",
                           "tool": "combine"},
                          files=[("references", "ref.png", ref, "image/png")])
    if st == 200 and res.get("images"):
        check("单参照图成功", res.get("used_reference") is True,
              f"耗时 {res.get('elapsed')}s")
        check("回显工具标识", res.get("tool") == "combine", str(res.get("tool")))
        check("回显工具展示名", res.get("tool_name") == "图像融合",
              str(res.get("tool_name")))
    else:
        check("单参照图成功", False,
              json.dumps((res or {}).get("detail"), ensure_ascii=False)[:300])

    if not args.multi_ref:
        print("\n[9] 多参照图（--multi-ref 才测，省额度）")
        return
    print("\n[9] 多参照图（真实生成）")
    ref2 = open(os.path.join(OUT_DIR, "multi_a.png"), "rb").read() \
        if os.path.isfile(os.path.join(OUT_DIR, "multi_a.png")) else ref
    st, res = c.post_form(
        "/api/image/generate",
        {"prompt": "融合这两张参考图的配色与构图", "size": "1024x1024", "n": "1"},
        files=[("references", "a.png", ref, "image/png"),
               ("references", "b.png", ref2, "image/png")])
    if st == 200 and res.get("images"):
        check("多参照图成功", res.get("reference_count") == 2,
              f"采纳 {res.get('reference_count')} 张 · 耗时 {res.get('elapsed')}s")
        save_data_url(res["images"][0]["data_url"],
                      os.path.join(OUT_DIR, "gen_multiref_api.png"))
    else:
        check("多参照图成功", False,
              json.dumps((res or {}).get("detail"), ensure_ascii=False)[:300])


def t_errors(c: Client, authed: bool) -> None:
    print("\n[10] 错误处理")
    st, res = c.post_form("/api/image/generate",
                          {"prompt": "", "size": "1024x1024", "n": "1"}, timeout=60)
    check("空提示词被拒", st == 400, f"HTTP {st}")
    check("空提示词给出中文提示",
          "提示词" in json.dumps((res or {}).get("detail") or {}, ensure_ascii=False))

    if not authed:
        print("  未登录，跳过配置相关错误用例")
        return
    st, _ = c.send("/api/admin/providers", "POST",
                   {"name": "坏配置", "base_url": "not-a-url", "api_key": "x"})
    check("非法地址被拒", st == 400, f"HTTP {st}")
    st, _ = c.send("/api/admin/providers", "POST",
                   {"name": "空key", "base_url": "https://example.com", "api_key": ""})
    check("空 API key 被拒", st == 400, f"HTTP {st}")
    st, _ = c.send("/api/admin/providers/not-exist-id", "PUT", {"name": "x"})
    check("编辑不存在的配置 → 404", st == 404, f"HTTP {st}")


def t_cleanup(c: Client, pid: str, args) -> None:
    print("\n[11] 清理")
    if not pid:
        print("  无测试配置需要清理")
        return
    if args.keep:
        print(f"  保留配置 {pid}（--keep）")
        return
    st, res = c.send(f"/api/admin/providers/{pid}", "DELETE")
    check("删除测试配置", st == 200, f"剩余 {len(res.get('providers') or [])} 条")
    check("删除后未残留",
          all(p["id"] != pid for p in (res.get("providers") or [])))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--url", default=TEST_BASE, help="被测中转站地址")
    ap.add_argument("--key", default=TEST_KEY)
    ap.add_argument("--prompt", default=TEST_PROMPT)
    ap.add_argument("--password", default="", help="后台管理密码（未初始化时用作初始密码）")
    ap.add_argument("--no-generate", action="store_true", help="跳过真实生成（省额度）")
    ap.add_argument("--multi-ref", action="store_true", help="额外验证多参照图")
    ap.add_argument("--keep", action="store_true", help="测试后保留配置")
    args = ap.parse_args()

    c = Client(args.base)
    print("=" * 78)
    print(f"图片生成模块端到端测试   服务={args.base}")
    print("=" * 78)

    t_pages(c)
    t_no_leak(c)
    t_auth(c)
    pid = t_admin_flow(c, args)
    t_generate(c, args)
    t_errors(c, bool(pid))
    t_cleanup(c, pid, args)

    print("\n" + "=" * 78)
    print(f"通过 {len(PASS)} 项，失败 {len(FAIL)} 项")
    if FAIL:
        print("失败项：" + "、".join(FAIL))
    print("结果：" + ("全部通过 ✅" if not FAIL else "存在问题 ⚠️"))
    return 0 if not FAIL else 2


if __name__ == "__main__":
    raise SystemExit(main())
