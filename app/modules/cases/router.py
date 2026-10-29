# -*- coding: utf-8 -*-
"""测试用例模块路由：列表 / 重新扫描 / 批量执行。"""
import sys
import threading
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends
from fastapi.responses import JSONResponse

from ...config import MAX_BODY_KEEP
from ...deps import ApiError, current_user, require_user
from ...store import append_history, load_meta, new_batch_id
from .parser import build_payload
from .runner import execute_case, failed_result, resolve_vars

router = APIRouter(prefix='/api', tags=['测试用例'])

# 执行会发起真实网络请求并读写记录文件，限制并发请求数，避免把自己压垮
_RUN_SLOTS = threading.BoundedSemaphore(4)


@router.get('/cases', summary='用例列表（文件 / 用例 / 测试用户 / 标签 / 统计）')
def list_cases(_user: dict = Depends(require_user)):
    return build_payload()


@router.post('/reload', summary='重新扫描用例目录')
def reload_cases(_user: dict = Depends(require_user)):
    return build_payload(force=True)


@router.post('/run', summary='执行选中的用例（可来自勾选或测试场景）')
def run_cases(
    payload: Dict[str, Any] = Body(default_factory=dict),
    user: Optional[dict] = Depends(current_user),
):
    data = build_payload()
    cases_by_id = {c['id']: c for c in data['cases']}
    meta = load_meta()

    settings = dict(meta['settings'])
    for k in ('baseUrlOverride', 'timeoutMs', 'concurrency', 'checkHttp', 'checkBiz',
              'bizCodeField', 'expectHttp', 'executedBy'):
        if payload.get(k) is not None:
            settings[k] = payload[k]

    # 执行人一律以登录账号为准，避免前端手填导致运行记录无法追溯
    if user:
        settings['executedBy'] = user['displayName'] or user['username']

    global_vars = resolve_vars(meta['settings'].get('globalVars') or {}, payload.get('globalVars') or {})
    global_headers = resolve_vars(meta['settings'].get('globalHeaders') or {},
                                  payload.get('globalHeaders') or payload.get('headers') or {})

    user_vars_map = {}
    for un, uv in (meta.get('users') or {}).items():
        user_vars_map[un] = uv.get('vars') or {}
    for un, uv in (payload.get('userVars') or {}).items():
        user_vars_map.setdefault(un, {})
        user_vars_map[un] = resolve_vars(user_vars_map[un], uv)

    if not _RUN_SLOTS.acquire(blocking=False):
        raise ApiError(429, '已有执行任务在进行中，请稍后再试', 'BUSY')

    selected_ids = payload.get('caseIds') or []
    selected = [cases_by_id[i] for i in selected_ids if i in cases_by_id]
    missing = [i for i in selected_ids if i not in cases_by_id]
    if not selected:
        _RUN_SLOTS.release()
        raise ApiError(400, '没有可执行的用例（未选中或用例已被移除）', missing=missing, results=[])

    try:
        return _do_run(payload, settings, selected, missing, user_vars_map,
                       global_vars, global_headers)
    finally:
        _RUN_SLOTS.release()


def _do_run(payload, settings, selected, missing, user_vars_map, global_vars, global_headers):
    t0 = time.time()
    started_at = time.strftime('%Y-%m-%d %H:%M:%S')
    started_ms = int(time.time() * 1000)
    results: List[Any] = [None] * len(selected)
    workers = max(1, min(8, int(settings.get('concurrency') or 1)))

    def work(idx_case):
        idx, case = idx_case
        uv = user_vars_map.get(case['user'], {})
        try:
            return idx, execute_case(case, settings, uv, global_vars, global_headers)
        except Exception as e:  # noqa: BLE001
            return idx, failed_result(case, f'{type(e).__name__}: {e}')

    if workers == 1:
        for i, c in enumerate(selected):
            _, r = work((i, c))
            results[i] = r
    else:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=workers) as ex:
            for idx, r in ex.map(work, list(enumerate(selected))):
                results[idx] = r

    passed = sum(1 for r in results if r and r['passed'])
    wall_ms = round((time.time() - t0) * 1000)                            # 真实经过时间
    duration_ms = sum((r or {}).get('durationMs') or 0 for r in results)   # 本批次用例耗时合计

    # 测试环境：优先取「环境地址覆盖」设置，否则汇总本次实际请求的目标域
    base_override = (settings.get('baseUrlOverride') or '').rstrip('/')
    envs = sorted({(r or {}).get('env') for r in results if (r or {}).get('env')})
    environment = base_override or (' + '.join(envs) if envs else '-')

    batch = {
        'batchId': new_batch_id(),
        'executedBy': settings.get('executedBy') or 'tester',
        'environment': environment,
        'startedAt': started_at,
        'startedAtMs': started_ms,
        'durationMs': duration_ms,
        'wallMs': wall_ms,
        'total': len(results),
        'passedCount': passed,
        'failedCount': len(results) - passed,
        'source': payload.get('source') or {'type': 'cases', 'name': '手动勾选'},
        'caseIds': [r['caseId'] for r in results if r],
        'results': [
            dict(r,
                 responseBody=(r.get('responseBody') or '')[:MAX_BODY_KEEP],
                 bodyTruncated=len(r.get('responseBody') or '') > MAX_BODY_KEEP)
            for r in results if r],
    }
    if payload.get('record', True):
        try:
            append_history(batch)
        except Exception as e:  # noqa: BLE001
            sys.stderr.write('[warn] 写入运行记录失败: %s\n' % e)

    return JSONResponse({
        'ok': True,
        'batchId': batch['batchId'],
        'executedBy': batch['executedBy'],
        'startedAt': started_at,
        'durationMs': duration_ms,
        'wallMs': wall_ms,
        'total': len(results),
        'passedCount': passed,
        'failedCount': len(results) - passed,
        'missing': missing,
        'results': results,
    })
