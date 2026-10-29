# -*- coding: utf-8 -*-
"""测试场景模块：场景的增删改查。

场景只存「用例 ID 列表 + 说明」，执行时复用测试用例模块的 /api/run。
"""
import random
import string
import time
from typing import Any, Dict

from fastapi import APIRouter, Body, Depends

from ...deps import ApiError, require_user
from ...store import load_scenarios, save_scenarios

router = APIRouter(prefix='/api/scenarios', tags=['测试场景'])


@router.get('', summary='场景列表')
def list_scenarios(_user: dict = Depends(require_user)):
    return load_scenarios()


@router.post('/save', summary='保存场景（有 id 为更新，无 id 为新建）')
def save_scenario(
    body: Dict[str, Any] = Body(default_factory=dict),
    _user: dict = Depends(require_user),
):
    sc = body.get('scenario') or {}
    s = load_scenarios()
    now = time.strftime('%Y-%m-%d %H:%M:%S')
    if sc.get('id'):
        for x in s['scenarios']:
            if x.get('id') == sc['id']:
                x.update({k: v for k, v in sc.items() if k != 'id'})
                x['updatedAt'] = now
                break
        else:
            sc['createdAt'] = now
            sc['updatedAt'] = now
            s['scenarios'].append(sc)
    else:
        sc['id'] = 'SC' + time.strftime('%Y%m%d%H%M%S') + '-' + ''.join(
            random.choices(string.ascii_lowercase + string.digits, k=3))
        sc['createdAt'] = now
        sc['updatedAt'] = now
        s['scenarios'].append(sc)
    save_scenarios(s)
    return {'ok': True, 'scenario': sc}


@router.post('/delete', summary='删除场景')
def delete_scenario(
    body: Dict[str, Any] = Body(default_factory=dict),
    _user: dict = Depends(require_user),
):
    sid = body.get('id')
    if not sid:
        raise ApiError(400, '缺少场景 id')
    s = load_scenarios()
    before = len(s['scenarios'])
    s['scenarios'] = [x for x in s['scenarios'] if x.get('id') != sid]
    if len(s['scenarios']) == before:
        raise ApiError(404, '场景不存在：%s' % sid)
    save_scenarios(s)
    return {'ok': True}
