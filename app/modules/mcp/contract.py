# -*- coding: utf-8 -*-
"""第 1 步 · 契约发现：tools/list 导出 contract.json + 快照 diff。

支持「按云枢功能模块分别发现」与「多选模块合并发现」：
- contract.json 只保留选中模块的工具，并记录 modules / moduleStats（全量分布）；
- 基线快照按模块分桶保存，diff 只在本次选中模块范围内比较，
  因此切换模块不会把别的模块的工具误报成「新增/删除」。
"""
import json
import os
import time

from ... import mcp_client
from ...config import (MCP_CONTRACT_FILE, MCP_DIR, MCP_SNAPSHOT_FILE,
                       MCP_TOOL_PREFIX)
from .modules import DEFAULT_MODULES, module_of, resolve, selected_stats, stats as module_stats


def _filter_prefix(tools):
    return [t for t in tools if str(t.get('name', '')).startswith(MCP_TOOL_PREFIX)]


def _tool_digest(t):
    schema = t.get('inputSchema') or {}
    return {
        'description': t.get('description') or '',
        'required': schema.get('required') or [],
        'props': {k: v.get('type') for k, v in (schema.get('properties') or {}).items()},
    }


def _contract(tools, module_keys=None):
    """按选中模块裁剪契约。module_keys 为空 → 默认模块（制品库），保持历史行为。"""
    keys = resolve(module_keys)
    selected = [t for t in tools if module_of(t.get('name')) in keys]
    # 网关 tools/list 的返回顺序不保证稳定（实测两次调用首项就不同），
    # 这里按「模块目录顺序 + 工具名」重排，避免 contract.json 每次发现都整篇重排、
    # 让 git diff / 快照 diff 只剩真正的增删改。
    rank = {k: i for i, k in enumerate(keys)}
    selected = sorted(selected,
                      key=lambda t: (rank.get(module_of(t.get('name')), len(keys)),
                                     str(t.get('name'))))
    return {
        'source': 'tools/list (MCP 2024-11-05)',
        'generatedAt': time.strftime('%Y-%m-%d %H:%M:%S'),
        'toolPrefix': MCP_TOOL_PREFIX,
        'toolCount': len(tools),                 # 网关返回的全量工具数
        'modules': keys,                         # 本次发现选中的模块
        'selectedToolCount': len(selected),
        'armoryToolCount': len(selected),        # 兼容旧字段（曾表示 armory 前缀工具数）
        'moduleStats': module_stats(tools),      # 全量工具按模块分布（供前端选择器）
        'selectedStats': selected_stats(tools, keys),
        'tools': [{'name': t['name'], 'description': t.get('description') or '',
                   'required': (t.get('inputSchema') or {}).get('required') or [],
                   'inputSchema': t.get('inputSchema') or {}} for t in selected],
    }


def _snapshot_tools(snap, modules):
    """从基线快照里取选中模块的工具。

    新格式按模块分桶（modules 键）；旧快照只有 tools 全量，按工具名前缀归组后再筛。
    """
    if not snap:
        return []
    buckets = snap.get('modules')
    if isinstance(buckets, dict) and buckets:
        out = []
        for k in modules:
            out.extend(((buckets.get(k) or {}).get('tools') or []))
        return out
    return [t for t in snap.get('tools') or [] if module_of(t.get('name')) in modules]


def diff_contracts(old, new, modules=None):
    """对比两份契约：新增 / 删除 / 变更（description、required、参数类型）。

    只在 modules 范围内比较；某模块在旧快照里一个工具都没有（首次发现该模块）时，
    该模块的工具不计入 added，避免「刚勾上新模块就刷出上百条新增」的噪声。
    """
    modules = modules or new.get('modules') or DEFAULT_MODULES
    if not old:
        return {'added': [], 'removed': [], 'changed': [], 'first': True,
                'modules': list(modules), 'firstSeen': list(modules)}
    old_tools = _snapshot_tools(old, modules)
    new_tools = [t for t in new.get('tools') or []
                 if module_of(t.get('name')) in modules]
    old_mods = {module_of(t.get('name')) for t in old_tools}
    first_seen = [m for m in modules if m not in old_mods]

    old_map = {t['name']: _tool_digest(t) for t in old_tools}
    new_map = {t['name']: _tool_digest(t) for t in new_tools}
    added = sorted(set(new_map) - set(old_map))
    removed = sorted(set(old_map) - set(new_map))
    if first_seen:  # 首次发现的模块不报新增，改为在 firstSeen 里单独回显
        added = [n for n in added if module_of(n) not in first_seen]
        removed = [n for n in removed if module_of(n) not in first_seen]
    changed = []
    for name in sorted(set(old_map) & set(new_map)):
        if old_map[name] != new_map[name]:
            fields = [f for f in ('description', 'required', 'props')
                      if old_map[name].get(f) != new_map[name].get(f)]
            changed.append({'tool': name, 'fields': fields,
                            'oldRequired': old_map[name]['required'],
                            'newRequired': new_map[name]['required']})
    return {'added': added, 'removed': removed, 'changed': changed, 'first': False,
            'modules': list(modules), 'firstSeen': first_seen}


def discover(module_keys=None):
    """拉取 tools/list -> 写 contract.json -> 与上次快照 diff -> 存新快照

    module_keys 为 None 时沿用上次发现选中的模块（读 contract.json），
    这样「一键回归」不需要重复传参也能保持同一发现范围。
    """
    tools = mcp_client.tools_list()
    if module_keys is None:
        module_keys = (load_contract() or {}).get('modules') or None
    contract = _contract(tools, module_keys)
    prev = load_baseline()
    diff = diff_contracts(prev, contract, contract['modules'])
    os.makedirs(MCP_DIR, exist_ok=True)
    with open(MCP_CONTRACT_FILE, 'w', encoding='utf-8') as f:
        json.dump(contract, f, ensure_ascii=False, indent=2)
    # 快照按模块分桶，且只覆盖「本次发现的模块」：
    # 切到 A 模块发现、再切回 B 模块时，B 仍有自己的历史基线可比，
    # 不会被当成「首次发现」，真实的新增/删除也不会被吞掉。
    prev_buckets = (prev or {}).get('modules')
    buckets = dict(prev_buckets) if isinstance(prev_buckets, dict) else {}
    fresh = {}
    for t in contract['tools']:
        fresh.setdefault(module_of(t['name']), []).append(t)
    for k, v in fresh.items():
        buckets[k] = {'tools': v, 'time': contract['generatedAt']}
    merged_tools = []
    for k in sorted(buckets):
        merged_tools.extend((buckets[k] or {}).get('tools') or [])
    with open(MCP_SNAPSHOT_FILE, 'w', encoding='utf-8') as f:
        json.dump({'time': contract['generatedAt'],
                   'modules': buckets,
                   'tools': merged_tools}, f, ensure_ascii=False)
    return contract, diff


def load_contract():
    if not os.path.isfile(MCP_CONTRACT_FILE):
        return None
    try:
        return json.load(open(MCP_CONTRACT_FILE, encoding='utf-8'))
    except Exception:  # noqa: BLE001
        return None


def load_baseline():
    """上次「契约发现」保存的基线快照（diff 的对比基准）。"""
    if not os.path.isfile(MCP_SNAPSHOT_FILE):
        return None
    try:
        return json.load(open(MCP_SNAPSHOT_FILE, encoding='utf-8'))
    except Exception:  # noqa: BLE001
        return None
