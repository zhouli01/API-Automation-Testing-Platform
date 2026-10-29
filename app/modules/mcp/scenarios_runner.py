# -*- coding: utf-8 -*-
"""第 5 步 · 执行层：场景链路顺序执行（状态依赖 + 变量提取），复用平台 HTTP 引擎。"""
import json
import os
import re

from ...config import MCP_SCENARIO_FILE
from ...modules.cases.runner import execute_case, json_path, failed_result
from ...store import load_meta
from .generator import A_OK as _STEP_ASSERTS

EXTRACT_SEP = '=>'


def _extract_value(body_text, spec):
    """'jsonpath => subjsonpath'：第一段取到字符串后尝试再解析一层 JSON。"""
    parts = [p.strip() for p in str(spec).split(EXTRACT_SEP, 1)]
    try:
        parsed = json.loads(body_text) if body_text else None
    except Exception:  # noqa: BLE001
        return None
    val = json_path(parsed, parts[0]) if parsed is not None else None
    if len(parts) == 2 and isinstance(val, str) and val[:1] in ('{', '['):
        try:
            inner = json.loads(val)
            val = json_path(inner, parts[1])
        except Exception:  # noqa: BLE001
            pass
    return val


def _step_case(idx, sc, step, gateway_url, batch_tag):
    tool = step['tool']
    cid = f'{os.path.basename(MCP_SCENARIO_FILE)}::{sc}::{idx}'
    return {
        'id': cid, 'caseNo': '', 'apiName': f'tools/call {tool}', 'apiPath': tool,
        'file': os.path.basename(MCP_SCENARIO_FILE), 'user': 'MCP',
        'module': 'mcp-scenarios', 'folder': 'mcp-scenarios',
        'name': f'{sc + 1}.{idx + 1} {tool}' + (f'（{step["desc"]}）' if step.get('desc') else ''),
        'method': 'POST', 'url': gateway_url, 'baseUrl': '',
        'query': [], 'tags': ['mcp-scenario'],
        'headers': [{'key': 'Authorization', 'value': '{{MCP_AUTH}}'},
                    {'key': 'Content-Type', 'value': 'application/json'}],
        'body': json.dumps({'jsonrpc': '2.0', 'id': 0, 'method': 'tools/call',
                            'params': {'name': tool, 'arguments': step.get('args') or {}}},
                           ensure_ascii=False),
        'contentType': 'application/json', 'expectCode': None, 'expectName': '',
        'description': step.get('desc') or '',
        '_asserts': list(_STEP_ASSERTS),
    }


def _run_chain(sc, steps, settings, gateway_url, auth_header):
    """顺序执行一条链路；extract 提取变量供后续步骤 {{var}} 使用。"""
    variables = {'MCP_AUTH': auth_header}
    results = []
    for idx, step in enumerate(steps):
        case = _step_case(idx, sc, step, gateway_url, sc)
        try:
            r = execute_case(case, settings, dict(variables), {}, {})
        except Exception as e:  # noqa: BLE001
            r = failed_result(case, f'{type(e).__name__}: {e}')
        for var, spec in (step.get('extract') or {}).items():
            val = _extract_value(r.get('responseBody') or '', spec)
            if val not in (None, ''):
                variables[var] = str(val)
        r['chain'] = sc + 1
        results.append(r)
        if not r.get('passed'):
            break  # 链路中断即停（失败恢复由场景设计保证：只读链路可安全重跑）
    return results


def run_scenarios(settings=None, auth_header=''):
    """执行全部场景链路，返回 {chains:[{name, steps, passed, results}], summary}"""
    if not os.path.isfile(MCP_SCENARIO_FILE):
        raise RuntimeError('尚未生成场景用例，请先执行「场景用例生成」')
    doc = json.load(open(MCP_SCENARIO_FILE, encoding='utf-8'))
    meta = load_meta()
    s = dict(meta['settings'])
    if settings:
        s.update({k: v for k, v in settings.items() if v is not None})
    gateway_url = doc.get('gateway') or ''
    chains = []
    for sc, scenario in enumerate(doc.get('scenarios') or []):
        results = _run_chain(sc, scenario.get('steps') or [], s, gateway_url,
                             auth_header or '')
        chains.append({
            'name': scenario.get('name'),
            'desc': scenario.get('desc') or '',
            'steps': len(results),
            'passed': sum(1 for r in results if r.get('passed')),
            'results': results,
        })
    total = sum(c['steps'] for c in chains)
    passed = sum(c['passed'] for c in chains)
    return {'chains': chains,
            'summary': {'chains': len(chains), 'total': total, 'passed': passed,
                        'failed': total - passed}}
