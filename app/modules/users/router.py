# -*- coding: utf-8 -*-
"""用户中心模块：登录 / 注册 / 登出 / 改密 / 个人资料 / 用户管理 / 登录日志。"""
from typing import Any, Dict

from fastapi import APIRouter, Body, Depends, Request
from fastapi.responses import JSONResponse

from ... import security
from ...deps import (ApiError, clear_session_cookie, client_ip, current_user,
                    require_user, session_token, set_session_cookie, user_agent)

router = APIRouter(prefix='/api/auth', tags=['用户中心'])


@router.get('/me', summary='当前登录态（未登录不报错，authenticated=false）')
def me(request: Request):
    user = current_user(request)
    total = security.count_users()
    return {
        'ok': True,
        'authenticated': bool(user),
        'user': user,
        'userCount': total,
        'needSetup': total == 0,   # 首次使用：第一个注册的人成为管理员
        'roles': security.ROLE_LABELS,
    }


@router.post('/login', summary='登录')
def login(request: Request, body: Dict[str, Any] = Body(default_factory=dict)):
    ok, msg, user, token, ttl = security.login(
        body.get('username'), body.get('password'),
        client_ip(request), user_agent(request), bool(body.get('remember')))
    if not ok:
        raise ApiError(401, msg)
    resp = JSONResponse({'ok': True, 'message': msg, 'user': user})
    set_session_cookie(resp, token, ttl)
    return resp


@router.post('/register', summary='注册（首个账号自动成为管理员）')
def register(request: Request, body: Dict[str, Any] = Body(default_factory=dict)):
    ok, msg, user, token = security.register_and_login(
        body.get('username'), body.get('password'),
        body.get('displayName'), body.get('email'),
        client_ip(request), user_agent(request))
    if not ok:
        raise ApiError(400, msg)
    resp = JSONResponse({'ok': True, 'message': msg, 'user': user}, status_code=201)
    set_session_cookie(resp, token, security.SESSION_TTL)
    return resp


@router.post('/logout', summary='登出')
def logout(request: Request):
    security.revoke_session(session_token(request))
    resp = JSONResponse({'ok': True})
    clear_session_cookie(resp)
    return resp


@router.post('/password', summary='修改自己的密码')
def change_password(request: Request, body: Dict[str, Any] = Body(default_factory=dict),
                    user: dict = Depends(require_user)):
    ok, msg = security.change_password(user['id'], body.get('oldPassword'), body.get('newPassword'))
    if not ok:
        raise ApiError(400, msg)
    # 改密后其他设备上的会话全部失效，当前会话保留
    security.revoke_user_sessions(user['id'], keep_token=session_token(request))
    return {'ok': True, 'message': msg}


@router.post('/profile', summary='修改自己的资料')
def update_profile(body: Dict[str, Any] = Body(default_factory=dict),
                   user: dict = Depends(require_user)):
    ok, msg, updated = security.update_profile(user['id'], body.get('displayName'), body.get('email'))
    if not ok:
        raise ApiError(400, msg)
    return {'ok': True, 'message': msg, 'user': updated}


@router.get('/users', summary='用户列表（非管理员不返回邮箱与登录 IP）')
def list_users(user: dict = Depends(require_user)):
    can_manage = user['role'] == 'admin'
    users = security.list_users()
    if not can_manage:
        users = [{k: v for k, v in u.items() if k not in ('email', 'lastLoginIp')}
                 for u in users]
    return {'ok': True, 'users': users, 'canManage': can_manage,
            'total': len(users), 'roles': security.ROLE_LABELS, 'me': user}


@router.get('/logins', summary='最近登录日志（管理员）')
def recent_logins(user: dict = Depends(require_user)):
    if user['role'] != 'admin':
        raise ApiError(403, '无权限执行该操作', 'FORBIDDEN')
    return {'ok': True, 'logs': security.recent_logins(30)}


@router.post('/users/update', summary='修改用户角色 / 状态 / 资料（管理员）')
def admin_update(body: Dict[str, Any] = Body(default_factory=dict),
                 actor: dict = Depends(require_user)):
    if actor['role'] != 'admin':
        raise ApiError(403, '无权限执行该操作', 'FORBIDDEN')
    ok, msg, user = security.admin_update(
        actor, int(body.get('id') or 0),
        role=body.get('role'), status=body.get('status'),
        display_name=body.get('displayName'), email=body.get('email'))
    if not ok:
        raise ApiError(400, msg)
    return {'ok': True, 'message': msg, 'user': user}


@router.post('/users/reset-password', summary='重置用户密码（管理员）')
def admin_reset_password(body: Dict[str, Any] = Body(default_factory=dict),
                         actor: dict = Depends(require_user)):
    if actor['role'] != 'admin':
        raise ApiError(403, '无权限执行该操作', 'FORBIDDEN')
    ok, msg = security.admin_reset_password(actor, int(body.get('id') or 0), body.get('newPassword'))
    if not ok:
        raise ApiError(400, msg)
    return {'ok': True, 'message': msg}


@router.post('/users/delete', summary='删除用户（管理员）')
def admin_delete(body: Dict[str, Any] = Body(default_factory=dict),
                 actor: dict = Depends(require_user)):
    if actor['role'] != 'admin':
        raise ApiError(403, '无权限执行该操作', 'FORBIDDEN')
    ok, msg = security.admin_delete(actor, int(body.get('id') or 0))
    if not ok:
        raise ApiError(400, msg)
    return {'ok': True, 'message': msg}
