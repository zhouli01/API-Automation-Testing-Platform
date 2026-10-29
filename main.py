# -*- coding: utf-8 -*-
"""Uvicorn 启动入口。

用法：
    python main.py             # 默认 8788
    python main.py 9000        # 指定端口
    python server.py 8788      # 兼容旧启动方式（等价于 main.py）
"""
import os
import sys

import uvicorn

from app.config import BASE_DIR


def main():
    # 部署沙箱会注入 PORT 并要求绑定 0.0.0.0；本地默认 127.0.0.1:8788 + 热重载
    sandboxed = bool(os.environ.get('PORT'))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get('PORT', '8788'))
    host = os.environ.get('HOST', '0.0.0.0' if sandboxed else '127.0.0.1')
    reload_on = (not sandboxed) and os.environ.get('APIFOX_RELOAD', '1') != '0'
    print('  本机访问: http://%s:%d' % (host, port))
    print('  接口文档: http://%s:%d/docs' % (host, port))
    uvicorn.run(
        'app.main:app',
        host=host,
        port=port,
        reload=reload_on,
        reload_dirs=[os.path.join(BASE_DIR, 'app')] if reload_on else None,
        log_level='info',
        access_log=False,
    )


if __name__ == '__main__':
    main()
