/**
 * 各视图 UI 巡检：进入每个视图后，检查可见页面、标题、标签高亮、表格行数。
 *
 * 菜单结构调整后（契约发现→一级页，参数级→测试用例页标签，场景级→测试场景页标签），
 * 本脚本改为按「视图」巡检，不再依赖 #page-mcp 内部的五个面板。
 */
const puppeteer = require('puppeteer-core');
const { goto } = require('./nav');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('requestfailed', r => errors.push('reqfail: ' + r.url()));
  page.on('response', r => {
    if (r.status() >= 400) errors.push('http' + r.status() + ': ' + r.url());
  });

  await page.goto('http://127.0.0.1:8788/', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 1200));

  // 视图 → 主表格选择器（用于统计行数）
  const views = [
    { sub: 'contract', table: '#mcpToolTable' },
    { sub: 'params', table: '#mcpParamsTable' },
    { sub: 'scenarios', table: '#mcpScenTable' },
    { sub: 'run', table: '#mcpRunTable' },
    { sub: 'diff', table: '#mcpPanel-diff table' },
  ];

  const report = [];
  for (const v of views) {
    const ok = await goto(page, v.sub);
    await new Promise(r => setTimeout(r, 2500));
    const info = await page.evaluate(tblSel => {
      const active = document.querySelector('.page.active');
      // 标签只在该页面可见时才有意义
      const tabBox = active ? active.querySelector('.seg-tabs') : null;
      const tab = tabBox ? tabBox.querySelector('.seg-tab.active') : null;
      const table = document.querySelector(tblSel);
      return {
        navOk: null,
        page: active ? active.id : null,
        pageTitle: active ? (active.querySelector('.page-head h2') || {}).textContent : null,
        activeMenu: (document.querySelector('.menu-item.active .mi-text') || {}).textContent || null,
        activeTab: tab ? tab.textContent.replace(/\s+/g, ' ').trim() : null,
        tableRows: table ? table.querySelectorAll('tbody tr').length : 0,
        tableText: table ? table.innerText.slice(0, 140).replace(/\s+/g, ' ') : '(no table)',
      };
    }, v.table);
    info.navOk = ok;
    report.push({ sub: v.sub, ...info });
    await page.screenshot({ path: `tools/shot-mcp-${v.sub}.png` });
  }

  console.log(JSON.stringify({ report, errors }, null, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
