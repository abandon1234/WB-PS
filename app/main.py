# -*- coding: utf-8 -*-
"""FastAPI 服务：图片文字识别 / 无痕编辑。

启动：
    python -m app.main                # 默认 http://127.0.0.1:8000
    python -m app.main --port 9000
"""
from __future__ import annotations

import argparse
import base64
import os
import sys
import threading
import time
import uuid
from typing import Any, Dict, List, Optional

import numpy as np
from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import fonts as font_lib
from . import ocr_engine, pipeline

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")

app = FastAPI(title="图片文字处理工具", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                   allow_headers=["*"])


# ------------------------------------------------------------------ 会话缓存

class Session:
    """把上传的图与检测结果缓存在内存，避免每步都重传大图。"""

    __slots__ = ("image", "items", "meta", "ts", "name")

    def __init__(self, image: np.ndarray, name: str):
        self.image = image
        self.name = name
        self.items: List[dict] = []
        self.meta: Dict[str, Any] = {}
        self.ts = time.time()


_SESSIONS: Dict[str, Session] = {}
_SESS_LOCK = threading.Lock()
_MAX_SESSIONS = 24
_TTL = 3600 * 4


def _gc() -> None:
    now = time.time()
    dead = [k for k, v in _SESSIONS.items() if now - v.ts > _TTL]
    for k in dead:
        _SESSIONS.pop(k, None)
    if len(_SESSIONS) > _MAX_SESSIONS:
        for k, _ in sorted(_SESSIONS.items(), key=lambda kv: kv[1].ts)[:len(_SESSIONS) - _MAX_SESSIONS]:
            _SESSIONS.pop(k, None)


def _put(image: np.ndarray, name: str = "image.png") -> str:
    with _SESS_LOCK:
        _gc()
        sid = uuid.uuid4().hex[:16]
        _SESSIONS[sid] = Session(image, name)
        return sid


def _get(sid: str) -> Session:
    with _SESS_LOCK:
        s = _SESSIONS.get(sid)
    if s is None:
        raise HTTPException(404, "会话已过期，请重新上传图片")
    s.ts = time.time()
    return s


async def _load_image(file: Optional[UploadFile], session_id: Optional[str]) -> np.ndarray:
    if file is not None and (file.filename or file.size):
        data = await file.read()
        if data:
            return pipeline.decode_image(data)
    if session_id:
        return _get(session_id).image
    raise HTTPException(400, "缺少图片：请上传文件或提供 session_id")


# ------------------------------------------------------------------ 页面与状态

@app.get("/")
def index():
    page = os.path.join(WEB_DIR, "index.html")
    if not os.path.isfile(page):
        raise HTTPException(500, "前端文件缺失")
    return FileResponse(page)


@app.get("/api/health")
def health():
    err = ocr_engine.backend_error()
    fams = font_lib.list_families()
    return {
        "ok": True,
        "ocr_backend": ocr_engine.backend_name(),
        "ocr_error": err,
        "font_count": len(fams),
        "version": app.version,
    }


@app.get("/api/fonts")
def get_fonts():
    fams = font_lib.list_families()
    return {"families": fams,
            "user_count": sum(1 for f in fams if f.get("user")),
            "user_dir": font_lib.USER_FONT_DIR}


@app.post("/api/fonts/reload")
def reload_fonts():
    font_lib.load_fonts(force=True)
    fams = font_lib.list_families()
    return {"families": fams,
            "user_count": sum(1 for f in fams if f.get("user")),
            "user_dir": font_lib.USER_FONT_DIR}


@app.get("/api/fonts/user")
def list_user_fonts():
    fams = font_lib.list_families()
    return {"dir": font_lib.USER_FONT_DIR,
            "files": font_lib.list_user_font_files(),
            "families": [f for f in fams if f.get("user")]}


@app.post("/api/fonts/upload")
async def upload_fonts(files: List[UploadFile] = File(...)):
    """导入自定义字体：落盘到 fonts/ 目录并热重扫，无需重启服务。"""
    added: List[dict] = []
    errors: List[dict] = []
    for f in files:
        try:
            data = await f.read()
            added.append(font_lib.add_user_font(f.filename or "", data))
        except ValueError as exc:
            errors.append({"file": f.filename, "error": str(exc)})
        except Exception as exc:                     # noqa: BLE001
            errors.append({"file": f.filename, "error": f"导入失败：{exc}"})

    fams = font_lib.list_families()
    return {"added": added, "errors": errors, "families": fams,
            "count": len(fams),
            "user_count": sum(1 for x in fams if x.get("user")),
            "user_dir": font_lib.USER_FONT_DIR}


@app.delete("/api/fonts/user/{name}")
def delete_user_font(name: str):
    try:
        ok = font_lib.remove_user_font(name)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not ok:
        raise HTTPException(404, "字体文件不存在")
    fams = font_lib.list_families()
    return {"removed": name, "families": fams, "count": len(fams),
            "user_count": sum(1 for x in fams if x.get("user"))}


# ------------------------------------------------------------------ 识别

@app.post("/api/analyze")
async def analyze(file: UploadFile = File(default=None),
                  session_id: Optional[str] = Form(default=None),
                  merge_lines: bool = Form(default=True),
                  min_score: float = Form(default=0.35)):
    img = await _load_image(file, session_id)
    try:
        result = pipeline.analyze(img, merge_lines=merge_lines, min_score=min_score)
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc

    sid = session_id or _put(img, getattr(file, "filename", "image.png") or "image.png")
    sess = _get(sid)
    sess.image = img
    sess.items = result["items"]
    sess.meta = result
    result["session_id"] = sid
    return result


# ------------------------------------------------------------------ 预览

@app.post("/api/preview")
async def preview(payload: dict = Body(...)):
    sid = payload.get("session_id")
    idx = payload.get("id")
    edit = payload.get("edit") or {}
    if sid is None or idx is None:
        raise HTTPException(400, "缺少 session_id 或 id")
    sess = _get(sid)
    item = next((it for it in sess.items if str(it.get("id")) == str(idx)), None)
    if item is None:
        raise HTTPException(404, f"未找到文字框 {idx}")

    png, info = pipeline.preview_item(sess.image, item, edit)
    return {
        "id": idx,
        "patch": "data:image/png;base64," + base64.b64encode(png).decode("ascii"),
        "region": info.get("region"),
        "info": {k: v for k, v in info.items() if k != "region"},
    }


@app.post("/api/preview-original")
async def preview_original(payload: dict = Body(...)):
    """返回指定框的原始局部图（用于重置单项预览）。"""
    sid = payload.get("session_id")
    idx = payload.get("id")
    sess = _get(sid)
    item = next((it for it in sess.items if str(it.get("id")) == str(idx)), None)
    if item is None:
        raise HTTPException(404, f"未找到文字框 {idx}")
    rect = item["rect"]
    region = (rect["x"] - 10, rect["y"] - 10, rect["w"] + 20, rect["h"] + 20)
    patch, region = pipeline.crop(sess.image, region)
    png = pipeline.encode_image(patch, ".png")
    return {"id": idx, "patch": "data:image/png;base64," + base64.b64encode(png).decode("ascii"),
            "region": list(region)}


# ------------------------------------------------------------------ 应用

@app.post("/api/apply")
async def apply(payload: dict = Body(...)):
    sid = payload.get("session_id")
    sess = _get(sid)
    edits: Dict[str, dict] = payload.get("edits") or {}
    new_items = payload.get("new_items") or []
    fmt = (payload.get("format") or "png").lower()
    quality = int(payload.get("quality") or 95)

    out, stats = pipeline.apply_edits(sess.image, sess.items, edits, new_items)
    ext = ".jpg" if fmt in ("jpg", "jpeg") else (".webp" if fmt == "webp" else ".png")
    data = pipeline.encode_image(out, ext, quality)
    mb = len(data) / 1024 / 1024
    return {
        "image": "data:image/" + ext.lstrip(".") + ";base64," + base64.b64encode(data).decode("ascii"),
        "size": [out.shape[1], out.shape[0]],
        "bytes": len(data),
        "stats": stats,
    }


@app.post("/api/export")
async def export(payload: dict = Body(...)):
    """直接返回文件流，用于一键下载。"""
    sid = payload.get("session_id")
    sess = _get(sid)
    edits: Dict[str, dict] = payload.get("edits") or {}
    new_items = payload.get("new_items") or []
    fmt = (payload.get("format") or "png").lower()
    quality = int(payload.get("quality") or 95)

    out, stats = pipeline.apply_edits(sess.image, sess.items, edits, new_items)
    ext = ".jpg" if fmt in ("jpg", "jpeg") else (".webp" if fmt == "webp" else ".png")
    data = pipeline.encode_image(out, ext, quality)
    stem = os.path.splitext(sess.name or "image")[0]
    return Response(
        content=data,
        media_type={"png": "image/png", "jpg": "image/jpeg",
                    "jpeg": "image/jpeg", "webp": "image/webp"}.get(fmt, "image/png"),
        headers={"Content-Disposition": f'attachment; filename="{stem}_edited{ext}"',
                 "X-Edit-Stats": str(stats['rendered'])},
    )


@app.get("/api/bounds")
def bounds(session_id: str):
    sess = _get(session_id)
    h, w = sess.image.shape[:2]
    return {"width": w, "height": h, "count": len(sess.items)}


# ------------------------------------------------------------------ 静态资源

if os.path.isdir(WEB_DIR):
    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


# ------------------------------------------------------------------ 入口

def main(argv: Optional[List[str]] = None) -> None:
    ap = argparse.ArgumentParser(description="图片文字处理工具")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--reload", action="store_true")
    args = ap.parse_args(argv)

    try:
        sys.stdout.reconfigure(encoding="utf-8")     # type: ignore[attr-defined]
    except Exception:                                # noqa: BLE001
        pass

    import uvicorn
    print(f"\n  图片文字处理工具  →  http://{args.host}:{args.port}\n")
    uvicorn.run("app.main:app", host=args.host, port=args.port,
                reload=args.reload, log_level="info")


if __name__ == "__main__":
    main()
