/**
 * MCP 测试各子菜单分页自测：
 * ① 契约发现 / ② 参数级用例 / ③ 场景级用例 / ④ 一键回归（含报告）
 * 校验分页条样式（左「共 N 项数据」+ 右 ‹ 1 2 3 … ›）、翻页、页码窗口折叠；⑤ Diff 不应有分页
 */
const puppeteer = require('puppeteer-core');
const wait = ms => new Promise(r => setTimeout(r, ms));

const readPager = (p, boxSel) => p.evaluate(sel => {
  const box = document.querySelector(sel);
  if (!box) return null;
  const pager = box.querySelector('.mcp-pager');
  if (!pager) return { exists: false };
  const info = pager.querySelector('.mpg-info');
  const nav = pager.querySelector('.mpg-nav');
  const bs = pager.getBoundingClientRect();
  const is = info.getBoundingClientRect();
  const ns = nav.getBoundingClientRect();
  return {
    exists: true,
    infoText: info ? info.innerText.replace(/\s+/g, ' ').trim() : '',
    nums: [...pager.querySelectorAll('.mpg-btn:not(.mpg-arrow)')].map(b => b.innerText.trim()),
    active: (pager.querySelector('.mpg-btn.on') || {}).innerText || '',
    gaps: pager.querySelectorAll('.mpg-gap').length,
    arrows: [...pager.querySelectorAll('.mpg-arrow')].map(b => ({ t: b.innerText.trim(), dis: b.disabled })),
    leftRight: is.left < ns.left && Math.abs(is.top - ns.top) < 14,
    boxW: Math.round(bs.width),
    // 当前页样式：仅描边 + 强调色文字
    activeStyle: (() => {
      const a = pager.querySelector('.mpg-btn.on');
      if (!a) return null;
      const cs = getComputedStyle(a);
      return { border: cs.borderColor, color: cs.color, weight: cs.fontWeight };
    })(),
  };
}, boxSel);

const clickNum = async (p, boxSel, label) => {
  const box = await p.$(boxSel);
  const btns = await box.$$('.mpg-btn');
  for (const b of btns) {
    const t = await p.evaluate(el => el.innerText.trim(), b);
    if (t === String(label)) { await b.click(); return true; }
  }
  return false;
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', args: ['--no-sandbox'],
  });
  const p = await browser.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await p.setViewport({ width: 1500, height: 1100 });
  await p.goto('http://127.0.0.1:8788/', { waitUntil: 'networkidle2' });
  await wait(900);
  await p.click('#menuMcpRoot'); await wait(350);

  const out = {};

  // ① 契约发现（101 工具 → 11 页）
  await p.click('#mcpSubmenu .mcp-sub[data-msub="contract"]'); await wait(1500);
  out.contract = await readPager(p, '#mcpToolTable');
  await clickNum(p, '#mcpToolTable', 6); await wait(400);
  out.contractP6 = await readPager(p, '#mcpToolTable');
  out.contractP6.firstNo = await p.evaluate(() =>
    document.querySelector('#mcpToolTable tbody tr td').innerText.trim());
  // 末页
  await clickNum(p, '#mcpToolTable', out.contractP6.nums[out.contractP6.nums.length - 1]); await wait(400);
  out.contractLast = await readPager(p, '#mcpToolTable');
  out.contractLast.rows = await p.evaluate(() =>
    document.querySelectorAll('#mcpToolTable tbody tr').length);

  // ② 参数级用例（100 工具 → 10 页）
  await p.click('#mcpSubmenu .mcp-sub[data-msub="params"]'); await wait(1200);
  out.params = await readPager(p, '#mcpParamsTable');
  await clickNum(p, '#mcpParamsTable', 3); await wait(350);
  out.paramsP3 = await readPager(p, '#mcpParamsTable');
  out.paramsP3.firstNo = await p.evaluate(() =>
    document.querySelector('#mcpParamsTable tbody tr td').innerText.trim());

  // ③ 场景级用例（3 链路 → 1 页）
  await p.click('#mcpSubmenu .mcp-sub[data-msub="scenarios"]'); await wait(1200);
  out.scenarios = await readPager(p, '#mcpScenTable');
  out.scenRows = await p.evaluate(() =>
    document.querySelectorAll('#mcpScenTable tbody tr').length);
  await p.screenshot({ path: 'tools/shot-pager-scenarios.png' });

  // ③-b 场景详情内用例分页
  await p.click('#mcpScenTable tbody tr:first-child'); await wait(1600);
  out.scenDetail = await readPager(p, '#mcpDetailBody');
  out.scenDetailRows = await p.evaluate(() =>
    document.querySelectorAll('#mcpDetailBody tbody tr.row-link').length);
  await p.click('#btnMcpDetailBack'); await wait(600);

  // ④ 一键回归记录（10 条）
  await p.click('#mcpSubmenu .mcp-sub[data-msub="run"]'); await wait(1500);
  out.run = await readPager(p, '#mcpRunTable');

  // ④-b 报告内明细分页（202 条 → 21 页）
  await p.evaluate(() => {
    const tr = [...document.querySelectorAll('#mcpRunTable tbody tr')]
      .find(r => /\t202\t/.test(r.innerText));
    (tr || document.querySelector('#mcpRunTable tbody tr')).querySelector('[data-report]').click();
  });
  await wait(1800);
  out.report = await p.evaluate(() => {
    const pagers = [...document.querySelectorAll('#mcpDetailBody .mcp-pager')];
    return pagers.map(pg => ({
      info: (pg.querySelector('.mpg-info') || {}).innerText.replace(/\s+/g, ' ').trim(),
      nums: [...pg.querySelectorAll('.mpg-btn:not(.mpg-arrow)')].map(b => b.innerText.trim()),
      active: (pg.querySelector('.mpg-btn.on') || {}).innerText || '',
      gaps: pg.querySelectorAll('.mpg-gap').length,
    }));
  });
  const repPager = await readPager(p, '#mcpDetailBody');
  await p.screenshot({ path: 'tools/shot-pager-report.png' });

  // ⑤ Diff 不应有分页
  await p.click('#btnMcpDetailBack'); await wait(600);
  await p.click('#mcpSubmenu .mcp-sub[data-msub="diff"]'); await wait(1200);
  out.diffPager = await p.evaluate(() =>
    document.querySelectorAll('#mcpPanel-diff .mcp-pager, #mcpPanel-diff .pager').length);

  out.errors = errors;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})();
