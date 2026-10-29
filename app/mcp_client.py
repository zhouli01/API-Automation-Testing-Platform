# -*- coding: utf-8 -*-
"""MCP 网关客户端：JSON-RPC over HTTP（initialize / tools/list / tools/call）。"""
import json
import threading
import urllib.request

from .config import MCP_GATEWAY_AUTH, MCP_GATEWAY_URL, MCP_TIMEOUT_S

_id_lock = threading.Lock()
_next_id = [0]


def _rpc(method, params, timeout=None):
    with _id_lock:
        _next_id[0] += 1
        rid = _next_id[0]
    payload = json.dumps({'jsonrpc': '2.0', 'id': rid,
                          'method': method, 'params': params}).encode('utf-8')
    req = urllib.request.Request(
        MCP_GATEWAY_URL, data=payload, method='POST',
        headers={'Authorization': MCP_GATEWAY_AUTH,
                 'Content-Type': 'application/json',
                 'Accept': 'application/json, text/event-stream'})
    with urllib.request.urlopen(req, timeout=timeout or MCP_TIMEOUT_S) as resp:
        return json.loads(resp.read().decode('utf-8'))


def tools_list():
    """返回 (全部工具, armory 前缀工具)"""
    resp = _rpc('tools/list', {})
    if 'error' in resp:
        raise RuntimeError('tools/list 失败: %s' % resp['error'])
    tools = resp['result']['tools']
    return tools


def tools_call(name, arguments, timeout=None):
    """调用工具，返回 {ok, isError, text, error, raw}"""
    try:
        resp = _rpc('tools/call', {'name': name, 'arguments': arguments or {}}, timeout)
    except Exception as e:  # noqa: BLE001
        return {'ok': False, 'isError': True, 'text': '', 'error': f'{type(e).__name__}: {e}', 'raw': None}
    if 'error' in resp:
        err = resp['error']
        return {'ok': False, 'isError': True, 'text': err.get('message', ''),
                'error': 'JSON-RPC %s: %s' % (err.get('code'), err.get('message')), 'raw': resp}
    result = resp.get('result') or {}
    text = ''.join((c.get('text') or '') for c in (result.get('content') or [])
                   if isinstance(c, dict))
    return {'ok': not result.get('isError'), 'isError': bool(result.get('isError')),
            'text': text, 'error': None, 'raw': resp}
