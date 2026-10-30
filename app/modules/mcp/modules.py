# -*- coding: utf-8 -*-
"""云枢（acohub）功能模块目录：把 MCP 网关的全量工具按菜单模块归类。

契约发现支持「按模块分别发现」与「多选模块合并发现」。模块划分依据工具名前缀——
网关把不同菜单的接口各起了固定前缀，因此不需要额外的菜单接口即可归类：

    armory_*                          制品库
    project-* / project_*             项目管理（/acohub/project/issues）
    mcp_code_*                        代码
    mcp_autosphere_*                  自动化测试
    cicd_*                            流水线
    document_*                        文档
    *_skill(s) / *_knowledge_base(s)  技能与知识库

新增模块只需在 MODULES 里追加一行，前端选择器会自动出现，无需改前端。
工具名既匹配不上前缀也匹配不上后缀时归入「其他」，保证不静默丢工具。
"""
import re

MODULES = [
    {'key': 'armory', 'label': '制品库', 'prefixes': ['armory_']},
    {'key': 'project', 'label': '项目管理', 'prefixes': ['project-', 'project_']},
    {'key': 'code', 'label': '代码', 'prefixes': ['mcp_code_']},
    {'key': 'autotest', 'label': '自动化测试', 'prefixes': ['mcp_autosphere_']},
    {'key': 'cicd', 'label': '流水线', 'prefixes': ['cicd_']},
    {'key': 'document', 'label': '文档', 'prefixes': ['document_']},
    {'key': 'skill', 'label': '技能与知识库',
     'suffixes': ['_skill', '_skills', '_knowledge_base', '_knowledge_bases']},
]

OTHER = {'key': 'other', 'label': '其他'}

# 顺序即前端 chip 的展示顺序；other 常驻末位（无工具时前端置灰）
MODULE_KEYS = [m['key'] for m in MODULES] + [OTHER['key']]
_LABELS = {m['key']: m['label'] for m in MODULES + [OTHER]}

# 未显式指定模块时的默认值：保持历史行为（只发现制品库）
DEFAULT_MODULES = ['armory']


def module_of(name):
    """工具名 → 模块 key（匹配不上前缀/后缀则归 other）。"""
    n = str(name or '')
    for m in MODULES:
        if any(n.startswith(p) for p in m.get('prefixes') or ()):
            return m['key']
        if any(n.endswith(s) for s in m.get('suffixes') or ()):
            return m['key']
    return OTHER['key']


def label_of(key):
    return _LABELS.get(key, key)


def resolve(keys):
    """把前端传来的模块列表规整为去重、合法、顺序稳定的 key 列表。

    接受 list 或 'armory,project' 这类逗号串；空值 / 全非法 → 回落到默认模块，
    保证 discover 永远有明确的发现范围（不会退化成「全量发现」）。
    """
    if not keys:
        return list(DEFAULT_MODULES)
    if isinstance(keys, str):
        keys = [k for k in re.split(r'[,，\s]+', keys) if k]
    wanted = {k for k in keys if k in MODULE_KEYS}
    ordered = [k for k in MODULE_KEYS if k in wanted]
    return ordered or list(DEFAULT_MODULES)


def stats(tools):
    """全量工具按模块统计，顺序固定；空模块也返回（count=0），前端据此置灰。"""
    buckets = {}
    for t in tools or []:
        name = (t or {}).get('name')
        buckets.setdefault(module_of(name), []).append(name)
    out = []
    for k in MODULE_KEYS:
        names = buckets.get(k) or []
        out.append({'key': k, 'label': label_of(k), 'count': len(names),
                    'sample': names[0] if names else ''})
    return out


def selected_stats(tools, keys):
    """选中模块各自的工具数（用于发现结果回显）。"""
    counts = {k: 0 for k in keys}
    for t in tools or []:
        k = module_of((t or {}).get('name'))
        if k in counts:
            counts[k] += 1
    return [{'key': k, 'label': label_of(k), 'count': counts[k]} for k in keys]
