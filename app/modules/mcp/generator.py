# -*- coding: utf-8 -*-
"""第 2/4a/4b 步 · 用例生成：参数级（规则）+ 场景级（内置链路模板，AI 可后续扩充）。"""
import json
import os
import time

from ...config import (MCP_DIR, MCP_PARAM_CASES_FILE, MCP_SCENARIO_FILE)
from .contract import load_contract
from .modules import module_of

MCP_URL_AUTH = None  # 延迟从 config 取，避免循环导入


def _gateway():
    from ...config import MCP_GATEWAY_AUTH, MCP_GATEWAY_URL
    return MCP_GATEWAY_URL, MCP_GATEWAY_AUTH


# 无参数只读工具：正常路径直接调用
READ_NOARG = [
    'armory_system_info', 'armory_platform_list', 'armory_arch_list',
    'armory_namespace_list', 'armory_watch_list', 'armory_my_subscriptions',
    'armory_notification_list', 'armory_notification_unread_count',
    'armory_audit_list', 'armory_audit_operators', 'armory_audit_operation_types',
    'armory_permissions_sys', 'armory_issue_subscription_count', 'armory_watch_count',
    'armory_namespace_search_users', 'armory_user_notification_preference_get',
]
REAL_PKG = {'namespace': 'armory', 'name': 'armory-cli', 'version': '2.2.1'}
READ_WITH_PKG = {
    'armory_package_info': dict(REAL_PKG), 'armory_package_versions': dict(REAL_PKG),
    'armory_package_readme': dict(REAL_PKG), 'armory_package_status': dict(REAL_PKG),
    'armory_package_check_name': dict(REAL_PKG), 'armory_version_max_semver': dict(REAL_PKG),
    'armory_version_info': dict(REAL_PKG), 'armory_release_list': dict(REAL_PKG),
    'armory_package_version_platforms': dict(REAL_PKG),
    'armory_package_armory_json': dict(REAL_PKG), 'armory_tag_list': dict(REAL_PKG),
    'armory_issue_list': dict(REAL_PKG), 'armory_webhook_list': dict(REAL_PKG),
    'armory_permissions_pkg': dict(REAL_PKG), 'armory_dependents_ranges': dict(REAL_PKG),
    'armory_namespace_info': {'name': 'armory'}, 'armory_namespace_members': {'name': 'armory'},
    'armory_namespace_packages_list': {'namespace': 'armory'},
    'armory_namespace_settings_get': {'namespace': 'armory'},
    'armory_dependencies_direct': {'name': 'armory-cli', 'version': '2.2.1'},
    'armory_dependency_graph_data': {'name': 'armory-cli', 'version': '2.2.1'},
}
SAMPLE = {'namespace': 'armory', 'name': 'armory-cli', 'pkgName': 'armory-cli',
          'version': '2.2.1', 'tag': 'stable', 'platform': 'windows', 'arch': 'x64',
          'keyword': 'armory', 'limit': 3, 'sha256': '0' * 64}

A_IS_ERR = [{'type': 'json', 'path': 'result.isError', 'op': 'eq', 'value': True,
             'desc': '参数校验失败（isError=true，-32602）'}]
A_TEXT_ERR = [{'type': 'json', 'path': 'result.content.0.text', 'op': 'contains',
               'value': '-32602', 'desc': '错误文本含 -32602'}]
A_OK = [{'type': 'json', 'path': 'result.content.0.text', 'op': 'notContains',
         'value': '-32602', 'desc': '无参数级校验错误'},
        {'type': 'json', 'path': 'result.content.0.text', 'op': 'exists',
         'desc': '返回 content 文本'}]


def sample_value(pname, schema):
    if pname in SAMPLE:
        return SAMPLE[pname]
    t = (schema or {}).get('type')
    if t in ('number', 'integer'):
        return 1
    if t == 'boolean':
        return True
    if t == 'array':
        return [1]
    return 'test-' + pname


def generate_param_cases():
    """4a 参数级用例：缺必填 / 类型错误 / 正常路径（只读白名单）/ 未知工具。"""
    contract = load_contract()
    if not contract:
        raise RuntimeError('尚未进行契约发现，请先执行「契约发现」')
    url, auth = _gateway()
    cases = []
    for t in contract['tools']:
        tool = t['name']
        mod = module_of(tool)
        schema = t.get('inputSchema') or {}
        props = schema.get('properties') or {}
        required = schema.get('required') or []
        args = {k: sample_value(k, props.get(k)) for k in required}
        if not required:
            if tool in READ_NOARG:
                cases.append(_param_case(url, auth, f'{tool} 正常路径', tool, {}, A_OK,
                                         '无必填参数只读工具，正常调用', mod))
            continue
        dropped = required[0]
        cases.append(_param_case(url, auth, f'{tool} 缺必填[{dropped}]', tool,
                                 {k: v for k, v in args.items() if k != dropped},
                                 A_IS_ERR + A_TEXT_ERR, f'删除必填字段 {dropped}', mod))
        first_str = next((k for k in required
                          if (props.get(k) or {}).get('type') == 'string'), None)
        if first_str:
            bad = dict(args)
            bad[first_str] = 123
            cases.append(_param_case(url, auth, f'{tool} 类型错误[{first_str}]', tool,
                                     bad, A_IS_ERR + A_TEXT_ERR,
                                     f'string 字段 {first_str} 传数字', mod))
        if tool in READ_NOARG:
            cases.append(_param_case(url, auth, f'{tool} 正常路径', tool, {}, A_OK,
                                     '只读工具正常调用', mod))
        elif tool in READ_WITH_PKG:
            ok_args = dict(READ_WITH_PKG[tool])
            for k in required:
                ok_args.setdefault(k, sample_value(k, props.get(k)))
            cases.append(_param_case(url, auth, f'{tool} 正常路径', tool, ok_args, A_OK,
                                     '真实样本参数正常调用', mod))
    cases.append(_param_case(url, auth, '未知工具', 'armory_no_such_tool', {},
                             [{'type': 'json', 'path': 'error.code', 'op': 'eq',
                               'value': -32601, 'desc': 'JSON-RPC error.code=-32601'}],
                             '调用不存在的工具'))
    doc = {'name': 'MCP armory 参数级用例（规则生成）', 'generatedBy': 'mcp/generator',
           'generatedAt': time.strftime('%Y-%m-%d %H:%M:%S'), 'cases': cases}
    os.makedirs(MCP_DIR, exist_ok=True)
    json.dump(doc, open(MCP_PARAM_CASES_FILE, 'w', encoding='utf-8'),
              ensure_ascii=False, indent=2)
    return {'file': os.path.basename(MCP_PARAM_CASES_FILE), 'total': len(cases)}


def _param_case(url, auth, name, tool, args, asserts, desc, mod='armory'):
    """mod：工具所属模块（armory / project / code …），用于用例列表按模块归类。"""
    return {'name': name, 'user': 'MCP', 'module': 'mcp-' + (mod or 'armory'),
            'apiName': f'tools/call {tool}', 'apiPath': tool,
            'method': 'POST', 'url': url,
            'headers': {'Authorization': auth, 'Content-Type': 'application/json'},
            'body': {'jsonrpc': '2.0', 'id': 0, 'method': 'tools/call',
                     'params': {'name': tool, 'arguments': args}},
            'expect': {'asserts': asserts}, 'description': desc}


# ================================================================ 4b 场景级链路
def _step(tool, args, extract=None, desc=''):
    return {'tool': tool, 'args': args, 'extract': extract or {}, 'desc': desc}


def _default_step_asserts():
    return A_OK


def generate_scenario_cases():
    """4b 场景级用例：只读链路（状态依赖：上一步输出喂给下一步）。"""
    url, auth = _gateway()
    scenarios = [
        {'name': 'S1 包查询链（search→info→versions→max_semver）',
         'desc': '参数级之外的业务链路：搜索包并提取名称，供后续工具复用',
         'steps': [
             _step('armory_package_search', {'keyword': 'armory', 'limit': 3},
                   {'pkgName': 'result.content.0.text => packages.0.name',
                    'ns': 'result.content.0.text => packages.0.namespace'},
                   '搜索 armory 包，提取 namespace/name'),
             _step('armory_package_info', {'namespace': '{{ns}}', 'name': '{{pkgName}}'},
                   desc='用上一步提取的参数查包详情'),
             _step('armory_package_versions', {'namespace': '{{ns}}', 'name': '{{pkgName}}'},
                   desc='查询包版本列表'),
             _step('armory_version_max_semver', {'namespace': '{{ns}}', 'name': '{{pkgName}}'},
                   desc='查询最新语义化版本'),
         ]},
        {'name': 'S2 平台元数据链（platform_list→arch_list→system_info）',
         'desc': '只读元数据链路，验证平台/架构基础数据一致性',
         'steps': [
             _step('armory_platform_list', {},
                   {'plat': 'result.content.0.text => 0.name'},
                   '平台列表，尝试提取首个平台名'),
             _step('armory_arch_list', {}, desc='架构列表'),
             _step('armory_system_info', {}, desc='系统信息'),
         ]},
        {'name': 'S3 命名空间链（namespace_list→info→members→packages）',
         'desc': '命名空间维度链路：列表提取名称后逐层下钻',
         'steps': [
             _step('armory_namespace_list', {},
                   {'nsName': 'result.content.0.text => 0.name'},
                   '命名空间列表，提取首个名称'),
             _step('armory_namespace_info', {'name': '{{nsName}}'}, desc='命名空间详情'),
             _step('armory_namespace_members', {'name': '{{nsName}}'}, desc='命名空间成员'),
             _step('armory_namespace_packages_list', {'namespace': '{{nsName}}'},
                   desc='命名空间下的包列表'),
         ]},
    ]
    doc = {'name': 'MCP armory 场景级用例（4b · 状态依赖链路）',
           'generatedBy': 'mcp/generator',
           'generatedAt': time.strftime('%Y-%m-%d %H:%M:%S'),
           'gateway': url, 'scenarios': scenarios}
    os.makedirs(MCP_DIR, exist_ok=True)
    json.dump(doc, open(MCP_SCENARIO_FILE, 'w', encoding='utf-8'),
              ensure_ascii=False, indent=2)
    return {'file': os.path.basename(MCP_SCENARIO_FILE),
            'scenarios': len(scenarios),
            'steps': sum(len(s['steps']) for s in scenarios)}
