# -*- coding: utf-8 -*-
"""MCP 测试模块路由：契约发现 / 用例生成 / 场景执行 / Schema diff / 一键回归。

对应架构五个环节（4a 参数级 · 4b 场景级 · 5 执行 · 6 diff 回归）。
"""
import json
import re
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


# 工具 description 里的接口声明：'…对应 API: GET /v1/packages/@:namespace/:name/versions'
# 路径遇到空白或中文/英文左括号即止（避免把「（version 可选）」这类备注吃进路径），
# 紧随其后的括号备注整段丢弃，保证「接口名称」列干净。
_API_DECL_RE = re.compile(
    r'对应\s*API\s*[:：]\s*([A-Za-z]+)\s+([^\s（(]+)'
    r'(?:\s*[（(][^）)]*[）)])?'
)


def _split_api(desc):
    """把 description 拆成 (方法, 路径, 纯描述)。

    armory 工具的 description 统一写成「<说明>。对应 API: <METHOD> <PATH>」，
    接口名称单独成列后，描述列只保留业务说明，避免重复。
    """
    desc = (desc or '').strip()
    m = _API_DECL_RE.search(desc)
    if not m:
        return '', '', desc
    method, path = m.group(1).upper(), m.group(2).rstrip('。;；,，')
    # 去掉句末单个句点，但保留路径里的省略号（?name=...）
    if path.endswith('.') and not path.endswith('...'):
        path = path[:-1]
    clean = (desc[:m.start()] + desc[m.end():]).strip()
    clean = clean.strip('。.;；,，').strip()
    return method, path, clean


@router.get('/tools', summary='契约发现的工具清单（完整工具名 / 接口名称 / 描述 / 必填参数）')
def list_tools(_user: dict = Depends(require_user)):
    contract = contract_mod.load_contract()
    if not contract:
        raise ApiError(400, '尚未进行契约发现，请先在「契约发现」页执行')
    tools = []
    for t in contract.get('tools') or []:
        method, path, clean = _split_api(t.get('description'))
        schema = t.get('inputSchema') or {}
        props = schema.get('properties') or {}
        tools.append({
            'name': t['name'],                       # 完整 MCP tool 名（含 armory_ 前缀）
            'apiMethod': method,
            'apiPath': path,
            'apiName': (method + ' ' + path).strip(),
            'description': clean or (t.get('description') or '').strip(),
            'required': t.get('required') or [],
            'params': [{'name': k, 'type': (v or {}).get('type') or '',
                        'description': (v or {}).get('description') or ''}
                       for k, v in props.items()],
            'paramCount': len(props),
        })
    return {'ok': True, 'generatedAt': contract.get('generatedAt'),
            'gateway': MCP_GATEWAY_URL,
            'total': contract.get('armoryToolCount') or len(tools),
            'withApi': sum(1 for t in tools if t['apiPath']),
            'tools': tools}


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


@router.get('/scenarios/detail', summary='场景详情：该链路下全部测试用例（含 JSON-RPC 请求与断言）')
def scenario_detail(index: int = 0, name: str = '', _user: dict = Depends(require_user)):
    """把「场景」展开成一条条可执行的测试用例，供详情页展示。"""
    try:
        with open(MCP_SCENARIO_FILE, encoding='utf-8') as f:
            doc = json.load(f)
    except (OSError, ValueError):
        raise ApiError(404, '尚未生成场景用例，请先执行「生成场景链路」')
    scenarios = doc.get('scenarios') or []
    if not scenarios:
        raise ApiError(404, '尚未生成场景用例，请先执行「生成场景链路」')
    if name:
        hit = next((i for i, s in enumerate(scenarios)
                    if name == str(i) or name in (s.get('name') or '')), None)
        if hit is None:
            raise ApiError(404, '未找到该场景：%s' % name)
        index = hit
    if not 0 <= index < len(scenarios):
        raise ApiError(404, '场景序号超出范围（0 ~ %d）' % (len(scenarios) - 1))
    sc = scenarios[index]
    gateway = doc.get('gateway') or MCP_GATEWAY_URL
    cases = []
    for i, st in enumerate(sc.get('steps') or []):
        c = scenarios_runner._step_case(i, index, st, gateway, sc.get('name') or '')
        headers = [{'key': h.get('key'), 'value': ('***' if str(h.get('key', '')).lower() == 'authorization'
                                                   else h.get('value'))}
                   for h in c.get('headers') or []]
        cases.append({
            'seq': i + 1, 'name': c['name'], 'caseId': c['id'],
            'tool': st.get('tool') or '', 'desc': st.get('desc') or '',
            'args': st.get('args') or {}, 'extract': st.get('extract') or {},
            'method': c['method'], 'url': c['url'], 'headers': headers,
            'body': c['body'], 'asserts': c.get('_asserts') or [],
            'module': c['module'], 'tags': c['tags'],
        })
    return {'ok': True, 'gateway': gateway,
            'scenario': {'index': index, 'name': sc.get('name') or '',
                         'desc': sc.get('desc') or '', 'stepCount': len(cases)},
            'cases': cases}


@router.get('/runs', summary='MCP 运行记录（分页，默认每页 10 条）')
def recent_runs(page: int = 1, pageSize: int = 10, limit: int = 0,
                _user: dict = Depends(require_user)):
    from ...store import history_summary, load_history, sorted_batches
    rows = []
    try:
        for b in sorted_batches(load_history()):
            if str((b.get('source') or {}).get('type') or '').startswith('mcp'):
                rows.append(history_summary(b))
    except Exception:  # noqa: BLE001
        pass
    size = limit if limit > 0 else pageSize
    size = max(1, min(int(size or 10), 100))
    total = len(rows)
    pages = max(1, (total + size - 1) // size)
    cur = min(max(1, int(page or 1)), pages)
    start = (cur - 1) * size
    return {'ok': True, 'runs': rows[start:start + size], 'total': total,
            'page': cur, 'pages': pages, 'pageSize': size}


def _mcp_tool_of(name: str, body: str) -> str:
    """从 JSON-RPC 请求体或用例名中还原真实 MCP 工具名（如 armory_package_search）。"""
    try:
        doc = json.loads(body or '{}')
        tool = ((doc.get('params') or {}).get('name') or '').strip()
        if tool:
            return tool
    except (ValueError, AttributeError):
        pass
    m = re.match(r'\s*([A-Za-z][A-Za-z0-9_]*)', name or '')
    return m.group(1) if m else ''


@router.get('/report', summary='回归执行结果测试报告（按批次，含失败明细与用例结果）')
def run_report(batchId: str = '', _user: dict = Depends(require_user)):
    from ...store import history_summary, load_history, sorted_batches
    batches = sorted_batches(load_history())
    target = None
    if batchId:
        target = next((b for b in batches if b.get('batchId') == batchId), None)
    else:  # 不传批次则取最近一次 MCP 运行
        target = next((b for b in batches
                       if str((b.get('source') or {}).get('type') or '').startswith('mcp')), None)
    if not target:
        raise ApiError(404, '未找到运行批次：%s' % (batchId or '（暂无 MCP 运行记录）'))
    results = []
    for r in target.get('results') or []:
        req = r.get('request') or {}
        asserts = r.get('asserts') or []
        body = (req.get('body') or '')[:2000]
        results.append({
            'caseId': r.get('caseId'), 'name': r.get('name') or r.get('caseName') or '',
            'tool': _mcp_tool_of(r.get('name') or r.get('caseName') or '', body),
            'module': r.get('module') or '', 'passed': bool(r.get('passed')),
            'status': r.get('status'), 'durationMs': r.get('durationMs') or 0,
            'requestMs': r.get('requestMs'),
            'error': r.get('error') or '',
            'chain': r.get('chain'),
            'asserts': [{'type': a.get('type'), 'path': a.get('path'), 'op': a.get('op'),
                         'expected': a.get('value'), 'passed': bool(a.get('passed')),
                         'skipped': bool(a.get('skipped')), 'soft': bool(a.get('soft')),
                         'desc': a.get('desc') or '', 'message': a.get('message') or ''}
                        for a in asserts],
            'assertsPassed': sum(1 for a in asserts if a.get('passed')),
            'assertsTotal': len([a for a in asserts if not a.get('skipped')]),
            'request': {'method': req.get('method'), 'url': req.get('url'),
                        'headers': req.get('headers') or {}, 'body': (req.get('body') or '')[:2000]},
            'responseBody': (r.get('responseBody') or '')[:2000],
            'bodyTruncated': bool(r.get('bodyTruncated')) or len(r.get('responseBody') or '') > 2000,
        })
    s = history_summary(target)
    summary = {'batchId': s.get('batchId'), 'executedBy': s.get('executedBy'),
               'environment': s.get('environment'), 'startedAt': s.get('startedAt'),
               'durationMs': s.get('durationMs'), 'wallMs': s.get('wallMs'),
               'total': s.get('total'), 'passedCount': s.get('passedCount'),
               'failedCount': s.get('failedCount'),
               'passRate': round((s.get('passedCount') or 0) * 100.0 / s['total'], 2) if s.get('total') else 0,
               'source': s.get('source') or {},
               'toolCount': len({r['tool'] for r in results if r['tool']}),
               'scenarioCount': len({r['chain'] for r in results if r.get('chain') is not None})}
    return {'ok': True, 'summary': summary, 'results': results}


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
