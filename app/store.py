# -*- coding: utf-8 -*-
"""数据持久化：平台元数据 / 运行记录 / 测试场景。

store 层只负责「读盘 -> 结构补全 -> 写盘」，不含业务判断；
旧的 ThreadingHTTPServer 版本会用到的同名工具函数也在这里集中提供。
"""
import json
import os
import random
import string
import sys
import threading
import time

from .config import (DATA_DIR, DEFAULT_SETTINGS, HISTORY_PATH, META_PATH,
                     SCENARIO_PATH)

# 进程内写锁：FastAPI 多线程处理请求，避免 JSON 文件并发写坏
_LOCK = threading.RLock()


def _read_json(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:  # noqa: BLE001 损坏文件不应阻断服务
        return default


def _write_json(path, obj, indent=1):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=indent)
    os.replace(tmp, path)


# ================================================================ 平台元数据
def load_meta():
    meta = _read_json(META_PATH, {})
    if not isinstance(meta, dict):
        meta = {}
    meta.setdefault('settings', {})
    meta.setdefault('users', {})
    meta.setdefault('caseTags', {})
    # 用例级「业务方向」：{caseId: '业务方向文本'}（在平台上编辑，覆盖用例文件里的值）
    meta.setdefault('caseBiz', {})
    for k, v in DEFAULT_SETTINGS.items():
        meta['settings'].setdefault(k, v)
    return meta


def save_meta(meta):
    _write_json(META_PATH, meta, indent=2)


# ================================================================ 运行记录
def load_history():
    h = _read_json(HISTORY_PATH, {})
    if not isinstance(h, dict):
        h = {}
    h.setdefault('batches', [])
    # 一次性迁移：批次 durationMs 语义统一为「本批次用例耗时合计」
    # （旧记录里它是从开始到结束的真实经过时间，并发执行时会偏小）
    if not h.get('_durationMigrated'):
        changed = False
        for b in h['batches']:
            rs = b.get('results') or []
            if not rs:
                continue
            total = sum((r or {}).get('durationMs') or 0 for r in rs)
            if 'wallMs' not in b:
                b['wallMs'] = b.get('durationMs')
            if b.get('durationMs') != total:
                b['durationMs'] = total
                changed = True
        h['_durationMigrated'] = True
        if changed:
            try:
                save_history(h)
            except Exception as e:  # noqa: BLE001
                sys.stderr.write('[warn] 耗时迁移写回失败: %s\n' % e)
    return h


def save_history(h):
    _write_json(HISTORY_PATH, h, indent=1)


def new_batch_id():
    return time.strftime('%Y%m%d-%H%M%S') + '-' + ''.join(
        random.choices(string.ascii_lowercase + string.digits, k=4))


def append_history(batch):
    with _LOCK:
        h = load_history()
        h['batches'].insert(0, batch)          # 新批次置顶（时间倒序）
        max_keep = 200
        try:
            max_keep = int(load_meta()['settings'].get('maxHistory') or 200)
        except Exception:  # noqa: BLE001
            pass
        if len(h['batches']) > max_keep:
            h['batches'] = h['batches'][:max_keep]
        save_history(h)


def sorted_batches(h):
    """按时间戳倒序（运行记录列表 / 导出共用）"""
    return sorted(h['batches'], key=lambda b: b.get('startedAtMs') or 0, reverse=True)


def history_summary(b):
    """去掉大字段，用于列表展示"""
    env = b.get('environment')
    if not env:
        # 兼容旧记录：从实际请求地址推断测试环境
        envs = []
        for r in (b.get('results') or []):
            o = origin(((r.get('request') or {}).get('url')) or '')
            if o and o not in envs:
                envs.append(o)
        env = ' + '.join(envs)
    return {
        'batchId': b.get('batchId'),
        'executedBy': b.get('executedBy'),
        'environment': env or '',
        'startedAt': b.get('startedAt'),
        'startedAtMs': b.get('startedAtMs'),
        'durationMs': b.get('durationMs'),
        'wallMs': b.get('wallMs'),
        'total': b.get('total'),
        'passedCount': b.get('passedCount'),
        'failedCount': b.get('failedCount'),
        'source': b.get('source') or {},
        'caseNames': [r.get('name') for r in (b.get('results') or [])][:8],
    }


def origin(url):
    """取 URL 的 scheme://host[:port]，作为「测试环境」标识"""
    import urllib.parse
    try:
        p = urllib.parse.urlsplit(url or '')
        if not p.scheme or not p.netloc:
            return ''
        return f'{p.scheme}://{p.netloc}'
    except Exception:  # noqa: BLE001
        return ''


# ================================================================ 测试场景
def load_scenarios():
    s = _read_json(SCENARIO_PATH, {})
    if not isinstance(s, dict):
        s = {}
    s.setdefault('scenarios', [])
    return s


def save_scenarios(s):
    _write_json(SCENARIO_PATH, s, indent=1)
