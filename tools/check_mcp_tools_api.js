const puppeteer = require('puppeteer-core');
const { goto } = require('./nav');
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', args: ['--no-sandbox'],
  });
  const p = await b.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await p.setViewport({ width: 1500, height: 1100 });
  await p.goto('http://127.0.0.1:8788/', { waitUntil: 'networkidle2' });
  await wait(900);
  await goto(p, 'contract'); await wait(1600);

  const head = await p.evaluate(() => [...document.querySelectorAll('#mcpToolTable thead th')].map(th => th.innerText.trim()));
  const first = await p.evaluate(() => {
    const tr = document.querySelector('#mcpToolTable tbody tr');
    if (!tr) return null;
    const nameEl = tr.querySelector('.mcp-tool-name');
    const rect = nameEl.getBoundingClientRect();
    return {
      cells: tr.cells.length,
      name: nameEl.innerText.trim(),
      nameFull: nameEl.dataset.copy,
      nameW: Math.round(rect.width), nameScrollW: nameEl.scrollWidth,
      clipped: nameEl.scrollWidth > nameEl.clientWidth + 1,
      method: (tr.querySelector('.mcp-method') || {}).innerText || '',
      methodClass: (tr.querySelector('.mcp-method') || {}).className || '',
      path: (tr.querySelector('.mcp-path') || {}).innerText || '',
      params: [...tr.querySelectorAll('.mcp-param')].map(x => x.innerText),
      desc: tr.querySelector('.mcp-tool-desc').innerText.trim(),
    };
  });

  // 最长工具名是否完整显示（第 1 页内找最长的一个）
  const longest = await p.evaluate(() => {
    const els = [...document.querySelectorAll('#mcpToolTable .mcp-tool-name')];
    const el = els.sort((a, b) => b.innerText.length - a.innerText.length)[0];
    return { text: el.innerText.trim(), clipped: el.scrollWidth > el.clientWidth + 1, len: el.innerText.trim().length };
  });

  // 点工具名 → 复制提示
  await p.click('#mcpToolTable tbody tr:first-child .mcp-tool-name');
  await wait(500);
  const toastText = await p.evaluate(() => {
    const t = document.querySelector('.toast, #toast, .toast-box');
    return t ? t.innerText.trim() : '';
  });

  await p.screenshot({ path: 'tools/shot-mcp-tools-api.png' });

  // 翻到第 2 页与末页，确认名称/接口仍完整
  await p.click('#mcpToolTable [data-mtp="2"]'); await wait(500);
  const page2 = await p.evaluate(() => {
    const tr = document.querySelector('#mcpToolTable tbody tr');
    return { no: tr.cells[0].innerText.trim(), name: tr.querySelector('.mcp-tool-name').innerText.trim(),
             api: (tr.querySelector('.mcp-method') || {}).innerText + ' ' + (tr.querySelector('.mcp-path') || {}).innerText };
  });
  const pagerText = await p.evaluate(() => {
    const el = document.querySelector('#mcpToolTable .mcp-pager, #mcpToolTable .pager');
    return el ? el.innerText.replace(/\n/g, ' | ') : '';
  });
  const pgNums = await p.evaluate(() => [...document.querySelectorAll('#mcpToolTable [data-mtp]')].map(b => b.dataset.mtp));
  await p.click('#mcpToolTable [data-mtp="' + pgNums[pgNums.length - 1] + '"]'); await wait(500);
  const lastPage = await p.evaluate(() => {
    const rows = [...document.querySelectorAll('#mcpToolTable tbody tr')];
    return { rows: rows.length, name: rows[0].querySelector('.mcp-tool-name').innerText.trim() };
  });

  console.log(JSON.stringify({ errors, head, first, longest, toastText, page2, pagerText, pgNums, lastPage }, null, 1));
  await b.close();
})();
