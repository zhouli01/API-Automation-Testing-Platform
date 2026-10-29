# -*- coding: utf-8 -*-
"""测试用例模块 —— 用例解析 / 执行引擎 / 接口路由。

拆分为三个文件：
    parser.py   扫描用例目录，把 Apifox 或通用 JSON 解析成统一用例模型
    runner.py   变量替换、断言、HTTP 代理、单条用例执行
    router.py   /api/cases、/api/reload、/api/run
"""
from .parser import build_payload, scan_case_dir, invalidate_cache
from .runner import execute_case, run_asserts, do_request

__all__ = ['build_payload', 'scan_case_dir', 'invalidate_cache',
           'execute_case', 'run_asserts', 'do_request']
