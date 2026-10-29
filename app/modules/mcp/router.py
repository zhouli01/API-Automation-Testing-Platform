# -*- coding: utf-8 -*-
"""MCP 测试模块路由：契约发现 / 用例生成 / 场景执行 / Schema diff / 一键回归。

对应架构五个环节（4a 参数级 · 4b 场景级 · 5 执行 · 6 diff 回归）。
"""
import json
import time
from typing import Any, Dict

from fastapi import APIRouter, Body, Depends

from ... import mcp_client
from ...config import (MCP_CONTRACT_FILE, MCP_GATEWAY_AUTH, MCP_GATEWAY_URL,
                       MCP_PARAM_CASES_FILE, MCP_SCENARIO_FILE, MCP_TOOL_PREFIX)
from ...deps import ApiError, require_user
from ...modules.cases.parser import build_payload, invalidate_cache
from . import contract as contract_mod
from . import generator, scenarios_runner

router = APIRouter(prefix='/api/mcp', tags=['MCP 测试'])


@router.get('/status', summary='MCP 测试模块状态（网关 / 各产物文件）')
def status(_user: dict = Depends(require_user)):
    def _info(path):
        try:
            import os
            st = os.stat(path)
            return {'exists': True, 'mtime': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(st.st_mtime))}
        except OSError:
            return {'exists': False, 'mtime': ''}
    contract = contract_mod.load_contract()
    return {
        'ok': True,
        'gateway': MCP_GATEWAY_URL,
        'toolPrefix': MCP_TOOL_PREFIX,
        'gatewayReachable': _ping(),
        'contract': dict(_info(MCP_CONTRACT_FILE),
                         toolCount=(contract or {}).get('armoryToolCount') or 0),
        'paramCases': _info(MCP_PARAM_CASES_FILE),
        'scenarioCases': _info(MCP_SCENARIO_FILE),
    }


def _ping():
    try:
        mcp_client.tools_list()
        return True
    except Exception:  # noqa: BLE001
        return False


@router.post('/discover', summary='第 1 步 · 契约发现：tools/list 导出 contract.json 并 diff')
def discover(_user: dict = Depends(require_user)):
    try:
        contract, diff = contract_mod.discover()
    except Exception as e:  # noqa: BLE001
        raise ApiError(502, f'MCP 网关不可达：{type(e).__name__}: {e}')
    invalidate_cache()
    return {'ok': True, 'gateway': MCP_GATEWAY_URL,
            'toolCount': contract['toolCount'],
            'armoryToolCount': contract['armoryToolCount'],
            'diff': diff}


@router.post('/generate/params', summary='第 2/4a 步 · 规则生成参数级用例')
def generate_params(_user: dict = Depends(require_user)):
    try:
        info = generator.generate_param_cases()
    except RuntimeError as e:
        raise ApiError(400, str(e))
    invalidate_cache()
    return {'ok': True, **info}


@router.post('/generate/scenarios', summary='第 4b 步 · 生成场景级链路用例（状态依赖）')
def generate_scenarios(_user: dict = Depends(require_user)):
    info = generator.generate_scenario_cases()
    return {'ok': True, **info}


@router.post('/scenarios/run', summary='第 5 步 · 执行场景链路（4b，状态依赖顺序执行）')
def run_scenarios(payload: Dict[str, Any] = Body(default_factory=dict),
                  _user: dict = Depends(require_user)):
    try:
        out = scenarios_runner.run_scenarios(
            settings=payload.get('settings') or {}, auth_header=MCP_GATEWAY_AUTH)
    except RuntimeError as e:
        raise ApiError(400, str(e))
    _record_scenario_history(out)
    return {'ok': True, **out}


@router.post('/diff', summary='第 6 步 · Schema diff：与上次快照对比（发现即告警）')
def schema_diff(_user: dict = Depends(require_user)):
    try:
        tools = mcp_client.tools_list()
    except Exception as e:  # noqa: BLE001
        raise ApiError(502, f'MCP 网关不可达：{type(e).__name__}: {e}')
    current = contract_mod._contract(tools)
    last = contract_mod.load_contract()
    diff = contract_mod.diff_contracts(
        {'tools': (last or {}).get('tools') or []}, current)
    return {'ok': True, 'currentCount': current['armoryToolCount'], 'diff': diff}


@router.post('/regression', summary='一键回归：契约发现 → diff → 生成参数用例 → 全量执行（4a+4b）')
def regression(payload: Dict[str, Any] = Body(default_factory=dict),
               _user: dict = Depends(require_user)):
    out = {'steps': {}}
    # 1. 契约发现 + diff
    try:
        contract, diff = contract_mod.discover()
    except Exception as e:  # noqa: BLE001
        raise ApiError(502, f'MCP 网关不可达：{type(e).__name__}: {e}')
    out['steps']['discover'] = {'toolCount': contract['armoryToolCount'], 'diff': diff}
    invalidate_cache()
    # 2/4a. 重新生成参数级用例（保证与最新契约一致）
    gen = generator.generate_param_cases()
    out['steps']['generateParams'] = gen
    invalidate_cache()
    # 5. 执行 4a：复用测试用例执行器
    data = build_payload(force=True)
    ids = [c['id'] for c in data['cases'] if c['file'].startswith('mcp/')]
    from ...modules.cases.router import _do_run
    payload_run = {'source': {'type': 'mcp-regression', 'name': 'MCP 一键回归（参数级）'}}
    resp = _do_run(payload_run, dict(data['settings']), [c for c in data['cases'] if c['id'] in set(ids)],
                   [], {}, data['settings'].get('globalVars') or {}, data['settings'].get('globalHeaders') or {})
    run4a = json.loads(resp.body)
    out['steps']['runParams'] = {k: run4a.get(k) for k in
                                 ('total', 'passedCount', 'failedCount', 'durationMs', 'wallMs', 'batchId')}
    # 4b/5. 场景链路
    import os
    if os.path.isfile(MCP_SCENARIO_FILE):
        scen = scenarios_runner.run_scenarios(auth_header=MCP_GATEWAY_AUTH)
        out['steps']['runScenarios'] = scen['summary']
        _record_scenario_history(scen)
    total = (out['steps']['runParams'].get('total') or 0) + (out['steps'].get('runScenarios', {}).get('total') or 0)
    passed = (out['steps']['runParams'].get('passedCount') or 0) + (out['steps'].get('runScenarios', {}).get('passed') or 0)
    out['summary'] = {'total': total, 'passed': passed, 'failed': total - passed,
                      'schemaDiff': diff}
    return {'ok': True, **out}


def _record_scenario_history(out):
    """场景执行结果写入运行记录（复用 history 存储，source 标记为 MCP 场景）。"""
    try:
        from ...store import append_history, new_batch_id
        from ...config import MAX_BODY_KEEP
        results = []
        for chain in out.get('chains', []):
            results.extend(chain.get('results') or [])
        if not results:
            return
        now = time.strftime('%Y-%m-%d %H:%M:%S')
        batch = {
            'batchId': new_batch_id(),
            'executedBy': 'MCP 场景回归',
            'environment': MCP_GATEWAY_URL,
            'startedAt': now, 'startedAtMs': int(time.time() * 1000),
            'durationMs': sum(r.get('durationMs') or 0 for r in results),
            'wallMs': sum(r.get('durationMs') or 0 for r in results),
            'total': len(results),
            'passedCount': sum(1 for r in results if r.get('passed')),
            'failedCount': sum(1 for r in results if not r.get('passed')),
            'source': {'type': 'mcp-scenarios', 'name': 'MCP 场景链路（4b）'},
            'caseIds': [r['caseId'] for r in results],
            'results': [dict(r, responseBody=(r.get('responseBody') or '')[:MAX_BODY_KEEP],
                             bodyTruncated=len(r.get('responseBody') or '') > MAX_BODY_KEEP)
                        for r in results],
        }
        append_history(batch)
    except Exception:  # noqa: BLE001
        pass
