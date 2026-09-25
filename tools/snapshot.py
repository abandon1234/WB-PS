# -*- coding: utf-8 -*-
"""打一个完整快照 zip：含源码、自定义字体、测试图，解压即可运行。

与 git 的分工：
    git    —— 版本管理，追踪代码演进，`git diff` / `git checkout` 回滚
    snapshot —— 完整副本，额外包含 `fonts/` 下你自己的字体
               （这些字体被 .gitignore 排除，避免分发有版权的商业字体）

用法：
    python tools/snapshot.py                 # 版本号自动取 git tag
    python tools/snapshot.py --version v1.1
    python tools/snapshot.py --out D:\\backup
"""
from __future__ import annotations

import argparse
import datetime
import os
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SKIP_DIRS = {".git", "__pycache__", ".venv", "venv", ".idea", ".vscode"}
# 用相对路径精确排除，避免误伤同名的普通目录
SKIP_REL_DIRS = {os.path.join("samples", "out")}
SKIP_FILES = {".font_cache.json"}
# 管理密码哈希不进快照：可再生，且多一个凭证就多一个泄露面
SKIP_REL_FILES = {
    os.path.join("data", "admin.json"),
    os.path.join("data", "admin.json.tmp"),
}
SKIP_SUFFIX = (".pyc", ".pyo", ".log", ".tmp")


def git_version() -> str:
    """取当前 git tag 作为版本号，取不到就回退。"""
    git = shutil.which("git") or os.path.join(
        os.path.expanduser("~"),
        ".workbuddy", "binaries", "PortableGit", "versions", "1.2.0", "cmd", "git.exe")
    if not os.path.isfile(git):
        return "v0"
    try:
        out = subprocess.run([git, "describe", "--tags", "--abbrev=0"],
                             cwd=ROOT, capture_output=True, text=True, timeout=10)
        tag = (out.stdout or "").strip()
        if tag:
            dirty = subprocess.run([git, "status", "--porcelain"],
                                   cwd=ROOT, capture_output=True, text=True, timeout=10)
            return tag + ("-dirty" if (dirty.stdout or "").strip() else "")
    except Exception:                    # noqa: BLE001
        pass
    return "v0"


def build(version: str, out_dir: str, quiet: bool = False) -> str:
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"WB-PS-{version}-{ts}.zip")
    prefix = f"WB-PS-{version}"

    n = 0
    raw = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for dirpath, dirnames, filenames in os.walk(ROOT):
            rel_dir = os.path.relpath(dirpath, ROOT)
            dirnames[:] = [d for d in dirnames
                           if d not in SKIP_DIRS
                           and (os.path.join(rel_dir, d) if rel_dir != "." else d)
                           not in SKIP_REL_DIRS]
            for fn in filenames:
                rel = os.path.relpath(os.path.join(dirpath, fn), ROOT)
                if fn in SKIP_FILES or fn.endswith(SKIP_SUFFIX) or rel in SKIP_REL_FILES:
                    continue
                full = os.path.join(dirpath, fn)
                try:
                    z.write(full, os.path.join(prefix, rel))
                except OSError:
                    continue
                n += 1
                raw += os.path.getsize(full)

    size = os.path.getsize(out)
    if not quiet:
        print(f"快照完成: {out}")
        print(f"  版本 {version} · 文件 {n} 个")
        print(f"  原始 {raw / 1024:.1f} KB → 压缩后 {size / 1024:.1f} KB")
        # 提示是否含自定义字体
        with zipfile.ZipFile(out) as z:
            names = z.namelist()
        fonts = [x for x in names
                 if "/fonts/" in x and x.lower().endswith((".ttf", ".otf", ".ttc", ".otc"))]
        print(f"  自定义字体: {len(fonts)} 个" +
              (f"（{', '.join(os.path.basename(f) for f in fonts[:3])}"
               + ("..." if len(fonts) > 3 else "") + "）" if fonts else ""))
        hosted = [x for x in names if "/data/" in x]
        if hosted:
            print(f"  ⚠ 含 data/ 配置 {len(hosted)} 个（内有明文 API key，请勿外发此 zip）")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="打完整快照 zip")
    ap.add_argument("--version", default=None, help="版本号，默认取 git tag")
    ap.add_argument("--out", default=os.path.dirname(ROOT), help="输出目录，默认项目上一级")
    args = ap.parse_args()

    version = args.version or git_version()
    path = build(version, args.out)
    print(f"\n解压后可直接运行：start.bat（Windows）或 python -m app.main")
    return 0 if os.path.isfile(path) else 1


if __name__ == "__main__":
    raise SystemExit(main())
