# -*- coding: utf-8 -*-
"""路由汇总：五个一级菜单模块 + 健康检查。"""
import time

from fastapi import APIRouter, Request

from .config import CASE_DIR
from .modules.cases.router import router as cases_router
from .modules.history.router import router as history_router
from .modules.mcp.router import router as mcp_router
from .modules.scenarios.router import router as scenarios_router
from .modules.settings.router import router as settings_router
from .modules.users.router import router as users_router

meta_router = APIRouter(prefix='/api', tags=['系统'])


@meta_router.get('/health', summary='健康检查（无需登录）')
def health(_request: Request):
    return {
        'ok': True,
        'time': time.strftime('%Y-%m-%d %H:%M:%S'),
        'caseDir': CASE_DIR,
        'authEnabled': True,
        'framework': 'FastAPI',
    }


def register_routers(app):
    app.include_router(cases_router)      # 测试用例
    app.include_router(scenarios_router)  # 测试场景
    app.include_router(history_router)    # 运行记录
    app.include_router(settings_router)   # 系统设置
    app.include_router(users_router)      # 用户中心
    app.include_router(mcp_router)        # MCP 测试（契约驱动）
    app.include_router(meta_router)       # /api/health
