/**
 * 验证「接口名称」在四处展示：
 *   ① 测试用例 → 用例列表（接口名称列 = 契约里的真实接口 METHOD /path）
 *   ② 测试用例 → 参数级用例（新增「接口名称」列）
 *   ③ 测试场景 → 场景级用例 → 场景详情（新增「接口名称」列 + 展开行 KV）
 *   ④ 运行记录详情（回归报告的失败明细与用例执行明细，均新增「接口名称」列）
 *
 * 运行：node tools/check_iface_name.js
 */
const puppeteer = require('puppeteer-core');
const { goto, wait } = require('./nav');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

// 取表格列头文本 + 前 3 行某列的文本（按列头名定位，列顺序变化也能适配）
const grabTable = (tableSel, colName) => {
  const tbl = document.querySelector(tableSel);
  if (!tbl) return null;
  const heads = [...tbl.querySelectorAll('thead th')].map(th => th.innerText.replace(/\s+/g, ' ').trim());
  const idx = heads.indexOf(colName);
  const rows = [...tbl.querySelectorAll('tbody tr')].slice(0, 3).map(tr => {
    const tds = [...tr.children];
    return idx >= 0 && tds[idx] ? tds[idx].innerText.replace(/\s+/g, ' ').trim() : '';
  });
  return { heads, colIdx: idx, rows };
};

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 1000 });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('http://127.0.0.1:8788/', { waitUntil: 'networkidle2' });
  await wait(1000);

  const out = { errors };

  // ① 用例列表（用的是 div 网格 .case-row，不是 table）
  await goto(page, 'caselist');
  await wait(1200);
  out.caseList = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#caseList .case-row')].slice(0, 6);
    return {
      head: (document.querySelector('#caseList .case-head') || {}).innerText || '',
      rows: rows.map(r => {
        const iface = r.querySelector('.case-iface');
        return iface ? iface.innerText.replace(/\s+/g, ' ').trim() : '';
      }),
      tips: rows.slice(0, 2).map(r => {
        const iface = r.querySelector('.case-iface');
        return iface ? iface.getAttribute('title') : '';
      }),
    };
  });

  // ② 参数级用例
  await goto(page, 'params');
  await wait(1400);
  out.params = await page.evaluate(grabTable, '#mcpParamsTable', '接口名称');

  // ③ 场景详情
  await goto(page, 'scenarios');
  await wait(1400);
  await page.click('#mcpScenTable tbody tr');
  await wait(1500);
  out.scenDetail = await page.evaluate(grabTable, '#mcpDetailBody table.dt', '接口名称');
  out.scenDetailKV = await page.evaluate(() => {
    const kv = [...document.querySelectorAll('#mcpDetailBody .mcp-kv > div')]
      .map(d => d.innerText.replace(/\s+/g, ' ').trim());
    return kv.slice(0, 6);
  });
  // 展开首行，确认展开区也有「接口名称」
  await page.click('#mcpDetailBody tr[data-scase="0"]');
  await wait(600);
  out.scenExpand = await page.evaluate(() => {
    const row = document.querySelector('#mcpScase-0');
    const kv = row ? [...row.querySelectorAll('.mcp-kv > div')].map(d => d.innerText.replace(/\s+/g, ' ').trim()) : [];
    return { hidden: row ? row.hidden : null, kv: kv.slice(0, 4) };
  });
  await page.click('#btnMcpDetailBack');
  await wait(700);

  // ④ 运行记录 → 报告
  await goto(page, 'run');
  await wait(1600);
  await page.click('#mcpRunTable [data-report]');
  await wait(2000);
  out.report = await page.evaluate(() => {
    const tables = [...document.querySelectorAll('#mcpDetailBody table.dt')];
    return tables.map(t => {
      const heads = [...t.querySelectorAll('thead th')].map(th => th.innerText.replace(/\s+/g, ' ').trim());
      const idx = heads.indexOf('接口名称');
      const first = t.querySelector('tbody tr');
      const tds = first ? [...first.children] : [];
      return { heads, hasIface: idx >= 0, firstIface: idx >= 0 && tds[idx] ? tds[idx].innerText.replace(/\s+/g, ' ').trim() : '' };
    });
  });
  // 展开首条执行明细
  const expBtn = await page.$('#mcpDetailBody tr[data-rexp="0"]');
  if (expBtn) {
    await expBtn.click();
    await wait(600);
    out.reportExpand = await page.evaluate(() => {
      const row = document.querySelector('#mcpRpt-0');
      const kv = row ? [...row.querySelectorAll('.mcp-kv > div')].map(d => d.innerText.replace(/\s+/g, ' ').trim()) : [];
      return { hidden: row ? row.hidden : null, kv: kv.slice(0, 5) };
    });
  }

  await page.screenshot({ path: 'tools/shot-iface-report.png', fullPage: false });
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})();
