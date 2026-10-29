# -*- coding: utf-8 -*-
"""全局配置：路径、默认平台设置、常量。

保持与旧版 server.py 完全一致的目录布局与数据文件位置，
因此 data/ 下的 meta.json / history.json / scenarios.json / users.db 无需迁移。
"""
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(BASE_DIR, 'static')
DATA_DIR = os.path.join(BASE_DIR, 'data')

META_PATH = os.path.join(DATA_DIR, 'meta.json')
HISTORY_PATH = os.path.join(DATA_DIR, 'history.json')
SCENARIO_PATH = os.path.join(DATA_DIR, 'scenarios.json')

# 用例目录：优先环境变量；本机默认 Downloads\apifox_case；云端/他人机器回落到项目内 cases/
def _default_case_dir():
    local = r'C:\Users\zhouli\Downloads\apifox_case'
    if os.path.isdir(local):
        return local
    return os.path.join(BASE_DIR, 'cases')


CASE_DIR = os.environ.get('APIFOX_CASE_DIR') or _default_case_dir()

MAX_BODY_KEEP = 30000   # 运行记录中单条响应体最多保留的字符数

DEFAULT_SETTINGS = {
    'baseUrlOverride': '',
    'timeoutMs': 15000,
    'concurrency': 1,
    'userField': 'infoName',      # 用户识别规则：filename | infoName | folder | caseName
    'checkHttp': True,
    'checkBiz': True,
    'bizCodeField': 'status|code',
    'expectHttp': [200, 201, 202, 204],
    'globalVars': {},
    'globalHeaders': {},
    'executedBy': os.environ.get('USERNAME') or os.environ.get('USER') or 'tester',
    'maxHistory': 200,
}

USER_FIELD_LABELS = {
    'filename': '文件名（去掉 .apifox-cli.json / .json）',
    'infoName': '文件内顶层 name 字段',
    'folder': '用例所在文件夹名',
    'caseName': '用例 name 字段',
}

# 前端静态资源的 Content-Type
STATIC_TYPES = {
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
}

# ================================================================ MCP 测试模块（契约驱动）
# 网关地址 / 认证：环境变量优先，其次 ~/.workbuddy/mcp.json 的 acohub 配置
def _mcp_gateway():
    url = os.environ.get('MCP_GATEWAY_URL')
    auth = os.environ.get('MCP_GATEWAY_AUTH')
    if url and auth:
        return url, auth
    try:
        cfg = _json.load(open(os.path.expanduser('~/.workbuddy/mcp.json'), encoding='utf-8'))
        aco = (cfg.get('mcpServers') or {}).get('acohub') or {}
        return (url or aco.get('url') or ''), (auth or ((aco.get('headers') or {}).get('Authorization') or ''))
    except Exception:  # noqa: BLE001
        return url or '', auth or ''


import json as _json  # noqa: E402
_MCP_URL, _MCP_AUTH = _mcp_gateway()

MCP_GATEWAY_URL = _MCP_URL
MCP_GATEWAY_AUTH = _MCP_AUTH
MCP_TOOL_PREFIX = os.environ.get('MCP_TOOL_PREFIX', 'armory_')
MCP_TIMEOUT_S = float(os.environ.get('MCP_TIMEOUT_S', '20'))

# MCP 相关产物路径
MCP_DIR = os.path.join(CASE_DIR, 'mcp') if os.path.isdir(CASE_DIR) or CASE_DIR else os.path.join(BASE_DIR, 'cases', 'mcp')
MCP_CONTRACT_FILE = os.path.join(MCP_DIR, 'contract.json')
MCP_PARAM_CASES_FILE = os.path.join(MCP_DIR, 'mcp-armory.cases.json')
MCP_SCENARIO_FILE = os.path.join(MCP_DIR, 'mcp-scenarios.cases.json')
MCP_SNAPSHOT_FILE = os.path.join(DATA_DIR, 'mcp_contract_snapshot.json')
