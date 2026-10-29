/* ============================================================
   接口自动化测试平台 —— 前端逻辑（菜单式）
   页面：测试用例 / 测试场景 / 运行记录 / 系统设置
   ============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  payload: null,
  selected: new Set(),
  results: new Map(),        // caseId -> result（当前会话）
  userMeta: {},              // userName -> {tags:[], vars:{}}
  caseTags: {},              // caseId -> [tag, ...]（用例级标签，可编辑）
  settings: {},
  search: '',                 // 搜索：用例名称 / 接口名称 / 标签，空格分隔多关键词（AND）
  collapsedUsers: new Set(),
  collapsedModules: new Set(),
  running: false,
  detailId: null,
  page: 'cases',
  history: { batches: [], stats: {} },
  batchDetail: null,         // 抽屉当前展示的批次（供「导出本批次」使用）
  scenarios: [],
  modalPicked: new Set(),
  editingScenarioId: null,
  me: null,                  // 当前登录用户（来自 /api/auth/me）
  authUsers: [],             // 用户中心：用户列表（全员可见，管理员可维护）
  usersSub: 'profile',       // 用户中心二级页：profile | list
  userCanManage: false,      // 当前账号能否维护用户（管理员）
  pages: { cases: 1, scenarios: 1, history: 1 },   // 各列表当前页码（每页 PAGE_SIZE 条）
};

/* ---------------- 工具 ---------------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
const TOAST_ICON = { ok: '✓', err: '✕', warn: '⚠' };
/**
 * 页面中央 toast
 * @param {string} msg  文案
 * @param {number} ms   停留时长
 * @param {'ok'|'err'|'warn'} [kind] 提示类型（成功/失败/警告），带配色与图标
 */
function toast(msg, ms = 2400, kind) {
  const el = $('#toast');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.innerHTML = (TOAST_ICON[kind] ? `<span class="ti">${TOAST_ICON[kind]}</span>` : '')
    + `<span class="tt">${esc(msg)}</span>`;
  el.hidden = false;
  // 重播动画
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, ms);
}
async function api(path, opts) {
  const res = await fetch(path, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  // 登录态失效：统一跳登录页，避免每个调用处各写一遍
  if (res.status === 401) {
    location.replace('/login?expired=1');
    throw new Error('登录已过期');
  }
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}
function post(path, body) {
  return api(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}
function shortPath(url) {
  try { const u = new URL(url); return u.pathname + (u.search || ''); }
  catch (e) { return url; }
}
function initials(name) { return String(name || '?').trim().slice(0, 2).toUpperCase(); }
function fmtMs(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return ms + ' ms';
  return (ms / 1000).toFixed(2) + ' s';
}
function fmtTime(ts) { return ts || '-'; }

/**
 * 批次耗时口径：
 *  - durationMs 主口径 = 本批次内所有用例执行耗时之和
 *  - wallMs     参考   = 从开始到结束的真实经过时间（并发执行时会小于合计）
 */
function batchDur(b) {
  const sum = b.durationMs || 0;
  const wall = (b.wallMs === undefined || b.wallMs === null) ? null : b.wallMs;
  return { sum, wall, same: wall === null || wall === sum };
}
function batchDurTip(b) {
  const { sum, wall, same } = batchDur(b);
  return same
    ? `本批次用例耗时合计 ${sum} ms`
    : `本批次用例耗时合计 ${sum} ms；真实经过时间 ${wall} ms（并发执行，故小于合计）`;
}

/** 批次统计：通过/失败/未测占比 + 耗时口径（供环形图与指标卡使用） */
function batchStats(b) {
  const results = b.results || [];
  const total = b.total || results.length || 0;
  const passed = b.passedCount != null ? b.passedCount : results.filter(r => r && r.passed).length;
  const failed = b.failedCount != null ? b.failedCount : results.filter(r => r && !r.passed).length;
  const untested = Math.max(0, total - passed - failed);
  const done = passed + failed;
  // 纯接口请求耗时：旧数据没有 requestMs 时回退到 durationMs
  const reqSum = results.reduce((s, r) => s + ((r && (r.requestMs != null ? r.requestMs : r.durationMs)) || 0), 0);
  const pct = n => (total ? ((n / total) * 100).toFixed(2) : '0.00');
  return {
    total, passed, failed, untested, done,
    passPct: pct(passed), failPct: pct(failed), untestedPct: pct(untested),
    reqSum,
    avgReq: done ? Math.round(reqSum / done) : 0,
  };
}

/** SVG 环形图（通过=绿 / 失败=红 / 未测=灰），自包含、导出 HTML 亦可复用 */
function donutSvg(st) {
  const R = 40, CX = 60, CY = 60, C = 2 * Math.PI * R;
  const segs = [
    { n: st.passed, color: 'var(--ok)' },
    { n: st.failed, color: 'var(--bad)' },
    { n: st.untested, color: '#c9cede' },
  ].filter(s => s.n > 0);
  let off = 0;
  const arcs = st.total
    ? segs.map(s => {
        const len = (s.n / st.total) * C;
        const el = `<circle r="${R}" cx="${CX}" cy="${CY}" fill="none" stroke="${s.color}" stroke-width="15"
          stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"
          transform="rotate(-90 ${CX} ${CY})" stroke-linecap="butt" />`;
        off += len;
        return el;
      }).join('')
    : `<circle r="${R}" cx="${CX}" cy="${CY}" fill="none" stroke="#c9cede" stroke-width="15" />`;
  return `<svg class="donut" viewBox="0 0 120 120" width="118" height="118" role="img" aria-label="通过率环形图">
    ${arcs}
    <text x="${CX}" y="58" text-anchor="middle" font-size="21" font-weight="700" fill="currentColor">${st.done}</text>
    <text x="${CX}" y="76" text-anchor="middle" font-size="10.5" fill="var(--text-faint)">已完成</text>
  </svg>`;
}

/** 批次统计卡片：环形图 + 通过/失败/未测占比 + 耗时指标（抽屉与导出 HTML 共用） */
function batchChartHtml(b) {
  const st = batchStats(b);
  const dur = batchDur(b);
  const legend = [
    { cls: 'ok', label: '通过', n: st.passed, pct: st.passPct },
    { cls: 'bad', label: '失败', n: st.failed, pct: st.failPct },
    { cls: 'idle', label: '未测', n: st.untested, pct: st.untestedPct },
  ].map(l => `<div class="lg"><span class="lg-dot ${l.cls}"></span>
      <span class="lg-name">${l.label}</span>
      <b class="${l.cls}">${l.n}</b><span class="lg-pct">(${l.pct}%)</span></div>`).join('');
  const metrics = [
    { label: '总耗时', val: fmtMs(dur.sum), tip: batchDurTip(b) },
    { label: '接口请求耗时', val: fmtMs(st.reqSum), tip: '本批次所有用例纯接口请求耗时之和（不含断言等处理开销）' },
    { label: '平均接口请求耗时', val: fmtMs(st.avgReq), tip: `接口请求耗时 / 已完成 ${st.done} 条` },
    dur.same ? null : { label: '真实经过时间', val: fmtMs(dur.wall), tip: '从开始到结束的真实时间（含并发）' },
  ].filter(Boolean).map(m => `<div class="bcm" title="${esc(m.tip)}"><span>${m.label}</span><b>${esc(m.val)}</b></div>`).join('');
  return `<div class="bchart">
    <div class="bchart-donut">${donutSvg(st)}</div>
    <div class="bchart-legend">${legend}</div>
    <div class="bchart-metrics">${metrics}</div>
  </div>`;
}

/* ============================================================
   分页（测试用例 / 测试场景 / 运行记录 每页 10 条）
   ============================================================ */
const PAGE_SIZE = 10;

/** 按当前页码切分数组，并夹紧页码（数据变少时自动回退到最后一页） */
function paginate(arr, name) {
  const size = PAGE_SIZE;
  const total = arr.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  let page = Number(state.pages[name] || 1);
  if (!isFinite(page) || page < 1) page = 1;
  if (page > totalPages) page = totalPages;
  state.pages[name] = page;
  const start = (page - 1) * size;
  return { items: arr.slice(start, start + size), page, totalPages, total, start, size, mode: 'page' };
}

/**
 * 分页控件 HTML。
 * 传 mode:'all' 时只展示条数信息（不足一页），不渲染翻页按钮。
 */
function pagerHtml(name, pg) {
  if (!pg.total) return '';
  const { page, totalPages, total, start, items } = pg;
  const range = `第 ${start + 1}-${start + items.length} 条 / 共 ${total} 条`;
  if (pg.mode === 'all' || total <= pg.size) {
    return `<div class="pager"><span class="pg-info">${range}　·　共 1 页</span></div>`;
  }
  const nums = [];
  const from = Math.max(1, page - 2), to = Math.min(totalPages, page + 2);
  if (from > 1) { nums.push(1); if (from > 2) nums.push('…'); }
  for (let i = from; i <= to; i++) nums.push(i);
  if (to < totalPages) { if (to < totalPages - 1) nums.push('…'); nums.push(totalPages); }
  const pgBtn = (label, val, cls) =>
    `<button class="pg-btn${cls ? ' ' + cls : ''}" data-pg="${name}:${val}" type="button">${label}</button>`;
  return `<div class="pager">
    <span class="pg-info">${range}</span>
    <span class="pg-ctrl">
      ${page > 1 ? pgBtn('‹ 上一页', page - 1) : '<button class="pg-btn" disabled type="button">‹ 上一页</button>'}
      ${nums.map(n => n === '…'
        ? '<span class="pg-gap">…</span>'
        : pgBtn(String(n), n, n === page ? 'on' : '')).join('')}
      ${page < totalPages ? pgBtn('下一页 ›', page + 1) : '<button class="pg-btn" disabled type="button">下一页 ›</button>'}
    </span>
    <span class="pg-page">第 ${page} / ${totalPages} 页</span>
  </div>`;
}

/** 分页点击（统一委托，避免各容器重复绑定） */
function bindPager() {
  document.addEventListener('click', e => {
    const el = e.target.closest && e.target.closest('[data-pg]');
    if (!el) return;
    const [name, raw] = String(el.dataset.pg).split(':');
    const val = Number(raw);
    if (!name || !isFinite(val)) return;
    e.preventDefault();
    state.pages[name] = val;
    if (name === 'cases') renderCaseList();
    else if (name === 'scenarios') renderScenarios();
    else if (name === 'history') renderHistory();
  });
}

/* ============================================================
   页面切换
   ============================================================ */
function switchPage(name, sub) {
  state.page = name;
  $$('.menu-item').forEach(b => b.classList.toggle('active', b.dataset.page === name));
  $$('.page').forEach(p => {
    const on = p.id === 'page-' + name;
    p.classList.toggle('active', on);
    p.hidden = !on;            // 与 [hidden]{display:none!important} 保持同步
  });
  // 用例页每次进入都刷新：修复「启动时加载失败就一直空白，必须手动 F5」的问题，
  // 同时保证从外部新增/修改用例文件后切回来能立即看到最新数据
  if (name === 'cases') loadCases();
  if (name === 'scenarios') loadScenarios();
  if (name === 'history') loadHistory();
  if (name === 'settings') renderSettings();
  if (name === 'users') {
    setUsersMenuOpen(true);
    setUsersPanel(sub || state.usersSub || 'profile');
  }
  if (name === 'mcp') {
    setMcpMenuOpen(true);
    setMcpPanel(sub || state.mcpSub || 'contract');
  }
}

/* ---------- MCP 测试（契约驱动）：二级菜单与五个环节面板 ---------- */
/* 子页面数据缓存：切换到对应子菜单时按需拉取，避免每次重建 DOM */
let _mcpTools = null;            // 契约工具清单
let _mcpToolPage = 1;            // 工具清单当前页
const MCP_TOOL_PAGE_SIZE = 10;   // 工具清单每页条数
let _mcpParamSum = null;         // 参数级用例概览
let _mcpParamPage = 1;
const MCP_PARAM_PAGE_SIZE = 10;
let _mcpScenSum = null;          // 场景级用例概览
let _mcpDiffData = null;         // 最近一次 diff 结果
let _mcpRunPage = 1;             // 运行记录当前页
const MCP_RUN_PAGE_SIZE = 10;    // 运行记录每页条数
let _mcpDetailFrom = 'scenarios';// 详情视图返回时回到哪个子菜单
let _mcpReport = null;           // 回归报告 {data, filter, page}
const MCP_REPORT_PAGE_SIZE = 20; // 报告内用例明细每页条数
let _mcpScenCases = null;        // 当前场景详情用例（展开行用）

function setMcpMenuOpen(open) {
  if ($('#mcpSubmenu')) $('#mcpSubmenu').hidden = !open;
  if ($('#menuGroupMcp')) $('#menuGroupMcp').classList.toggle('open', open);
}

const MCP_PANELS = {
  contract: ['契约发现', '从 MCP Server tools/list 自动提取接口契约'],
  params: ['参数级用例', '按 JSON Schema 规则批量生成 4a 参数级用例'],
  scenarios: ['场景级用例', '4b 状态依赖链路：上一步输出喂给下一步'],
  run: ['一键回归', '契约发现 → diff → 生成 → 全量执行（4a + 4b）'],
  diff: ['Schema Diff', '对比 tools/list 与上次快照，接口变更自动告警'],
};

function setMcpPanel(sub) {
  const name = MCP_PANELS[sub] ? sub : 'contract';
  state.mcpSub = name;
  $$('#mcpSubmenu .mcp-sub').forEach(b => b.classList.toggle('active', b.dataset.msub === name));
  Object.keys(MCP_PANELS).forEach(k => {
    const el = $('#mcpPanel-' + k);
    if (el) el.hidden = k !== name;
  });
  if ($('#mcpPanel-detail')) $('#mcpPanel-detail').hidden = true;  // 详情是覆盖视图
  if ($('#mcpTitle')) $('#mcpTitle').textContent = MCP_PANELS[name][0];
  if ($('#mcpPageDesc')) $('#mcpPageDesc').textContent = MCP_PANELS[name][1];
  loadMcpPanel(name);
}

/* ---------- 详情视图（场景详情 / 回归报告共用） ---------- */
function openMcpDetail(opts) {
  _mcpDetailFrom = opts.from || state.mcpSub || 'scenarios';
  Object.keys(MCP_PANELS).forEach(k => {
    const el = $('#mcpPanel-' + k);
    if (el) el.hidden = true;
  });
  const detail = $('#mcpPanel-detail');
  if (!detail) return;
  detail.hidden = false;
  if ($('#mcpDetailTitle')) $('#mcpDetailTitle').textContent = opts.title || '详情';
  if ($('#mcpDetailSub')) $('#mcpDetailSub').textContent = opts.sub || '';
  if ($('#mcpDetailActions')) $('#mcpDetailActions').innerHTML = opts.actions || '';
  if ($('#mcpDetailBody')) $('#mcpDetailBody').innerHTML = opts.body || '';
  if ($('#mcpTitle')) $('#mcpTitle').textContent = opts.title || '详情';
  if ($('#mcpPageDesc')) $('#mcpPageDesc').textContent = opts.pageDesc || '';
}

function closeMcpDetail() {
  const detail = $('#mcpPanel-detail');
  if (detail) detail.hidden = true;
  _mcpReport = null;
  _mcpScenCases = null;
  setMcpPanel(_mcpDetailFrom || 'scenarios');
}

/* 切到哪个子页面就加载哪个子页面的数据（以前只有契约页会加载，其余 4 页是空白占位） */
function loadMcpPanel(name) {
  if (name === 'contract') { loadMcpStatus(); loadMcpTools(); return; }
  if (name === 'params') { loadMcpSummary().then(s => s && renderMcpParams(s.params)); return; }
  if (name === 'scenarios') { loadMcpSummary().then(s => s && renderMcpScen(s.scenarios)); return; }
  if (name === 'run') { loadMcpSummary().then(() => loadMcpRuns(1)); return; }
  if (name === 'diff') { loadMcpDiff(); }
}

async function loadMcpSummary() {
  try {
    const d = await api('/api/mcp/cases/summary');
    _mcpParamSum = d.params;
    _mcpScenSum = d.scenarios;
    return d;
  } catch (e) {
    return null;
  }
}

function mcpChips(items) {
  return items.map(([label, value, kind]) =>
    '<span class="mcp-chip' + (kind ? ' ' + kind : '') + '">' + esc(label) +
    ' <b>' + esc(value) + '</b></span>').join('');
}

function mcpPager(attr, page, pages, total, rows) {
  return '<div class="mcp-pager">' +
    '<button class="btn ghost sm" data-' + attr + '="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>' +
    '<span>第 ' + page + ' / ' + pages + ' 页（本页 ' + rows + ' 条，共 ' + total + ' 条）</span>' +
    '<button class="btn ghost sm" data-' + attr + '="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>下一页</button>' +
    '</div>';
}

/* ---------- ① 契约发现：状态 + 工具清单（每页 10 条） ---------- */
async function loadMcpStatus() {
  try {
    const s = await api('/api/mcp/status');
    $('#mcpGatewayText').textContent =
      `网关：${s.gateway} ｜ ${s.gatewayReachable ? '可达 ✓' : '不可达 ✗'} ｜ ` +
      `契约：${s.contract.exists ? s.contract.toolCount + ' 个工具（' + s.contract.mtime + '）' : '未发现'}`;
  } catch (e) {
    $('#mcpGatewayText').textContent = '网关状态获取失败：' + e.message;
  }
}

async function loadMcpTools() {
  const box = $('#mcpToolTable');
  if (!box) return;
  try {
    const d = await api('/api/mcp/tools');
    _mcpTools = d.tools || [];
    if ($('#mcpToolCount')) $('#mcpToolCount').textContent =
      `共 ${d.total} 个工具（发现于 ${d.generatedAt}）｜接口名称已标注 ${d.withApi != null ? d.withApi : (d.tools || []).filter(t => t.apiPath).length} 个`;
    renderMcpToolPage(1);
  } catch (e) {
    _mcpTools = null;
    box.textContent = e.message.includes('尚未') ? '尚未发现契约，请先点击上方「发现并导出契约」。' : '加载失败：' + e.message;
    if ($('#mcpToolCount')) $('#mcpToolCount').textContent = '';
  }
}

/* 接口路径里的 :param 高亮，并在 / 之后加换行点（长路径按段折行，不从单词中间断开）
   注意顺序：先插 <wbr> 再包 <em>，否则会把 </em> 里的斜杠也当成换行点。 */
function mcpApiPath(path) {
  const s = esc(path || '').replace(/\/(?=\S)/g, '/<wbr>');
  return s.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '<em class="mcp-param">:$1</em>');
}

function mcpApiCell(t) {
  if (!t.apiPath) return '<span class="mcp-none">—</span>';
  const m = (t.apiMethod || '').toLowerCase();
  return '<div class="mcp-api">' +
    '<span class="mcp-method m-' + esc(m) + '">' + esc(t.apiMethod) + '</span>' +
    '<code class="mcp-path">' + mcpApiPath(t.apiPath) + '</code></div>';
}

function renderMcpToolPage(page) {
  const box = $('#mcpToolTable');
  if (!box || !_mcpTools) return;
  const total = _mcpTools.length;
  const pages = Math.max(1, Math.ceil(total / MCP_TOOL_PAGE_SIZE));
  _mcpToolPage = Math.min(Math.max(1, page || 1), pages);
  const start = (_mcpToolPage - 1) * MCP_TOOL_PAGE_SIZE;
  const rows = _mcpTools.slice(start, start + MCP_TOOL_PAGE_SIZE);
  box.innerHTML =
    '<table class="dt dt-tools"><thead><tr>' +
    '<th class="ta-c" style="width:52px">#</th>' +
    '<th style="width:290px">工具名称（MCP Tool）</th>' +
    '<th style="width:352px">接口名称</th>' +
    '<th>工具说明</th>' +
    '<th style="width:200px">必填参数</th>' +
    '</tr></thead><tbody>' +
    rows.map((t, i) =>
      '<tr><td class="ta-c">' + (start + i + 1) + '</td>' +
      '<td><code class="mcp-tool-name" data-copy="' + esc(t.name) + '" ' +
      'title="完整 MCP Tool 名：' + esc(t.name) + '（点击复制）">' + esc(t.name) + '</code></td>' +
      '<td>' + mcpApiCell(t) + '</td>' +
      '<td class="mcp-tool-desc">' + esc(t.description || '—') + '</td>' +
      '<td>' + ((t.required || []).length
        ? t.required.map(r => '<span class="env-chip">' + esc(r) + '</span>').join(' ')
        : '<span class="mcp-none">无</span>') + '</td></tr>'
    ).join('') +
    '</tbody></table>' + mcpPager('mtp', _mcpToolPage, pages, total, rows.length);
}

/* ---------- ② 参数级用例（4a） ---------- */
function renderMcpParams(sum) {
  const box = $('#mcpParamsTable');
  if (!box) return;
  if (!sum || !sum.exists || !sum.total) {
    if ($('#mcpParamsMeta')) $('#mcpParamsMeta').textContent = '尚未生成参数级用例';
    if ($('#mcpParamsCats')) $('#mcpParamsCats').innerHTML = '';
    box.textContent = '尚未生成参数级用例，点击右上角「重新生成参数级用例」。';
    return;
  }
  if ($('#mcpParamsMeta')) $('#mcpParamsMeta').textContent =
    `共 ${sum.total} 条 ｜ ${sum.tools.length} 个工具 ｜ 生成于 ${sum.mtime} ｜ ${sum.file}`;
  if ($('#mcpParamsCats')) {
    $('#mcpParamsCats').innerHTML = mcpChips(
      sum.categories.map(c => [c.name, c.count])
        .concat([['合计', sum.total, 'ok']]));
  }
  const total = sum.tools.length;
  const pages = Math.max(1, Math.ceil(total / MCP_PARAM_PAGE_SIZE));
  _mcpParamPage = Math.min(Math.max(1, _mcpParamPage || 1), pages);
  const start = (_mcpParamPage - 1) * MCP_PARAM_PAGE_SIZE;
  const rows = sum.tools.slice(start, start + MCP_PARAM_PAGE_SIZE);
  box.innerHTML =
    '<table class="dt"><thead><tr>' +
    '<th style="width:60px">#</th><th style="width:290px">工具</th><th style="width:80px">用例数</th>' +
    '<th style="width:230px">用例分类</th><th>用例示例</th>' +
    '</tr></thead><tbody>' +
    rows.map((t, i) =>
      '<tr><td class="ta-c">' + (start + i + 1) + '</td>' +
      '<td><b>' + esc(t.tool) + '</b></td>' +
      '<td class="ta-c">' + t.count + '</td>' +
      '<td>' + Object.keys(t.cats).map(k =>
        '<span class="env-chip">' + esc(k) + ' ×' + t.cats[k] + '</span>').join(' ') + '</td>' +
      '<td style="opacity:.75">' + esc(t.sample) + '</td></tr>'
    ).join('') +
    '</tbody></table>' + mcpPager('mpp', _mcpParamPage, pages, total, rows.length);
}

/* ---------- ③ 场景级用例（4b）：链路列表 → 点击进入场景详情（该场景下全部用例） ---------- */
function renderMcpScen(sum) {
  const box = $('#mcpScenTable');
  if (!box) return;
  if (!sum || !sum.exists || !sum.chains.length) {
    if ($('#mcpScenMeta')) $('#mcpScenMeta').textContent = '尚未生成场景链路';
    box.textContent = '尚未生成场景链路，点击右上角「生成场景链路」。';
    return;
  }
  if ($('#mcpScenMeta')) $('#mcpScenMeta').textContent =
    `共 ${sum.chains.length} 条链路 / ${sum.stepCount} 个步骤 ｜ 生成于 ${sum.mtime} ｜ ${sum.file}`;
  box.innerHTML =
    '<table class="dt"><thead><tr>' +
    '<th style="width:56px">#</th><th style="width:250px">场景链路</th><th style="width:240px">说明</th>' +
    '<th style="width:64px">步骤</th><th>步骤链（tool → tool）</th><th style="width:104px">用例</th>' +
    '</tr></thead><tbody>' +
    sum.chains.map((c, ci) =>
      '<tr class="row-link" data-scen="' + ci + '" title="点击查看该场景下的全部测试用例">' +
      '<td class="ta-c">' + (ci + 1) + '</td>' +
      '<td><b>' + esc(c.name) + '</b></td>' +
      '<td style="opacity:.75">' + esc(c.desc || '—') + '</td>' +
      '<td class="ta-c">' + c.stepCount + '</td>' +
      '<td>' + c.steps.map((s, i) =>
        (i ? ' <span style="opacity:.4">→</span> ' : '') +
        '<span class="env-chip">' + esc(s.tool) + '</span>').join('') + '</td>' +
      '<td class="ta-c"><button class="btn ghost sm" data-scen="' + ci + '">详情 →</button></td></tr>'
    ).join('') +
    '</tbody></table>' +
    '<div class="mcp-pager"><span>点击任一行进入场景详情，可查看该场景下的全部测试用例（请求 / 断言 / 变量传递）</span></div>';
}

function prettyJson(s) {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch (e) { return String(s || ''); }
}

function shortText(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

async function openMcpScenDetail(index) {
  openMcpDetail({
    from: 'scenarios',
    title: '场景详情',
    sub: '正在加载该场景下的测试用例…',
    pageDesc: '该场景链路包含的全部可执行测试用例',
    body: '<div class="empty-hint">正在加载…</div>',
  });
  try {
    const d = await api('/api/mcp/scenarios/detail?index=' + encodeURIComponent(index));
    renderMcpScenDetail(d);
  } catch (e) {
    if ($('#mcpDetailSub')) $('#mcpDetailSub').textContent = '加载失败';
    if ($('#mcpDetailBody')) $('#mcpDetailBody').innerHTML =
      '<div class="empty-hint">加载失败：' + esc(e.message) + '</div>';
  }
}

function mcpCaseAssertList(asserts) {
  if (!asserts || !asserts.length) return '<div class="empty-hint">无自定义断言</div>';
  return '<ul class="mcp-asserts">' + asserts.map(a =>
    '<li><code>' + esc([a.type, a.path, a.op].filter(Boolean).join(' ')) +
    (a.value !== undefined ? ' = ' + esc(JSON.stringify(a.value)) : '') + '</code>' +
    (a.desc ? '<em>' + esc(a.desc) + '</em>' : '') + '</li>').join('') + '</ul>';
}

/* 场景详情：一条链路 = 多条按顺序执行的用例 */
function renderMcpScenDetail(d) {
  const sc = d.scenario || {};
  const cases = d.cases || [];
  _mcpScenCases = { scenario: sc, cases };
  const tools = Array.from(new Set(cases.map(c => c.tool).filter(Boolean)));
  const varLinks = cases.reduce((arr, c) =>
    arr.concat(Object.keys(c.extract || {}).map(k => k + ' ← ' + c.extract[k])), []);
  if ($('#mcpDetailTitle')) $('#mcpDetailTitle').textContent = sc.name || '场景详情';
  if ($('#mcpDetailSub')) $('#mcpDetailSub').textContent =
    (sc.desc ? sc.desc + ' ｜ ' : '') + `共 ${cases.length} 条用例 / ${tools.length} 个工具`;
  if ($('#mcpPageDesc')) $('#mcpPageDesc').textContent = '该场景链路包含的全部可执行测试用例';
  if ($('#mcpDetailActions')) $('#mcpDetailActions').innerHTML =
    '<button class="btn ghost sm" id="btnMcpScenExport">导出用例 JSON</button>';
  const body = $('#mcpDetailBody');
  if (!body) return;
  body.innerHTML =
    '<div class="mcp-stats">' + mcpChips([
      ['场景步骤', cases.length],
      ['涉及工具', tools.length],
      ['传递变量', varLinks.length],
      ['网关', d.gateway || '—'],
    ]) + '</div>' +
    (varLinks.length
      ? '<div class="mcp-varline">变量传递：' + varLinks.map(v =>
        '<span class="env-chip ok">' + esc(v) + '</span>').join(' ') + '</div>'
      : '') +
    '<div class="table-wrap">' +
    '<table class="dt"><thead><tr>' +
    '<th style="width:50px">#</th><th style="width:260px">用例名称</th><th style="width:230px">工具</th>' +
    '<th style="width:210px">参数</th><th style="width:130px">提取变量</th><th>说明</th>' +
    '</tr></thead><tbody>' +
    cases.map((c, i) => {
      const argKeys = Object.keys(c.args || {});
      const exKeys = Object.keys(c.extract || {});
      return '<tr class="row-link" data-scase="' + i + '" title="点击展开该用例的请求与断言">' +
        '<td class="ta-c">' + (i + 1) + '</td>' +
        '<td><b>' + esc(c.name) + '</b></td>' +
        '<td><code>' + esc(c.tool) + '</code></td>' +
        '<td>' + (argKeys.length ? argKeys.map(k => '<span class="env-chip">' +
          esc(k) + '=' + esc(typeof c.args[k] === 'object' ? JSON.stringify(c.args[k]) : c.args[k]) +
          '</span>').join(' ') : '<span style="opacity:.5">无参</span>') + '</td>' +
        '<td>' + (exKeys.length ? exKeys.map(k => '<span class="env-chip ok">' +
          esc(k) + '</span>').join(' ') : '<span style="opacity:.5">—</span>') + '</td>' +
        '<td style="opacity:.75">' + esc(c.desc || '—') + '</td></tr>' +
        '<tr class="mcp-exp-row" id="mcpScase-' + i + '" hidden><td colspan="6">' +
        mcpScenCaseHtml(c) + '</td></tr>';
    }).join('') +
    '</tbody></table></div>' +
    '<div class="mcp-pager"><span>点击任一行展开 JSON-RPC 请求、请求头与断言</span></div>';
}

function mcpScenCaseHtml(c) {
  const kv = [
    ['用例 ID', c.caseId], ['所属模块', c.module], ['标签', (c.tags || []).join(' / ') || '—'],
    ['请求', c.method + ' ' + c.url],
  ];
  return '<div class="mcp-case">' +
    '<div class="mcp-kv">' + kv.map(([k, v]) =>
      '<div><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('') + '</div>' +
    '<div class="mcp-case-cols">' +
    '<div><div class="mcp-sub">JSON-RPC 请求体</div><pre class="mcp-out sm">' +
    esc(prettyJson(c.body)) + '</pre></div>' +
    '<div><div class="mcp-sub">断言（' + (c.asserts || []).length + ' 条）</div>' +
    mcpCaseAssertList(c.asserts) + '</div>' +
    '</div>' +
    '<div class="mcp-sub">请求头</div><pre class="mcp-out sm">' +
    esc((c.headers || []).map(h => h.key + ': ' + h.value).join('\n') || '（无）') + '</pre>' +
    '</div>';
}

/* ---------- ④ 一键回归：结果 + 运行记录（分页每页 10 条）+ 测试报告 ---------- */
async function loadMcpRuns(page) {
  const box = $('#mcpRunTable');
  if (!box) return;
  // 顶部先给出「将执行什么」的规模
  if ($('#mcpRunMeta')) {
    const p = _mcpParamSum, s = _mcpScenSum;
    $('#mcpRunMeta').textContent = p && p.exists
      ? `将执行：参数级 ${p.total} 条 + 场景级 ${s && s.exists ? s.stepCount : 0} 步`
      : '尚未生成用例，一键回归会自动重新生成';
  }
  const p = Math.max(1, page || _mcpRunPage || 1);
  try {
    const d = await api('/api/mcp/runs?page=' + p + '&pageSize=' + MCP_RUN_PAGE_SIZE);
    _mcpRunPage = d.page || 1;
    const runs = d.runs || [];
    if (!d.total) {
      box.textContent = '暂无 MCP 运行记录，点击右上角「开始一键回归」。';
      return;
    }
    box.innerHTML =
      '<table class="dt"><thead><tr>' +
      '<th style="width:50px">#</th><th style="width:160px">批次</th><th style="width:150px">执行时间</th>' +
      '<th style="width:200px">来源</th><th style="width:66px">总数</th><th style="width:66px">通过</th>' +
      '<th style="width:66px">失败</th><th style="width:90px">耗时</th><th style="width:90px">通过率</th>' +
      '<th style="width:96px">报告</th></tr></thead><tbody>' +
      runs.map((r, i) => {
        const rate = r.total ? ((r.passedCount / r.total) * 100).toFixed(1) + '%' : '-';
        const bad = r.failedCount > 0;
        return '<tr><td class="ta-c">' + ((d.page - 1) * d.pageSize + i + 1) + '</td>' +
          '<td><code>' + esc(r.batchId) + '</code></td>' +
          '<td>' + esc(r.startedAt || '') + '</td>' +
          '<td>' + esc((r.source && r.source.name) || (r.source && r.source.type) || '—') + '</td>' +
          '<td class="ta-c">' + r.total + '</td>' +
          '<td class="ta-c" style="color:var(--ok)">' + r.passedCount + '</td>' +
          '<td class="ta-c" style="color:' + (bad ? 'var(--bad)' : 'var(--text-faint)') + '">' + r.failedCount + '</td>' +
          '<td class="ta-c">' + (r.wallMs || r.durationMs || 0) + ' ms</td>' +
          '<td class="ta-c" style="color:' + (bad ? 'var(--bad)' : 'var(--ok)') + '">' + rate + '</td>' +
          '<td class="ta-c"><button class="btn ghost sm" data-report="' + esc(r.batchId) + '">查看报告</button></td></tr>';
      }).join('') +
      '</tbody></table>' +
      mcpPager('mrp', d.page, d.pages, d.total, runs.length);
  } catch (e) {
    box.textContent = '运行记录加载失败：' + e.message;
  }
}

async function openMcpReport(batchId) {
  openMcpDetail({
    from: 'run',
    title: '回归测试报告',
    sub: '正在生成报告…',
    pageDesc: '本次回归执行的完整结果：概览 / 失败明细 / 用例执行明细',
    body: '<div class="empty-hint">正在加载运行结果…</div>',
  });
  try {
    const d = await api('/api/mcp/report?batchId=' + encodeURIComponent(batchId));
    _mcpReport = { data: d, filter: 'all', page: 1 };
    renderMcpReport();
  } catch (e) {
    if ($('#mcpDetailSub')) $('#mcpDetailSub').textContent = '报告加载失败';
    if ($('#mcpDetailBody')) $('#mcpDetailBody').innerHTML =
      '<div class="empty-hint">报告加载失败：' + esc(e.message) + '</div>';
  }
}

function renderMcpReport() {
  const body = $('#mcpDetailBody');
  if (!body || !_mcpReport) return;
  const { data, filter } = _mcpReport;
  const s = data.summary || {};
  const results = data.results || [];
  const fails = results.filter(r => !r.passed);
  const list = filter === 'fail' ? fails : results;
  const pages = Math.max(1, Math.ceil(list.length / MCP_REPORT_PAGE_SIZE));
  const cur = Math.min(Math.max(1, _mcpReport.page || 1), pages);
  _mcpReport.page = cur;
  const start = (cur - 1) * MCP_REPORT_PAGE_SIZE;
  const rows = list.slice(start, start + MCP_REPORT_PAGE_SIZE);

  if ($('#mcpDetailTitle')) $('#mcpDetailTitle').textContent = '回归测试报告 · ' + (s.batchId || '');
  if ($('#mcpDetailSub')) $('#mcpDetailSub').textContent =
    `${s.startedAt || ''} ｜ ${(s.source && s.source.name) || 'MCP 回归'} ｜ 通过率 ${s.passRate}%`;
  if ($('#mcpDetailActions')) $('#mcpDetailActions').innerHTML =
    '<button class="btn ghost sm" id="btnMcpReportExport">导出报告 JSON</button>';

  const cards = [
    ['批次', s.batchId || '—', ''],
    ['执行时间', s.startedAt || '—', ''],
    ['来源', (s.source && s.source.name) || '—', ''],
    ['执行人', s.executedBy || '—', ''],
    ['测试环境', s.environment || '—', ''],
    ['用例总数', s.total || 0, ''],
    ['通过', s.passedCount || 0, 'ok'],
    ['失败', s.failedCount || 0, (s.failedCount ? 'bad' : '')],
    ['通过率', s.passRate + '%', (s.failedCount ? 'bad' : 'ok')],
    ['用例耗时合计', (s.durationMs || 0) + ' ms', ''],
    ['实际执行耗时', (s.wallMs || 0) + ' ms', ''],
    ['覆盖工具数', s.toolCount || 0, ''],
  ];
  let html = '<div class="mcp-report-head">' + cards.map(([k, v, kind]) =>
    '<div class="mcp-rpt' + (kind ? ' ' + kind : '') + '"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>'
  ).join('') + '</div>';

  // 失败明细
  if (fails.length) {
    html += '<div class="card-head" style="margin-top:14px">失败用例明细<em>共 ' + fails.length + ' 条，需优先处理</em></div>' +
      '<div class="table-wrap"><table class="dt"><thead><tr>' +
      '<th style="width:50px">#</th><th style="width:300px">用例</th><th style="width:220px">工具</th>' +
      '<th style="width:70px">HTTP</th><th style="width:90px">耗时</th><th>失败原因</th>' +
      '</tr></thead><tbody>' +
      fails.map((r, i) => '<tr><td class="ta-c">' + (i + 1) + '</td>' +
        '<td><b>' + esc(r.name) + '</b></td><td><code>' + esc(r.tool) + '</code></td>' +
        '<td class="ta-c">' + esc(r.status || '—') + '</td>' +
        '<td class="ta-c">' + r.durationMs + ' ms</td>' +
        '<td style="color:var(--bad)">' + esc(shortText(r.error || '断言未通过', 200)) + '</td></tr>').join('') +
      '</tbody></table></div>';
  } else {
    html += '<div class="card-head" style="margin-top:14px">失败用例明细</div>' +
      '<div class="empty-hint ok">本次回归全部用例通过，无失败明细。</div>';
  }

  // 用例执行明细（可筛选 + 分页）
  html += '<div class="card-head" style="margin-top:14px">用例执行明细<em>共 ' + results.length +
    ' 条 ｜ 点击任一行展开请求 / 响应 / 断言</em></div>' +
    '<div class="mcp-filters">' +
    '<button class="btn sm ' + (filter === 'all' ? 'primary' : 'ghost') + '" data-rpf="all">全部 ' + results.length + '</button>' +
    '<button class="btn sm ' + (filter === 'fail' ? 'primary' : 'ghost') + '" data-rpf="fail">仅失败 ' + fails.length + '</button>' +
    '</div>' +
    (rows.length ? '' : '<div class="empty-hint">当前筛选下没有用例——本次回归无失败用例，切换「全部」查看完整明细。</div>') +
    '<div class="table-wrap"><table class="dt"><thead><tr>' +
    '<th style="width:46px">#</th><th style="width:44px">结果</th><th style="width:330px">用例</th>' +
    '<th style="width:200px">工具</th><th style="width:64px">HTTP</th><th style="width:88px">耗时</th>' +
    '<th style="width:76px">断言</th><th>说明</th>' +
    '</tr></thead><tbody>' +
    rows.map((r, i) => {
      const idx = start + i;
      return '<tr class="row-link' + (r.passed ? '' : ' row-bad') + '" data-rexp="' + idx + '">' +
        '<td class="ta-c">' + (idx + 1) + '</td>' +
        '<td class="ta-c" style="color:' + (r.passed ? 'var(--ok)' : 'var(--bad)') + '">' +
        (r.passed ? '✓' : '✗') + '</td>' +
        '<td>' + esc(r.name) + '</td>' +
        '<td><code>' + esc(r.tool) + '</code></td>' +
        '<td class="ta-c">' + esc(r.status || '—') + '</td>' +
        '<td class="ta-c">' + r.durationMs + ' ms</td>' +
        '<td class="ta-c">' + r.assertsPassed + '/' + r.assertsTotal + '</td>' +
        '<td style="opacity:.75">' + (r.passed ? '通过' : esc(shortText(r.error || '断言未通过', 80))) + '</td></tr>' +
        '<tr class="mcp-exp-row" id="mcpRpt-' + idx + '" hidden><td colspan="8">' +
        mcpReportCaseHtml(r) + '</td></tr>';
    }).join('') +
    '</tbody></table></div>' +
    mcpPager('rpp', cur, pages, list.length, rows.length);

  body.innerHTML = html;
}

function mcpReportCaseHtml(r) {
  const req = r.request || {};
  const hdr = Object.keys(req.headers || {}).map(k =>
    k + ': ' + (String(k).toLowerCase() === 'authorization' ? '***' : req.headers[k])).join('\n');
  return '<div class="mcp-case">' +
    '<div class="mcp-kv">' +
    '<div><span>用例 ID</span><b>' + esc(r.caseId) + '</b></div>' +
    '<div><span>请求</span><b>' + esc((req.method || '') + ' ' + (req.url || '')) + '</b></div>' +
    '<div><span>HTTP / 耗时</span><b>' + esc(r.status || '—') + ' / ' + r.durationMs + ' ms（请求 ' + (r.requestMs ?? '—') + ' ms）</b></div>' +
    '<div><span>断言</span><b>' + r.assertsPassed + ' / ' + r.assertsTotal + ' 通过</b></div>' +
    '</div>' +
    (r.error ? '<div class="mcp-sub">失败原因</div><pre class="mcp-out sm" style="color:var(--bad)">' +
      esc(r.error) + '</pre>' : '') +
    '<div class="mcp-sub">断言明细</div>' +
    (r.asserts || []).map(a => '<div class="mcp-assert' + (a.passed ? ' ok' : ' bad') + '">' +
      (a.passed ? '✓' : '✗') + ' <code>' + esc([a.type, a.path, a.op].filter(Boolean).join(' ')) +
      (a.expected !== undefined && a.expected !== null ? ' = ' + esc(JSON.stringify(a.expected)) : '') +
      '</code>' + (a.desc ? '<em>' + esc(a.desc) + '</em>' : '') +
      (a.message ? '<em>' + esc(a.message) + '</em>' : '') + '</div>').join('') +
    '<div class="mcp-case-cols">' +
    '<div><div class="mcp-sub">请求头</div><pre class="mcp-out sm">' + esc(hdr || '（无）') + '</pre></div>' +
    '<div><div class="mcp-sub">请求体</div><pre class="mcp-out sm">' + esc(prettyJson(req.body)) + '</pre></div>' +
    '</div>' +
    '<div class="mcp-sub">响应体' + (r.bodyTruncated ? '（已截断）' : '') +
    '</div><pre class="mcp-out sm">' + esc(r.responseBody || '（空）') + '</pre>' +
    '</div>';
}

function downloadJson(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

/* ---------- ⑤ Schema Diff ---------- */
async function loadMcpDiff() {
  const box = $('#mcpDiffTable');
  if (!box) return;
  box.innerHTML = '<div class="empty-hint">正在与基线快照对比…</div>';
  try {
    const d = await post('/api/mcp/diff');
    _mcpDiffData = d;
    renderMcpDiff(d);
  } catch (e) {
    if ($('#mcpDiffMeta')) $('#mcpDiffMeta').textContent = '对比失败';
    box.innerHTML = '<div class="empty-hint">对比失败：' + esc(e.message) + '</div>';
  }
}

function renderMcpDiff(d) {
  const box = $('#mcpDiffTable');
  if (!box || !d) return;
  const df = d.diff || {};
  const added = df.added || [], removed = df.removed || [], changed = df.changed || [];
  const base = d.baselineTime || '（无基线）';
  if ($('#mcpDiffMeta')) {
    $('#mcpDiffMeta').textContent = df.first
      ? `当前 ${d.currentCount} 个工具 ｜ 首次发现，无基线可对比`
      : `当前 ${d.currentCount} 个工具 ｜ 基线 ${base} ｜ 新增 ${added.length} / 删除 ${removed.length} / 变更 ${changed.length}`;
  }
  const rows = [];
  added.forEach(t => rows.push(['新增', t, '—', '新增工具，需要补参数级用例']));
  removed.forEach(t => rows.push(['删除', t, '—', '工具已下线，对应用例应删除']));
  changed.forEach(c => rows.push(['变更', c.tool, (c.fields || []).join(' / '),
    'required: [' + (c.oldRequired || []).join(', ') + '] → [' + (c.newRequired || []).join(', ') + ']']));
  if (df.first) {
    box.innerHTML = '<div class="empty-hint">首次发现契约（当前 ' + d.currentCount +
      ' 个工具），已写入基线快照，下次执行 Diff 起开始比对。</div>';
    return;
  }
  if (!rows.length) {
    box.innerHTML = '<div class="empty-hint ok">接口契约无变化（基线 ' + esc(base) + '），用例无需更新。</div>';
    return;
  }
  box.innerHTML =
    '<table class="dt"><thead><tr>' +
    '<th style="width:80px">类型</th><th style="width:300px">工具</th><th style="width:170px">变更字段</th><th>详情</th>' +
    '</tr></thead><tbody>' +
    rows.map(r => {
      const kind = r[0] === '新增' ? 'ok' : (r[0] === '删除' ? 'bad' : 'warn');
      return '<tr><td><span class="env-chip ' + kind + '">' + esc(r[0]) + '</span></td>' +
        '<td><b>' + esc(r[1]) + '</b></td><td>' + esc(r[2]) + '</td>' +
        '<td style="opacity:.8">' + esc(r[3]) + '</td></tr>';
    }).join('') +
    '</tbody></table>';
}

/* ---------- 操作按钮 ---------- */
async function mcpAction(btn, outSel, fn, after) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '执行中…';
  const out = outSel ? $(outSel) : null;
  if (out) { out.hidden = true; out.textContent = ''; }
  try {
    const data = await fn();
    if (typeof after === 'function') after(data);
    return data;
  } catch (e) {
    if (out) { out.hidden = false; out.textContent = '执行失败：' + e.message; }
    toast('执行失败：' + e.message, 3200, 'err');
    return null;
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function bindMcpEvents() {
  const on = (sel, fn) => { const el = $(sel); if (el) el.addEventListener('click', fn); };

  on('#btnMcpDiscover', () => mcpAction($('#btnMcpDiscover'), '#mcpOutContract',
    async () => {
      const d = await post('/api/mcp/discover');
      loadMcpStatus(); loadMcpTools();
      return d;
    },
    d => {
      const out = $('#mcpOutContract');
      out.hidden = false;
      out.textContent = `契约发现完成：工具总数 ${d.toolCount}（armory ${d.armoryToolCount} 个）\n` + fmtDiff(d.diff);
      toast('契约发现完成：' + d.armoryToolCount + ' 个 armory 工具', 2600, 'ok');
    }));

  on('#btnMcpDiffQuick', () => mcpAction($('#btnMcpDiffQuick'), '#mcpOutContract',
    () => post('/api/mcp/diff'),
    d => {
      const out = $('#mcpOutContract');
      out.hidden = false;
      out.textContent = fmtDiff(d.diff) + (d.baselineTime ? `\n（基线：${d.baselineTime}）` : '');
    }));

  on('#btnMcpGenParams', () => mcpAction($('#btnMcpGenParams'), '#mcpOutParams',
    () => post('/api/mcp/generate/params'),
    d => {
      const out = $('#mcpOutParams');
      out.hidden = false;
      out.textContent = `已生成 ${d.total} 条参数级用例 → ${d.file}`;
      _mcpParamPage = 1;
      loadMcpSummary().then(s => s && renderMcpParams(s.params));
      toast('已生成 ' + d.total + ' 条参数级用例', 2600, 'ok');
      loadMcpStatus();
    }));

  on('#btnMcpGenScen', () => mcpAction($('#btnMcpGenScen'), '#mcpOutScen',
    () => post('/api/mcp/generate/scenarios'),
    d => {
      const out = $('#mcpOutScen');
      out.hidden = false;
      out.textContent = `已生成 ${d.scenarios} 条链路 / ${d.steps} 个步骤 → ${d.file}`;
      loadMcpSummary().then(s => s && renderMcpScen(s.scenarios));
      toast('已生成 ' + d.scenarios + ' 条场景链路', 2600, 'ok');
    }));

  on('#btnMcpRunScen', () => mcpAction($('#btnMcpRunScen'), '#mcpOutScen',
    () => post('/api/mcp/scenarios/run'),
    d => {
      const out = $('#mcpOutScen');
      out.hidden = false;
      const lines = [`场景执行：${d.summary.passed}/${d.summary.total} 通过`];
      (d.chains || []).forEach(c => {
        lines.push('', `◆ ${c.name}：${c.passed}/${c.steps} 步通过`);
        (c.results || []).forEach(r =>
          lines.push(`  ${r.passed ? '✓' : '✗'} ${r.name}（${r.durationMs} ms）` +
            (r.error ? ` — ${r.error}` : '')));
      });
      out.textContent = lines.join('\n');
      toast(`场景执行完成：${d.summary.passed}/${d.summary.total} 通过`,
        2800, d.summary.failed ? 'warn' : 'ok');
      loadMcpRuns(1);
    }));

  on('#btnMcpRegression', () => mcpAction($('#btnMcpRegression'), '#mcpOutRun',
    () => post('/api/mcp/regression'),
    d => {
      const s = d.summary || {};
      const out = $('#mcpOutRun');
      out.hidden = false;
      const rp = (d.steps && d.steps.runParams) || {};
      const rs = (d.steps && d.steps.runScenarios) || {};
      out.textContent = [
        `一键回归完成：${s.passed}/${s.total} 通过（失败 ${s.failed || 0}）`,
        `· 契约发现：armory 工具 ${(d.steps && d.steps.discover && d.steps.discover.toolCount) || 0} 个`,
        `· 参数级 4a：${rp.passedCount || 0}/${rp.total || 0}，耗时 ${rp.wallMs || rp.durationMs || 0} ms`,
        `· 场景级 4b：${rs.passed || 0}/${rs.total || 0}`,
        `· Schema Diff：${(fmtDiff(s.schemaDiff || {})).split('\n')[0]}`,
      ].join('\n');
      toast(`一键回归：${s.passed}/${s.total} 通过`, 3000, s.failed ? 'warn' : 'ok');
      loadMcpStatus();
      loadMcpRuns(1);
      loadMcpDiff();
    }));

  on('#btnMcpDiff', () => mcpAction($('#btnMcpDiff'), null,
    () => post('/api/mcp/diff'),
    d => { _mcpDiffData = d; renderMcpDiff(d); }));

  // 三个清单的分页按钮统一委托到各自的容器
  const pagerBind = (sel, attr, fn) => {
    const box = $(sel);
    if (!box) return;
    box.addEventListener('click', e => {
      const btn = e.target.closest && e.target.closest('[data-' + attr + ']');
      if (btn && !btn.disabled) fn(Number(btn.dataset[attr]));
    });
  };
  pagerBind('#mcpToolTable', 'mtp', p => renderMcpToolPage(p));

  // 工具清单：点击工具名复制完整 MCP Tool 名
  const toolBox = $('#mcpToolTable');
  if (toolBox) {
    toolBox.addEventListener('click', e => {
      const c = e.target.closest && e.target.closest('[data-copy]');
      if (!c) return;
      const text = c.dataset.copy;
      const done = () => toast('已复制：' + text, 1800, 'ok');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => fallback());
      } else fallback();
      function fallback() {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (err) { toast('复制失败', 1800, 'bad'); }
        ta.remove();
      }
    });
  }
  pagerBind('#mcpParamsTable', 'mpp', p => { _mcpParamPage = p; renderMcpParams(_mcpParamSum); });

  // 场景列表：点击任一行/「详情」→ 场景详情页（该场景下全部用例）
  const scenBox = $('#mcpScenTable');
  if (scenBox) {
    scenBox.addEventListener('click', e => {
      const t = e.target.closest && e.target.closest('[data-scen]');
      if (t) openMcpScenDetail(Number(t.dataset.scen));
    });
  }

  // 一键回归：运行记录分页 + 每行「查看报告」
  const runBox = $('#mcpRunTable');
  if (runBox) {
    runBox.addEventListener('click', e => {
      const rep = e.target.closest && e.target.closest('[data-report]');
      if (rep) { openMcpReport(rep.dataset.report); return; }
      const pg = e.target.closest && e.target.closest('[data-mrp]');
      if (pg && !pg.disabled) loadMcpRuns(Number(pg.dataset.mrp));
    });
  }

  // 详情视图：返回 / 展开用例 / 报告筛选与分页
  on('#btnMcpDetailBack', () => closeMcpDetail());
  const detailBody = $('#mcpDetailBody');
  if (detailBody) {
    detailBody.addEventListener('click', e => {
      const t = e.target;
      const scase = t.closest && t.closest('[data-scase]');
      if (scase) {
        const row = $('#mcpScase-' + scase.dataset.scase);
        if (row) row.hidden = !row.hidden;
        return;
      }
      const rexp = t.closest && t.closest('[data-rexp]');
      if (rexp) {
        const row = $('#mcpRpt-' + rexp.dataset.rexp);
        if (row) row.hidden = !row.hidden;
        return;
      }
      const f = t.closest && t.closest('[data-rpf]');
      if (f && _mcpReport) {
        _mcpReport.filter = f.dataset.rpf;
        _mcpReport.page = 1;
        renderMcpReport();
        return;
      }
      const pg = t.closest && t.closest('[data-rpp]');
      if (pg && !pg.disabled && _mcpReport) {
        _mcpReport.page = Number(pg.dataset.rpp);
        renderMcpReport();
      }
    });
  }

  const detailActions = $('#mcpDetailActions');
  if (detailActions) {
    detailActions.addEventListener('click', e => {
      if (e.target.id === 'btnMcpScenExport' && _mcpScenCases) {
        downloadJson('mcp-scenario-cases.json', _mcpScenCases);
        toast('已导出该场景用例 JSON', 2200, 'ok');
      }
      if (e.target.id === 'btnMcpReportExport' && _mcpReport) {
        downloadJson('mcp-regression-report-' + ((_mcpReport.data.summary || {}).batchId || '') + '.json',
          _mcpReport.data);
        toast('已导出回归报告 JSON', 2200, 'ok');
      }
    });
  }
}

function fmtDiff(d) {
  if (!d) return '无 diff 数据';
  if (d.first) return '首次发现契约，无对比基线。';
  const lines = [];
  lines.push(`新增工具 ${d.added.length} 个${d.added.length ? '：' + d.added.join(', ') : ''}`);
  lines.push(`删除工具 ${d.removed.length} 个${d.removed.length ? '：' + d.removed.join(', ') : ''}`);
  lines.push(`变更工具 ${d.changed.length} 个`);
  d.changed.forEach(c =>
    lines.push(`  · ${c.tool}（${c.fields.join('/')}）required: [${c.oldRequired}] → [${c.newRequired}]`));
  if (!d.added.length && !d.removed.length && !d.changed.length)
    lines.push('接口契约无变化，用例无需更新。');
  return lines.join('\n');
}

/* ---------- 用户中心：二级菜单与二级页面 ---------- */
function setUsersMenuOpen(open) {
  if ($('#usersSubmenu')) $('#usersSubmenu').hidden = !open;
  if ($('#menuGroupUsers')) $('#menuGroupUsers').classList.toggle('open', open);
}

function setUsersPanel(sub) {
  const name = sub === 'list' ? 'list' : 'profile';
  state.usersSub = name;
  $$('#usersSubmenu .submenu-item').forEach(b => b.classList.toggle('active', b.dataset.sub === name));
  if ($('#panelProfile')) $('#panelProfile').hidden = name !== 'profile';
  if ($('#panelList')) $('#panelList').hidden = name !== 'list';
  if ($('#usersTitle')) $('#usersTitle').textContent = name === 'list' ? '用户列表' : '个人资料';
  updateUsersPageDesc();
  if (name === 'profile') renderAccount();
  else loadUsers();
}

function updateUsersPageDesc() {
  const isAdmin = (state.me || {}).role === 'admin';
  if ($('#usersPageDesc')) {
    $('#usersPageDesc').textContent = state.usersSub === 'list'
      ? (isAdmin ? '系统全部账号，可调整角色、停用、重置密码、删除'
                 : '系统全部账号，仅管理员可维护')
      : '查看账号信息、修改密码';
  }
  if ($('#userListHint')) {
    const n = state.authUsers.length;
    $('#userListHint').textContent = n
      ? `当前共 ${n} 个账号` + (isAdmin ? '，可维护角色与状态' : '')
      : '当前系统中的全部账号';
  }
}

/* ============================================================
   用例加载
   ============================================================ */
let _casesLoading = false;   // 并发防抖：避免快速切换页面时重复请求、旧响应覆盖新响应

async function loadCases(force) {
  if (_casesLoading) return;
  _casesLoading = true;
  try {
    // 有未落盘的标签/设置编辑时，先等它保存完再拉数据，避免旧数据覆盖本地编辑
    await flushSave();
    const data = force ? await post('/api/reload') : await api('/api/cases');
    state.payload = data;
    state.settings = { ...data.settings };

    data.users.forEach(u => {
      if (!state.userMeta[u.name]) {
        state.userMeta[u.name] = { tags: [...u.tags], vars: { ...u.vars } };
      }
    });
    const names = new Set(data.users.map(u => u.name));
    Object.keys(state.userMeta).forEach(n => { if (!names.has(n)) delete state.userMeta[n]; });

    // 用例级标签：以后端返回为准回填（flushSave 已保证挂起的编辑先落库）
    const ct = {};
    (data.cases || []).forEach(c => { ct[c.id] = [...(c.tags || [])]; });
    state.caseTags = ct;
    const ids = new Set(data.cases.map(c => c.id));
    state.selected.forEach(id => { if (!ids.has(id)) state.selected.delete(id); });

    if ($('#caseDirText')) $('#caseDirText').textContent = data.caseDir;
    renderAccount();

    const wb = $('#warnBar');
    if (data.warnings && data.warnings.length) {
      wb.hidden = false;
      wb.innerHTML = data.warnings.map(w => '⚠ ' + esc(w)).join('<br>');
    } else { wb.hidden = true; }

    renderCaseList();
    renderSettings();
  } catch (e) {
    $('#caseList').innerHTML =
      `<div class="empty-state"><div class="empty-icon">⚠</div>
       <p>用例加载失败：${esc(e.message)}</p>
       <p><button class="btn primary sm" data-cases-retry>重试</button></p></div>`;
  } finally {
    _casesLoading = false;
  }
}

/* ============================================================
   测试用例页
   ============================================================ */
/**
 * 用例筛选：搜索框支持按「用例名称 / 接口名称 / 标签」组合筛选。
 * 空格分隔多个关键词，需全部命中（AND）；每个关键词可命中任一字段（OR）。
 */
function caseTagsOf(c) {
  return (state.caseTags[c.id] || c.tags || []).map(t => String(t).toLowerCase());
}

function visibleCases() {
  const tokens = state.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return (state.payload ? state.payload.cases : []).slice();
  return (state.payload ? state.payload.cases : []).filter(c => {
    const name = String(c.name || '').toLowerCase();
    const iface = [c.apiName, c.apiPath, c.module, c.folder, c.url, shortPath(c.url)]
      .map(x => String(x || '').toLowerCase()).join(' ');
    const tags = caseTagsOf(c).join(' ');
    return tokens.every(t => name.includes(t) || iface.includes(t) || tags.includes(t));
  });
}

/** 是否处于筛选状态 */
function hasActiveFilter() {
  return !!state.search.trim();
}

function renderCaseList() {
  const list = $('#caseList');
  const allMatched = visibleCases();
  const total = (state.payload ? state.payload.cases.length : 0);
  const fc = $('#filterCount');
  if (fc) fc.textContent = hasActiveFilter() ? `匹配 ${allMatched.length} / ${total} 条` : '';

  // 筛选条件变化 → 回到第 1 页
  const sig = state.search;
  if (sig !== state._caseFilterSig) { state._caseFilterSig = sig; state.pages.cases = 1; }

  if (!allMatched.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div>
      <p>没有匹配的用例${hasActiveFilter() ? '（试试清空搜索条件）' : ''}</p></div>`;
    updateStats();
    return;
  }

  // 分页：每页 PAGE_SIZE 条（分组结构在当页内重建）
  const pg = paginate(allMatched, 'cases');
  const cases = pg.items;

  const groups = new Map();   // user -> Map(module -> cases)
  cases.forEach(c => {
    if (!groups.has(c.user)) groups.set(c.user, new Map());
    const g = groups.get(c.user);
    if (!g.has(c.module)) g.set(c.module, []);
    g.get(c.module).push(c);
  });

  let html = `<div class="case-head">
    <span></span>
    <span>测试用例ID</span>
    <span>用例名称</span>
    <span>接口名称</span>
    <span>标签</span>
    <span class="th-ops">操作</span>
  </div>`;
  for (const [user, modules] of groups) {
    const uCases = [].concat(...Array.from(modules.values()));
    const allSel = uCases.every(c => state.selected.has(c.id));
    const someSel = uCases.some(c => state.selected.has(c.id));
    const collapsed = state.collapsedUsers.has(user);
    const tags = ((state.userMeta[user] || {}).tags) || [];

    html += `<div class="group">
      <!-- 用户分组行：用户名 / N 条用例 / + 标签 / 执行该用户 —— 按需求隐藏（DOM 与事件保留，删除 hidden 即可恢复） -->
      <div class="group-head" hidden>
        <span class="caret" data-toggle-user="${esc(user)}">${collapsed ? '▶' : '▼'}</span>
        <input type="checkbox" data-user-cb="${esc(user)}" ${allSel ? 'checked' : ''}
               ${someSel && !allSel ? 'data-indet="1"' : ''} />
        <span class="g-name" data-toggle-user="${esc(user)}">${esc(user)}</span>
        <span class="g-meta">${uCases.length} 条用例</span>
        <span class="spacer"></span>
        <span class="tag-editor">
          ${tags.map(t => `<span class="tag">${esc(t)}<span class="x" data-untag="${esc(t)}" data-user="${esc(user)}">×</span></span>`).join('')}
          <input class="tag-input" data-tag-input="${esc(user)}" placeholder="+ 标签" />
        </span>
        <button class="btn ghost sm" data-run-user="${esc(user)}">执行该用户</button>
      </div>`;

    if (!collapsed) {
      for (const [module, mCases] of modules) {
        const mKey = user + '::' + module;
        const mCollapsed = state.collapsedModules.has(mKey);
        const mAll = mCases.every(c => state.selected.has(c.id));
        // 模块分组行（模块名 + 用例数，如「软件包列表 2」）—— 按需求隐藏（DOM 与事件保留，删除 hidden 即可恢复）
        html += `<div class="module-head" hidden>
            <span class="caret" data-toggle-module="${esc(mKey)}">${mCollapsed ? '▶' : '▼'}</span>
            <input type="checkbox" data-module-cb="${esc(mKey)}" ${mAll ? 'checked' : ''} />
            <span class="m-name" data-toggle-module="${esc(mKey)}">${esc(module)}</span>
            <span class="m-count">${mCases.length}</span>
          </div>`;
        if (!mCollapsed) html += mCases.map(caseRowHtml).join('');
      }
    }
    html += '</div>';
  }
  html += pagerHtml('cases', pg);
  list.innerHTML = html;
  $$('[data-indet="1"]', list).forEach(cb => { cb.indeterminate = true; });
  updateStats();
}

function caseRowHtml(c) {
  const sel = state.selected.has(c.id);
  const tags = state.caseTags[c.id] || [];
  const apiName = c.apiName || c.module || shortPath(c.url);
  const apiTip = `${c.apiName ? c.apiName + ' · ' : ''}${c.method} ${c.url}`;
  return `<div class="case-row${sel ? ' selected' : ''}" data-case="${esc(c.id)}">
    <input type="checkbox" data-case-cb="${esc(c.id)}" ${sel ? 'checked' : ''} />
    <span class="case-no" title="测试用例ID：${esc(c.caseNo || '-')}">${esc(c.caseNo || '-')}</span>
    <span class="case-name" title="${esc(c.name)}">${esc(c.name)}</span>
    <span class="case-iface" title="${esc(apiTip)}">
      <span class="method ${esc(c.method)}">${esc(c.method)}</span>
      <span class="iface-name">${esc(apiName)}</span>
    </span>
    <span class="tag-editor case-tags">
      ${tags.map(t => `<span class="tag">${esc(t)}<span class="x" data-ctag-untag="${esc(t)}" data-case="${esc(c.id)}" title="移除标签">×</span></span>`).join('')}
      <input class="tag-input" data-ctag-input="${esc(c.id)}" placeholder="+ 标签" title="输入后回车添加标签" />
    </span>
    <span class="row-actions ops-center">
      <button class="btn primary sm" data-run-one="${esc(c.id)}">执行</button>
      <button class="btn ghost sm" data-detail="${esc(c.id)}">详情</button>
    </span>
  </div>`;
}

/** 把用例级标签同步回 payload.cases（详情抽屉 / 过滤等复用同一份数据） */
function syncCaseTags(caseId) {
  const c = ((state.payload && state.payload.cases) || []).find(x => x.id === caseId);
  if (c) c.tags = [...(state.caseTags[caseId] || [])];
}

function updateStats() {
  const total = (state.payload ? state.payload.cases.length : 0);
  const results = Array.from(state.results.values());
  const pass = results.filter(r => r.passed).length;
  const fail = results.length - pass;
  const ms = results.reduce((a, r) => a + (r.durationMs || 0), 0);
  $('#stCases').textContent = total;
  $('#stSelected').textContent = state.selected.size;
  $('#stPass').textContent = pass;
  $('#stFail').textContent = fail;
  $('#stTime').textContent = ms;
  const btn = $('#btnRun');
  btn.disabled = state.running || state.selected.size === 0;
  btn.textContent = state.running ? '执行中…' : `执行选中 (${state.selected.size})`;
}

/* ============================================================
   执行
   ============================================================ */
function readSettingsFromUI() {
  return {
    executedBy: $('#setExecutedBy') ? $('#setExecutedBy').value.trim() : state.settings.executedBy,
    baseUrlOverride: $('#setBaseUrl') ? $('#setBaseUrl').value.trim() : state.settings.baseUrlOverride,
    timeoutMs: Number($('#setTimeout') ? $('#setTimeout').value : 15000) || 15000,
    concurrency: Math.max(1, Math.min(8, Number($('#setConcurrency') ? $('#setConcurrency').value : 1) || 1)),
    userField: $('#setUserField') ? $('#setUserField').value : state.settings.userField,
    checkHttp: $('#setCheckHttp') ? $('#setCheckHttp').checked : true,
    checkBiz: $('#setCheckBiz') ? $('#setCheckBiz').checked : true,
    bizCodeField: ($('#setBizField') ? $('#setBizField').value.trim() : '') || 'status|code',
    expectHttp: parseHttpCodes($('#setExpectHttp') ? $('#setExpectHttp').value : ''),
    maxHistory: Number($('#setMaxHistory') ? $('#setMaxHistory').value : 200) || 200,
    globalVars: collectKv('#globalVars', 'gvar'),
    globalHeaders: collectKv('#globalHeaders', 'ghead'),
  };
}
function parseHttpCodes(str) {
  const out = String(str || '').split(/[,，\s]+/).map(x => parseInt(x, 10)).filter(x => !isNaN(x));
  return out.length ? out : [200, 201, 202, 204];
}
function collectKv(sel, kind) {
  const box = $(sel);
  if (!box) return {};
  const out = {};
  $$(`[data-kvkey="${kind}"]`, box).forEach(inp => {
    const k = inp.value.trim();
    if (!k) return;
    const row = inp.closest('.kv-row');
    const v = row.querySelector(`[data-kvval="${kind}"]`);
    out[k] = v ? v.value : '';
  });
  return out;
}

async function runCases(caseIds, source) {
  if (!caseIds.length) { toast('请先勾选要执行的用例', 2600, 'warn'); return; }
  state.running = true;
  caseIds.forEach(id => state.results.delete(id));
  renderCaseList();

  const settings = readSettingsFromUI();
  state.settings = { ...state.settings, ...settings };
  const userVars = {};
  Object.entries(state.userMeta).forEach(([u, m]) => { userVars[u] = m.vars || {}; });

  const mode = $('#runMode').value;
  try {
    if (mode === 'failfast') {
      const ordered = state.payload.cases.map(c => c.id).filter(id => caseIds.includes(id));
      let allOk = true;
      let done = 0;
      for (const id of ordered) {
        const res = await post('/api/run', { ...settings, caseIds: [id], userVars, source });
        const r = res.results[0];
        state.results.set(id, r);
        done++;
        renderCaseList();
        if (!r || !r.passed) {
          allOk = false;
          toast(`执行失败：${(r && r.name) || id} 未通过（已执行 ${done}/${ordered.length}）`, 3600, 'err');
          break;
        }
      }
      if (allOk) toast(`执行成功：${ordered.length} 条用例全部通过`, 2600, 'ok');
    } else {
      const res = await post('/api/run', { ...settings, caseIds, userVars, source });
      (res.results || []).forEach(r => state.results.set(r.caseId, r));
      if (res.failedCount) {
        toast(`执行失败：${res.failedCount} 条未通过（通过 ${res.passedCount}/${res.total}，耗时 ${res.durationMs}ms）`, 3800, 'err');
      } else {
        toast(`执行成功：${res.passedCount} 条用例全部通过（耗时 ${res.durationMs}ms）`, 2800, 'ok');
      }
    }
  } catch (e) {
    toast('执行失败：' + e.message, 3600, 'err');
  } finally {
    state.running = false;
    renderCaseList();
    if (state.detailId) openCaseDetail(state.detailId);
    loadHistory(true);
  }
}

/* ============================================================
   测试场景页
   ============================================================ */
async function loadScenarios() {
  try {
    const data = await api('/api/scenarios');
    state.scenarios = data.scenarios || [];
    renderScenarios();
  } catch (e) { toast('加载场景失败：' + e.message, 3000, 'err'); }
}

function renderScenarios() {
  const box = $('#scenarioTable');
  // 与运行记录页一致：按创建时间倒序，最新在最上面
  state.scenarios.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  if (!state.scenarios.length) {
    box.innerHTML = `<div class="empty-state"><div class="empty-icon">☰</div>
      <p>还没有测试场景。点右上角「新建场景」，或到「测试用例」页勾选用例后点「存为测试场景」。</p></div>`;
    return;
  }
  const caseMap = {};
  (state.payload ? state.payload.cases : []).forEach(c => { caseMap[c.id] = c; });

  // 分页：每页 PAGE_SIZE（10）条，翻页控件放在表格末尾（与运行记录一致）
  const pg = paginate(state.scenarios, 'scenarios');
  box.innerHTML = `<table class="dt dt-sc">
    <thead><tr>
      <th style="width:210px">场景名称</th>
      <th>场景说明</th>
      <th class="ta-c" style="width:150px">用例数</th>
      <th class="ta-c" style="width:110px">用户数</th>
      <th style="width:190px">创建时间</th>
      <th style="width:190px">更新时间</th>
      <th class="ta-c" style="width:220px">操作</th>
    </tr></thead><tbody>
    ${pg.items.map(sc => {
      const ids = sc.caseIds || [];
      // 注意：必须先 filter 再用 caseMap 取回「用例对象」，否则拿到的是 id 字符串
      const found = ids.filter(id => caseMap[id]).map(id => caseMap[id]);
      const users = Array.from(new Set(found.map(c => c.user)));
      const missing = ids.length - found.length;
      return `<tr data-sc-row="${esc(sc.id)}">
        <td class="batch-id">${esc(sc.name)}</td>
        <td>${sc.description ? esc(sc.description) : '<span style="color:var(--text-faint)">-</span>'}</td>
        <td class="ta-c">${ids.length}${missing ? `<span class="badge idle" style="margin-left:5px" title="用例库中已不存在">失效 ${missing}</span>` : ''}</td>
        <td class="ta-c">${users.length}</td>
        <td class="ts">${esc(sc.createdAt || '-')}</td>
        <td class="ts">${esc(sc.updatedAt || sc.createdAt || '-')}</td>
        <td class="ta-c"><div class="row-actions ops-center">
          <button class="btn primary sm" data-sc-run="${esc(sc.id)}">执行</button>
          <button class="btn ghost sm" data-sc-edit="${esc(sc.id)}">编辑</button>
          <button class="btn danger ghost sm" data-sc-del="${esc(sc.id)}">删除</button>
        </div></td>
      </tr>`;
    }).join('')}
    </tbody></table>
    ${pagerHtml('scenarios', pg)}`;
}

/**
 * 场景明细抽屉：列出场景包含的用例（与运行记录批次明细同一抽屉样式）。
 * 用例已从用例库移除的，单独标注「失效」。
 */
function openScenarioDetail(scId) {
  const sc = state.scenarios.find(x => x.id === scId);
  if (!sc) return;
  const caseMap = {};
  (state.payload ? state.payload.cases : []).forEach(c => { caseMap[c.id] = c; });
  const ids = sc.caseIds || [];
  const found = ids.filter(id => caseMap[id]).map(id => caseMap[id]);
  const users = Array.from(new Set(found.map(c => c.user)));
  const missing = ids.filter(id => !caseMap[id]);

  $('#dwTitle').textContent = sc.name;
  $('#dwSub').textContent = `场景 ID：${sc.id}　|　创建：${sc.createdAt || '-'}　|　更新：${sc.updatedAt || sc.createdAt || '-'}`;
  $('#btnExportBatch').hidden = true;

  let html = `<div class="sec-title" style="margin-top:0">场景概况</div>
    <dl class="kv">
      <dt>场景名称</dt><dd>${esc(sc.name)}</dd>
      <dt>场景说明</dt><dd>${sc.description ? esc(sc.description) : '-'}</dd>
      <dt>用例数</dt><dd>${ids.length}${missing.length ? `　<span class="badge idle">失效 ${missing.length}</span>` : ''}</dd>
      <dt>涉及用户</dt><dd>${users.length ? esc(users.join('、')) : '-'}</dd>
      <dt>创建时间</dt><dd>${esc(sc.createdAt || '-')}</dd>
      <dt>更新时间</dt><dd>${esc(sc.updatedAt || sc.createdAt || '-')}</dd>
    </dl>`;

  html += `<div class="sec-title">场景内的用例（${ids.length} 条）</div>`;
  if (!ids.length) {
    html += '<div class="empty-hint">该场景还没有用例，点「编辑」添加。</div>';
  } else {
    html += `<table class="dt">
      <thead><tr>
        <th class="ta-c" style="width:44px">#</th>
        <th>用例名称</th>
        <th style="width:150px">接口</th>
        <th style="width:120px">测试用户</th>
        <th class="ta-c" style="width:110px">状态</th>
      </tr></thead><tbody>
      ${ids.map((id, i) => {
        const c = caseMap[id];
        if (!c) {
          return `<tr><td class="mono ta-c">${i + 1}</td>
            <td colspan="3" style="color:var(--text-faint)">${esc(id)}</td>
            <td class="ta-c"><span class="badge idle">已失效</span></td></tr>`;
        }
        return `<tr data-detail="${esc(c.id)}">
          <td class="mono ta-c">${i + 1}</td>
          <td>${esc(c.name || '未命名用例')}</td>
          <td class="mono">${esc(c.apiName || shortPath(c.url) || '-')}</td>
          <td>${esc(c.user || '-')}</td>
          <td class="ta-c"><span class="badge pass">有效</span></td>
        </tr>`;
      }).join('')}
      </tbody></table>`;
  }

  $('#dwBody').innerHTML = html;
  state.batchDetail = null;
  $('#drawer').hidden = false;
  $('#drawerMask').hidden = false;
}

function openScenarioModal(scenario, presetIds) {
  state.editingScenarioId = scenario ? scenario.id : null;
  state.modalPicked = new Set(scenario ? (scenario.caseIds || []) : (presetIds || []));
  $('#mdTitle').textContent = scenario ? '编辑测试场景' : '新建测试场景';

  const groups = new Map();
  (state.payload ? state.payload.cases : []).forEach(c => {
    if (!groups.has(c.user)) groups.set(c.user, []);
    groups.get(c.user).push(c);
  });

  let picker = '';
  for (const [user, cs] of groups) {
    picker += `<div class="cp-group">
      <div class="cp-head">
        <input type="checkbox" data-cp-user="${esc(user)}" />
        <span>${esc(user)}</span><span class="cp-count">${cs.length} 条</span>
      </div>
      ${cs.map(c => `<label class="cp-item">
        <input type="checkbox" data-cp-case="${esc(c.id)}" data-cp-owner="${esc(user)}"
               ${state.modalPicked.has(c.id) ? 'checked' : ''} />
        <span>${esc(c.name)}</span>
        <span class="cp-p">${esc(c.method)} ${esc(shortPath(c.url))}</span>
      </label>`).join('')}
    </div>`;
  }

  $('#mdBody').innerHTML = `
    <label class="field"><span>场景名称</span>
      <input type="text" id="scName" value="${esc(scenario ? scenario.name : '')}" placeholder="如 软件包管理-回归场景" /></label>
    <label class="field"><span>场景说明<em>可选</em></span>
      <input type="text" id="scDesc" value="${esc(scenario ? (scenario.description || '') : '')}" placeholder="这条场景验证什么" /></label>
    <div class="field">
      <span>选择用例（已选 <b id="scPickedCount">${state.modalPicked.size}</b> 条）
        <em>点用户行可整组勾选</em></span>
      <div style="display:flex;gap:7px;margin-bottom:7px">
        <button class="btn ghost sm" id="scPickAll">全选</button>
        <button class="btn ghost sm" id="scPickNone">清空</button>
      </div>
      <div class="case-picker">${picker || '<div class="empty-hint" style="padding:12px">暂无用例</div>'}</div>
    </div>`;

  $('#modal').hidden = false;
  $('#modalMask').hidden = false;
}

function closeModal() {
  $('#modal').hidden = true;
  $('#modalMask').hidden = true;
  state.editingScenarioId = null;
}

async function saveScenario() {
  const name = $('#scName').value.trim();
  if (!name) { toast('请填写场景名称'); return; }
  const payload = {
    scenario: {
      id: state.editingScenarioId || undefined,
      name,
      description: $('#scDesc').value.trim(),
      caseIds: Array.from(state.modalPicked),
    },
  };
  try {
    await post('/api/scenarios/save', payload);
    toast('场景已保存', 2200, 'ok');
    closeModal();
    loadScenarios();
  } catch (e) { toast('保存失败：' + e.message, 3000, 'err'); }
}

/* ============================================================
   运行记录页
   ============================================================ */
async function loadHistory(silent) {
  try {
    const data = await api('/api/history');
    state.history = data;
    renderHistory();
  } catch (e) { if (!silent) toast('加载运行记录失败：' + e.message, 3000, 'err'); }
}

function renderHistory() {
  const { batches = [], stats = {} } = state.history || {};
  $('#hsBatch').textContent = stats.batchCount || 0;
  $('#hsCase').textContent = stats.caseCount || 0;
  $('#hsPass').textContent = stats.passedCount || 0;
  $('#hsFail').textContent = stats.failedCount || 0;
  const rate = stats.caseCount ? ((stats.passedCount / stats.caseCount) * 100).toFixed(1) + '%' : '-';
  $('#hsRate').textContent = rate;

  const box = $('#historyTable');
  if (!batches.length) {
    box.innerHTML = `<div class="empty-state"><div class="empty-icon">◷</div>
      <p>还没有运行记录。到「测试用例」或「测试场景」执行一次就会出现。</p></div>`;
    return;
  }
  const pg = paginate(batches, 'history');
  box.innerHTML = `<table class="dt dt-hs">
    <thead><tr>
      <th style="width:210px">执行批次</th>
      <th style="width:140px">执行用户</th>
      <th style="width:190px">时间戳</th>
      <th style="width:200px">测试环境</th>
      <th>来源</th>
      <th class="ta-c" style="width:120px">用例数</th>
      <th class="ta-c" style="width:100px">通过</th>
      <th class="ta-c" style="width:100px">失败</th>
      <th class="ta-c" style="width:130px" title="本批次内所有用例执行耗时之和">耗时</th>
      <th class="ta-c" style="width:210px">操作</th>
    </tr></thead><tbody>
    ${pg.items.map(b => `<tr data-batch="${esc(b.batchId)}">
      <td class="batch-id">${esc(b.batchId)}</td>
      <td>${esc(b.executedBy || '-')}</td>
      <td class="ts">${esc(b.startedAt || '-')}</td>
      <td class="mono">${b.environment ? `<span class="env-chip">${esc(b.environment)}</span>` : '-'}</td>
      <td>${esc((b.source && b.source.name) || '-')}
        ${b.source && b.source.type === 'scenario' ? '<span class="badge idle" style="margin-left:6px">场景</span>' : ''}</td>
      <td class="ta-c">${b.total}</td>
      <td class="ta-c"><span class="badge pass">${b.passedCount}</span></td>
      <td class="ta-c">${b.failedCount ? `<span class="badge fail">${b.failedCount}</span>` : '<span class="badge idle">0</span>'}</td>
      <td class="mono ta-c" title="${esc(batchDurTip(b))}">${fmtMs(b.durationMs)}</td>
      <td class="ta-c"><div class="row-actions ops-center">
        <button class="btn ghost sm" data-batch-view="${esc(b.batchId)}">查看</button>
        <button class="btn ghost sm" data-batch-export="${esc(b.batchId)}" title="导出当前批次的执行记录为 HTML">导出</button>
      </div></td>
    </tr>`).join('')}
    </tbody></table>
    ${pagerHtml('history', pg)}`;
}

async function openBatchDetail(batchId) {
  try {
    const data = await post('/api/history/detail', { batchId });
    if (!data.ok) throw new Error(data.error || '批次不存在');
    const b = data.batch;
    $('#dwTitle').textContent = '执行批次 ' + b.batchId;
    $('#dwSub').textContent = `执行用户：${b.executedBy}　|　时间戳：${b.startedAt}　|　测试环境：${b.environment || '-'}　|　来源：${(b.source && b.source.name) || '-'}`;

    let html = `<div class="sec-title" style="margin-top:0">批次统计</div>` + batchChartHtml(b);

    html += `<div class="sec-title">批次概况</div>
      <dl class="kv">
        <dt>执行批次</dt><dd>${esc(b.batchId)}</dd>
        <dt>执行用户</dt><dd>${esc(b.executedBy || '-')}</dd>
        <dt>时间戳</dt><dd>${esc(b.startedAt || '-')}</dd>
        <dt>测试环境</dt><dd><span class="env-chip">${esc(b.environment || '-')}</span></dd>
        <dt>来源</dt><dd>${esc((b.source && b.source.name) || '-')}（${esc((b.source && b.source.type) || 'cases')}）</dd>
        <dt>用例数</dt><dd>${b.total}</dd>
        <dt>通过 / 失败</dt><dd><span style="color:var(--ok)">${b.passedCount}</span> / <span style="color:var(--bad)">${b.failedCount}</span></dd>
        <dt>用例耗时合计</dt><dd>${fmtMs(b.durationMs)}
          <span style="color:var(--text-faint);font-size:11px">（本批次 ${b.total} 条用例执行耗时之和）</span></dd>
        ${batchDur(b).same ? '' : `<dt>真实经过时间</dt><dd>${fmtMs(batchDur(b).wall)}
          <span style="color:var(--text-faint);font-size:11px">（含并发，故小于合计）</span></dd>`}
      </dl>`;

    html += `<div class="sec-title">本次执行的全部用例记录（${(b.results || []).length} 条）</div>`;
    html += (b.results || []).map((r, i) => batchRecHtml(r, i)).join('') || '<div class="empty-hint">无记录</div>';

    $('#dwBody').innerHTML = html;
    state.batchDetail = b;
    $('#btnExportBatch').hidden = false;
    $('#drawer').hidden = false;
    $('#drawerMask').hidden = false;
  } catch (e) { toast('打开批次失败：' + e.message, 3000, 'err'); }
}

/* ============================================================
   记录详情渲染工具（运行记录 / 用例详情共用）
   ============================================================ */
function fmtVal(v) {
  if (v === null) return 'null';
  if (v === undefined) return '';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
  return String(v);
}

function originOf(url) {
  const m = String(url || '').match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i);
  return m ? m[1] : '';
}

function bytesText(n) {
  if (n === null || n === undefined || n === '') return '-';
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function utf8Bytes(s) {
  s = String(s || '');
  try { return new TextEncoder().encode(s).length; } catch (e) { return s.length; }
}

function cellHtml(c) {
  if (c === null || c === undefined) return '';
  if (typeof c === 'object') {
    if (c.html !== undefined) return c.html;
    if (c.text !== undefined) return esc(String(c.text));
    return '';
  }
  return esc(String(c));
}

/** 通用表格：headers = ['#','名称'] 或 [{t:'名称', w:'90px', align:'center'}]；rows = [[cell...]] 或 [{cls, cells:[[...]]}] */
function tableHtml(headers, rows, emptyText) {
  const hs = (headers || []).map(h => (typeof h === 'object' ? h : { t: h }));
  // 列对齐：表头与其下方数据使用同一个 class，保证两者始终一致
  const alignCls = h => (h.align === 'center' ? ' class="ta-c"' : (h.align === 'right' ? ' class="ta-r"' : ''));
  const head = hs.length
    ? `<thead><tr>${hs.map(h => `<th${alignCls(h)}${h.w ? ` style="width:${h.w}"` : ''}>${esc(h.t)}</th>`).join('')}</tr></thead>`
    : '';
  const body = (rows && rows.length)
    ? `<tbody>${rows.map(r => {
        const arr = Array.isArray(r) ? r : (r.cells || []);
        const cls = (!Array.isArray(r) && r.cls) ? ` class="${r.cls}"` : '';
        return `<tr${cls}>${arr.map((c, i) => {
          // 单元格对齐跟随该列表头的 align 设置
          const al = alignCls(hs[i] || {});
          const own = (c && typeof c === 'object' && c.cls) ? c.cls : '';
          const cc = (al || own) ? ` class="${[al ? al.slice(8, -1) : '', own].filter(Boolean).join(' ')}"` : '';
          return `<td${cc}>${cellHtml(c)}</td>`;
        }).join('')}</tr>`;
      }).join('')}</tbody>`
    : `<tbody><tr><td colspan="${hs.length || 1}"><span class="empty-hint">${esc(emptyText || '（无）')}</span></td></tr></tbody>`;
  return `<div class="rt-wrap"><table class="rt">${head}${body}</table></div>`;
}

/** 把任意 JSON 展平成 {k, v} 行（嵌套用 . 与 [i]，最多 4 层） */
function flattenRows(val, prefix, out, depth) {
  out = out || [];
  depth = depth || 0;
  if (out.length >= 400) return out;
  const key = prefix === '' || prefix === undefined ? '(根)' : prefix;
  if (val === null || typeof val !== 'object') {
    out.push({ k: key, v: fmtVal(val) });
    return out;
  }
  if (Array.isArray(val)) {
    if (!val.length) { out.push({ k: key, v: '[]' }); return out; }
    if (depth >= 4) { out.push({ k: key, v: JSON.stringify(val) }); return out; }
    val.forEach((v, i) => flattenRows(v, `${prefix}[${i}]`, out, depth + 1));
    return out;
  }
  const keys = Object.keys(val);
  if (!keys.length) { out.push({ k: key, v: '{}' }); return out; }
  if (depth >= 4) { out.push({ k: key, v: JSON.stringify(val) }); return out; }
  keys.forEach(k => flattenRows(val[k], prefix ? `${prefix}.${k}` : k, out, depth + 1));
  return out;
}

/** 文本 → 表格行；非 JSON 则原样一行 */
function jsonRows(text) {
  if (text === null || text === undefined || text === '') return [];
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { return [{ k: '(原始内容)', v: String(text) }]; }
  return flattenRows(obj, '', [], 0);
}

/** 从完整 URL 解析 query 参数 */
function queryRows(url) {
  const s = String(url || '');
  const qi = s.indexOf('?');
  if (qi < 0) return [];
  return s.slice(qi + 1).split('&').filter(Boolean).map(p => {
    const i = p.indexOf('=');
    const k = i < 0 ? p : p.slice(0, i);
    const v = i < 0 ? '' : p.slice(i + 1);
    let dk = k, dv = v;
    try { dk = decodeURIComponent(k.replace(/\+/g, ' ')); } catch (e) { /* ignore */ }
    try { dv = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { /* ignore */ }
    return { k: dk, v: dv };
  });
}

/** 把底层网络异常翻译成人能看懂的失败原因 */
function errorKind(err) {
  const s = String(err || '');
  if (!s) return '';
  if (/timed out|timeout|超时/i.test(s)) return '请求超时';
  if (/connection refused|拒绝/i.test(s)) return '连接被拒绝（服务未启动或端口不通）';
  if (/getaddrinfo|name or service not known|nodename nor servname|dns|解析/i.test(s)) return '域名解析失败';
  if (/sslerror|certificate|证书/i.test(s)) return '证书 / SSL 校验失败';
  if (/remotedisconnected|connection reset|brokenpipe|aborted|econnreset/i.test(s)) return '连接被中断';
  if (/urlopen error|urlerror|cannot connect|network is unreachable|unreachable/i.test(s)) return '网络不可达';
  if (/invalid url|unknown url type/i.test(s)) return '请求地址不合法';
  return '请求异常';
}

function bizCodeOf(r) {
  const a = (r.asserts || []).find(x => /status|code/i.test(String(x.path || '')) && x.actual !== undefined);
  if (a) return a.actual;
  try {
    const o = JSON.parse(r.responseBody || '');
    if (o && typeof o === 'object') {
      if (o.status !== undefined) return o.status;
      if (o.code !== undefined) return o.code;
    }
  } catch (e) { /* ignore */ }
  return undefined;
}

/** 失败详情（放在返回结果表格中） */
function errorDetailHtml(r) {
  const parts = [];
  const bad = (r.asserts || []).filter(a => !a.passed && !a.skipped);
  if (r.error) {
    parts.push(`<div><b style="color:var(--bad)">${esc(errorKind(r.error) || '请求异常')}</b></div>
      <div class="mono" style="margin-top:2px">${esc(r.error)}</div>`);
  } else if (r.status === null || r.status === undefined) {
    parts.push('<div><b style="color:var(--bad)">无响应</b>：请求未返回任何响应（超时 / 连接失败）</div>');
  }
  if (bad.length) {
    parts.push(`<div style="margin-top:${r.error ? '6' : '0'}px"><b>${bad.length} 项断言未通过：</b></div>` +
      bad.map(a => `<div class="mono">· ${esc(a.desc || '')}　期望 <b>${esc(JSON.stringify(a.expected))}</b>，实际 <b>${esc(JSON.stringify(a.actual))}</b></div>`).join(''));
  }
  if (!parts.length) parts.push('<div>执行失败（未捕获到具体错误信息，请查看响应体与断言明细）</div>');
  return parts.join('');
}

/** 单条执行记录详情：基本信息 + 请求参数 + 返回结果 + 响应体（默认收起）
 *  opts: { request, asserts, body, openBody } —— 缺省全部包含；导出时可裁剪 */
function execRecordHtml(r, opts) {
  opts = opts || {};
  const incReq = opts.request !== false;
  const incAssert = opts.asserts !== false;
  const incBody = opts.body !== false;
  const req = r.request || {};
  const env = r.env || originOf(req.url) || '-';
  const iface = r.interface || r.module || r.folder || '-';
  const failed = !r.passed;
  const sizeBytes = r.responseBytes !== undefined ? r.responseBytes : utf8Bytes(r.responseBody);
  let html = '';

  /* ---- 基本信息 ---- */
  html += `<div class="sub-label">基本信息</div>` + tableHtml(['项目', '内容'], [
    [{ cls: 'k', text: '测试用例名称' }, { cls: 'v', text: r.caseName || r.name || '-' }],
    [{ cls: 'k', text: '接口名称' }, { cls: 'v', text: iface }],
    [{ cls: 'k', text: '测试环境' }, { cls: 'v', html: `<span class="env-chip">${esc(env)}</span>` }],
    [{ cls: 'k', text: '执行用户' }, { cls: 'v', text: r.user || '-' }],
    [{ cls: 'k', text: '请求方法' }, { cls: 'v', text: req.method || '-' }],
    [{ cls: 'k', text: '接口地址' }, { cls: 'v', text: req.url || '-' }],
    [{ cls: 'k', text: '执行耗时' }, { cls: 'v', text: (r.durationMs || 0) + ' ms' }],
  ]);

  /* ---- 请求参数 ---- */
  if (incReq) {
    html += `<div class="sub-label">请求参数</div>`;
    const qRows = (req.query && req.query.length)
      ? req.query.map(q => [{ cls: 'k', text: q.key }, { cls: 'v', text: fmtVal(q.value) }])
      : queryRows(req.url).map(q => [{ cls: 'k', text: q.k }, { cls: 'v', text: q.v }]);
    html += `<div class="rt-cap">Query 参数（${qRows.length}）</div>` +
      tableHtml(['参数名', '参数值'], qRows, '（无 Query 参数）');
    const hRows = Object.keys(req.headers || {}).map(k => [{ cls: 'k', text: k }, { cls: 'v', text: fmtVal(req.headers[k]) }]);
    html += `<div class="rt-cap">请求头（${hRows.length}）</div>` + tableHtml(['Header', '值'], hRows, '（无请求头）');
    const bRows = jsonRows(req.body);
    html += `<div class="rt-cap">请求体（${bRows.length}）</div>` + tableHtml(['字段', '值'], bRows, '（无请求体）');
  }

  /* ---- 返回结果 ---- */
  html += `<div class="sub-label">返回结果</div>`;
  const biz = bizCodeOf(r);
  const resRows = [
    [{ cls: 'k', text: '执行结论' }, { cls: 'v', html: failed
      ? '<span style="color:var(--bad);font-weight:700">✕ 失败</span>'
      : '<span style="color:var(--ok);font-weight:700">✓ 通过</span>' }],
    [{ cls: 'k', text: 'HTTP 状态码' }, { cls: 'v', text: (r.status === null || r.status === undefined) ? '无响应' : r.status }],
    [{ cls: 'k', text: '业务码' }, { cls: 'v', text: biz === undefined ? '-' : fmtVal(biz) }],
    [{ cls: 'k', text: '响应大小' }, { cls: 'v', text: bytesText(sizeBytes) }],
    [{ cls: 'k', text: '执行耗时' }, { cls: 'v', text: (r.durationMs || 0) + ' ms' }],
  ];
  if (failed) resRows.push({ cls: 'bad', cells: [{ cls: 'k', text: '失败原因' }, { cls: 'v', html: errorDetailHtml(r) }] });
  html += tableHtml(['项目', '结果'], resRows);

  /* 断言明细 */
  if (incAssert) {
    const aRows = (r.asserts || []).map((a, i) => ({
      cls: a.skipped ? 'skip' : (a.passed ? '' : 'bad'),
      cells: [
        { text: i + 1 },
        { html: esc(a.desc || '') + (a.skipped ? ' <span class="empty-hint">（响应中无该字段，已跳过）</span>' : '') },
        { text: JSON.stringify(a.expected) },
        { text: a.actual === undefined ? '-' : JSON.stringify(a.actual) },
        { html: `<span style="font-weight:700;color:${a.skipped ? 'var(--text-faint)' : (a.passed ? 'var(--ok)' : 'var(--bad)')}">${a.skipped ? '— 跳过' : (a.passed ? '✓ 通过' : '✕ 失败')}</span>` },
      ],
    }));
    html += `<div class="rt-cap">断言明细（${aRows.length}）</div>` +
      tableHtml([{ t: '#', align: 'center' }, '断言项', '期望值', '实际值', '结果'], aRows, '（无断言）');
  }

  /* ---- 响应体（默认收起） ---- */
  if (incBody) {
    const truncTip = r.bodyTruncated ? '<div class="empty-hint" style="padding:6px 0 0">响应体过大，运行记录中仅保留前 30000 字符</div>' : '';
    html += `<details class="fold"${opts.openBody ? ' open' : ''}>
      <summary>响应体 <span class="fold-hint">${bytesText(sizeBytes)} · 点击展开</span></summary>
      <div class="fold-body"><div class="code">${esc(prettyBody(r.responseBody))}</div>${truncTip}</div>
    </details>`;
  }

  return html;
}

/* ============================================================
   运行记录页 单条记录
   ============================================================ */
function batchRecHtml(r, i) {
  const cls = r.passed ? 'pass' : 'fail';
  const label = r.passed ? '通过' : '失败';
  return `<div class="rec">
    <div class="rec-head" data-rec-toggle="${i}">
      <span class="badge ${cls}">${label}</span>
      <span class="rec-name">${esc(r.name)}</span>
      <span class="ts">${esc(r.status ?? 'ERR')} · ${r.durationMs}ms</span>
      <span class="mono" style="color:var(--text-faint)">${esc(r.user || '')}</span>
    </div>
    <div class="rec-body" data-rec-body="${i}" hidden>
      ${execRecordHtml(r)}
    </div>
  </div>`;
}

/* ============================================================
   运行记录导出为 HTML（单文件、样式内嵌）
   ============================================================ */
const EXPORT_CSS = `
*{box-sizing:border-box}
:root{
  --border:#e3e6ef;--border-strong:#d2d7e6;--text:#1f2430;--text-dim:#6b7383;--text-faint:#9aa2b4;
  --accent:#4f46e5;--accent-soft:#eef0ff;--ok:#0f9d58;--ok-soft:#e7f7ee;--bad:#e5484d;--bad-soft:#fdecee;
  --warn:#b7791f;--warn-soft:#fdf5e3;--code-bg:#f3f4f8;--sunken:#eef0f6;--card:#ffffff;
  --mono:ui-monospace,SFMono-Regular,"JetBrains Mono",Consolas,"Courier New",monospace;
}
body{margin:0;padding:26px 26px 70px;background:#f5f6fa;color:var(--text);font-size:13px;line-height:1.62;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1120px;margin:0 auto}
.mono{font-family:var(--mono);font-size:11px}
.mut{color:var(--text-faint)}
.empty-hint{color:var(--text-faint);font-size:11.5px}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}

/* 头部 */
.ex-head{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px 22px;
  box-shadow:0 1px 2px rgba(20,26,45,.05),0 8px 24px rgba(20,26,45,.05)}
.ex-head h1{margin:0 0 6px;font-size:20px;letter-spacing:.2px}
.ex-meta{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:11.5px;color:var(--text-faint);font-family:var(--mono)}
.ex-stats{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}
.ex-stat{flex:1 1 120px;background:var(--sunken);border:1px solid var(--border);border-radius:9px;
  padding:9px 12px;display:flex;flex-direction:column}
.ex-stat b{font-size:19px;font-weight:700;line-height:1.2}
.ex-stat span{font-size:11px;color:var(--text-dim);margin-top:2px}
.ex-stat.ok b{color:var(--ok)} .ex-stat.bad b{color:var(--bad)}

/* 目录 */
.ex-toc{margin-top:14px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px;
  box-shadow:0 1px 2px rgba(20,26,45,.05),0 8px 24px rgba(20,26,45,.05)}
.toc-list{border:1px solid var(--border);border-radius:8px;overflow:hidden}
.toc-list table{width:100%;border-collapse:collapse;font-size:11.5px}
.toc-list th,.toc-list td{border-bottom:1px solid var(--border);padding:6px 9px;text-align:left;vertical-align:top}
.toc-list th.num,.toc-list td.num{text-align:center}
.toc-list td.num .badge{margin:0 auto}
.toc-list th{background:var(--sunken);color:var(--text-dim);font-weight:600;white-space:nowrap}
.toc-list tr:last-child td{border-bottom:none}
.toc-list td.bid a{font-family:var(--mono);font-weight:650}

/* 批次 */
.ex-batch{margin-top:22px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;
  box-shadow:0 1px 2px rgba(20,26,45,.05),0 8px 24px rgba(20,26,45,.05)}
.ex-batch > h2{margin:0 0 4px;font-size:15px;font-family:var(--mono);letter-spacing:.2px}
.batch-meta{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:11.5px;color:var(--text-dim);
  font-family:var(--mono);padding-bottom:10px;border-bottom:1px solid var(--border);margin-bottom:6px}

.sec-title{font-size:11.5px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.6px;
  margin:18px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--border)}
.sub-label{font-size:11.5px;font-weight:700;color:var(--text-dim);margin:12px 0 6px}
.rec + .sub-label, .rec:first-of-type + .sub-label{margin-top:0}

/* 单条用例记录卡片 */
.rec{border:1px solid var(--border);border-radius:9px;margin-bottom:10px;overflow:hidden;background:var(--card)}
.rec-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:8px 11px;background:var(--sunken)}
.rec.pass .rec-head{border-left:3px solid var(--ok)}
.rec.fail .rec-head{border-left:3px solid var(--bad)}
.rec-name{font-size:12.5px;font-weight:600;flex:1;min-width:140px}
.badge{display:inline-block;padding:1px 8px;border-radius:5px;font-size:10.5px;font-weight:700;white-space:nowrap}
.badge.pass{background:var(--ok-soft);color:var(--ok)}
.badge.fail{background:var(--bad-soft);color:var(--bad)}
.badge.idle{background:var(--sunken);color:var(--text-faint)}
.rec-body{padding:11px;border-top:1px solid var(--border)}

/* 小表格 */
.rt-cap{font-size:11px;color:var(--text-faint);margin:8px 0 4px}
.rt-wrap{border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:2px}
.rt{width:100%;border-collapse:collapse;font-size:11.5px}
.rt th,.rt td{border-bottom:1px solid var(--border);padding:5px 9px;text-align:left;vertical-align:top;word-break:break-all}
.rt th{background:var(--sunken);color:var(--text-dim);font-weight:600;white-space:nowrap}
.rt tr:last-child td{border-bottom:none}
.rt td.k{width:148px;color:var(--text-dim);font-family:var(--mono);font-size:10.5px}
.rt td.v{font-family:var(--mono);font-size:11px;line-height:1.6}
.rt tr.bad td{background:var(--bad-soft)}
.rt tr.skip td{color:var(--text-faint)}
.env-chip{display:inline-block;padding:1px 7px;border-radius:5px;background:var(--accent-soft);color:var(--accent);
  font-family:var(--mono);font-size:10.5px;border:1px solid var(--border-strong)}
.code{background:var(--code-bg);border:1px solid var(--border);border-radius:8px;padding:11px 13px;
  font-family:var(--mono);font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-all}
.fold{border:1px solid var(--border);border-radius:8px;margin-top:12px;overflow:hidden;background:var(--card)}
.fold > summary{cursor:pointer;padding:8px 11px;font-size:11.5px;font-weight:600;color:var(--text-dim);
  display:flex;align-items:center;gap:7px;list-style:none;user-select:none}
.fold > summary::-webkit-details-marker{display:none}
.fold > summary::before{content:'▸';color:var(--text-faint)}
.fold[open] > summary::before{content:'▾'}
.fold > summary:hover{background:var(--accent-soft);color:var(--text)}
.fold .fold-hint{font-weight:400;color:var(--text-faint);font-size:10.5px}
.fold .fold-body{border-top:1px solid var(--border)}
.fold .fold-body .code{border:none;border-radius:0}

/* 批次统计卡片（环形图 + 指标） */
.bchart{display:flex;gap:26px;align-items:center;flex-wrap:wrap;background:var(--sunken);
  border:1px solid var(--border);border-radius:10px;padding:14px 18px;margin-bottom:4px}
.bchart-donut{flex:0 0 auto;color:var(--text)}
.bchart-legend{display:flex;flex-direction:column;gap:9px;font-size:12px;min-width:130px}
.lg{display:flex;align-items:baseline;gap:7px;white-space:nowrap}
.lg-dot{width:8px;height:8px;border-radius:50%;align-self:center;flex:0 0 8px}
.lg-dot.ok{background:var(--ok)} .lg-dot.bad{background:var(--bad)} .lg-dot.idle{background:#c9cede}
.lg-name{color:var(--text-dim)}
.lg b{font-size:13px}
.lg b.ok{color:var(--ok)} .lg b.bad{color:var(--bad)} .lg b.idle{color:var(--text-faint)}
.lg-pct{color:var(--text-faint);font-size:11px}
.bchart-metrics{flex:1;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;min-width:240px}
.bcm{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:9px 12px;cursor:help}
.bcm span{display:block;font-size:11px;color:var(--text-dim);margin-bottom:2px}
.bcm b{font-size:16px;font-family:var(--mono);font-weight:700}

/* 工具栏 */
.toolbar{position:fixed;right:20px;bottom:20px;display:flex;gap:8px;z-index:10}
.toolbar button{cursor:pointer;font:inherit;font-size:12px;padding:7px 14px;border-radius:8px;
  border:1px solid var(--border-strong);background:var(--card);color:var(--text);
  box-shadow:0 4px 14px rgba(20,26,45,.14)}
.toolbar button:hover{border-color:var(--accent);color:var(--accent)}
.ex-foot{margin-top:26px;text-align:center;font-size:11px;color:var(--text-faint)}

/* 打印 */
@media print{
  body{background:#fff;padding:0;font-size:11.5px}
  .toolbar{display:none}
  .ex-head,.ex-toc,.ex-batch{box-shadow:none;border-color:#ccc}
  .ex-batch{page-break-inside:auto}
  .rec{page-break-inside:avoid}
  .fold{border-color:#ccc}
  .fold > summary::before{content:''}
  .rt th{position:static}
  a{color:inherit}
}
`;

function exportStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 批次测试环境：优先取批次字段，旧记录从请求地址兜底推断 */
function batchEnv(b) {
  if (b.environment) return b.environment;
  const seen = [];
  (b.results || []).forEach(r => {
    const o = r.env || originOf((r.request || {}).url);
    if (o && !seen.includes(o)) seen.push(o);
  });
  return seen.join(' + ');
}

function exportRecHtml(r, opts) {
  const cls = r.passed ? 'pass' : 'fail';
  return `<article class="rec ${cls}">
    <div class="rec-head">
      <span class="badge ${cls}">${r.passed ? '通过' : '失败'}</span>
      <span class="rec-name">${esc(r.caseName || r.name || '-')}</span>
      <span class="mono mut">HTTP ${esc(r.status === null || r.status === undefined ? 'ERR' : r.status)} · ${r.durationMs || 0}ms${r.user ? ' · ' + esc(r.user) : ''}</span>
    </div>
    <div class="rec-body">${execRecordHtml(r, opts)}</div>
  </article>`;
}

/** 生成自包含的 HTML 报告（样式内嵌，可直接双击打开 / 转发 / 打印为 PDF） */
function buildExportHtml(data, opts) {
  const batches = data.batches || [];
  const stats = data.stats || {};
  const title = String(opts.title || '').trim() || '接口自动化测试运行记录';
  const rate = stats.caseCount ? ((stats.passedCount / stats.caseCount) * 100).toFixed(1) + '%' : '-';
  const recOpts = { request: opts.request, asserts: opts.asserts, body: opts.body, openBody: opts.openBody };
  const generatedAt = data.generatedAt || '';

  const tocRows = batches.map((b, i) => `<tr>
      <td class="bid"><a href="#batch-${i + 1}">${esc(b.batchId)}</a></td>
      <td>${esc(b.executedBy || '-')}</td>
      <td class="mono">${esc(b.startedAt || '-')}</td>
      <td class="mono">${esc(batchEnv(b) || '-')}</td>
      <td>${esc((b.source && b.source.name) || '-')}</td>
      <td class="num">${b.total || 0}</td>
      <td class="num"><span class="badge pass">${b.passedCount || 0}</span></td>
      <td class="num">${(b.failedCount || 0) ? `<span class="badge fail">${b.failedCount}</span>` : '<span class="badge idle">0</span>'}</td>
      <td class="mono num" title="${esc(batchDurTip(b))}">${fmtMs(b.durationMs)}</td>
    </tr>`).join('');

  const sections = batches.map((b, i) => {
    const results = b.results || [];
    return `<section class="ex-batch" id="batch-${i + 1}">
      <h2>批次 ${esc(b.batchId)}</h2>
      <div class="sec-title" style="margin-top:8px">批次统计</div>
      ${batchChartHtml(b)}
      <div class="batch-meta" style="margin-top:12px">
        <span>执行用户：${esc(b.executedBy || '-')}</span>
        <span>时间戳：${esc(b.startedAt || '-')}</span>
        <span>测试环境：${esc(batchEnv(b) || '-')}</span>
        <span>来源：${esc((b.source && b.source.name) || '-')}</span>
        <span>用例数：${results.length || b.total || 0}</span>
        <span>通过 ${b.passedCount || 0} / 失败 ${b.failedCount || 0}</span>
        <span>用例耗时合计：${fmtMs(b.durationMs)}</span>
        ${batchDur(b).same ? '' : `<span>真实经过时间：${fmtMs(batchDur(b).wall)}</span>`}
      </div>
      <div class="sec-title">本次执行的全部用例记录（${results.length} 条）</div>
      ${results.map(r => exportRecHtml(r, recOpts)).join('') || '<div class="empty-hint">无记录</div>'}
    </section>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(title)}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="ex-head">
    <h1>${esc(title)}</h1>
    <div class="ex-meta">
      <span>导出时间：${esc(generatedAt)}</span>
      <span>用例目录：${esc(data.caseDir || '-')}</span>
      <span>数据来源：接口自动化测试平台</span>
    </div>
    <div class="ex-stats">
      <div class="ex-stat"><b>${stats.batchCount || 0}</b><span>执行批次</span></div>
      <div class="ex-stat"><b>${stats.caseCount || 0}</b><span>累计用例执行</span></div>
      <div class="ex-stat ok"><b>${stats.passedCount || 0}</b><span>通过</span></div>
      <div class="ex-stat bad"><b>${stats.failedCount || 0}</b><span>失败</span></div>
      <div class="ex-stat"><b>${rate}</b><span>通过率</span></div>
    </div>
  </header>

  <nav class="ex-toc">
    <div class="sec-title" style="margin-top:0">批次索引（按时间戳倒序）</div>
    <div class="toc-list">
      <table><thead><tr>
        <th>执行批次</th><th>执行用户</th><th>时间戳</th><th>测试环境</th><th>来源</th>
        <th class="num">用例数</th><th class="num">通过</th><th class="num">失败</th><th class="num">耗时</th>
      </tr></thead><tbody>
      ${tocRows || '<tr><td colspan="9"><span class="empty-hint">（无批次）</span></td></tr>'}
      </tbody></table>
    </div>
  </nav>

  ${sections || '<section class="ex-batch"><div class="empty-hint">无运行记录</div></section>'}

  <div class="ex-foot">由「接口自动化测试平台」导出于 ${esc(generatedAt)}　·　共 ${stats.batchCount || 0} 个批次 / ${stats.caseCount || 0} 条用例执行</div>
</div>

<div class="toolbar">
  <button type="button" onclick="document.querySelectorAll('details.fold').forEach(d=>d.open=true)">展开全部响应体</button>
  <button type="button" onclick="document.querySelectorAll('details.fold').forEach(d=>d.open=false)">收起全部响应体</button>
  <button type="button" onclick="window.print()">打印 / 存为 PDF</button>
</div>
</body>
</html>`;
}

function downloadHtml(filename, html) {
  const blob = new Blob(['\ufeff', html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function doExportHistory() {
  const limit = Number($('#exScope').value || 0);
  const btn = $('#btnDoExport');
  btn.disabled = true;
  btn.textContent = '导出中…';
  try {
    const data = await api('/api/history/export' + (limit > 0 ? '?limit=' + limit : ''));
    if (!data.ok) throw new Error(data.error || '导出数据获取失败');
    if (!(data.batches || []).length) { toast('暂无运行记录可导出', 2600, 'warn'); return; }
    const html = buildExportHtml(data, {
      title: $('#exTitle').value,
      request: $('#exIncRequest').checked,
      asserts: $('#exIncAssert').checked,
      body: $('#exIncBody').checked,
      openBody: $('#exOpenBody').checked,
    });
    downloadHtml(`运行记录-${exportStamp()}.html`, html);
    toast(`已导出 ${data.batches.length} 个批次 / ${data.stats.caseCount} 条用例执行记录`);
    closeExportModal();
  } catch (e) {
    toast('导出失败：' + e.message, 3000, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '导出';
  }
}

/** 由单个批次数据生成并下载 HTML（列表行导出 / 抽屉导出共用） */
function downloadBatchHtml(b) {
  const data = {
    ok: true,
    generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    caseDir: (state.payload && state.payload.caseDir) || '',
    stats: {
      batchCount: 1,
      caseCount: b.total || (b.results || []).length,
      passedCount: b.passedCount || 0,
      failedCount: b.failedCount || 0,
    },
    batches: [b],
  };
  const html = buildExportHtml(data, {
    title: '接口自动化测试运行记录 · 批次 ' + b.batchId,
    request: true, asserts: true, body: true, openBody: false,
  });
  downloadHtml(`运行记录-${b.batchId}.html`, html);
}

/** 抽屉里导出单个批次（全量内容，响应体默认收起） */
function exportCurrentBatch() {
  const b = state.batchDetail;
  if (!b) return;
  downloadBatchHtml(b);
  toast('已导出批次 ' + b.batchId, 2400, 'ok');
}

/** 运行记录列表行：导出当前批次的执行记录（含请求参数、断言、响应体） */
async function exportBatchRow(batchId, btn) {
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '导出中…'; }
  try {
    const data = await post('/api/history/detail', { batchId });
    if (!data.ok) throw new Error(data.error || '批次不存在');
    downloadBatchHtml(data.batch);
    toast('已导出批次 ' + batchId, 2400, 'ok');
  } catch (e) {
    toast('导出失败：' + e.message, 3000, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

function openExportModal() {
  if (!(state.history && (state.history.batches || []).length)) { toast('暂无运行记录可导出', 2600, 'warn'); return; }
  const total = state.history.stats && state.history.stats.batchCount;
  $('#exHint').textContent = `当前共 ${total} 个批次。导出为单个 HTML 文件：样式内嵌、无需联网，可直接双击打开、转发或打印成 PDF。`;
  $('#exportMask').hidden = false;
  $('#exportModal').hidden = false;
}
function closeExportModal() {
  $('#exportMask').hidden = true;
  $('#exportModal').hidden = true;
}

/* ============================================================
   用例详情抽屉
   ============================================================ */
function openCaseDetail(caseId) {
  const c = (state.payload ? state.payload.cases : []).find(x => x.id === caseId);
  if (!c) return;
  state.detailId = caseId;
  state.batchDetail = null;
  $('#btnExportBatch').hidden = true;
  const r = state.results.get(caseId);

  $('#dwTitle').textContent = c.name || caseId;
  $('#dwSub').textContent = `${c.method} ${c.url}`;

  let html = `<div class="sec-title">用例信息</div>
    <dl class="kv">
      <dt>测试用例ID</dt><dd class="mono">${esc(c.caseNo || '-')}</dd>
      <dt>测试用例名称</dt><dd>${esc(c.name)}</dd>
      <dt>测试用户</dt><dd>${esc(c.user)}</dd>
      <dt>所属模块</dt><dd>${esc(c.module || '-')}</dd>
      <dt>标签</dt><dd>${(state.caseTags[c.id] || []).map(t => `<span class="tag">${esc(t)}</span>`).join(' ') || '-'}
        <span style="color:var(--text-faint);font-size:11px">（在用例列表行内可直接编辑）</span></dd>
      <dt>用户标签</dt><dd>${((state.userMeta[c.user] || {}).tags || []).join(', ') || '-'}</dd>
      <dt>来源文件</dt><dd>${esc(c.file)}（${esc(c.fileFormat)}）</dd>
    </dl>`;

  html += `<div class="sec-title">对应接口</div>
    <dl class="kv">
      <dt>接口名称</dt><dd>${esc(c.apiName || c.module || '-')}</dd>
      <dt>请求方法</dt><dd>${esc(c.method)}</dd>
      <dt>请求地址</dt><dd>${esc(c.url)}</dd>
      <dt>接口路径</dt><dd>${esc(shortPath(c.url))}</dd>
    </dl>`;

  html += `<div class="sec-title">入参</div>`;
  if (c.query && c.query.length) {
    html += `<div style="margin-bottom:8px">
      <div class="empty-hint" style="padding:0 0 5px">Query 参数</div>
      <div class="code">${esc(c.query.map(q => `${q.key} = ${q.value}`).join('\n'))}</div></div>`;
  }
  const hs = {};
  (c.headers || []).forEach(h => { hs[h.key] = h.value; });
  html += `<div style="margin-bottom:8px">
    <div class="empty-hint" style="padding:0 0 5px">请求头</div>
    <div class="code">${esc(JSON.stringify(hs, null, 2))}</div></div>`;
  html += `<div>
    <div class="empty-hint" style="padding:0 0 5px">请求体</div>
    <div class="code">${c.body ? esc(prettyBody(c.body)) : '（无）'}</div></div>`;

  html += `<div class="sec-title">期望结果</div>
    <dl class="kv">
      <dt>期望业务码</dt><dd>${c.expectCode ?? '-'}${c.expectName ? ' · ' + esc(c.expectName) : ''}</dd>
      <dt>期望 HTTP</dt><dd>${esc((state.settings.expectHttp || [200, 201, 202, 204]).join(', '))}</dd>
    </dl>`;

  if (r) {
    html += `<div class="sec-title">最近一次执行记录</div>`;
    html += `<dl class="kv" style="margin-bottom:8px">
        <dt>执行结论</dt><dd style="color:${r.passed ? 'var(--ok)' : 'var(--bad)'};font-weight:700">${r.passed ? '✓ 通过' : '✕ 失败'}</dd>
        <dt>测试环境</dt><dd><span class="env-chip">${esc(r.env || originOf((r.request || {}).url) || '-')}</span></dd>
      </dl>`;
    html += execRecordHtml(r);
  } else {
    html += `<div class="sec-title">执行</div>
      <button class="btn primary" data-run-one="${esc(c.id)}">立即执行该用例</button>`;
  }

  $('#dwBody').innerHTML = html;
  $('#drawer').hidden = false;
  $('#drawerMask').hidden = false;
}

function prettyBody(body) {
  if (!body) return '（空）';
  try { return JSON.stringify(JSON.parse(body), null, 2); }
  catch (e) { return body; }
}
function closeDrawer() {
  state.detailId = null;
  state.batchDetail = null;
  $('#btnExportBatch').hidden = true;
  $('#drawer').hidden = true;
  $('#drawerMask').hidden = true;
}

/* ============================================================
   系统设置页
   ============================================================ */
function renderSettings() {
  if (!$('#setExecutedBy')) return;
  const s = state.settings || {};
  $('#setExecutedBy').value = s.executedBy || '';
  $('#setBaseUrl').value = s.baseUrlOverride || '';
  $('#setTimeout').value = s.timeoutMs || 15000;
  $('#setConcurrency').value = s.concurrency || 1;
  $('#setCheckHttp').checked = s.checkHttp !== false;
  $('#setCheckBiz').checked = s.checkBiz !== false;
  $('#setBizField').value = s.bizCodeField || 'status|code';
  $('#setExpectHttp').value = (s.expectHttp || [200, 201, 202, 204]).join(',');
  $('#setMaxHistory').value = s.maxHistory || 200;
  $('#setCaseDir').value = (state.payload && state.payload.caseDir) || '';

  const labels = (state.payload && state.payload.userFieldLabels) || {};
  $('#setUserField').innerHTML = Object.entries(labels).map(([k, v]) =>
    `<option value="${esc(k)}"${s.userField === k ? ' selected' : ''}>${esc(v)}</option>`).join('');

  renderKvList('#globalVars', s.globalVars || {}, 'gvar');
  renderKvList('#globalHeaders', s.globalHeaders || {}, 'ghead');
}

function renderKvList(sel, obj, kind) {
  const box = $(sel);
  if (!box) return;
  const keys = Object.keys(obj);
  box.innerHTML = keys.map(k => `
    <div class="kv-row">
      <input value="${esc(k)}" data-kvkey="${kind}" data-old="${esc(k)}" placeholder="键" />
      <input value="${esc(obj[k] ?? '')}" data-kvval="${kind}" data-key="${esc(k)}" placeholder="值" />
      <button class="kv-del" data-kvdel="${kind}" data-key="${esc(k)}">×</button>
    </div>`).join('') || '<div class="empty-hint" style="padding:0">暂无</div>';
}

/* ============================================================
   元数据保存
   ============================================================ */
let _saveTimer = null;
function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    try { await post('/api/meta', { users: state.userMeta, settings: state.settings, caseTags: state.caseTags }); }
    catch (e) { console.warn('保存失败', e); }
  }, 500);
}

/** 立即落盘挂起的编辑（拉取用例数据前调用，防止旧数据覆盖本地未保存的标签/设置） */
async function flushSave() {
  if (!_saveTimer) return;
  clearTimeout(_saveTimer);
  _saveTimer = null;
  try { await post('/api/meta', { users: state.userMeta, settings: state.settings, caseTags: state.caseTags }); }
  catch (e) { console.warn('保存失败', e); }
}

/* ============================================================
   事件绑定
   ============================================================ */
function bindEvents() {
  // 菜单
  $$('.menu-item').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.page === 'users') {
      setUsersMenuOpen(true);
      switchPage('users', state.usersSub || 'profile');
    } else if (b.dataset.page === 'mcp') {
      setMcpMenuOpen(true);
      switchPage('mcp', state.mcpSub || 'contract');
    } else {
      switchPage(b.dataset.page);
    }
  }));
  // 用户中心二级菜单（必须限定容器：否则 MCP 的 .mcp-sub 也被这里捕获，
  // b.dataset.sub 为 undefined → 点任意 MCP 子菜单都会跳到用户中心页）
  $$('#usersSubmenu .submenu-item').forEach(b => b.addEventListener('click', () => {
    switchPage('users', b.dataset.sub);
  }));
  // MCP 二级菜单
  $$('#mcpSubmenu .mcp-sub').forEach(b => b.addEventListener('click', () => {
    switchPage('mcp', b.dataset.msub);
  }));

  // 顶栏
  $('#btnReload').addEventListener('click', doReload);
  bindMcpEvents();
  $('#btnReload2').addEventListener('click', doReload);

  // 测试用例页 —— 搜索（用例名称 / 接口名称 / 标签 组合筛选）
  $('#searchBox').addEventListener('input', e => {
    state.search = e.target.value;
    renderCaseList();
  });
  $('#searchBox').addEventListener('keydown', e => {
    if (e.key === 'Escape' && e.target.value) {
      e.target.value = ''; state.search = ''; renderCaseList();
    }
  });

  // 测试用例页 —— 工具条
  $('#btnSelectAll').addEventListener('click', () => { visibleCases().forEach(c => state.selected.add(c.id)); renderCaseList(); });
  $('#btnInvert').addEventListener('click', () => {
    visibleCases().forEach(c => state.selected.has(c.id) ? state.selected.delete(c.id) : state.selected.add(c.id));
    renderCaseList();
  });
  $('#btnClear').addEventListener('click', () => { state.selected.clear(); renderCaseList(); });
  $('#btnClearResults').addEventListener('click', () => { state.results.clear(); renderCaseList(); toast('结果已清空'); });
  $('#btnRun').addEventListener('click', () => {
    const ids = state.payload.cases.map(c => c.id).filter(id => state.selected.has(id));
    runCases(ids, { type: 'cases', name: '手动勾选' });
  });
  $('#btnSaveScenario').addEventListener('click', () => {
    if (!state.selected.size) { toast('请先勾选要放入场景的用例', 2600, 'warn'); return; }
    openScenarioModal(null, Array.from(state.selected));
  });

  // 测试用例页 —— 列表
  $('#caseList').addEventListener('click', e => {
    // 加载失败后的「重试」按钮
    if (e.target.closest('[data-cases-retry]')) { loadCases(); return; }
    const t = e.target;
    if (t.type === 'checkbox' && t.dataset.caseCb !== undefined) {
      t.checked ? state.selected.add(t.dataset.caseCb) : state.selected.delete(t.dataset.caseCb);
      renderCaseList(); return;
    }
    if (t.type === 'checkbox' && t.dataset.userCb !== undefined) {
      const u = t.dataset.userCb;
      state.payload.cases.filter(c => c.user === u).forEach(c => t.checked ? state.selected.add(c.id) : state.selected.delete(c.id));
      renderCaseList(); return;
    }
    if (t.type === 'checkbox' && t.dataset.moduleCb !== undefined) {
      const [u, m] = t.dataset.moduleCb.split('::');
      state.payload.cases.filter(c => c.user === u && c.module === m)
        .forEach(c => t.checked ? state.selected.add(c.id) : state.selected.delete(c.id));
      renderCaseList(); return;
    }
    if (t.dataset.untag) {
      const u = t.dataset.user;
      state.userMeta[u].tags = state.userMeta[u].tags.filter(x => x !== t.dataset.untag);
      renderCaseList(); scheduleSave(); return;
    }
    // 用例级标签：移除
    if (t.dataset.ctagUntag !== undefined && t.dataset.case) {
      const cid = t.dataset.case;
      state.caseTags[cid] = (state.caseTags[cid] || []).filter(x => x !== t.dataset.ctagUntag);
      syncCaseTags(cid);
      renderCaseList(); scheduleSave(); return;
    }
    if (t.dataset.toggleUser) {
      const u = t.dataset.toggleUser;
      state.collapsedUsers.has(u) ? state.collapsedUsers.delete(u) : state.collapsedUsers.add(u);
      renderCaseList(); return;
    }
    if (t.dataset.toggleModule) {
      const k = t.dataset.toggleModule;
      state.collapsedModules.has(k) ? state.collapsedModules.delete(k) : state.collapsedModules.add(k);
      renderCaseList(); return;
    }
    if (t.dataset.runOne) { runCases([t.dataset.runOne], { type: 'cases', name: '单条执行' }); return; }
    if (t.dataset.runUser) {
      const u = t.dataset.runUser;
      const ids = state.payload.cases.filter(c => c.user === u).map(c => c.id);
      ids.forEach(id => state.selected.add(id));
      renderCaseList();
      runCases(ids, { type: 'cases', name: '按用户执行：' + u }); return;
    }
    if (t.dataset.detail) { openCaseDetail(t.dataset.detail); return; }
    const row = t.closest('.case-row');
    if (row && !t.closest('button') && t.type !== 'checkbox' && !t.closest('.tag-editor')) {
      openCaseDetail(row.dataset.case);
    }
  });
  $('#caseList').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    // 用例级标签：回车添加
    if (e.target.dataset.ctagInput !== undefined) {
      const cid = e.target.dataset.ctagInput;
      const val = e.target.value.trim();
      if (!val) return;
      const tags = state.caseTags[cid] || (state.caseTags[cid] = []);
      if (!tags.includes(val)) tags.push(val);
      e.target.value = '';
      syncCaseTags(cid);
      renderCaseList(); scheduleSave();
      // 渲染后重新聚焦到该行输入框，便于连续添加
      const again = $(`[data-ctag-input="${cid}"]`, $('#caseList'));
      if (again) again.focus();
      return;
    }
    if (!e.target.dataset.tagInput) return;
    const u = e.target.dataset.tagInput;
    const val = e.target.value.trim();
    if (!val) return;
    const tags = state.userMeta[u].tags;
    if (!tags.includes(val)) tags.push(val);
    e.target.value = '';
    renderCaseList(); scheduleSave();
  });

  // 测试场景页
  $('#btnNewScenario').addEventListener('click', () => openScenarioModal(null, []));
  $('#btnRefreshScenarios').addEventListener('click', loadScenarios);
  $('#btnSaveScenarioModal').addEventListener('click', saveScenario);
  $('#btnCancelModal').addEventListener('click', closeModal);
  $('#btnCloseModal').addEventListener('click', closeModal);
  $('#modalMask').addEventListener('click', closeModal);
  $('#scenarioTable').addEventListener('click', async e => {
    const t = e.target;
    if (t.dataset.scRun) {
      const sc = state.scenarios.find(x => x.id === t.dataset.scRun);
      if (!sc) return;
      const valid = (sc.caseIds || []).filter(id => state.payload.cases.some(c => c.id === id));
      if (!valid.length) { toast('该场景没有可执行的用例（用例可能已被移除）'); return; }
      await runCases(valid, { type: 'scenario', name: sc.name });
      switchPage('history');
      return;
    }
    if (t.dataset.scEdit) {
      const sc = state.scenarios.find(x => x.id === t.dataset.scEdit);
      if (sc) openScenarioModal(sc, []);
      return;
    }
    if (t.dataset.scDel) {
      const sc = state.scenarios.find(x => x.id === t.dataset.scDel);
      if (!sc) return;
      if (!confirm(`确认删除测试场景「${sc.name}」？`)) return;
      await post('/api/scenarios/delete', { id: sc.id });
      toast('场景已删除', 2200, 'ok');
      loadScenarios();
      return;
    }
    // 点击行（非操作按钮）→ 查看场景用例明细
    const tr = t.closest && t.closest('tr[data-sc-row]');
    if (tr) openScenarioDetail(tr.dataset.scRow);
  });
  $('#mdBody').addEventListener('click', e => {
    const t = e.target;
    if (t.id === 'scPickAll') {
      (state.payload ? state.payload.cases : []).forEach(c => state.modalPicked.add(c.id));
      $$('[data-cp-case]', $('#mdBody')).forEach(cb => { cb.checked = true; });
      $$('[data-cp-user]', $('#mdBody')).forEach(cb => { cb.checked = true; });
      $('#scPickedCount').textContent = state.modalPicked.size; return;
    }
    if (t.id === 'scPickNone') {
      state.modalPicked.clear();
      $$('[data-cp-case]', $('#mdBody')).forEach(cb => { cb.checked = false; });
      $$('[data-cp-user]', $('#mdBody')).forEach(cb => { cb.checked = false; });
      $('#scPickedCount').textContent = 0; return;
    }
  });
  $('#mdBody').addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.cpCase !== undefined) {
      t.checked ? state.modalPicked.add(t.dataset.cpCase) : state.modalPicked.delete(t.dataset.cpCase);
      $('#scPickedCount').textContent = state.modalPicked.size;
      const owner = t.dataset.cpOwner;
      const all = $$(`[data-cp-case][data-cp-owner="${CSS.escape(owner)}"]`, $('#mdBody'));
      const ownerCb = $(`[data-cp-user="${CSS.escape(owner)}"]`, $('#mdBody'));
      if (ownerCb) {
        const checked = all.filter(x => x.checked).length;
        ownerCb.checked = checked === all.length;
        ownerCb.indeterminate = checked > 0 && checked < all.length;
      }
      return;
    }
    if (t.dataset.cpUser !== undefined) {
      const owner = t.dataset.cpUser;
      $$(`[data-cp-case][data-cp-owner="${CSS.escape(owner)}"]`, $('#mdBody')).forEach(cb => {
        cb.checked = t.checked;
        t.checked ? state.modalPicked.add(cb.dataset.cpCase) : state.modalPicked.delete(cb.dataset.cpCase);
      });
      $('#scPickedCount').textContent = state.modalPicked.size;
    }
  });

  // 运行记录页
  $('#btnRefreshHistory').addEventListener('click', () => loadHistory());
  // 运行记录导出
  $('#btnExportHistory').addEventListener('click', openExportModal);
  $('#btnCloseExport').addEventListener('click', closeExportModal);
  $('#btnCancelExport').addEventListener('click', closeExportModal);
  $('#exportMask').addEventListener('click', closeExportModal);
  $('#btnDoExport').addEventListener('click', doExportHistory);
  $('#btnExportBatch').addEventListener('click', exportCurrentBatch);
  // 「响应体默认展开」与「包含响应体」联动：不包含响应体时该选项无意义
  $('#exIncBody').addEventListener('change', () => {
    const on = $('#exIncBody').checked;
    $('#exOpenBody').disabled = !on;
    if (!on) $('#exOpenBody').checked = false;
  });
  $('#btnClearHistory').addEventListener('click', () => clearHistory());
  $('#btnClearHistory2').addEventListener('click', () => clearHistory());
  $('#historyTable').addEventListener('click', e => {
    // 「导出」优先：避免同时触发行的「查看」
    const expBtn = e.target.closest && e.target.closest('[data-batch-export]');
    if (expBtn) { e.stopPropagation(); exportBatchRow(expBtn.dataset.batchExport, expBtn); return; }
    const b = e.target.dataset.batchView || (e.target.closest('tr') && e.target.closest('tr').dataset.batch);
    if (b) openBatchDetail(b);
  });

  // 系统设置页
  $('#btnSaveSettings').addEventListener('click', async () => {
    state.settings = { ...state.settings, ...readSettingsFromUI() };
    try {
      await post('/api/meta', { settings: state.settings, users: state.userMeta });
      toast('设置已保存', 2200, 'ok');
      renderAccount();
      await loadCases(true);
    } catch (e) { toast('保存失败：' + e.message, 3000, 'err'); }
  });
  $('#btnResetAll').addEventListener('click', async () => {
    if (!confirm('将清空标签、场景、运行记录与全部设置，确认继续？')) return;
    await post('/api/history/clear');
    const sc = await api('/api/scenarios');
    for (const s of (sc.scenarios || [])) await post('/api/scenarios/delete', { id: s.id });
    state.userMeta = {};
    state.caseTags = {};
    await post('/api/meta', { users: {}, settings: {}, clearCaseTags: true });
    toast('已清空平台数据', 2400, 'ok');
    state.results.clear();
    loadCases(true); loadScenarios(); loadHistory();
  });

  // 全局：新增/删除变量行
  document.addEventListener('click', e => {
    const add = e.target.dataset.addVar;
    if (add) {
      const obj = state.settings[add] || (state.settings[add] = {});
      let n = add === 'globalHeaders' ? 'Authorization' : 'var' + (Object.keys(obj).length + 1);
      while (n in obj) n += '_';
      obj[n] = '';
      renderSettings();
      return;
    }
    const del = e.target.dataset.kvdel;
    if (del) {
      const name = del === 'gvar' ? 'globalVars' : 'globalHeaders';
      delete state.settings[name][e.target.dataset.key];
      renderSettings();
    }
  });
  document.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.kvval) {
      const name = t.dataset.kvval === 'gvar' ? 'globalVars' : 'globalHeaders';
      state.settings[name][t.dataset.key] = t.value;
    }
    if (t.dataset.kvkey) {
      const name = t.dataset.kvkey === 'gvar' ? 'globalVars' : 'globalHeaders';
      const obj = state.settings[name];
      const old = t.dataset.old, val = t.value.trim();
      if (val && val !== old) {
        obj[val] = obj[old]; delete obj[old]; t.dataset.old = val;
        renderSettings();
      }
    }
  });

  // 抽屉
  $('#btnCloseDrawer').addEventListener('click', closeDrawer);
  $('#drawerMask').addEventListener('click', closeDrawer);
  $('#dwBody').addEventListener('click', e => {
    if (e.target.dataset.runOne) { runCases([e.target.dataset.runOne], { type: 'cases', name: '单条执行' }); return; }
    const idx = e.target.closest('[data-rec-toggle]') && e.target.closest('[data-rec-toggle]').dataset.recToggle;
    if (idx !== undefined && idx !== false) {
      const body = $(`[data-rec-body="${idx}"]`);
      if (body) body.hidden = !body.hidden;
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeDrawer(); closeModal(); closeExportModal(); toggleUserMenu(false); }
  });

  // 用户中心 —— 顶栏账号菜单
  $('#btnUserMenu').addEventListener('click', e => {
    e.stopPropagation();
    toggleUserMenu();
  });
  document.addEventListener('click', e => {
    if (!$('#userMenu').hidden && !e.target.closest('.userbox')) toggleUserMenu(false);
  });
  $('#userMenu').addEventListener('click', e => {
    const act = e.target.dataset.um;
    if (!act) return;
    toggleUserMenu(false);
    if (act === 'users') { switchPage('users', 'profile'); }
    else if (act === 'password') {
      switchPage('users', 'profile');
      setTimeout(() => $('#pwOld').focus(), 120);
    }
    else if (act === 'logout') doLogout();
  });

  // 用户中心 —— 个人资料 / 改密 / 用户管理
  $('#btnSaveProfile').addEventListener('click', saveProfile);
  $('#btnChangePwd').addEventListener('click', changePassword);
  $('#btnRefreshUsers').addEventListener('click', loadUsers);
  $('#userRows').addEventListener('click', onUserAction);
}

async function doReload() {
  toast('正在重新扫描用例目录…');
  await loadCases(true);
  toast('扫描完成', 2000, 'ok');
}

async function clearHistory() {
  if (!confirm('确认清空全部运行记录？此操作不可恢复。')) return;
  await post('/api/history/clear');
  toast('运行记录已清空', 2400, 'ok');
  loadHistory();
}

/* ============================================================
   用户中心
   ============================================================ */
function toggleUserMenu(force) {
  const box = $('#userMenu');
  if (!box) return;
  const on = force === undefined ? box.hidden : force;
  box.hidden = !on;
  $('#btnUserMenu').setAttribute('aria-expanded', String(on));
}

function renderAccount() {
  const u = state.me;
  if (!u) return;
  const name = u.displayName || u.username;
  [$('#userAvatar'), $('#umAvatar'), $('#pfAvatar')].forEach(el => {
    if (el) el.textContent = initials(name);
  });
  if ($('#whoami')) $('#whoami').textContent = name;
  if ($('#userRole')) $('#userRole').textContent = u.roleLabel || u.role;
  if ($('#umName')) $('#umName').textContent = name;
  if ($('#umSub')) $('#umSub').textContent = '@' + u.username + ' · ' + (u.roleLabel || u.role);

  if ($('#pfName')) $('#pfName').textContent = name;
  if ($('#pfUsername')) $('#pfUsername').textContent = '@' + u.username + (u.email ? ' · ' + u.email : '');
  if ($('#pfRole')) {
    $('#pfRole').textContent = u.roleLabel || u.role;
    $('#pfRole').classList.toggle('tester', u.role !== 'admin');
  }
  if ($('#pfDisplayName') && document.activeElement !== $('#pfDisplayName')) $('#pfDisplayName').value = name;
  if ($('#pfEmail') && document.activeElement !== $('#pfEmail')) $('#pfEmail').value = u.email || '';
  if ($('#pfCreated')) $('#pfCreated').textContent = u.createdAt || '—';
  if ($('#pfLastLogin')) $('#pfLastLogin').textContent = u.lastLoginAt || '—';
  if ($('#pfLastIp')) $('#pfLastIp').textContent = u.lastLoginIp || '—';
  if ($('#pfStatus')) $('#pfStatus').textContent = u.statusLabel || u.status;

  updateUsersPageDesc();
}

async function loadMe() {
  try {
    const d = await api('/api/auth/me');
    if (!d.authenticated) { location.replace('/login'); return false; }
    state.me = d.user;
    renderAccount();
    return true;
  } catch (e) {
    location.replace('/login');
    return false;
  }
}

async function loadUsers() {
  if (!state.me) return;
  try {
    const d = await api('/api/auth/users');
    state.authUsers = d.users || [];
    state.userCanManage = !!d.canManage;
    renderUsers();
    updateUsersPageDesc();
  } catch (e) {
    toast('加载用户列表失败：' + e.message, 3000, 'err');
  }
}

function renderUsers() {
  const tb = $('#userRows');
  if (!tb) return;
  const me = state.me || {};
  const canManage = state.userCanManage;
  if ($('#thUserOps')) $('#thUserOps').hidden = !canManage;
  if ($('#thUserIp')) $('#thUserIp').hidden = !canManage;
  const adminCount = state.authUsers.filter(x => x.role === 'admin' && x.status === 'active').length;
  const rows = state.authUsers.map(u => {
    const self = u.id === me.id;
    const lastAdmin = u.role === 'admin' && u.status === 'active' && adminCount <= 1;
    const lockRole = self || lastAdmin;
    const lockStatus = self || lastAdmin;
    const ipCell = canManage ? `<td class="mono">${esc(u.lastLoginIp || '-')}</td>` : '';
    const opsCell = canManage ? `
      <td class="ta-c">
        <div class="uact uact-center">
          <button data-act="role" data-uid="${u.id}" ${lockRole ? 'disabled' : ''}>${u.role === 'admin' ? '设为测试' : '设为管理员'}</button>
          <button data-act="status" data-uid="${u.id}" ${lockStatus ? 'disabled' : ''}>${u.status === 'active' ? '停用' : '启用'}</button>
          <button data-act="reset" data-uid="${u.id}">重置密码</button>
          <button data-act="delete" data-uid="${u.id}" class="danger" ${lockRole ? 'disabled' : ''}>删除</button>
        </div>
      </td>` : '';
    return `<tr data-uid="${u.id}">
      <td>
        <div class="urow-user">
          <span class="avatar${u.status === 'disabled' ? ' muted' : ''}">${esc(initials(u.displayName || u.username))}</span>
          <div class="uu-id">
            <b>${esc(u.displayName)}${self ? '<span class="me-tag">我</span>' : ''}</b>
            <span>@${esc(u.username)}${u.email ? ' · ' + esc(u.email) : ''}</span>
          </div>
        </div>
      </td>
      <td class="ta-c"><span class="role-badge${u.role === 'admin' ? '' : ' tester'}">${esc(u.roleLabel)}</span></td>
      <td class="ta-c"><span class="status-chip${u.status === 'disabled' ? ' disabled' : ''}">${esc(u.statusLabel)}</span></td>
      <td class="mono">${esc(u.createdAt || '-')}</td>
      <td class="mono">${esc(u.lastLoginAt || '-')}</td>
      ${ipCell}${opsCell}
    </tr>`;
  }).join('');
  const cols = canManage ? 7 : 5;
  tb.innerHTML = rows || `<tr><td colspan="${cols}"><div class="empty-hint">暂无用户</div></td></tr>`;
}

async function onUserAction(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn || btn.disabled) return;
  const id = Number(btn.dataset.uid);
  const u = state.authUsers.find(x => x.id === id);
  if (!u) return;
  const act = btn.dataset.act;
  try {
    if (act === 'role') {
      const role = u.role === 'admin' ? 'tester' : 'admin';
      if (!confirm(`确认将「${u.displayName}」设为${role === 'admin' ? '管理员' : '测试人员'}？`)) return;
      await post('/api/auth/users/update', { id, role });
      toast('角色已更新', 2000, 'ok');
    } else if (act === 'status') {
      const status = u.status === 'active' ? 'disabled' : 'active';
      if (status === 'disabled' && !confirm(`停用后「${u.displayName}」会立即被踢下线，确认停用？`)) return;
      await post('/api/auth/users/update', { id, status });
      toast(status === 'disabled' ? '账号已停用' : '账号已启用', 2000, 'ok');
    } else if (act === 'reset') {
      const pwd = prompt(`为「${u.displayName}」设置新密码（至少 6 位）：`);
      if (!pwd) return;
      await post('/api/auth/users/reset-password', { id, newPassword: pwd });
      toast('密码已重置，该用户需重新登录', 2800, 'ok');
    } else if (act === 'delete') {
      if (!confirm(`删除后不可恢复，确认删除用户「${u.displayName}」？`)) return;
      await post('/api/auth/users/delete', { id });
      toast('用户已删除', 2200, 'ok');
    }
    await loadUsers();
  } catch (err) { toast(err.message, 3400, 'err'); }
}

async function saveProfile() {
  const displayName = $('#pfDisplayName').value.trim();
  const email = $('#pfEmail').value.trim();
  if (!displayName) { toast('显示名不能为空', 2400, 'warn'); return; }
  try {
    const d = await post('/api/auth/profile', { displayName, email });
    state.me = d.user;
    renderAccount();
    toast('资料已更新', 2200, 'ok');
  } catch (e) { toast(e.message, 3000, 'err'); }
}

async function changePassword() {
  const oldPassword = $('#pwOld').value;
  const newPassword = $('#pwNew').value;
  const again = $('#pwNew2').value;
  if (!oldPassword || !newPassword) { toast('请填写原密码和新密码', 2400, 'warn'); return; }
  if (newPassword.length < 6) {
    toast('新密码至少 6 位', 2800, 'warn'); return;
  }
  if (newPassword !== again) { toast('两次输入的新密码不一致', 2400, 'warn'); return; }
  try {
    await post('/api/auth/password', { oldPassword, newPassword });
    $('#pwOld').value = ''; $('#pwNew').value = ''; $('#pwNew2').value = '';
    toast('密码已修改，其他设备上的登录已失效', 3200, 'ok');
  } catch (e) { toast(e.message, 3400, 'err'); }
}

async function doLogout() {
  if (!confirm('确认退出登录？')) return;
  try { await post('/api/auth/logout'); } catch (e) { /* 忽略 */ }
  location.replace('/login');
}

/* ============================================================
   启动
   ============================================================ */
(async () => {
  // 未登录不继续渲染任何业务数据：由 loadMe 负责跳转登录页
  if (!(await loadMe())) return;
  bindEvents();
  bindPager();
  loadCases();
  loadHistory(true);
  loadScenarios();
})();
