// DeskMinis MCP 设置页 UI 驱动：launch → 设置 → MCP 页 → 添加表单 → 试连 → 保存 → 截图
// 在 xvfb 下跑：xvfb-run -a node drive-mcp-ui.mjs
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const APP_DIR = '/home/user/Deskminis/deskminis';
const SHOTS = '/tmp/claude-0/-home-user-Deskminis/de13f871-02f4-5133-95e9-9105e3bca00b/scratchpad/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const NODE_BIN = execSync('which node').toString().trim();
const FIXTURE = path.join(APP_DIR, 'tests/mcp-stdio-server.mjs');

const log = (...a) => console.log('[drive]', ...a);
const ss = async (page, name) => {
  const f = path.join(SHOTS, name + '.png');
  await page.screenshot({ path: f });
  log('screenshot:', f);
};
// v-model 输入：直接设 value 不触发 Vue 响应，必须补 input 事件
const fill = (page, sel, value) => page.evaluate(({ sel, value }) => {
  const el = document.querySelector(sel);
  if (!el) return 'NOT_FOUND ' + sel;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'OK';
}, { sel, value });
const clickText = (page, scope, text) => page.evaluate(({ scope, text }) => {
  const els = [...document.querySelectorAll(scope)];
  const el = els.find(e => e.textContent?.trim() === text) ?? els.find(e => e.textContent?.includes(text));
  if (!el) return 'NOT_FOUND: ' + text + ' | 候选: ' + els.map(e => e.textContent?.trim()).filter(Boolean).slice(0, 30).join(' / ');
  el.click(); return 'OK';
}, { scope, text });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'],
  cwd: APP_DIR,
  timeout: 45_000,
});
try {
  // 等真正的 UI 窗口（跳过 devtools）
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    page = app.windows().find(w => !w.url().startsWith('devtools://')) ?? null;
    if (!page) await sleep(500);
  }
  if (!page) page = await app.firstWindow();
  log('window url:', page.url());
  await page.waitForSelector('body', { timeout: 15_000 });
  await sleep(4000); // 等 renderer 连上 minisd、首屏渲染稳定
  await ss(page, '01-main');

  // 打开设置：左栏图标轨的「设置」入口（title 或文本），失败时 dump 候选
  const openSettings = await page.evaluate(() => {
    const cands = [...document.querySelectorAll('[title], button, .it, .mi, .tb-ico')];
    const el = cands.find(e => (e.getAttribute('title') ?? '').includes('设置'))
      ?? cands.find(e => (e.textContent ?? '').trim() === '设置')
      ?? cands.find(e => (e.textContent ?? '').includes('设置'));
    if (!el) return 'NOT_FOUND | 带 title 的元素: ' + [...document.querySelectorAll('[title]')].map(e => e.getAttribute('title')).slice(0, 40).join(' / ');
    el.click(); return 'OK: ' + (el.getAttribute('title') ?? el.textContent?.trim());
  });
  log('openSettings →', openSettings);
  await page.waitForSelector('.sitem', { timeout: 8_000 });

  // 进 MCP 页
  log('nav MCP →', await clickText(page, '.sitem', 'MCP'));
  await sleep(600);
  await ss(page, '02-mcp-empty');

  // 添加服务器表单
  log('add →', await clickText(page, 'button', '添加服务器'));
  await page.waitForSelector('#mcp-f-name', { timeout: 5_000 });
  log('name →', await fill(page, '#mcp-f-name', 'demo-fixture'));
  log('command →', await fill(page, '#mcp-f-command', NODE_BIN));
  log('args →', await fill(page, '#mcp-f-args', FIXTURE));
  await sleep(300);
  await ss(page, '03-form-filled');

  // 表单内试连（按钮文案含「试连」）
  log('test →', await clickText(page, 'button', '试连'));
  // 等内联结果出现（✓/✗ 文案）
  for (let i = 0; i < 40; i++) {
    const t = await page.evaluate(() => document.body.innerText);
    if (t.includes('连接成功') || t.includes('✗') || t.includes('失败')) break;
    await sleep(500);
  }
  await sleep(400);
  await ss(page, '04-test-result');

  // 保存 → 列表行
  log('save →', await clickText(page, 'button', '保存'));
  await sleep(1200);
  await ss(page, '05-list');

  // 列表行再试连一次（走 { name } 形态）
  log('row-test →', await clickText(page, '.mxtestbtn', '试连'));
  for (let i = 0; i < 40; i++) {
    const t = await page.evaluate(() => document.body.innerText);
    if (t.includes('连接成功')) break;
    await sleep(500);
  }
  await sleep(400);
  await ss(page, '06-row-test');

  // 抓页面文本收尾（供报告引用）
  const finalText = await page.evaluate(() => document.querySelector('.mxs')?.innerText ?? document.body.innerText);
  log('--- MCP 页面文本 ---\n' + finalText.slice(0, 1200));
} finally {
  await app.close().catch(() => {});
}
log('done');
