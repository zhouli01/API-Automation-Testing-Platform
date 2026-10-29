# -*- coding: utf-8 -*-
"""接口自动化测试平台 —— FastAPI 应用入口

启动：
    python main.py [端口]      # 兼容旧用法
    uvicorn app.main:app --host 127.0.0.1 --port 8788
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .security import init_db, count_users, ensure_single_user
from .modules.cases import build_payload
from .routers import register_routers
from .web import install_static, install_error_handlers
from .config import CASE_DIR


@asynccontextmanager
async def lifespan(app):
    init_db()
    ensure_single_user()   # 单用户模式：内置管理员 zhouli，登录页停用
    data = build_payload(force=True)
    print('=' * 62)
    print('  接口自动化测试平台已启动 (FastAPI)')
    print('  接口文档: /docs')
    print('  用例目录: %s' % CASE_DIR)
    print('  扫描结果: %d 个文件 / %d 条用例 / %d 个测试用户' % (
        data['stats']['fileCount'], data['stats']['caseCount'], data['stats']['userCount']))
    users = count_users()
    if users == 0:
        print('  用户中心: 暂无账号 —— 第一个注册的账号将自动成为管理员')
    else:
        print('  用户中心: 已注册 %d 个账号' % users)
    for w in data['warnings']:
        print('  [警告] %s' % w)
    print('=' * 62)
    yield


def create_app():
    app = FastAPI(
        title='接口自动化测试平台',
        version='3.0',
        description='按一级菜单模块拆分的 FastAPI 后端：测试用例 / 测试场景 / 运行记录 / 系统设置 / 用户中心',
        lifespan=lifespan,
        docs_url='/docs',
        redoc_url=None,
    )
    register_routers(app)       # 5 个模块路由 + 健康检查
    install_error_handlers(app)  # 401/403/404/409/422/500 统一为 {ok, code, error}
    install_static(app)          # 首页登录跳转 + 静态资源（最后挂载，不吞 /api）
    return app


app = create_app()
