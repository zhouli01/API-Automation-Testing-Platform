# -*- coding: utf-8 -*-
"""静态托管 + 统一错误处理。

页面语义与旧版完全一致：
    /                     未登录 302 -> /login，已登录 -> index.html
    /login /register      登录注册页（auth.html）
    /style.css /app.js …  静态资源公开（登录页也要用样式）
    /docs /openapi.json   FastAPI 自带接口文档（不参与登录拦截）
"""
import os

from fastapi import FastAPI, Request
from fastapi.exceptions import HTTPException as FastApiHTTPException, RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse

from .config import STATIC_DIR, STATIC_TYPES
from .deps import current_user


def install_error_handlers(app: FastAPI):
    """所有错误统一为 {ok:false, code?, error}，前端只需读 error 字段"""

    @app.exception_handler(FastApiHTTPException)
    async def _http_error(_request: Request, exc: FastApiHTTPException):
        detail = exc.detail
        if isinstance(detail, dict):
            return JSONResponse(detail, status_code=exc.status_code)
        return JSONResponse({'ok': False, 'error': str(detail)}, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_request: Request, exc: RequestValidationError):
        first = (exc.errors() or [{}])[0]
        loc = '.'.join(str(x) for x in first.get('loc') or [] if x != 'body')
        msg = first.get('msg') or '参数不合法'
        return JSONResponse(
            {'ok': False, 'code': 'VALIDATION_ERROR',
             'error': (f'参数不合法：{loc} {msg}' if loc else f'参数不合法：{msg}')},
            status_code=422)

    @app.exception_handler(Exception)
    async def _unhandled(_request: Request, exc: Exception):  # noqa: BLE001
        return JSONResponse({'ok': False, 'error': f'{type(exc).__name__}: {exc}'}, status_code=500)


def _file(full_path: str):
    """在 static 目录内安全定位文件，越界返回 None"""
    rel = os.path.normpath(full_path.lstrip('/').replace('\\', '/')).replace('\\', '/')
    if rel.startswith('..') or os.path.isabs(rel):
        return None
    full = os.path.join(STATIC_DIR, rel)
    return full if os.path.isfile(full) else None


def install_static(app: FastAPI):
    @app.get('/', include_in_schema=False)
    @app.get('/index.html', include_in_schema=False)
    def index(request: Request):
        if not current_user(request):
            return RedirectResponse('/login', status_code=302)
        return FileResponse(os.path.join(STATIC_DIR, 'index.html'),
                            media_type='text/html; charset=utf-8',
                            headers={'Cache-Control': 'no-store'})

    @app.get('/login', include_in_schema=False)
    @app.get('/register', include_in_schema=False)
    @app.get('/auth.html', include_in_schema=False)
    def auth_page():
        return FileResponse(os.path.join(STATIC_DIR, 'auth.html'),
                            media_type='text/html; charset=utf-8',
                            headers={'Cache-Control': 'no-store'})

    @app.get('/assets/{file_path:path}', include_in_schema=False)
    @app.get('/{file_path:path}', include_in_schema=False)
    def static_file(file_path: str):
        """静态资源兜底（放在最后注册，不会吞掉 /api 与 /docs）"""
        full = _file(file_path)
        if not full:
            return JSONResponse({'ok': False, 'error': 'Not Found: /%s' % file_path}, status_code=404)
        ctype = STATIC_TYPES.get(os.path.splitext(full)[1].lower(), 'application/octet-stream')
        return FileResponse(full, media_type=ctype, headers={'Cache-Control': 'no-store'})
