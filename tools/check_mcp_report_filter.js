// 专项验证：报告页「仅失败」筛选 + 明细分页（构造 202 条批次验证翻页）
const puppeteer = require('puppeteer-core');
const { goto } = require('./nav');
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

  await page.goto('http://127.0.0.1:8788/', { waitUntil: 'networkidle2' });
  await wait(900);
  await goto(page, 'run');
  await wait(1500);

  const out = { errors };

  // 打开 202 条的参数级批次（第 2 行），验证明细分页
  const rows = await page.$$('#mcpRunTable tbody tr');
  out.rowCount = rows.length;
  // 找到 202 条的那一行
  const idx = await page.evaluate(() => {
    const trs = [...document.querySelectorAll('#mcpRunTable tbody tr')];
    return trs.findIndex(tr => /\t202\t/.test(tr.innerText));
  });
  out.targetIdx = idx;
  await page.click('#mcpRunTable tbody tr:nth-child(' + (idx + 1) + ') [data-report]');
  await wait(2000);

  out.rpt = await page.evaluate(() => {
    const b = document.querySelector('#mcpDetailBody');
    return {
      title: document.querySelector('#mcpDetailTitle').textContent.trim(),
      sub: document.querySelector('#mcpDetailSub').textContent.trim(),
      statCards: [...b.querySelectorAll('.mcp-rpt')].map(c => c.innerText.replace(/\s+/g, ' ').trim()),
      filters: [...b.querySelectorAll('[data-rpf]')].map(x => x.textContent.trim()),
      caseRows: b.querySelectorAll('tr[data-rexp]').length,
      pager: (b.querySelector('.mcp-pager') || {}).innerText || '',
    };
  });

  // 首页 -> 下一页
  await page.click('#mcpDetailBody [data-rpp="2"]');
  await wait(600);
  out.page2 = await page.evaluate(() => ({
    caseRows: document.querySelectorAll('#mcpDetailBody tr[data-rexp]').length,
    pager: (document.querySelector('#mcpDetailBody .mcp-pager') || {}).innerText || '',
    firstId: (document.querySelector('#mcpDetailBody tr[data-rexp]') || {}).innerText || '',
  }));

  // 切「仅失败」
  await page.click('#mcpDetailBody [data-rpf="fail"]');
  await wait(600);
  out.failFilter = await page.evaluate(() => ({
    caseRows: document.querySelectorAll('#mcpDetailBody tr[data-rexp]').length,
    active: [...document.querySelectorAll('#mcpDetailBody [data-rpf]')].map(x => x.textContent.trim() + (x.classList.contains('primary') ? '*' : '')),
    empty: (document.querySelector('#mcpDetailBody .empty-hint') || {}).innerText || '',
    pager: (document.querySelector('#mcpDetailBody .mcp-pager') || {}).innerText || '',
  }));

  // 回到全部
  await page.click('#mcpDetailBody [data-rpf="all"]');
  await wait(600);
  out.backAll = await page.evaluate(() => ({
    caseRows: document.querySelectorAll('#mcpDetailBody tr[data-rexp]').length,
    pager: (document.querySelector('#mcpDetailBody .mcp-pager') || {}).innerText || '',
  }));

  // 展开一条
  await page.click('#mcpDetailBody tr[data-rexp]');
  await wait(500);
  out.expand = await page.evaluate(() => {
    const shown = [...document.querySelectorAll('#mcpDetailBody tr.mcp-exp-row')].filter(r => !r.hidden);
    return shown.length;
  });

  await page.screenshot({ path: 'tools/shot-mcp-report-202.png' });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
