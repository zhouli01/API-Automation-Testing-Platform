/**
 * 契约发现 · 云枢功能模块选择器自测。
 *
 * 覆盖：
 * 1) 模块 chips 渲染（数量 / 标签 / 计数 / 空模块置灰）
 * 2) 单模块切换：工具清单按模块收窄
 * 3) 多选合并发现：一次勾多个模块 → 契约合并导出，工具数 = 各模块之和
 * 4) 快捷操作：全选 / 仅制品库
 * 5) 模块列（工具清单每行展示所属模块）
 * 6) 收尾：把发现范围恢复为「仅制品库」，避免污染下次手动验证
 *
 * 运行：node tools/check_mcp_modules.js
 */
const puppeteer = require('puppeteer-core');
const { goto, wait } = require('./nav');

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
  page.on('response', r => { if (r.status() >= 400) errors.push('http' + r.status() + ': ' + r.url()); });

  await page.goto('http://127.0.0.1:8788/', { waitUntil: 'networkidle2', timeout: 60000 });
  await wait(1200);
  await goto(page, 'contract');
  await wait(2000);

  /** 读取选择器 + 工具清单的当前状态 */
  const snap = () => page.evaluate(() => {
    const chips = [...document.querySelectorAll('#mcpModules .chip')].map(c => ({
      key: c.dataset.mod,
      label: (c.textContent || '').replace(/\d+$/, '').trim(),
      count: Number((c.querySelector('.cnt') || {}).textContent || 0),
      on: c.classList.contains('on'),
      dim: c.classList.contains('dim'),
      disabled: !!c.disabled,
    }));
    const pagerInfo = document.querySelector('#mcpToolTable .mpg-info');
    const rows = [...document.querySelectorAll('#mcpToolTable tbody tr')];
    return {
      chips,
      sum: (document.querySelector('#mcpModSum') || {}).textContent || '',
      countText: (document.querySelector('#mcpToolCount') || {}).textContent || '',
      tableTotal: pagerInfo ? Number((pagerInfo.querySelector('b') || {}).textContent || 0) : -1,
      rows: rows.length,
      emptyHint: document.querySelector('#mcpToolTable tbody td[colspan]')
        ? document.querySelector('#mcpToolTable tbody td[colspan]').textContent.trim() : '',
      modLabels: rows.map(r => (r.children[1] || {}).textContent || '').filter(Boolean),
    };
  }).catch(() => ({}));

  const click = async sel => {
    const el = await page.$(sel);
    if (!el) return false;
    await el.click();
    await wait(900);
    return true;
  };

  const out = {};
  out.initial = await snap();

  // ② 单模块切换：只留「项目管理」
  await click('#mcpModDefault');                 // 先回到仅制品库，保证起点确定
  await click('#mcpModules .chip[data-mod="armory"]');   // 取消制品库（此时唯一选中 → 应被拒绝）
  out.rejectLast = await snap();
  await click('#mcpModules .chip[data-mod="project"]');  // 勾上项目管理（armory 仍在）
  await click('#mcpModules .chip[data-mod="armory"]');   // 取消制品库 → 只剩项目管理
  out.projectOnly = await snap();

  // ③ 多选合并发现：项目管理 + 制品库
  await click('#mcpModules .chip[data-mod="armory"]');
  await page.screenshot({ path: 'tools/shot-mcp-modules-picked.png' });
  await click('#btnMcpDiscover');
  await wait(2500);
  out.multiDiscover = {
    ...(await snap()),
    outText: await page.evaluate(() => (document.querySelector('#mcpOutContract') || {}).textContent || ''),
  };
  await page.screenshot({ path: 'tools/shot-mcp-modules-multi.png' });

  // ④ 快捷操作：仅制品库（契约仍含两个模块，清单应只剩 101 项）
  await click('#mcpModDefault');
  out.armoryOnly = await snap();
  await page.screenshot({ path: 'tools/shot-mcp-modules-armory.png' });

  // ④ 快捷操作：全选（清单回到契约内全部模块）
  await click('#mcpModAll');
  out.allPicked = await snap();

  // ⑤ 收尾：恢复「仅制品库」并重新发现，保持历史默认范围
  await click('#mcpModDefault');
  await click('#btnMcpDiscover');
  await wait(2500);
  out.final = await snap();

  console.log(JSON.stringify({ out, errors }, null, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
