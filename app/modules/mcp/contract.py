# -*- coding: utf-8 -*-
"""第 1 步 · 契约发现：tools/list 导出 contract.json + 快照 diff。"""
import json
import os
import time

from ... import mcp_client
from ...config import (MCP_CONTRACT_FILE, MCP_DIR, MCP_SNAPSHOT_FILE,
                       MCP_TOOL_PREFIX)


def _filter_prefix(tools):
    return [t for t in tools if str(t.get('name', '')).startswith(MCP_TOOL_PREFIX)]


def _tool_digest(t):
    schema = t.get('inputSchema') or {}
    return {
        'description': t.get('description') or '',
        'required': schema.get('required') or [],
        'props': {k: v.get('type') for k, v in (schema.get('properties') or {}).items()},
    }


def _contract(tools):
    armory = _filter_prefix(tools)
    return {
        'source': 'tools/list (MCP 2024-11-05)',
        'generatedAt': time.strftime('%Y-%m-%d %H:%M:%S'),
        'toolPrefix': MCP_TOOL_PREFIX,
        'toolCount': len(tools),
        'armoryToolCount': len(armory),
        'tools': [{'name': t['name'], 'description': t.get('description') or '',
                   'required': (t.get('inputSchema') or {}).get('required') or [],
                   'inputSchema': t.get('inputSchema') or {}} for t in armory],
    }


def diff_contracts(old, new):
    """对比两份契约：新增 / 删除 / 变更（description、required、参数类型）。"""
    if not old:
        return {'added': [], 'removed': [], 'changed': [], 'first': True}
    old_map = {t['name']: _tool_digest({'description': t.get('description', ''),
                                        'inputSchema': t.get('inputSchema') or {}})
               for t in old.get('tools', [])}
    new_map = {t['name']: _tool_digest({'description': t.get('description', ''),
                                        'inputSchema': t.get('inputSchema') or {}})
               for t in new.get('tools', [])}
    added = sorted(set(new_map) - set(old_map))
    removed = sorted(set(old_map) - set(new_map))
    changed = []
    for name in sorted(set(old_map) & set(new_map)):
        if old_map[name] != new_map[name]:
            fields = [f for f in ('description', 'required', 'props')
                      if old_map[name].get(f) != new_map[name].get(f)]
            changed.append({'tool': name, 'fields': fields,
                            'oldRequired': old_map[name]['required'],
                            'newRequired': new_map[name]['required']})
    return {'added': added, 'removed': removed, 'changed': changed, 'first': False}


def discover():
    """拉取 tools/list -> 写 contract.json -> 与上次快照 diff -> 存新快照"""
    tools = mcp_client.tools_list()
    contract = _contract(tools)
    prev = None
    if os.path.isfile(MCP_SNAPSHOT_FILE):
        try:
            prev = json.load(open(MCP_SNAPSHOT_FILE, encoding='utf-8'))
        except Exception:  # noqa: BLE001
            prev = None
    diff = diff_contracts(prev, contract)
    os.makedirs(MCP_DIR, exist_ok=True)
    with open(MCP_CONTRACT_FILE, 'w', encoding='utf-8') as f:
        json.dump(contract, f, ensure_ascii=False, indent=2)
    with open(MCP_SNAPSHOT_FILE, 'w', encoding='utf-8') as f:
        json.dump({'time': contract['generatedAt'], 'tools': contract['tools']}, f,
                  ensure_ascii=False)
    return contract, diff


def load_contract():
    if not os.path.isfile(MCP_CONTRACT_FILE):
        return None
    try:
        return json.load(open(MCP_CONTRACT_FILE, encoding='utf-8'))
    except Exception:  # noqa: BLE001
        return None
