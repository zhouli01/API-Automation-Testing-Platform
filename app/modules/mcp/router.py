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


@router.get('/tools', summary='契约发现的工具清单（名称 / 描述 / 必填参数）')
def list_tools(_user: dict = Depends(require_user)):
    contract = contract_mod.load_contract()
    if not contract:
        raise ApiError(400, '尚未进行契约发现，请先在「契约发现」页执行')
    return {'ok': True, 'generatedAt': contract.get('generatedAt'),
            'gateway': MCP_GATEWAY_URL,
            'total': contract.get('armoryToolCount') or len(contract.get('tools') or []),
            'tools': [{'name': t['name'],
                       'description': (t.get('description') or '').strip(),
                       'required': t.get('required') or []}
                      for t in contract.get('tools') or []]}


@router.get('/cases/summary', summary='已生成用例概览（4a 参数级 / 4b 场景级）')
def cases_summary(_user: dict = Depends(require_user)):
    return {'ok': True, 'gateway': MCP_GATEWAY_URL,
            'params': _param_summary(), 'scenarios': _scenario_summary()}


# 用例名 → 分类（与 generator 的命名规则一一对应）
_CAT_RULES = (('缺必填', '缺必填'), ('类型错误', '类型错误'),
              ('正常路径', '正常路径'), ('未知工具', '未知工具'))


def _mtime(path):
    import os
    try:
        return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(os.stat(path).st_mtime))
    except OSError:
        return ''


def _param_summary():
    try:
        with open(MCP_PARAM_CASES_FILE, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {'exists': False, 'mtime': '', 'total': 0, 'categories': [], 'tools': []}
    cases = data.get('cases') or []
    cats: Dict[str, int] = {}
    tools: Dict[str, dict] = {}
    for c in cases:
        name = c.get('name') or ''
        cat = next((label for key, label in _CAT_RULES if key in name), '其他')
        cats[cat] = cats.get(cat, 0) + 1
        tool = c.get('apiPath') or '—'
        it = tools.setdefault(tool, {'tool': tool, 'count': 0, 'cats': {}, 'sample': name})
        it['count'] += 1
        it['cats'][cat] = it['cats'].get(cat, 0) + 1
    order = ['缺必填', '类型错误', '正常路径', '未知工具', '其他']
    return {
        'exists': True, 'mtime': _mtime(MCP_PARAM_CASES_FILE),
        'file': 'cases/mcp/' + MCP_PARAM_CASES_FILE.replace('\\', '/').split('/')[-1],
        'total': len(cases),
        'categories': [{'name': k, 'count': cats[k]} for k in order if cats.get(k)],
        'tools': sorted(tools.values(), key=lambda x: (-x['count'], x['tool'])),
    }


def _scenario_summary():
    try:
        with open(MCP_SCENARIO_FILE, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {'exists': False, 'mtime': '', 'chains': [], 'stepCount': 0}
    chains = []
    for s in data.get('scenarios') or []:
        steps = s.get('steps') or []
        chains.append({
            'name': s.get('name') or '', 'desc': s.get('desc') or '',
            'stepCount': len(steps),
            'steps': [{'tool': st.get('tool') or '', 'desc': st.get('desc') or '',
                       'args': st.get('args') or {}, 'extract': st.get('extract') or {}}
                      for st in steps],
        })
    return {'exists': True, 'mtime': _mtime(MCP_SCENARIO_FILE),
            'file': 'cases/mcp/' + MCP_SCENARIO_FILE.replace('\\', '/').split('/')[-1],
            'chains': chains, 'stepCount': sum(c['stepCount'] for c in chains)}


@router.get('/runs', summary='最近 MCP 运行记录（参数级 / 场景级回归）')
def recent_runs(limit: int = 5, _user: dict = Depends(require_user)):
    from ...store import history_summary, load_history, sorted_batches
    out = []
    try:
        for b in sorted_batches(load_history()):
            if str((b.get('source') or {}).get('type') or '').startswith('mcp'):
                out.append(history_summary(b))
            if len(out) >= max(1, min(limit, 20)):
                break
    except Exception:  # noqa: BLE001
        pass
    return {'ok': True, 'runs': out}


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


@router.post('/diff', summary='第 6 步 · Schema diff：与上次基线快照对比（发现即告警）')
def schema_diff(_user: dict = Depends(require_user)):
    try:
        tools = mcp_client.tools_list()
    except Exception as e:  # noqa: BLE001
        raise ApiError(502, f'MCP 网关不可达：{type(e).__name__}: {e}')
    current = contract_mod._contract(tools)
    # 基线 = 上次「契约发现」时的快照（data/mcp_contract_snapshot.json），
    # 不用 contract.json——它在每次发现/回归后都会刷新为最新，会导致 diff 恒为空
    baseline = contract_mod.load_baseline()
    diff = contract_mod.diff_contracts(baseline, current)
    return {'ok': True, 'currentCount': current['armoryToolCount'],
            'baselineTime': (baseline or {}).get('generatedAt') or
                            (baseline or {}).get('time') or '', 'diff': diff}


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
