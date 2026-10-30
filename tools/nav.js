/**
 * 自测脚本共用的导航辅助。
 *
 * 菜单结构调整后（契约发现提为一级菜单、参数级用例并入「测试用例」页标签、
 * 场景级用例并入「测试场景」页标签），旧的 `#mcpSubmenu .mcp-sub[data-msub=...]`
 * 选择器已失效。所有脚本统一通过 goto(page, sub) 进入目标视图。
 *
 * 用法：
 *   const { goto } = require('./nav');
 *   await goto(page, 'contract');   // 契约发现（一级页）
 *   await goto(page, 'params');     // 测试用例 → 参数级用例标签
 *   await goto(page, 'scenarios');  // 测试场景 → 场景级用例标签
 *   await goto(page, 'run');        // MCP 测试 → 一键回归
 */
const wait = ms => new Promise(r => setTimeout(r, ms));

async function clickIf(page, sel, waitMs = 400) {
  const el = await page.$(sel);
  if (!el) return false;
  await el.click();
  await wait(waitMs);
  return true;
}

/**
 * 进入指定视图。sub 沿用旧的 MCP 子页命名，便于各脚本最小改动。
 * @returns {Promise<boolean>} 是否成功定位到入口
 */
async function goto(page, sub = 'run') {
  switch (sub) {
    case 'contract':
      return clickIf(page, '.menu-item[data-page="contract"]', 1500);

    case 'params':
      await clickIf(page, '.menu-item[data-page="cases"]', 300);
      return clickIf(page, '#caseTabs .seg-tab[data-ctab="params"]', 1200);

    case 'caselist':
      await clickIf(page, '.menu-item[data-page="cases"]', 300);
      return clickIf(page, '#caseTabs .seg-tab[data-ctab="list"]', 900);

    case 'scenarios':
      await clickIf(page, '.menu-item[data-page="scenarios"]', 300);
      return clickIf(page, '#scenTabs .seg-tab[data-stab="mcp"]', 1200);

    case 'scenlist':
      await clickIf(page, '.menu-item[data-page="scenarios"]', 300);
      return clickIf(page, '#scenTabs .seg-tab[data-stab="list"]', 900);

    case 'run':
      await clickIf(page, '#menuMcpRoot', 350);
      return clickIf(page, '#mcpSubmenu .mcp-sub[data-msub="run"]', 1500);

    case 'diff':
      await clickIf(page, '#menuMcpRoot', 350);
      return clickIf(page, '#mcpSubmenu .mcp-sub[data-msub="diff"]', 1200);

    default:
      throw new Error('未知的视图: ' + sub);
  }
}

module.exports = { goto, clickIf, wait };
