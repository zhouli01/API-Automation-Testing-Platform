# -*- coding: utf-8 -*-
"""运行记录模块：批次列表 / 详情 / 导出数据 / 删除 / 清空。"""
import time
from typing import Any, Dict

from fastapi import APIRouter, Body, Depends, Query

from ...config import CASE_DIR
from ...deps import ApiError, require_user
from ...store import history_summary, load_history, save_history, sorted_batches

router = APIRouter(prefix='/api/history', tags=['运行记录'])


def _stats(batches):
    total_cases = sum(b.get('total') or 0 for b in batches)
    total_pass = sum(b.get('passedCount') or 0 for b in batches)
    return {
        'batchCount': len(batches),
        'caseCount': total_cases,
        'passedCount': total_pass,
        'failedCount': total_cases - total_pass,
    }


@router.get('', summary='批次列表（已去掉响应体等大字段）')
def list_history(_user: dict = Depends(require_user)):
    batches = sorted_batches(load_history())
    return {'batches': [history_summary(b) for b in batches], 'stats': _stats(batches)}


@router.get('/export', summary='导出全量批次数据（?limit=N 限制条数，0 或缺省=全部）')
def export_history(limit: int = Query(0, ge=0), _user: dict = Depends(require_user)):
    batches = sorted_batches(load_history())
    if limit > 0:
        batches = batches[:limit]
    return {
        'ok': True,
        'generatedAt': time.strftime('%Y-%m-%d %H:%M:%S'),
        'caseDir': CASE_DIR,
        'stats': _stats(batches),
        'batches': batches,
    }


@router.post('/detail', summary='单个批次详情')
def history_detail(
    body: Dict[str, Any] = Body(default_factory=dict),
    _user: dict = Depends(require_user),
):
    bid = body.get('batchId')
    for b in load_history()['batches']:
        if b.get('batchId') == bid:
            return {'ok': True, 'batch': b}
    raise ApiError(404, '批次不存在：%s' % bid)


@router.post('/delete', summary='删除批次')
def delete_batch(
    body: Dict[str, Any] = Body(default_factory=dict),
    _user: dict = Depends(require_user),
):
    bid = body.get('batchId')
    if not bid:
        raise ApiError(400, '缺少批次号')
    h = load_history()
    h['batches'] = [b for b in h['batches'] if b.get('batchId') != bid]
    save_history(h)
    return {'ok': True}


@router.post('/clear', summary='清空全部运行记录')
def clear_history(_user: dict = Depends(require_user)):
    save_history({'batches': []})
    return {'ok': True}
