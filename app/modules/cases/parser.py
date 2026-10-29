# -*- coding: utf-8 -*-
"""用例目录解析：Apifox 导出格式 + 平台通用 JSON 格式 -> 统一用例模型。

解析结果直接决定前端列表、执行与运行记录，逻辑与原 server.py 保持一致：
  · folder_stack 记录当前所处的文件夹层级，module 取最深一级文件夹名
  · 用户识别规则 userField：filename / infoName / folder / caseName
  · 用例 ID：Apifox 用「相对路径::blockId」，通用格式用「相对路径::序号」
  · 测试用例ID（caseNo）：优先取 metaInfo.httpApiCaseId，缺省由 scan_case_dir 从 1 补号
"""
import json
import os
import time
import urllib.parse

from ...config import CASE_DIR, USER_FIELD_LABELS
from ...store import load_meta

# 场景/执行都要读同一份解析结果，做 3 秒缓存避免每次请求全量扫盘
_CACHE = {'payload': None, 'mtime': 0.0}


def invalidate_cache():
    _CACHE['payload'] = None
    _CACHE['mtime'] = 0.0


# ================================================================ 工具
def _strip_ext(filename):
    name = os.path.basename(filename)
    for suffix in ('.apifox-cli.json', '.apifox.json', '.json'):
        if name.lower().endswith(suffix):
            return name[: -len(suffix)]
    return os.path.splitext(name)[0]


def _clean_items(pairs):
    """Apifox 的 header/query 是 [{key,value,disabled}] 结构 -> [(key,value)]"""
    out = []
    for p in pairs or []:
        if not isinstance(p, dict):
            continue
        if p.get('disabled'):
            continue
        k = p.get('key')
        if k is None or k == '':
            continue
        out.append((str(k), '' if p.get('value') is None else str(p.get('value'))))
    return out


def _build_url(req):
    """Apifox: url.host=[10,12,7,250] url.path=[api,armory,v1,packages]
    -> http://10.12.7.250/api/armory/v1/packages"""
    u = req.get('url') or {}
    protocol = (u.get('protocol') or 'http').strip()
    host = u.get('host') or []
    path = u.get('path') or []
    if isinstance(host, str):
        host = [host]
    if isinstance(path, str):
        path = [p for p in path.split('/') if p != '']
    if host:
        base = f"{protocol}://{'.'.join(str(h) for h in host)}"
    else:
        base = (req.get('baseUrl') or '').rstrip('/')
    seg = '/'.join(str(p) for p in path)
    if base:
        return base + ('/' + seg if seg else '')
    return '' if not seg else '/' + seg


def _build_body(req):
    """返回 (body_str, content_type)"""
    body = req.get('body')
    if body in (None, '', {}) or (isinstance(body, list) and not body):
        return None, None
    if isinstance(body, str):
        return body, None
    if not isinstance(body, dict):
        return json.dumps(body, ensure_ascii=False), 'application/json'

    btype = str(body.get('type') or '').lower()
    ctype_map = {
        'json': 'application/json', 'xml': 'application/xml', 'html': 'text/html',
        'text': 'text/plain', 'javascript': 'application/javascript', 'raw': 'text/plain',
    }
    if btype in ctype_map or 'raw' in body:
        raw = body.get('raw')
        if raw is None:
            raw = body.get('content')
        if raw is None:
            raw = body.get('text')
        if raw is None:
            return None, None
        return str(raw), ctype_map.get(btype, 'text/plain')
    if btype in ('urlencoded', 'form'):
        params = body.get('parameters') or body.get('formData') or []
        return urllib.parse.urlencode(_clean_items(params)), 'application/x-www-form-urlencoded'
    if btype in ('form-data', 'formdata'):
        return None, None  # 暂不支持 multipart
    if btype == 'graphql':
        return json.dumps({'query': body.get('query'), 'variables': body.get('variables') or {}},
                          ensure_ascii=False), 'application/json'
    # 直接就是 JSON 主体：parameters 列表转对象
    params = body.get('parameters')
    if params and isinstance(params, list):
        try:
            return json.dumps({p.get('key'): p.get('value') for p in params if not p.get('disabled')},
                              ensure_ascii=False), 'application/json'
        except Exception:  # noqa: BLE001
            pass
    return json.dumps(body, ensure_ascii=False), 'application/json'


# ================================================================ Apifox
def _parse_apifox(doc, filename, user_field):
    """解析 Apifox CLI 导出文档 -> (用例列表, 文件名基名)"""
    info_name = ((doc.get('info') or {}).get('name') or '').strip()
    file_base = _strip_ext(filename)
    cases = []
    folder_stack = []

    def resolve_user(case_name, folder_path):
        if user_field == 'filename':
            return file_base
        if user_field == 'folder':
            return folder_path[-1] if folder_path else (info_name or file_base)
        if user_field == 'caseName':
            return case_name or info_name or file_base
        return info_name or file_base  # infoName 默认

    def walk(items):
        for it in items or []:
            if not isinstance(it, dict):
                continue
            children = it.get('item')
            if isinstance(children, list) and children:
                folder_stack.append(str(it.get('name') or ''))
                walk(children)
                folder_stack.pop()
                continue
            req = it.get('request') or {}
            if not isinstance(req, dict) or not req:
                continue
            case_name = str(it.get('name') or '').strip()
            meta_info = it.get('metaInfo') or {}
            rd = it.get('responseDefinition') or {}
            url = _build_url(req)
            query = _clean_items((req.get('url') or {}).get('query'))
            headers = _clean_items(req.get('header'))
            body, body_ctype = _build_body(req)
            cid = f"{filename}::{meta_info.get('blockId') or meta_info.get('id') or len(cases)}"
            cases.append({
                'id': cid,
                'caseNo': ('' if meta_info.get('httpApiCaseId') in (None, '')
                           else str(meta_info.get('httpApiCaseId'))),
                'apiName': str(meta_info.get('httpApiName') or '').strip(),
                'apiPath': str(meta_info.get('httpApiPath') or '').strip(),
                'file': filename,
                'user': resolve_user(case_name, folder_stack),
                'module': folder_stack[-1] if folder_stack else (info_name or file_base),
                'folder': '/'.join(folder_stack),
                'name': case_name,
                'method': str(req.get('method') or 'GET').upper(),
                'url': url,
                'baseUrl': req.get('baseUrl') or '',
                'query': [{'key': k, 'value': v} for k, v in query],
                'headers': [{'key': k, 'value': v} for k, v in headers],
                'body': body,
                'contentType': body_ctype,
                'expectCode': rd.get('code'),
                'expectName': rd.get('name') or '',
                'tags': meta_info.get('tags') or [],
                'description': (it.get('description') or '') if isinstance(it.get('description'), str) else '',
            })

    walk(doc.get('item') or [])
    return cases, file_base


# ================================================================ 通用格式
def _parse_generic(doc, filename, user_field):
    """兼容非 Apifox 的通用 JSON：数组 / {cases:[..]} / {testCases:[..]} 等"""
    raw = None
    if isinstance(doc, list):
        raw = doc
    elif isinstance(doc, dict):
        for key in ('cases', 'testCases', 'testcases', 'items', 'list'):
            if isinstance(doc.get(key), list):
                raw = doc[key]
                break
    if not raw:
        return [], _strip_ext(filename)

    file_base = _strip_ext(filename)
    cases = []
    for i, c in enumerate(raw):
        if not isinstance(c, dict):
            continue
        name = str(c.get('name') or c.get('title') or f'用例{i + 1}')
        if user_field == 'caseName':
            user = name
        else:
            user = str(c.get('user') or c.get('username') or c.get('userName') or file_base)
        req = c.get('request') if isinstance(c.get('request'), dict) else c
        url = str(req.get('url') or req.get('path') or '')
        headers = req.get('headers') or req.get('header') or {}
        if isinstance(headers, list):
            headers = dict(_clean_items(headers))
        query = req.get('query') or req.get('params') or {}
        if isinstance(query, list):
            query = dict(_clean_items(query))
        body = req.get('body')
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        expect = req.get('expect') or c.get('expect') or {}
        # 自定义断言列表（MCP / JSON-RPC 等场景）：[{type,path,op,value,desc,soft,skipIfMissing}]
        custom_asserts = expect.get('asserts') if isinstance(expect, dict) else None
        cases.append({
            'id': f"{filename}::{i}",
            'caseNo': str(c.get('caseNo') or c.get('caseId') or '').strip(),
            'apiName': str(c.get('apiName') or c.get('interface') or '').strip(),
            'apiPath': str(c.get('apiPath') or '').strip(),
            'file': filename,
            'user': user,
            'module': str(c.get('module') or c.get('folder') or file_base),
            'folder': str(c.get('module') or ''),
            'name': name,
            'method': str(req.get('method') or 'GET').upper(),
            'url': url,
            'baseUrl': str(req.get('baseUrl') or ''),
            'query': [{'key': k, 'value': '' if v is None else str(v)} for k, v in (query or {}).items()],
            'headers': [{'key': k, 'value': '' if v is None else str(v)} for k, v in (headers or {}).items()],
            'body': body,
            'contentType': 'application/json' if body else None,
            'expectCode': expect.get('code') if isinstance(expect, dict) else None,
            'expectName': '',
            'tags': c.get('tags') or [],
            'description': str(c.get('description') or ''),
            '_asserts': custom_asserts if isinstance(custom_asserts, list) and custom_asserts else None,
        })
    return cases, file_base


# ================================================================ 扫描 / 组装
def scan_case_dir():
    """扫描用例目录，返回 (files, cases, warnings)"""
    warnings = []
    if not os.path.isdir(CASE_DIR):
        return [], [], [f'用例目录不存在：{CASE_DIR}']

    meta = load_meta()
    user_field = meta['settings'].get('userField', 'infoName')

    json_files = []
    for root, _dirs, files in os.walk(CASE_DIR):
        for fn in files:
            if fn.lower().endswith('.json'):
                json_files.append(os.path.join(root, fn))
    json_files.sort()

    file_infos = []
    all_cases = []
    for fp in json_files:
        rel = os.path.relpath(fp, CASE_DIR).replace('\\', '/')
        try:
            with open(fp, 'r', encoding='utf-8') as f:
                doc = json.load(f)
        except Exception as e:  # noqa: BLE001
            warnings.append(f'解析失败 {rel}：{type(e).__name__}: {e}')
            continue
        is_apifox = isinstance(doc, dict) and 'item' in doc and 'info' in doc
        cases, _base = (_parse_apifox(doc, rel, user_field) if is_apifox
                        else _parse_generic(doc, rel, user_field))
        for c in cases:
            c['fileFormat'] = 'apifox' if is_apifox else 'generic'
        all_cases.extend(cases)
        file_infos.append({
            'file': rel,
            'absPath': fp,
            'format': 'apifox' if is_apifox else 'generic',
            'caseCount': len(cases),
            'users': sorted({c['user'] for c in cases}),
            'mtime': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(os.path.getmtime(fp))),
            'size': os.path.getsize(fp),
        })

    # 测试用例ID 兜底：用例文件里没有 ID 的，统一从 1 开始计数
    seq = 0
    for c in all_cases:
        if not str(c.get('caseNo') or '').strip():
            seq += 1
            c['caseNo'] = str(seq)

    return file_infos, all_cases, warnings


def build_payload(force=False):
    """前端 /api/cases 的完整数据包（文件、用例、测试用户、标签、统计）"""
    now = time.time()
    if not force and _CACHE['payload'] and (now - _CACHE['mtime']) < 3:
        return _CACHE['payload']
    files, cases, warnings = scan_case_dir()
    meta = load_meta()
    settings = meta['settings']
    user_meta = meta.get('users', {})
    case_tags = meta.get('caseTags') or {}
    case_biz = meta.get('caseBiz') or {}
    # 用例级标签（用户在平台上编辑）覆盖用例文件里的原始 tags
    for c in cases:
        if c['id'] in case_tags:
            c['tags'] = list(case_tags[c['id']] or [])
    # 用例级「业务方向」：平台上有值则覆盖文件里的值
    for c in cases:
        v = case_biz.get(c['id'])
        if v is not None and str(v).strip() != '':
            c['bizDir'] = str(v).strip()

    user_names = sorted({c['user'] for c in cases})
    users = []
    for un in user_names:
        u = user_meta.get(un, {})
        ucases = [c for c in cases if c['user'] == un]
        users.append({
            'name': un,
            'caseCount': len(ucases),
            'files': sorted({c['file'] for c in ucases}),
            'modules': sorted({c['module'] for c in ucases}),
            'tags': u.get('tags') or [],
            'vars': u.get('vars') or {},
            'note': u.get('note') or '',
            'enabled': u.get('enabled', True),
        })
    all_tags = sorted({t for u in users for t in u['tags']})

    payload = {
        'caseDir': CASE_DIR,
        'caseDirExists': os.path.isdir(CASE_DIR),
        'settings': settings,
        'userFieldLabels': USER_FIELD_LABELS,
        'files': files,
        'users': users,
        'allTags': all_tags,
        'caseTags': case_tags,
        'cases': cases,
        'warnings': warnings,
        'stats': {
            'fileCount': len(files),
            'caseCount': len(cases),
            'userCount': len(users),
            'tagCount': len(all_tags),
        },
    }
    _CACHE['payload'] = payload
    _CACHE['mtime'] = time.time()
    return payload
