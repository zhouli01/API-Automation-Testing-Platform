# -*- coding: utf-8 -*-
"""用例执行引擎：变量替换 -> 发真实请求 -> 断言校验 -> 结构化结果。"""
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from ...store import origin

VAR_RE = re.compile(r'\{\{\s*([^}\s]+)\s*\}\}')
UNRESOLVED_RE = re.compile(r'\{\{.*?\}\}')


# ================================================================ 变量
def substitute(value, variables):
    if isinstance(value, str):
        return VAR_RE.sub(lambda m: str(variables.get(m.group(1), m.group(0))), value)
    if isinstance(value, dict):
        return {k: substitute(v, variables) for k, v in value.items()}
    if isinstance(value, list):
        return [substitute(v, variables) for v in value]
    return value


def resolve_vars(*layers):
    """按顺序叠加变量层，后者覆盖前者（空值不覆盖）"""
    out = {}
    for layer in layers:
        if isinstance(layer, dict):
            for k, v in layer.items():
                if v is None:
                    continue
                out[k] = v
    return out


# ================================================================ 断言
def _to_num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _cmp(actual, op, expected):
    if op == 'eq':
        a, e = _to_num(actual), _to_num(expected)
        if a is not None and e is not None:
            return a == e
        return str(actual) == str(expected)
    if op == 'ne':
        return not _cmp(actual, 'eq', expected)
    if op == 'contains':
        return str(expected) in str(actual)
    if op == 'notContains':
        return str(expected) not in str(actual)
    if op in ('gt', 'lt', 'ge', 'le'):
        a, e = _to_num(actual), _to_num(expected)
        if a is None or e is None:
            return False
        return {'gt': a > e, 'lt': a < e, 'ge': a >= e, 'le': a <= e}[op]
    if op == 'regex':
        try:
            return re.search(str(expected), str(actual)) is not None
        except re.error:
            return False
    if op == 'exists':
        return actual is not None
    if op == 'in':
        pool = expected if isinstance(expected, (list, tuple)) else [expected]
        return any(_cmp(actual, 'eq', item) for item in pool)
    if op == 'notIn':
        return not _cmp(actual, 'in', expected)
    return False


def json_path(obj, path):
    """支持路径别名：code|status 表示先取 code，取不到再取 status"""
    if not path:
        return obj
    cur = obj
    for part in str(path).split('.'):
        if cur is None:
            return None
        alts = [p for p in part.split('|') if p != '']
        if isinstance(cur, list):
            nxt = None
            for a in alts:
                try:
                    nxt = cur[int(a)]
                    break
                except (ValueError, IndexError):
                    continue
            cur = nxt
        elif isinstance(cur, dict):
            nxt = None
            for a in alts:
                if a in cur:
                    nxt = cur[a]
                    break
            cur = nxt
        else:
            return None
    return cur


def build_asserts(case, settings):
    """由用例声明 + 平台设置生成默认断言"""
    asserts = []
    if settings.get('checkHttp', True):
        asserts.append({
            'type': 'status', 'op': 'in',
            'value': settings.get('expectHttp') or [200, 201, 202, 204],
            'desc': f"HTTP 状态码 ∈ {settings.get('expectHttp') or [200, 201, 202, 204]}",
            'soft': False,
        })
    code = case.get('expectCode')
    if settings.get('checkBiz', True) and code:
        suffix = '（' + str(case.get('expectName')) + '）' if case.get('expectName') else ''
        asserts.append({
            'type': 'json', 'path': settings.get('bizCodeField') or 'status|code',
            'op': 'eq', 'value': code,
            'desc': '业务码 = ' + str(code) + suffix,
            'soft': False, 'skipIfMissing': True,
        })
    return asserts


def run_asserts(asserts, status, body_text, duration_ms):
    results = []
    try:
        parsed = json.loads(body_text) if body_text else None
    except Exception:  # noqa: BLE001
        parsed = None

    for a in asserts or []:
        atype = a.get('type', 'status')
        op = a.get('op', 'eq')
        expected = a.get('value')
        if atype == 'status':
            actual = status
        elif atype == 'duration':
            actual = round(duration_ms)
        elif atype == 'json':
            actual = json_path(parsed, a.get('path')) if parsed is not None else None
        elif atype == 'body':
            actual = body_text
        else:
            actual = None

        skipped = False
        if actual is None and a.get('skipIfMissing'):
            passed = True
            skipped = True
        else:
            passed = _cmp(actual, op, expected)
        results.append({
            'type': atype,
            'path': a.get('path'),
            'op': op,
            'expected': expected,
            'actual': actual,
            'desc': a.get('desc') or f'{atype} {op} {expected}',
            'soft': bool(a.get('soft')),
            'skipIfMissing': bool(a.get('skipIfMissing')),
            'skipped': skipped,
            'passed': passed,
        })
    return results


# ================================================================ HTTP 代理
def do_request(method, url, headers, body, timeout_s):
    data = None
    if body not in (None, ''):
        data = body.encode('utf-8') if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, method=method.upper())
    for k, v in (headers or {}).items():
        if v is None or str(v) == '':
            continue
        try:
            req.add_header(k, str(v))
        except Exception:  # noqa: BLE001
            pass
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            raw = resp.read()
            status = resp.status
            resp_headers = list(resp.headers.items())
    except urllib.error.HTTPError as e:
        raw = e.read()
        status = e.code
        resp_headers = list(e.headers.items()) if e.headers else []
    except Exception as e:  # noqa: BLE001
        return {
            'status': None,
            'durationMs': round((time.time() - start) * 1000),
            'headers': [],
            'body': '',
            'error': f'{type(e).__name__}: {e}',
        }
    duration = round((time.time() - start) * 1000)
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        text = raw.decode('utf-8', errors='replace')
    return {'status': status, 'durationMs': duration, 'headers': resp_headers, 'body': text, 'error': None}


def build_final_url(case, base_url_override):
    """「环境地址覆盖」：保留原 path / query，只替换 scheme://host[:port]"""
    url = case.get('url') or ''
    if base_url_override:
        override = base_url_override.rstrip('/')
        if url.startswith('http://') or url.startswith('https://'):
            parsed = urllib.parse.urlsplit(url)
            path = parsed.path + (('?' + parsed.query) if parsed.query else '')
            url = override + path
        else:
            url = override + ('/' + url.lstrip('/') if url else '')
    return url


# ================================================================ 单条用例
def execute_case(case, settings, user_vars, global_vars, global_headers):
    t_case = time.time()   # 用例级总耗时起点（含变量替换、请求、断言）
    variables = resolve_vars(global_vars, user_vars, case.get('vars') or {})
    url = substitute(build_final_url(case, settings.get('baseUrlOverride')), variables)

    query_pairs = []
    for q in case.get('query') or []:
        k = substitute(str(q.get('key', '')), variables)
        v = substitute(str(q.get('value', '')), variables)
        query_pairs.append((k, v))
    if query_pairs:
        url += ('&' if '?' in url else '?') + urllib.parse.urlencode(query_pairs)

    headers = {}
    for k, v in (global_headers or {}).items():
        headers[str(k)] = substitute(str(v), variables)
    for h in case.get('headers') or []:
        k = substitute(str(h.get('key', '')), variables)
        v = substitute(str(h.get('value', '')), variables)
        if UNRESOLVED_RE.search(v) or UNRESOLVED_RE.search(k):
            continue  # 变量未定义则不发送该请求头（避免发送 "{{Cookie}}" 字面量）
        headers[k] = v

    body = substitute(case.get('body'), variables)
    if body:
        ctype = case.get('contentType')
        if ctype:
            headers.setdefault('Content-Type', ctype)
    else:
        body = None

    timeout_s = max(1.0, float(settings.get('timeoutMs') or 15000) / 1000)
    r = do_request(case.get('method', 'GET'), url, headers, body, timeout_s)
    raw_asserts = case.get('_asserts') or build_asserts(case, settings)
    asserts = run_asserts(raw_asserts, r['status'], r['body'], r['durationMs'])
    hard = [a for a in asserts if not a.get('soft') and not a.get('skipped')]
    passed = r['error'] is None and all(a['passed'] for a in hard)

    return {
        'caseId': case['id'],
        'name': case['name'],
        'caseName': case['name'],
        'interface': case.get('module') or case.get('folder') or '',
        'user': case['user'],
        'module': case['module'],
        'folder': case.get('folder') or '',
        'file': case['file'],
        'env': origin(url),
        'request': {
            'method': case.get('method'),
            'url': url,
            'caseUrl': case.get('url'),
            'baseUrl': case.get('baseUrl'),
            'headers': headers,
            'query': [{'key': k, 'value': v} for k, v in query_pairs],
            'body': body,
        },
        'status': r['status'],
        'durationMs': round((time.time() - t_case) * 1000),  # 用例总耗时（准备+请求+断言）
        'requestMs': r['durationMs'],                        # 纯接口请求耗时
        'responseHeaders': r['headers'],
        'responseBody': r['body'],
        'responseBytes': len((r['body'] or '').encode('utf-8')),
        'error': r['error'],
        'asserts': asserts,
        'passed': passed,
    }


def failed_result(case, err):
    """执行过程中抛出异常时的兜底结果（保证批次里每条用例都有记录）"""
    return {
        'caseId': case['id'], 'name': case['name'], 'caseName': case['name'],
        'interface': case.get('module') or case.get('folder') or '',
        'user': case['user'], 'module': case['module'],
        'folder': case.get('folder') or '', 'file': case['file'],
        'env': origin(case.get('url') or ''),
        'request': {
            'method': case.get('method'), 'url': case.get('url'),
            'caseUrl': case.get('url'), 'baseUrl': case.get('baseUrl'),
            'headers': {}, 'query': case.get('query') or [], 'body': case.get('body'),
        },
        'status': None, 'durationMs': 0, 'requestMs': 0, 'responseHeaders': [], 'responseBody': '',
        'responseBytes': 0,
        'error': err, 'asserts': [], 'passed': False,
    }
