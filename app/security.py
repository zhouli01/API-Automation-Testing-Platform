# -*- coding: utf-8 -*-
"""
用户中心 —— 平台自建账号体系

能力：
  1. 注册 / 登录：密码 PBKDF2-HMAC-SHA256（20 万次迭代 + 16 字节随机盐），不落明文
  2. 会话：随机令牌写入 HttpOnly Cookie，服务端只存令牌的 SHA-256 摘要，默认 7 天（勾选记住我 30 天）
  3. 用户管理：角色（admin/tester）、启用停用、重置密码、删除；首个注册用户自动成为管理员
  4. 安全：同账号同 IP 5 分钟内失败 5 次锁定 5 分钟；改密后其他会话自动失效；不能删除/停用最后一个管理员

存储：data/users.db（SQLite，无第三方依赖）
"""
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import time

# 保证数据库仍落在项目的 data/users.db（与旧版一致，无需迁移）
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, 'data', 'users.db')

SESSION_COOKIE = 'at_session'
SESSION_TTL = 7 * 24 * 3600          # 普通登录有效期
SESSION_TTL_REMEMBER = 30 * 24 * 3600  # 记住我
PBKDF2_ROUNDS = 200000

USERNAME_RE = re.compile(r'^[A-Za-z0-9_.\-]{3,32}$')
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')

ROLE_LABELS = {'admin': '管理员', 'tester': '测试人员'}
STATUS_LABELS = {'active': '正常', 'disabled': '已停用'}

MAX_FAILS = 5
FAIL_WINDOW = 300
LOCK_SECONDS = 300


# ================================================================ 基础设施
def _conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA foreign_keys=ON')
    return conn


def init_db():
    """建表 + 清理过期会话；服务启动时调用一次。"""
    with _conn() as conn:
        conn.executescript('''
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT    NOT NULL UNIQUE,
            display_name  TEXT    NOT NULL DEFAULT '',
            email         TEXT    NOT NULL DEFAULT '',
            password_hash TEXT    NOT NULL,
            salt          TEXT    NOT NULL,
            role          TEXT    NOT NULL DEFAULT 'tester',
            status        TEXT    NOT NULL DEFAULT 'active',
            created_at    INTEGER NOT NULL,
            last_login_at INTEGER NOT NULL DEFAULT 0,
            last_login_ip TEXT    NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT    PRIMARY KEY,
            user_id    INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            ip         TEXT    NOT NULL DEFAULT '',
            user_agent TEXT    NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS login_log (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT    NOT NULL,
            ip       TEXT    NOT NULL DEFAULT '',
            ok       INTEGER NOT NULL,
            reason   TEXT    NOT NULL DEFAULT '',
            at       INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_login_log     ON login_log(username, at);
        ''')
        conn.execute('DELETE FROM sessions WHERE expires_at <= ?', (int(time.time()),))
        conn.execute('DELETE FROM login_log WHERE at <= ?', (int(time.time()) - 30 * 86400,))
    return DB_PATH


# ================================================================ 密码
def _hash_password(password, salt_hex):
    return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'),
                               bytes.fromhex(salt_hex), PBKDF2_ROUNDS).hex()


def _token_hash(token):
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def _fmt(ts):
    return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(ts)) if ts else ''


def _public(row):
    return {
        'id': row['id'],
        'username': row['username'],
        'displayName': row['display_name'] or row['username'],
        'email': row['email'] or '',
        'role': row['role'],
        'roleLabel': ROLE_LABELS.get(row['role'], row['role']),
        'status': row['status'],
        'statusLabel': STATUS_LABELS.get(row['status'], row['status']),
        'createdAt': _fmt(row['created_at']),
        'lastLoginAt': _fmt(row['last_login_at']),
        'lastLoginIp': row['last_login_ip'] or '',
    }


def _get_user_row(conn, user_id):
    return conn.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()


# ================================================================ 校验
def validate_username(username):
    if not username:
        return False, '请输入用户名'
    if not USERNAME_RE.match(username):
        return False, '用户名需 3~32 位，仅支持字母、数字、下划线、点、短横线'
    return True, ''


def validate_password(password, username=''):
    """密码规则：只限制长度（6~128 位），不做任何复杂度要求。

    username 参数保留是为了兼容既有调用点，当前不参与校验。
    """
    if not password:
        return False, '请输入密码'
    if len(password) < 6:
        return False, '密码至少 6 位'
    if len(password) > 128:
        return False, '密码过长（最多 128 位）'
    return True, ''


# ================================================================ 限流
def _recent_failures(conn, username, ip):
    since = int(time.time()) - FAIL_WINDOW
    row = conn.execute(
        'SELECT COUNT(*) AS c FROM login_log WHERE username = ? AND ip = ? AND ok = 0 AND at > ?',
        (username.lower(), ip or '', since)).fetchone()
    return row['c'] if row else 0


def _lock_remain(conn, username, ip):
    since = int(time.time()) - FAIL_WINDOW
    row = conn.execute(
        'SELECT MAX(at) AS t FROM login_log WHERE username = ? AND ip = ? AND ok = 0 AND at > ?',
        (username.lower(), ip or '', since)).fetchone()
    if not row or not row['t']:
        return 0
    if _recent_failures(conn, username, ip) < MAX_FAILS:
        return 0
    remain = int(row['t'] + LOCK_SECONDS - time.time())
    return remain if remain > 0 else 0


def _log(conn, username, ip, ok, reason=''):
    conn.execute('INSERT INTO login_log (username, ip, ok, reason, at) VALUES (?,?,?,?,?)',
                 (username.lower(), ip or '', 1 if ok else 0, reason, int(time.time())))


# ================================================================ 会话
def session_ttl(remember=False):
    return SESSION_TTL_REMEMBER if remember else SESSION_TTL


def _create_session(conn, user_id, ip, user_agent, ttl):
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    conn.execute(
        'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) '
        'VALUES (?,?,?,?,?,?)',
        (_token_hash(token), user_id, now, now + ttl, ip or '', (user_agent or '')[:300]))
    return token


def get_session_user(token):
    """令牌 → 用户信息；无效/过期/已停用返回 None。剩余有效期不足一半时自动续期。"""
    if not token:
        return None
    now = int(time.time())
    with _conn() as conn:
        row = conn.execute(
            'SELECT s.expires_at, s.created_at, u.* FROM sessions s '
            'JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
            (_token_hash(token),)).fetchone()
        if not row:
            return None
        if row['expires_at'] <= now:
            conn.execute('DELETE FROM sessions WHERE token_hash = ?', (_token_hash(token),))
            return None
        if row['status'] != 'active':
            return None
        lifetime = row['expires_at'] - row['created_at']
        if row['expires_at'] - now < lifetime // 2:
            conn.execute('UPDATE sessions SET expires_at = ? WHERE token_hash = ?',
                         (now + lifetime, _token_hash(token)))
        return _public(row)


def revoke_session(token):
    if not token:
        return
    with _conn() as conn:
        conn.execute('DELETE FROM sessions WHERE token_hash = ?', (_token_hash(token),))


def revoke_user_sessions(user_id, keep_token=''):
    with _conn() as conn:
        if keep_token:
            conn.execute('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?',
                         (user_id, _token_hash(keep_token)))
        else:
            conn.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,))


# ================================================================ 注册 / 登录
def count_users():
    with _conn() as conn:
        row = conn.execute('SELECT COUNT(*) AS c FROM users').fetchone()
    return row['c'] if row else 0


def is_first_user():
    return count_users() == 0


def register_and_login(username, password, display_name='', email='', ip='', user_agent=''):
    """注册并直接登录。首个用户自动获得管理员角色。

    返回 (ok, msg, user, token)
    """
    username = (username or '').strip()
    display_name = (display_name or '').strip() or username
    email = (email or '').strip()

    ok, msg = validate_username(username)
    if not ok:
        return False, msg, None, None
    ok, msg = validate_password(password, username)
    if not ok:
        return False, msg, None, None
    if email and not EMAIL_RE.match(email):
        return False, '邮箱格式不正确', None, None
    if len(display_name) > 32:
        return False, '显示名最多 32 个字符', None, None

    salt = secrets.token_hex(16)
    pwd_hash = _hash_password(password, salt)
    now = int(time.time())

    with _conn() as conn:
        exists = conn.execute('SELECT id FROM users WHERE username = ?',
                              (username.lower(),)).fetchone()
        if exists:
            return False, '该用户名已被注册', None, None
        first = conn.execute('SELECT COUNT(*) AS c FROM users').fetchone()['c'] == 0
        role = 'admin' if first else 'tester'
        try:
            cur = conn.execute(
                'INSERT INTO users (username, display_name, email, password_hash, salt, role, '
                'status, created_at, last_login_at, last_login_ip) VALUES (?,?,?,?,?,?,?,?,?,?)',
                (username.lower(), display_name, email, pwd_hash, salt, role,
                 'active', now, now, ip or ''))
        except sqlite3.IntegrityError:
            return False, '该用户名已被注册', None, None
        user_id = cur.lastrowid
        token = _create_session(conn, user_id, ip, user_agent, SESSION_TTL)
        _log(conn, username, ip, True, 'register')
        row = _get_user_row(conn, user_id)

    msg = '注册成功，已获得管理员权限' if row['role'] == 'admin' else '注册成功'
    return True, msg, _public(row), token


def login(username, password, ip='', user_agent='', remember=False):
    """校验账号密码并签发会话。返回 (ok, msg, user, token, ttl)"""
    username = (username or '').strip().lower()
    password = password or ''
    if not username or not password:
        return False, '请输入用户名和密码', None, None, 0

    with _conn() as conn:
        remain = _lock_remain(conn, username, ip)
        if remain > 0:
            return (False, '登录失败次数过多，请 %d 分钟后再试' % max(1, remain // 60 + 1),
                    None, None, 0)
        row = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
        if not row:
            _log(conn, username, ip, False, 'no such user')
            return False, '用户名或密码错误', None, None, 0
        if row['status'] != 'active':
            _log(conn, username, ip, False, 'disabled')
            return False, '该账号已被停用，请联系管理员', None, None, 0
        if not hmac.compare_digest(_hash_password(password, row['salt']), row['password_hash']):
            _log(conn, username, ip, False, 'bad password')
            left = MAX_FAILS - _recent_failures(conn, username, ip)
            msg = '用户名或密码错误'
            if left <= 0:
                # 已达失败上限：明确告知已进入锁定期，避免用户继续盲试
                msg += '，已连续失败 %d 次，%d 分钟内无法再登录' % (MAX_FAILS, max(1, LOCK_SECONDS // 60))
            elif left <= 2:
                msg += '，再失败 %d 次将临时锁定' % left
            return False, msg, None, None, 0

        ttl = session_ttl(remember)
        conn.execute('UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE id = ?',
                     (int(time.time()), ip or '', row['id']))
        token = _create_session(conn, row['id'], ip, user_agent, ttl)
        _log(conn, username, ip, True, 'login')
        conn.execute('DELETE FROM login_log WHERE ok = 0 AND username = ?', (username,))
        row = _get_user_row(conn, row['id'])

    return True, '登录成功', _public(row), token, ttl


# ================================================================ 用户管理
def list_users():
    with _conn() as conn:
        rows = conn.execute('SELECT * FROM users ORDER BY id ASC').fetchall()
    return [_public(r) for r in rows]


def change_password(user_id, old_password, new_password):
    with _conn() as conn:
        row = _get_user_row(conn, user_id)
        if not row:
            return False, '用户不存在'
        if not hmac.compare_digest(_hash_password(old_password or '', row['salt']),
                                   row['password_hash']):
            return False, '原密码不正确'
        ok, msg = validate_password(new_password, row['username'])
        if not ok:
            return False, msg
        if hmac.compare_digest(new_password, old_password or ''):
            return False, '新密码不能与原密码相同'
        salt = secrets.token_hex(16)
        conn.execute('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?',
                     (_hash_password(new_password, salt), salt, user_id))
    return True, '密码已修改'


def update_profile(user_id, display_name=None, email=None):
    with _conn() as conn:
        row = _get_user_row(conn, user_id)
        if not row:
            return False, '用户不存在', None
        dn = row['display_name'] if display_name is None else str(display_name).strip()
        em = row['email'] if email is None else str(email).strip()
        if not dn:
            return False, '显示名不能为空', None
        if len(dn) > 32:
            return False, '显示名最多 32 个字符', None
        if em and not EMAIL_RE.match(em):
            return False, '邮箱格式不正确', None
        conn.execute('UPDATE users SET display_name = ?, email = ? WHERE id = ?', (dn, em, user_id))
        row = _get_user_row(conn, user_id)
    return True, '资料已更新', _public(row)


def _admin_count(conn):
    return conn.execute("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND status = 'active'"
                        ).fetchone()['c']


def admin_update(actor, user_id, role=None, status=None, display_name=None, email=None):
    """管理员修改他人：角色 / 状态 / 显示名 / 邮箱。"""
    if not actor or actor.get('role') != 'admin':
        return False, '需要管理员权限', None
    with _conn() as conn:
        row = _get_user_row(conn, user_id)
        if not row:
            return False, '用户不存在', None
        if role and role not in ROLE_LABELS:
            return False, '角色不合法', None
        if status and status not in STATUS_LABELS:
            return False, '状态不合法', None
        if user_id == actor['id'] and role and role != 'admin':
            return False, '不能取消自己的管理员权限', None
        if user_id == actor['id'] and status == 'disabled':
            return False, '不能停用自己的账号', None
        if role == 'tester' and row['role'] == 'admin' and _admin_count(conn) <= 1:
            return False, '系统至少需要保留一个可用管理员', None
        if status == 'disabled' and row['role'] == 'admin' and _admin_count(conn) <= 1:
            return False, '系统至少需要保留一个可用管理员', None

        dn = row['display_name'] if display_name is None else str(display_name).strip()
        em = row['email'] if email is None else str(email).strip()
        if em and not EMAIL_RE.match(em):
            return False, '邮箱格式不正确', None
        conn.execute(
            'UPDATE users SET role = ?, status = ?, display_name = ?, email = ? WHERE id = ?',
            (role or row['role'], status or row['status'], dn or row['username'], em, user_id))
        if status == 'disabled':
            conn.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,))
        row = _get_user_row(conn, user_id)
    return True, '已保存', _public(row)


def admin_reset_password(actor, user_id, new_password):
    if not actor or actor.get('role') != 'admin':
        return False, '需要管理员权限'
    with _conn() as conn:
        row = _get_user_row(conn, user_id)
        if not row:
            return False, '用户不存在'
        ok, msg = validate_password(new_password, row['username'])
        if not ok:
            return False, msg
        salt = secrets.token_hex(16)
        conn.execute('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?',
                     (_hash_password(new_password, salt), salt, user_id))
        conn.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,))
        # 清掉该账号的历史失败记录，避免重置密码后仍被登录锁定挡住
        conn.execute('DELETE FROM login_log WHERE ok = 0 AND username = ?', (row['username'],))
    return True, '密码已重置，该用户需重新登录'


def admin_delete(actor, user_id):
    if not actor or actor.get('role') != 'admin':
        return False, '需要管理员权限'
    if user_id == actor['id']:
        return False, '不能删除自己的账号'
    with _conn() as conn:
        row = _get_user_row(conn, user_id)
        if not row:
            return False, '用户不存在'
        if row['role'] == 'admin' and _admin_count(conn) <= 1:
            return False, '系统至少需要保留一个可用管理员'
        conn.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,))
        conn.execute('DELETE FROM users WHERE id = ?', (user_id,))
    return True, '用户已删除'


def recent_logins(limit=20):
    with _conn() as conn:
        rows = conn.execute(
            'SELECT * FROM login_log ORDER BY id DESC LIMIT ?', (limit,)).fetchall()
    return [{'username': r['username'], 'ip': r['ip'], 'ok': bool(r['ok']),
             'reason': r['reason'], 'at': _fmt(r['at'])} for r in rows]


# ================================================================ 单用户模式（用户中心停用）
# 默认登录用户固定为 zhouli（管理员），无需输入密码；/api/* 自动以该身份执行。
SINGLE_USER_NAME = 'zhouli'
_single_user_cache = None


def ensure_single_user():
    """保证内置用户 zhouli 存在且为可用管理员；返回其公开信息（带缓存）。"""
    global _single_user_cache
    if _single_user_cache:
        return _single_user_cache
    with _conn() as conn:
        row = conn.execute('SELECT * FROM users WHERE username = ?',
                           (SINGLE_USER_NAME,)).fetchone()
        if row:
            if row['role'] != 'admin' or row['status'] != 'active':
                conn.execute("UPDATE users SET role = 'admin', status = 'active' WHERE id = ?",
                             (row['id'],))
                row = conn.execute('SELECT * FROM users WHERE id = ?', (row['id'],)).fetchone()
        else:
            salt = secrets.token_hex(16)
            pwd_hash = _hash_password(secrets.token_urlsafe(32), salt)  # 随机密码，不可用于登录
            now = int(time.time())
            conn.execute(
                'INSERT INTO users (username, display_name, email, password_hash, salt, '
                "role, status, created_at, last_login_at, last_login_ip) "
                'VALUES (?,?,?,?,?,?,?,?,?,?)',
                (SINGLE_USER_NAME, SINGLE_USER_NAME, '', pwd_hash, salt,
                 'admin', 'active', now, now, ''))
            row = conn.execute('SELECT * FROM users WHERE username = ?',
                               (SINGLE_USER_NAME,)).fetchone()
    _single_user_cache = _public(row)
    return _single_user_cache
