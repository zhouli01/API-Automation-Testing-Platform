# -*- coding: utf-8 -*-
"""第 2 步：从 contract.json（MCP tools/list 导出）规则化生成参数级测试用例。

产出：cases/mcp/mcp-armory.cases.json（平台通用 JSON 格式，每条用例即一次
JSON-RPC tools/call，执行器用平台原有 HTTP 引擎直连 MCP 网关）。

用例设计（全部为参数级、无副作用）：
  · 缺必填参数：删除第一个 required 字段        -> 预期 result.isError == true（zod -32602）
  · 类型错误：  第一个 string 必填传数字 123    -> 预期 result.isError == true
  · 未知工具：  不存在的工具名                  -> 预期 error.code == -32601
  · 正常路径：  合法参数组合（仅只读白名单工具）-> 预期响应不含参数校验错误
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CONTRACT = os.path.join(ROOT, 'cases', 'mcp', 'contract.json')
OUT = os.path.join(ROOT, 'cases', 'mcp', 'mcp-armory.cases.json')

MCP_URL = 'http://10.12.7.250/api/mcp/gateway'
AUTH = json.load(open(os.path.expanduser('~/.workbuddy/mcp.json'), encoding='utf-8'))[
    'mcpServers']['acohub']['headers']['Authorization']

# 无参数、纯只读工具：正常路径直接调用
READ_NOARG = [
    'armory_system_info', 'armory_platform_list', 'armory_arch_list',
    'armory_namespace_list', 'armory_watch_list', 'armory_my_subscriptions',
    'armory_notification_list', 'armory_notification_unread_count',
    'armory_audit_list', 'armory_audit_operators', 'armory_audit_operation_types',
    'armory_permissions_sys', 'armory_issue_subscription_count', 'armory_watch_count',
    'armory_namespace_search_users', 'armory_user_notification_preference_get',
]
# 以真实存在的包（armory/armory-cli@2.2.1）为样本的只读工具 -> 完整必填参数
REAL_PKG = {'namespace': 'armory', 'name': 'armory-cli', 'version': '2.2.1'}
READ_WITH_PKG = {
    'armory_package_info': dict(REAL_PKG),
    'armory_package_versions': dict(REAL_PKG),
    'armory_package_readme': dict(REAL_PKG),
    'armory_package_status': dict(REAL_PKG),
    'armory_package_check_name': dict(REAL_PKG),
    'armory_version_max_semver': dict(REAL_PKG),
    'armory_version_info': dict(REAL_PKG),
    'armory_release_list': dict(REAL_PKG),
    'armory_package_version_platforms': dict(REAL_PKG),
    'armory_package_armory_json': dict(REAL_PKG),
    'armory_tag_list': dict(REAL_PKG),
    'armory_issue_list': dict(REAL_PKG),
    'armory_webhook_list': dict(REAL_PKG),
    'armory_permissions_pkg': dict(REAL_PKG),
    'armory_dependents_ranges': dict(REAL_PKG),
    'armory_namespace_info': {'name': 'armory'},
    'armory_namespace_members': {'name': 'armory'},
    'armory_namespace_packages_list': {'namespace': 'armory'},
    'armory_namespace_settings_get': {'namespace': 'armory'},
    'armory_dependencies_direct': {'name': 'armory-cli', 'version': '2.2.1'},
    'armory_dependency_graph_data': {'name': 'armory-cli', 'version': '2.2.1'},
}

# 按参数名/类型给正常路径填充样本值
SAMPLE = {
    'namespace': 'armory', 'name': 'armory-cli', 'pkgName': 'armory-cli',
    'version': '2.2.1', 'tag': 'stable', 'platform': 'windows', 'arch': 'x64',
    'keyword': 'armory', 'limit': 3, 'sha256': '0' * 64,
}


def sample_value(pname, schema):
    if pname in SAMPLE:
        return SAMPLE[pname]
    t = (schema or {}).get('type')
    if t == 'number' or t == 'integer':
        return 1
    if t == 'boolean':
        return True
    if t == 'array':
        return [1]
    return 'test-' + pname


def rpc_body(name, args, rid=[1000]):  # noqa: B006
    rid[0] += 1
    return {'jsonrpc': '2.0', 'id': rid[0], 'method': 'tools/call',
            'params': {'name': name, 'arguments': args}}


def case(name, tool, args, asserts, desc):
    return {
        'name': name, 'user': 'MCP', 'module': 'mcp-armory',
        'apiName': f'tools/call {tool}', 'apiPath': tool,
        'method': 'POST', 'url': MCP_URL,
        'headers': {'Authorization': AUTH, 'Content-Type': 'application/json'},
        'body': rpc_body(tool, args),
        'expect': {'asserts': asserts},
        'description': desc,
    }


A_IS_ERR = [{'type': 'json', 'path': 'result.isError', 'op': 'eq', 'value': True,
             'desc': '参数校验失败（isError=true，MCP -32602）'}]
A_TEXT_32602 = [{'type': 'json', 'path': 'result.content.0.text', 'op': 'contains',
                 'value': '-32602', 'desc': '错误文本含 -32602'}]
A_OK = [{'type': 'json', 'path': 'result.content.0.text', 'op': 'notContains',
         'value': '-32602', 'desc': '无参数级校验错误（-32602）'},
        {'type': 'json', 'path': 'result.content.0.text', 'op': 'exists',
         'desc': '返回 content 文本'}]

contract = json.load(open(CONTRACT, encoding='utf-8'))
cases = []
for t in contract['tools']:
    tool = t['name']
    schema = t['inputSchema']
    props = schema.get('properties') or {}
    required = schema.get('required') or []
    if not required:
        if tool in READ_NOARG:
            cases.append(case(f'{tool} 正常路径', tool, {}, A_OK,
                              '无必填参数只读工具，正常调用'))
        continue
    # 1) 缺必填：删掉第一个 required
    args = {k: sample_value(k, props.get(k)) for k in required}
    dropped = required[0]
    neg1 = {k: v for k, v in args.items() if k != dropped}
    cases.append(case(f'{tool} 缺必填[{dropped}]', tool, neg1, A_IS_ERR + A_TEXT_32602,
                      f'删除必填字段 {dropped}，预期参数校验失败'))
    # 2) 类型错误：第一个 string 必填传数字
    first_str = next((k for k in required
                      if (props.get(k) or {}).get('type') == 'string'), None)
    if first_str:
        bad = dict(args)
        bad[first_str] = 123
        cases.append(case(f'{tool} 类型错误[{first_str}]', tool, bad, A_IS_ERR + A_TEXT_32602,
                          f'string 字段 {first_str} 传数字，预期参数校验失败'))
    # 3) 正常路径：只读白名单
    if tool in READ_NOARG:
        cases.append(case(f'{tool} 正常路径', tool, {}, A_OK, '只读工具正常调用'))
    elif tool in READ_WITH_PKG:
        ok_args = dict(READ_WITH_PKG[tool])
        for k in required:
            if k not in ok_args:
                ok_args[k] = sample_value(k, props.get(k))
        cases.append(case(f'{tool} 正常路径', tool, ok_args, A_OK,
                          '真实样本参数（armory/armory-cli@2.2.1）正常调用'))

# 未知工具
cases.append(case('未知工具', 'armory_no_such_tool', {},
                  [{'type': 'json', 'path': 'error.code', 'op': 'eq', 'value': -32601,
                    'desc': 'JSON-RPC error.code = -32601 Tool not found'}],
                  '调用不存在的工具，预期 -32601'))

doc = {
    'name': 'MCP armory 工具参数级测试用例（规则生成，来源 contract.json）',
    'generatedBy': 'tools/gen_mcp_cases.py',
    'cases': cases,
}
json.dump(doc, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('生成用例:', len(cases), '->', os.path.relpath(OUT, ROOT))
from collections import Counter
print(Counter(c['name'].split(' ')[0].rsplit('_', 1)[0] for c in cases).most_common(5))
