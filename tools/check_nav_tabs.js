/**
 * 菜单信息架构自测：
 * ① 契约发现提为一级菜单，位于「测试用例」上方；MCP 测试只剩 一键回归 / Schema Diff
 * ② 测试用例页：参数级用例（默认标签）+ 用例列表
 * ③ 测试场景页：场景级用例（默认标签）+ 我的场景；场景详情可进入并正确返回
 * ④ 一键回归报告可进入并正确返回
 */
const puppeteer = require('puppeteer-core');
const wait = ms => new Promise(r => setTimeout(r, ms));

const visible = (p, sel) => p.evaluate(s => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { hidden: el.hidden, display: getComputedStyle(el).display, w: Math.round(r.width), h: Math.round(r.height) };
}, sel);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', args: ['--no-sandbox'],
  });
  const p = await browser.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await p.setViewport({ width: 1500, height: 1120 });
  await p.goto('http://127.0.0.1:8788/', { waitUntil: 'networkidle2' });
  await wait(1400);

  const out = {};

  // ---- ① 菜单顺序 / 结构 ----
  out.menu = await p.evaluate(() =>
    [...document.querySelectorAll('.menu > .menu-item, .menu > .menu-group')].map(el => {
      const it = el.classList.contains('menu-group') ? el.querySelector('.menu-item') : el;
      return {
        text: it.querySelector('.mi-text').innerText.trim(),
        page: it.dataset.page,
        subs: el.classList.contains('menu-group')
          ? [...el.querySelectorAll('.submenu-item')].map(b => b.innerText.trim()) : [],
      };
    }));

  // ---- 默认页：测试用例 → 参数级用例标签 ----
  out.defaultPage = await p.evaluate(() => ({
    page: state.page,
    casesTab: state.casesTab,
    activeMenu: (document.querySelector('.menu-item.active .mi-text') || {}).innerText,
    activeTab: (document.querySelector('#caseTabs .seg-tab.active') || {}).innerText.replace(/\s+/g, ' '),
    paramsShown: !document.querySelector('#casesTab-params').hidden,
    listShown: !document.querySelector('#casesTab-list').hidden,
  }));
  await wait(1200);
  out.paramsRows = await p.evaluate(() =>
    document.querySelectorAll('#mcpParamsTable tbody tr').length);
  out.paramsPager = await p.evaluate(() => {
    const pg = document.querySelector('#mcpParamsTable .mcp-pager');
    return pg ? (pg.querySelector('.mpg-info').innerText.replace(/\s+/g, ' ').trim() + ' | ' +
      [...pg.querySelectorAll('.mpg-btn:not(.mpg-arrow)')].map(b => b.innerText.trim()).join(' ')) : null;
  });
  out.tabCounts = await p.evaluate(() => ({
    params: document.querySelector('#tabCaseParamCount').innerText,
    list: document.querySelector('#tabCaseListCount').innerText,
    scenChain: document.querySelector('#tabScenMchCount').innerText,
    scenList: document.querySelector('#tabScenListCount').innerText,
  }));
  await p.screenshot({ path: 'tools/shot-nav-cases-params.png' });

  // ---- 切到「用例列表」标签 ----
  await p.click('#caseTabs .seg-tab[data-ctab="list"]'); await wait(900);
  out.listTab = await p.evaluate(() => ({
    casesTab: state.casesTab,
    paramsShown: !document.querySelector('#casesTab-params').hidden,
    listShown: !document.querySelector('#casesTab-list').hidden,
    cases: document.querySelectorAll('#caseList .case-card, #caseList .case-row, #caseList tbody tr').length,
    stCases: document.querySelector('#stCases').innerText,
  }));
  await p.screenshot({ path: 'tools/shot-nav-cases-list.png' });

  // ---- ② 契约发现（一级菜单） ----
  await p.click('.menu-item[data-page="contract"]'); await wait(1600);
  out.contract = await p.evaluate(() => ({
    page: state.page,
    activeMenu: (document.querySelector('.menu-item.active .mi-text') || {}).innerText,
    title: document.querySelector('#page-contract h2').innerText,
    gateway: document.querySelector('#mcpGatewayText').innerText.slice(0, 40),
    rows: document.querySelectorAll('#mcpToolTable tbody tr').length,
    pager: (document.querySelector('#mcpToolTable .mpg-info') || {}).innerText.replace(/\s+/g, ' ').trim(),
    visible: !document.querySelector('#page-contract').hidden,
    mcpPageVisible: !document.querySelector('#page-mcp').hidden,
  }));
  await p.screenshot({ path: 'tools/shot-nav-contract.png' });

  // ---- ③ 测试场景 → 场景级用例标签 + 详情返回 ----
  await p.click('.menu-item[data-page="scenarios"]'); await wait(1500);
  out.scen = await p.evaluate(() => ({
    page: state.page,
    scenTab: state.scenTab,
    activeTab: (document.querySelector('#scenTabs .seg-tab.active') || {}).innerText.replace(/\s+/g, ' '),
    mcpShown: !document.querySelector('#scenTab-mcp').hidden,
    listShown: !document.querySelector('#scenTab-list').hidden,
    rows: document.querySelectorAll('#mcpScenTable tbody tr').length,
  }));
  await p.screenshot({ path: 'tools/shot-nav-scenarios.png' });

  await p.click('#mcpScenTable tbody tr:first-child'); await wait(1600);
  out.scenDetail = await p.evaluate(() => ({
    page: state.page,
    title: document.querySelector('#mcpDetailTitle').innerText,
    sub: document.querySelector('#mcpDetailSub').innerText,
    cases: document.querySelectorAll('#mcpDetailBody tbody tr.row-link').length,
    detailShown: !document.querySelector('#page-mcpdetail').hidden,
    menuActive: (document.querySelector('.menu-item.active .mi-text') || {}).innerText,
  }));
  await p.screenshot({ path: 'tools/shot-nav-scen-detail.png' });
  await p.click('#btnMcpDetailBack'); await wait(1000);
  out.scenBack = await p.evaluate(() => ({
    page: state.page,
    scenTab: state.scenTab,
    scenariosShown: !document.querySelector('#page-scenarios').hidden,
    detailHidden: document.querySelector('#page-mcpdetail').hidden,
    mcpShown: !document.querySelector('#scenTab-mcp').hidden,
  }));

  // ---- 「我的场景」标签 ----
  await p.click('#scenTabs .seg-tab[data-stab="list"]'); await wait(900);
  out.myScen = await p.evaluate(() => ({
    scenTab: state.scenTab,
    listShown: !document.querySelector('#scenTab-list').hidden,
    meta: document.querySelector('#scenListMeta').innerText,
    table: document.querySelector('#scenarioTable').innerText.slice(0, 60).replace(/\s+/g, ' '),
  }));
  await p.screenshot({ path: 'tools/shot-nav-scenarios-list.png' });

  // ---- ④ MCP 测试：一键回归 → 报告 → 返回 ----
  await p.click('#menuMcpRoot'); await wait(500);
  out.mcpMenu = await p.evaluate(() => ({
    page: state.page,
    subs: [...document.querySelectorAll('#mcpSubmenu .submenu-item')].map(b => b.innerText.trim()),
    active: (document.querySelector('#mcpSubmenu .submenu-item.active') || {}).innerText,
    title: document.querySelector('#mcpTitle').innerText,
    rows: document.querySelectorAll('#mcpRunTable tbody tr').length,
  }));
  await wait(900);
  await p.evaluate(() => {
    const tr = document.querySelector('#mcpRunTable tbody tr');
    if (tr) tr.querySelector('[data-report]').click();
  });
  await wait(1800);
  out.report = await p.evaluate(() => ({
    page: state.page,
    title: document.querySelector('#mcpDetailTitle').innerText,
    cards: document.querySelectorAll('#mcpDetailBody .mcp-rpt').length,
    rows: document.querySelectorAll('#mcpDetailBody tbody tr').length,
  }));
  await p.screenshot({ path: 'tools/shot-nav-report.png' });
  await p.click('#btnMcpDetailBack'); await wait(1000);
  out.reportBack = await p.evaluate(() => ({
    page: state.page,
    mcpSub: state.mcpSub,
    mcpShown: !document.querySelector('#page-mcp').hidden,
    detailHidden: document.querySelector('#page-mcpdetail').hidden,
  }));

  // ---- ⑤ Schema Diff 仍可用 ----
  await p.click('#mcpSubmenu .mcp-sub[data-msub="diff"]'); await wait(1500);
  out.diff = await p.evaluate(() => ({
    title: document.querySelector('#mcpTitle').innerText,
    meta: document.querySelector('#mcpDiffMeta').innerText.slice(0, 60),
    page: state.page,
  }));

  out.errors = errors;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})();
