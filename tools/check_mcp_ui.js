const puppeteer = require('puppeteer-core');

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

  await page.goto('http://127.0.0.1:8788/', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 1200));

  // 打开 MCP 菜单
  await page.click('#menuMcpRoot');
  await new Promise(r => setTimeout(r, 800));

  const subs = ['contract', 'params', 'scenarios', 'run', 'diff'];
  const report = [];
  for (const s of subs) {
    await page.click(`#mcpSubmenu .mcp-sub[data-msub="${s}"]`);
    await new Promise(r => setTimeout(r, 2500));
    const info = await page.evaluate(() => {
      const vis = [];
      document.querySelectorAll('#page-mcp .users-panel').forEach(p => {
        const st = getComputedStyle(p);
        if (!p.hidden && st.display !== 'none') vis.push(p.id);
      });
      const pageMcp = document.querySelector('#page-mcp');
      const pageUsers = document.querySelector('#page-users');
      const table = document.querySelector('#page-mcp .users-panel:not([hidden]) .table-wrap');
      return {
        visiblePanels: vis,
        mcpPageVisible: !pageMcp.hidden,
        usersPageVisible: !pageUsers.hidden,
        title: (document.querySelector('#mcpTitle') || {}).textContent,
        activeSub: (document.querySelector('#mcpSubmenu .mcp-sub.active') || {}).dataset?.msub,
        tableText: table ? table.innerText.slice(0, 160).replace(/\s+/g, ' ') : '(no table)',
        tableRows: table ? table.querySelectorAll('tbody tr').length : 0,
      };
    });
    report.push({ sub: s, ...info });
    await page.screenshot({ path: `tools/shot-mcp-${s}.png` });
  }
  console.log(JSON.stringify({ report, errors }, null, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
