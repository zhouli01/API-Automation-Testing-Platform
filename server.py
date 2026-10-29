# -*- coding: utf-8 -*-
"""兼容旧启动方式：python server.py [端口]

实际后端已迁移到 FastAPI（app/ 包），本文件仅作为启动壳保留，
以免 start.bat / 既有快捷方式失效。
"""
import sys

from main import main

if __name__ == '__main__':
    main()
