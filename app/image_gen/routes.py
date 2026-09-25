# -*- coding: utf-8 -*-
"""图片生成模块的路由。

页面：  GET  /image                      独立页面（与文字处理模块分开）
配置：  /api/image/providers ...          增删改查 + 启用/禁用 + 连通性测试
生成：  POST /api/image/generate          文生图 / 参照图生图
"""
from __future__ import annotations

import os
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from . import client as gen_client
from . import config as gen_config

WEB_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "web")

router = APIRouter(tags=["image-gen"])

ALLOWED_REF_TYPES = ("image/png", "image/jpeg", "image/webp", "image/bmp")


def _raise(exc: gen_client.GenError) -> None:
    """把客户端的结构化错误转成 HTTP 响应。"""
    status = exc.status if isinstance(exc.status, int) and exc.status >= 400 else 400
    if status in (408, 504):
        status = 504
    raise HTTPException(status_code=status, detail=exc.to_dict())


# ------------------------------------------------------------------ 页面

@router.get("/image", include_in_schema=False)
def image_page():
    page = os.path.join(WEB_DIR, "image.html")
    if not os.path.isfile(page):
        raise HTTPException(500, "页面文件缺失：web/image.html")
    return FileResponse(page)


# ------------------------------------------------------------------ 概览

@router.get("/api/image/overview")
def overview():
    """页面初始化用：配置列表 + 当前生效配置 + 可选尺寸。"""
    providers = gen_config.list_providers()
    active = gen_config.active_provider()
    return {
        "providers": providers,
        "active_id": (active or {}).get("id"),
        "has_usable": active is not None,
        "default_model": gen_config.DEFAULT_MODEL,
        "sizes": list(gen_config.ALLOWED_SIZES),
    }


# ------------------------------------------------------------------ 配置 CRUD

@router.get("/api/image/providers")
def list_providers():
    return {"providers": gen_config.list_providers()}


@router.post("/api/image/providers")
def create_provider(payload: Dict[str, Any] = Body(...)):
    try:
        item = gen_config.add_provider(
            name=payload.get("name") or "",
            base_url=payload.get("base_url") or "",
            api_key=payload.get("api_key") or "",
            model=payload.get("model") or gen_config.DEFAULT_MODEL,
            note=payload.get("note") or "",
            enabled=bool(payload.get("enabled", True)),
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"provider": gen_config.public_view(item),
            "providers": gen_config.list_providers()}


@router.put("/api/image/providers/{pid}")
def update_provider(pid: str, payload: Dict[str, Any] = Body(...)):
    try:
        item = gen_config.update_provider(
            pid,
            name=payload.get("name"),
            base_url=payload.get("base_url"),
            api_key=payload.get("api_key"),      # 空串 = 不修改
            model=payload.get("model"),
            note=payload.get("note"),
            enabled=payload.get("enabled"),
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"provider": gen_config.public_view(item),
            "providers": gen_config.list_providers()}


@router.delete("/api/image/providers/{pid}")
def delete_provider(pid: str):
    if not gen_config.delete_provider(pid):
        raise HTTPException(404, "配置不存在")
    return {"deleted": pid, "providers": gen_config.list_providers()}


@router.post("/api/image/providers/{pid}/toggle")
def toggle_provider(pid: str, payload: Dict[str, Any] = Body(default={})):
    enabled = payload.get("enabled")
    if enabled is None:
        cur = gen_config.get_provider(pid)
        if cur is None:
            raise HTTPException(404, "配置不存在")
        enabled = not cur.get("enabled")
    try:
        item = gen_config.set_enabled(pid, bool(enabled))
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    active = gen_config.active_provider()
    return {"provider": gen_config.public_view(item),
            "active_id": (active or {}).get("id"),
            "providers": gen_config.list_providers()}


@router.post("/api/image/providers/{pid}/activate")
def activate_provider(pid: str):
    try:
        item = gen_config.set_active(pid)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"active_id": item["id"], "providers": gen_config.list_providers()}


@router.post("/api/image/providers/{pid}/test")
async def test_provider(pid: str):
    p = gen_config.get_provider(pid)
    if p is None:
        raise HTTPException(404, "配置不存在")
    try:
        info = await run_in_threadpool(gen_client.ping, p, 30)
    except gen_client.GenError as exc:
        _raise(exc)
    return {"result": info}


# ------------------------------------------------------------------ 生成

@router.post("/api/image/generate")
async def generate_image(
    # 注意：multipart 里的空字符串会被 FastAPI 判定为"字段缺失"并抛 422，
    # 所以这里设默认空串，把空提示词的校验交给业务层，好给出可读的中文提示。
    prompt: str = Form(default=""),
    size: str = Form(default=gen_config.DEFAULT_SIZE),
    n: int = Form(default=1),
    provider_id: Optional[str] = Form(default=None),
    timeout: int = Form(default=gen_client.DEFAULT_TIMEOUT),
    reference: Optional[UploadFile] = File(default=None),
):
    """生成图片。参照图存在时自动作为条件输入（走 generations 的 image 字段）。"""
    provider = gen_config.get_provider(provider_id) if provider_id else None
    if provider is None:
        provider = gen_config.active_provider()
    if provider is None:
        raise HTTPException(400, {
            "message": "没有可用的中转站配置",
            "hint": "请先在右上角「中转站配置」里新增一条并启用",
        })
    if not provider.get("enabled"):
        raise HTTPException(400, {
            "message": f"配置「{provider.get('name')}」已禁用",
            "hint": "启用后即可使用，或切换到其他配置",
        })

    ref: Optional[tuple] = None
    if reference is not None and (reference.filename or ""):
        ctype = (reference.content_type or "").lower()
        if ctype and ctype not in ALLOWED_REF_TYPES:
            raise HTTPException(400, {
                "message": f"参照图格式不支持：{ctype}",
                "hint": "请使用 PNG / JPG / WEBP / BMP",
            })
        data = await reference.read()
        if data:
            ref = (data, reference.filename or "reference.png")

    try:
        result = await run_in_threadpool(
            gen_client.generate, provider, prompt, size, n, ref, timeout)
    except gen_client.GenError as exc:
        _raise(exc)

    return {
        "ok": True,
        **result,
        "provider": {
            "id": provider.get("id"),
            "name": provider.get("name"),
            "base_url": provider.get("base_url"),
            "model": provider.get("model"),
        },
    }
