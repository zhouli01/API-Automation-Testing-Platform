// 验证：场景详情跳转 / 用例展开 / 回归记录分页 / 回归报告
const puppeteer = require('puppeteer-core');
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1100 });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('requestfailed', r => errors.push('reqfail: ' + r.url()));

  await page.goto('http://127.0.0.1:8788/', { waitUntil: 'networkidle2' });
  await wait(900);
  await page.click('#menuMcpRoot');
  await wait(500);

  const out = { errors };

  // ① 场景级：点链路行跳转详情
  await page.click('#mcpSubmenu .mcp-sub[data-msub="scenarios"]');
  await wait(1500);
  out.scenRows = await page.evaluate(() =>
    [...document.querySelectorAll('#mcpScenTable tbody tr')].map(tr => tr.innerText.replace(/\s+/g, ' ').slice(0, 60)));

  await page.click('#mcpScenTable tbody tr');
  await wait(1500);
  out.detail1 = await page.evaluate(() => ({
    visible: !document.querySelector('#mcpPanel-detail').hidden,
    scenPanelHidden: document.querySelector('#mcpPanel-scenarios') ? document.querySelector('#mcpPanel-scenarios').hidden : null,
    title: document.querySelector('#mcpDetailTitle').textContent.trim(),
    sub: document.querySelector('#mcpDetailSub').textContent.trim(),
    chips: [...document.querySelectorAll('#mcpDetailBody .chip')].map(c => c.textContent.trim()).slice(0, 8),
    caseRows: document.querySelectorAll('#mcpDetailBody tr[data-scase]').length,
    varline: (document.querySelector('#mcpDetailBody .mcp-varline') || {}).innerText || '',
    firstRow: (document.querySelector('#mcpDetailBody tr[data-scase]') || {}).innerText || '',
  }));

  // ② 详情内用例行展开
  await page.click('#mcpDetailBody tr[data-scase]');
  await wait(600);
  out.expand = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#mcpDetailBody tr.mcp-exp-row')];
    const shown = rows.filter(r => !r.hidden);
    return {
      total: rows.length,
      shown: shown.length,
      text: shown[0] ? shown[0].innerText.replace(/\s+/g, ' ').slice(0, 400) : '',
    };
  });
  await page.screenshot({ path: 'tools/shot-mcp-scen-detail.png', fullPage: false });

  // 返回场景列表
  await page.click('#btnMcpDetailBack');
  await wait(900);
  out.backOk = await page.evaluate(() => ({
    detailHidden: document.querySelector('#mcpPanel-detail').hidden,
    scenVisible: !document.querySelector('#mcpPanel-scenarios').hidden,
  }));

  // ③ 一键回归：分页
  await page.click('#mcpSubmenu .mcp-sub[data-msub="run"]');
  await wait(1500);
  out.runs = await page.evaluate(() => ({
    rows: document.querySelectorAll('#mcpRunTable tbody tr').length,
    head: [...document.querySelectorAll('#mcpRunTable thead th')].map(th => th.textContent.trim()),
    pager: (document.querySelector('#mcpRunTable').closest('.card').querySelector('.mcp-pager') || {}).innerText || '',
    hasReportBtn: !!document.querySelector('#mcpRunTable [data-report]'),
    firstRow: (document.querySelector('#mcpRunTable tbody tr') || {}).innerText || '',
  }));

  // ④ 打开报告
  await page.click('#mcpRunTable tbody tr [data-report]');
  await wait(2000);
  out.report = await page.evaluate(() => {
    const body = document.querySelector('#mcpDetailBody');
    return {
      visible: !document.querySelector('#mcpPanel-detail').hidden,
      title: document.querySelector('#mcpDetailTitle').textContent.trim(),
      cards: [...body.querySelectorAll('.mcp-rpt')].map(c => c.innerText.replace(/\s+/g, ' ').trim()).slice(0, 6),
      failRows: body.querySelectorAll('table.dt tbody tr').length,
      caseRows: body.querySelectorAll('tr[data-rexp]').length,
      filters: [...body.querySelectorAll('[data-rpf]')].map(b => b.textContent.trim()),
      pager: (body.querySelector('.mcp-pager') || {}).innerText || '',
    };
  });

  // 仅失败筛选
  const failedBtn = await page.$('#mcpDetailBody [data-rpf="failed"]');
  if (failedBtn) { await failedBtn.click(); await wait(600); }
  out.filterFailed = await page.evaluate(() => ({
    caseRows: document.querySelectorAll('#mcpDetailBody tr[data-rexp]').length,
    empty: (document.querySelector('#mcpDetailBody .mcp-empty') || {}).innerText || '',
  }));

  // 用例明细展开
  const anyRow = await page.$('#mcpDetailBody tr[data-rexp]');
  if (anyRow) { await anyRow.click(); await wait(500); }
  out.reportExpand = await page.evaluate(() => {
    const shown = [...document.querySelectorAll('#mcpDetailBody tr.mcp-exp-row')].filter(r => !r.hidden);
    return { shown: shown.length, text: shown[0] ? shown[0].innerText.replace(/\s+/g, ' ').slice(0, 300) : '' };
  });
  await page.screenshot({ path: 'tools/shot-mcp-report.png', fullPage: false });

  // 导出按钮存在性
  out.exportBtns = await page.evaluate(() =>
    [...document.querySelectorAll('#mcpDetailActions button')].map(b => b.id + ':' + b.textContent.trim()));

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
