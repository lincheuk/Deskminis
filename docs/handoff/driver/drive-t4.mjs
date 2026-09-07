// T4 实拍：三栏工作台——对话列 + 产出物预览 + 工作区面板
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
const APP_DIR = '/home/user/Deskminis/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/ef029206-b91f-57eb-8ce8-a84cf713c455/scratchpad';
const SHOTS = path.join(S, 'shots');
const DATA = path.join(S, 't4-data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
const log = (...a) => console.log('[t4]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ss = async (p, n) => { await p.screenshot({ path: path.join(SHOTS, n + '.png') }); log('shot:', n); };
const MD = [
  '# 农村电动车充电基础设施',
  '',
  '## 战略分析与实施框架',
  '',
  '为区域发展署编制 · 2026 年 3 月',
  '',
  '### 摘要',
  '',
  '本报告分析了农村地区电动车充电网络的建设路径。核心结论有三条：',
  '',
  '1. **选址优先级**：优先覆盖县域主干道服务区，单站辐射半径 30 公里',
  '2. **成本结构**：直流快充站单站投资约 42 万元，其中设备占 61%',
  '3. **回收周期**：按日均 18 车次测算，投资回收期为 4.2 年',
  '',
  '### 一、现状',
  '',
  '截至 2025 年底，试点区域共有充电桩 127 个，其中直流快充仅 23 个，交流慢充占比过高导致周转率低下。',
  '',
  '| 类型 | 数量 | 占比 | 日均使用次数 |',
  '|---|---|---|---|',
  '| 直流快充 | 23 | 18% | 11.4 |',
  '| 交流慢充 | 104 | 82% | 2.1 |',
  '',
  '### 二、建议',
  '',
  '分三期推进，首期在 6 个乡镇布点，配套 `财政补贴 40%` 的资金方案。'
].join("\n");
const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45000,
  env: { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA,
         DESKMINIS_FAKE_REPLY: '报告已经写好了，放在 `whitepaper.md`。我在右边打开给你看——摘要里列了三条核心结论，第二节的表格对比了两种充电桩的周转率差异。要调整哪部分？' },
});
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { page = app.windows().find(w => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(500); }
  await page.waitForSelector('body', { timeout: 15000 });
  await sleep(4500);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.evaluate((md) => {
    const ta = document.querySelector('.card .field');
    ta.focus();
    ta.value = '__tool__ file_write ' + JSON.stringify({ path: 'whitepaper.md', content: md, tool_title: '撰写充电基础设施白皮书' });
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, MD);
  await sleep(200);
  await page.keyboard.press('Enter');
  for (let i = 0; i < 50; i++) { await sleep(500); if (await page.evaluate(() => !document.querySelector('.go.stop'))) break; }
  await sleep(2000);
  await ss(page, 't4-chat-nopreview');
  const w = await page.evaluate(() => ({ ws: !!document.querySelector('.ws'), rows: document.querySelectorAll('.ws .row').length }));
  log('workspace:', JSON.stringify(w));
  // 点工作区里的 whitepaper.md → 分栏预览
  const clicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.ws .row')].find(e => e.textContent?.includes('whitepaper'));
    if (!el) return 'NOT_FOUND'; el.click(); return 'OK';
  });
  log('open file →', clicked);
  await sleep(1500);
  await ss(page, 't4-split-light');
  const sp = await page.evaluate(() => ({
    split: !!document.querySelector('.split.withPreview'),
    doc: !!document.querySelector('.pane .doc'),
    h1: document.querySelector('.pane .doc h2, .pane .doc h1')?.textContent ?? null,
    table: !!document.querySelector('.pane .doc table'),
  }));
  log('preview:', JSON.stringify(sp));
  // 分栏对照态（原图工具条里高亮的那个）
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.seg button')].find(e => e.getAttribute('title') === '分栏对照');
    b?.click();
  });
  await sleep(700);
  await ss(page, 't4-split-compare');
  const sp2 = await page.evaluate(() => ({
    split: !!document.querySelector('.pane .split'),
    gutter: document.querySelectorAll('.pane .gutter span').length,
  }));
  log('compare:', JSON.stringify(sp2));

  // 改动 tab
  await page.evaluate(() => { const b = [...document.querySelectorAll('.tabs button')].find(e => e.textContent?.includes('改动')); b?.click(); });
  await sleep(500);
  await ss(page, 't4-changes');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await sleep(400);
  await ss(page, 't4-split-dark');
} finally { await app.close().catch(() => {}); }
log('done');
