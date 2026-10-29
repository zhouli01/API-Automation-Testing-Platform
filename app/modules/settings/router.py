# -*- coding: utf-8 -*-
"""系统设置模块：平台元数据（设置项 / 测试用户变量 / 用例标签 / 业务方向）读写。"""
from typing import Any, Dict

from fastapi import APIRouter, Body, Depends

from ...deps import require_user
from ...modules.cases.parser import invalidate_cache
from ...store import load_meta, save_meta

router = APIRouter(prefix='/api', tags=['系统设置'])


@router.get('/meta', summary='读取平台元数据')
def get_meta(_user: dict = Depends(require_user)):
    return load_meta()


@router.post('/meta', summary='保存平台元数据（设置项 / 测试用户 / 用例标签）')
def update_meta(
    body: Dict[str, Any] = Body(default_factory=dict),
    _user: dict = Depends(require_user),
):
    meta = load_meta()
    if isinstance(body.get('settings'), dict):
        for k, v in body['settings'].items():
            meta['settings'][k] = v
    if isinstance(body.get('users'), dict):
        for un, uv in body['users'].items():
            cur = meta['users'].get(un, {})
            if isinstance(uv, dict):
                cur.update(uv)
            meta['users'][un] = cur
    # 用例级标签：{caseId: [tag, ...]}
    if isinstance(body.get('caseTags'), dict):
        ct = meta.setdefault('caseTags', {})
        for cid, tgs in body['caseTags'].items():
            if isinstance(tgs, list):
                ct[cid] = [str(x).strip() for x in tgs if str(x).strip()]
            else:
                ct.pop(cid, None)
    if body.get('clearCaseTags'):
        meta['caseTags'] = {}
    save_meta(meta)
    invalidate_cache()   # 标签 / 业务方向会影响用例列表，清掉解析缓存
    return {'ok': True, 'meta': meta}
