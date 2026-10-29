const puppeteer = require('puppeteer-core');
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('requestfailed', r => errors.push('reqfail: ' + r.url()));

  await page.goto('http://127.0.0.1:8788/', { waitUntil: 'networkidle2' });
  await wait(800);
  await page.click('#menuMcpRoot');
  await wait(500);

  const out = {};

  // ⑤ Diff 页面点「立即 Diff」
  await page.click('#mcpSubmenu .mcp-sub[data-msub="diff"]');
  await wait(1500);
  await page.click('#btnMcpDiff');
  await wait(3000);
  out.diff = await page.evaluate(() => ({
    meta: document.querySelector('#mcpDiffMeta').textContent,
    table: document.querySelector('#mcpDiffTable').innerText.slice(0, 120).replace(/\s+/g, ' '),
    disabled: document.querySelector('#btnMcpDiff').disabled,
    label: document.querySelector('#btnMcpDiff').textContent,
  }));

  // ② 参数级：重新生成
  await page.click('#mcpSubmenu .mcp-sub[data-msub="params"]');
  await wait(1200);
  await page.click('#btnMcpGenParams');
  await wait(3000);
  out.genParams = await page.evaluate(() => ({
    meta: document.querySelector('#mcpParamsMeta').textContent,
    out: document.querySelector('#mcpOutParams').textContent,
    hidden: document.querySelector('#mcpOutParams').hidden,
    rows: document.querySelectorAll('#mcpParamsTable tbody tr').length,
    chips: document.querySelector('#mcpParamsCats').innerText.replace(/\s+/g, ' '),
  }));

  // ③ 场景级：执行链路
  await page.click('#mcpSubmenu .mcp-sub[data-msub="scenarios"]');
  await wait(1200);
  await page.click('#btnMcpRunScen');
  await wait(6000);
  out.runScen = await page.evaluate(() => ({
    out: (document.querySelector('#mcpOutScen').textContent || '').slice(0, 220),
    hidden: document.querySelector('#mcpOutScen').hidden,
  }));
  await page.screenshot({ path: 'tools/shot-mcp-scen-run.png' });

  // ④ 一键回归
  await page.click('#mcpSubmenu .mcp-sub[data-msub="run"]');
  await wait(1200);
  await page.click('#btnMcpRegression');
  await wait(12000);
  out.regression = await page.evaluate(() => ({
    out: (document.querySelector('#mcpOutRun').textContent || '').slice(0, 300),
    hidden: document.querySelector('#mcpOutRun').hidden,
    rows: document.querySelectorAll('#mcpRunTable tbody tr').length,
  }));
  await page.screenshot({ path: 'tools/shot-mcp-run-done.png' });

  out.errors = errors;
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
