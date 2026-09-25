# -*- coding: utf-8 -*-
"""图片生成模块的路由。

页面：
    GET  /image                     生成页（独立页面与静态资源）
    GET  /admin                     后台管理页（独立页面与静态资源）

公开接口（**不含任何密钥/地址信息**）：
    GET  /api/image/status          是否就绪、模型名、可选尺寸
    POST /api/image/generate        文生图 / 参照图生图

后台接口（全部需登录，key 一律打码下发）：
    /api/admin/status               初始化状态 / 登录状态
    /api/admin/setup|login|logout|password
    /api/admin/providers ...        增删改查、启用禁用、设为当前、连通性测试

设计约束：服务端不保存任何生成结果——图片以 data URL 直接回给浏览器，
由前端自行存入本机 IndexedDB。磁盘上只有配置（data/）与日志。
"""
from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from fastapi import (APIRouter, Body, Depends, File, Form, HTTPException,
                     Request, Response, UploadFile)
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from . import admin_auth
from . import client as gen_client
from . import config as gen_config

WEB_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "web")

router = APIRouter(tags=["image-gen"])

ALLOWED_REF_TYPES = ("image/png", "image/jpeg", "image/webp", "image/bmp")


# ------------------------------------------------------------------ 公共小件

def _fail(status: int, message: str, hint: str = "", detail: str = "") -> None:
    raise HTTPException(status_code=status,
                        detail={"message": message, "hint": hint, "detail": detail})


def _raise(exc: gen_client.GenError) -> None:
    """把客户端的结构化错误转成 HTTP 响应。"""
    status = exc.status if isinstance(exc.status, int) and exc.status >= 400 else 400
    if status in (408, 504):
        status = 504
    raise HTTPException(status_code=status, detail=exc.to_dict())


def _page(name: str):
    path = os.path.join(WEB_DIR, name)
    if not os.path.isfile(path):
        raise HTTPException(500, f"页面文件缺失：web/{name}")
    return FileResponse(path)


def require_admin(request: Request) -> str:
    """后台接口的统一守卫。"""
    if admin_auth.needs_setup():
        _fail(409, "后台尚未初始化", "请先在后台页面设置管理密码")
    if not admin_auth.verify_token(admin_auth.token_from_request(request)):
        _fail(401, "未登录或登录已过期", "请重新登录后台")
    return "ok"


# ------------------------------------------------------------------ 页面

@router.get("/image", include_in_schema=False)
def image_page():
    return _page("image.html")


@router.get("/admin", include_in_schema=False)
def admin_page():
    return _page("admin.html")


# ------------------------------------------------------------------ 公开：生成

@router.get("/api/image/status")
def image_status():
    """生成页初始化用。刻意不含中转站名称、地址、key。"""
    return gen_config.public_status()


@router.post("/api/image/generate")
async def generate_image(
    # multipart 里的空字符串会被 FastAPI 判定为"字段缺失"并抛 422，
    # 所以设默认空串，把校验交给业务层，好给出可读的中文提示。
    prompt: str = Form(default=""),
    size: str = Form(default=gen_config.DEFAULT_SIZE),
    n: int = Form(default=1),
    timeout: int = Form(default=gen_client.DEFAULT_TIMEOUT),
    references: List[UploadFile] = File(default=[]),
):
    """生成图片。

    参照图存在时作为条件输入；多张时会按中转站能力自动处理
    （见 client.generate 的说明）。
    """
    provider = gen_config.active_provider()
    if provider is None:
        _fail(400, "后台尚未配置可用的中转站", "请联系管理员在后台完成配置")

    refs: List[tuple] = []
    for f in references[:gen_client.MAX_REFERENCES]:
        if f is None or not (f.filename or ""):
            continue
        ctype = (f.content_type or "").lower()
        if ctype and ctype not in ALLOWED_REF_TYPES:
            _fail(400, f"参照图格式不支持：{ctype}", "请使用 PNG / JPG / WEBP / BMP")
        data = await f.read()
        if data:
            refs.append((data, f.filename or f"reference{len(refs) + 1}.png"))

    try:
        result = await run_in_threadpool(
            gen_client.generate, provider, prompt, size, n, refs, timeout)
    except gen_client.GenError as exc:
        _raise(exc)
        raise                                          # 让类型检查器满意

    # 响应里只留非敏感的模型标识，不带中转站地址
    return {
        "ok": True,
        **result,
        "provider": {
            "name": provider.get("name"),
            "model": provider.get("model"),
        },
    }


# ------------------------------------------------------------------ 后台：会话

@router.get("/api/admin/status")
def admin_status(request: Request):
    st = admin_auth.state()
    st["authenticated"] = (not st["needs_setup"]) and \
        admin_auth.verify_token(admin_auth.token_from_request(request))
    return st


@router.post("/api/admin/setup")
def admin_setup(payload: Dict[str, Any] = Body(...)):
    if not admin_auth.needs_setup():
        _fail(409, "后台已初始化", "如需重置，请删除 data/admin.json 后重启服务")
    try:
        admin_auth.set_password(payload.get("password") or "")
    except ValueError as exc:
        _fail(400, str(exc))
    return _login_response("初始化完成，已自动登录")


@router.post("/api/admin/login")
def admin_login(request: Request, payload: Dict[str, Any] = Body(...)):
    if admin_auth.needs_setup():
        _fail(409, "后台尚未初始化", "请先设置管理密码")
    ip = (request.client.host if request.client else "local") or "local"
    wait = admin_auth.locked_seconds(ip)
    if wait:
        _fail(429, f"尝试次数过多，请 {wait} 秒后再试")

    if not admin_auth.verify_password(payload.get("password") or ""):
        admin_auth.record_failure(ip)
        left = admin_auth.remaining_attempts(ip)
        _fail(401, "密码不正确", f"还可尝试 {left} 次" if left else "已达上限，请稍后再试")
    admin_auth.clear_failures(ip)
    return _login_response("登录成功")


def _login_response(message: str) -> Any:
    token = admin_auth.issue_token()
    return _json_with_cookie(
        {
            "ok": True,
            "message": message,
            "token": token,                    # 供非浏览器客户端（脚本）使用
            "expires_in": admin_auth.SESSION_TTL,
        }, token)


def _json_with_cookie(body: Dict[str, Any], token: str):
    """把令牌同时写进 HttpOnly Cookie 与响应体。

    Cookie 供浏览器使用（JS 读不到，防 XSS 窃取）；
    响应体里的明文令牌只对命令行等非浏览器调用有意义。
    """
    from fastapi.responses import JSONResponse
    resp = JSONResponse(body)
    resp.set_cookie(
        admin_auth.COOKIE_NAME, token,
        max_age=admin_auth.SESSION_TTL, httponly=True, samesite="lax", path="/")
    return resp


@router.post("/api/admin/logout")
def admin_logout():
    from fastapi.responses import JSONResponse
    resp = JSONResponse({"ok": True, "message": "已退出登录"})
    resp.delete_cookie(admin_auth.COOKIE_NAME, path="/")
    return resp


@router.post("/api/admin/password")
def admin_change_password(payload: Dict[str, Any] = Body(...),
                          _: str = Depends(require_admin)):
    try:
        admin_auth.change_password(payload.get("old_password") or "",
                                   payload.get("new_password") or "")
    except ValueError as exc:
        _fail(400, str(exc))
    # 轮换了签名密钥，旧令牌全部失效，这里直接补发一个新的
    return _login_response("密码已更新，请在其他设备重新登录")


# ------------------------------------------------------------------ 后台：配置

@router.get("/api/admin/providers")
def admin_list(_: str = Depends(require_admin)):
    return {"providers": gen_config.list_providers(reveal=False),
            "active_id": (gen_config.active_provider() or {}).get("id"),
            "default_model": gen_config.DEFAULT_MODEL,
            "sizes": list(gen_config.ALLOWED_SIZES)}


@router.post("/api/admin/providers")
def admin_create(payload: Dict[str, Any] = Body(...),
                 _: str = Depends(require_admin)):
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
        _fail(400, str(exc))
    return {"provider": gen_config.public_view(item),
            "providers": gen_config.list_providers(reveal=False)}


@router.put("/api/admin/providers/{pid}")
def admin_update(pid: str, payload: Dict[str, Any] = Body(...),
                 _: str = Depends(require_admin)):
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
        _fail(400, str(exc))
    except KeyError as exc:
        _fail(404, str(exc))
    return {"provider": gen_config.public_view(item),
            "providers": gen_config.list_providers(reveal=False)}


@router.delete("/api/admin/providers/{pid}")
def admin_delete(pid: str, _: str = Depends(require_admin)):
    if not gen_config.delete_provider(pid):
        _fail(404, "配置不存在")
    return {"deleted": pid,
            "providers": gen_config.list_providers(reveal=False),
            "active_id": (gen_config.active_provider() or {}).get("id")}


@router.post("/api/admin/providers/{pid}/toggle")
def admin_toggle(pid: str, payload: Dict[str, Any] = Body(default={}),
                 _: str = Depends(require_admin)):
    enabled = payload.get("enabled")
    if enabled is None:
        cur = gen_config.get_provider(pid)
        if cur is None:
            _fail(404, "配置不存在")
        enabled = not cur.get("enabled")
    try:
        item = gen_config.set_enabled(pid, bool(enabled))
    except KeyError as exc:
        _fail(404, str(exc))
    return {"provider": gen_config.public_view(item),
            "providers": gen_config.list_providers(reveal=False),
            "active_id": (gen_config.active_provider() or {}).get("id")}


@router.post("/api/admin/providers/{pid}/activate")
def admin_activate(pid: str, _: str = Depends(require_admin)):
    try:
        item = gen_config.set_active(pid)
    except KeyError as exc:
        _fail(404, str(exc))
    except ValueError as exc:
        _fail(400, str(exc))
    return {"active_id": item["id"],
            "providers": gen_config.list_providers(reveal=False)}


@router.post("/api/admin/providers/{pid}/test")
async def admin_test(pid: str, _: str = Depends(require_admin)):
    p = gen_config.get_provider(pid)
    if p is None:
        _fail(404, "配置不存在")
    try:
        info = await run_in_threadpool(gen_client.ping, p, 30)
    except gen_client.GenError as exc:
        _raise(exc)
    return {"result": info}


# ------------------------------------------------------------------ 后台：概览

@router.get("/api/admin/system")
def admin_system(_: str = Depends(require_admin)):
    """后台首页的概览信息（不含任何密钥）。"""
    providers = gen_config.list_providers(reveal=False)
    active = gen_config.active_provider()
    data_ok = os.path.isdir(gen_config.DATA_DIR)
    return {
        "provider_count": len(providers),
        "enabled_count": sum(1 for p in providers if p["enabled"]),
        "active_name": (active or {}).get("name"),
        "active_model": (active or {}).get("model"),
        "config_file": gen_config.CONFIG_FILE,
        "data_dir_exists": data_ok,
        "stores_generated_images": False,      # 明确声明：服务端不保存生成结果
    }
