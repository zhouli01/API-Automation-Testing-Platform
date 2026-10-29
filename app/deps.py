# -*- coding: utf-8 -*-
"""公共依赖：登录态、角色校验、统一错误响应、Cookie 工具。

沿用旧版 Handler 的判定语义，保证前端零改动：
    · 未登录访问 /api/*        -> 401 {ok:false, code:'UNAUTHENTICATED', error:...}
    · 角色不匹配               -> 403 {ok:false, code:'FORBIDDEN', error:...}
    · 业务失败（参数/状态冲突） -> 4xx {ok:false, error:...}
    · 未捕获异常               -> 500 {ok:false, error:'Type: msg'}
"""
from typing import Optional

from fastapi import Depends, HTTPException, Request

from . import security
from .config import DATA_DIR


# ================================================================ 错误
class ApiError(HTTPException):
    """业务错误：前端只需读 ok / error 两个字段"""

    def __init__(self, status_code: int, error: str, code: Optional[str] = None, **extra):
        payload = {'ok': False, 'error': error}
        if code:
            payload['code'] = code
        payload.update(extra)
        super().__init__(status_code=status_code, detail=payload)


def unauthenticated() -> ApiError:
    return ApiError(401, '未登录或登录已过期，请重新登录', 'UNAUTHENTICATED')


def forbidden() -> ApiError:
    return ApiError(403, '无权限执行该操作', 'FORBIDDEN')


# ================================================================ 会话
def session_token(request: Request) -> str:
    return request.cookies.get(security.SESSION_COOKIE) or ''


def client_ip(request: Request) -> str:
    return request.client.host if request.client else ''


def user_agent(request: Request) -> str:
    return request.headers.get('user-agent') or ''


def current_user(request: Request) -> Optional[dict]:
    """解析当前用户。

    单用户模式：用户中心已停用 —— 无论是否携带有效会话，都以内置管理员
    zhouli 的身份执行（沿用原有取执行人 / 记录运行记录的逻辑）。
    """
    token = session_token(request)
    user = security.get_session_user(token) if token else None
    if user:
        return user
    return security.ensure_single_user()


def require_user(request: Request) -> dict:
    user = current_user(request)
    if not user:
        raise unauthenticated()
    return user


def require_admin(request: Request) -> dict:
    user = require_user(request)
    if user.get('role') != 'admin':
        raise forbidden()
    return user


# 依赖别名：路由里写 user: dict = RequireUser 即可
RequireUser = Depends(require_user)
RequireAdmin = Depends(require_admin)


# ================================================================ Cookie
def set_session_cookie(response, token: str, ttl: int):
    response.set_cookie(
        key=security.SESSION_COOKIE, value=token, max_age=int(ttl),
        path='/', httponly=True, samesite='lax',
    )


def clear_session_cookie(response):
    response.delete_cookie(key=security.SESSION_COOKIE, path='/', httponly=True, samesite='lax')


def ensure_data_dir():
    import os
    os.makedirs(DATA_DIR, exist_ok=True)
