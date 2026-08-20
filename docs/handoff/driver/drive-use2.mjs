// 段2重跑：DATA 已就绪（技能已装、MCP 条目已替换为 node fixture）→ 会话真调 mcp__ 工具。
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = '/home/user/Deskminis/deskminis';
const SCRATCH = '/tmp/claude-0/-home-user-Deskminis/de13f871-02f4-5133-95e9-9105e3bca00b/scratchpad';
const SHOTS = path.join(SCRATCH, 'shots');
const DATA = path.join(SCRATCH, 'use-data');
const log = (...a) => console.log('[e2e]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ss = async (page, name) => { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); log('shot:', name); };
const waitText = async (page, needle, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    if ((await page.evaluate(() => document.body.innerText)).includes(needle)) return true;
    await sleep(500);
  }
  return false;
};

const cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'mcp-servers', 'servers.json'), 'utf8'));
const serverName = Object.keys(cfg.mcpServers)[0];
log('server:', serverName, '| command:', cfg.mcpServers[serverName].command);

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45_000,
  env: { ...process.env, DESKMINIS_DATA_DIR: DATA, DESKMINIS_FAKE_PROVIDER: '1' },
});
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null;
    if (!page) await sleep(500);
  }
  await page.waitForSelector('body', { timeout: 15_000 });
  await sleep(4000);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });

  const toolName = `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__echo`; // D5 sanitizeSegment 同规则
  log('调用:', toolName);
  await page.evaluate((t) => {
    const ta = document.querySelector('.composer textarea, textarea');
    ta.focus(); ta.value = t;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, `__tool__ ${toolName} {"tool_title":"市场MCP echo 试调","hi":"aurora","from":"market-install"}`);
  await sleep(300);
  // 点发送钮（composer 内最后一个 button，即青色圆形发送钮）
  const sendRes = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.composer button')];
    const b = btns.at(-1);
    if (!b) return 'NO_BTN';
    b.click(); return 'SENT via ' + (b.className || 'button');
  });
  log('send →', sendRes);

  const permShown = await waitText(page, '仅此次', 24) || await waitText(page, '本会话允许', 6);
  log('MCP 权限卡:', permShown);
  await ss(page, 'use2-perm-card');
  if (permShown) {
    const r = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const b = btns.find((e) => e.textContent?.trim() === '本会话允许') ?? btns.find((e) => e.textContent?.includes('允许'));
      if (!b) return 'NO_ALLOW_BTN';
      b.click(); return 'ALLOWED';
    });
    log('允许 →', r);
  }
  const done = await waitText(page, 'aurora', 40);
  log('echo 回显 aurora:', done);
  await sleep(1000);
  await ss(page, 'use2-tool-result');
  // 点开工具行抓错误正文
  await page.evaluate(() => { document.querySelector('.tline')?.click(); });
  await sleep(800);
  const expand = await page.evaluate(() => document.querySelector('.texpand')?.innerText ?? 'NO_EXPAND');
  log('── 工具行展开 ──');
  log(expand.slice(0, 800));
  const txt = await page.evaluate(() => document.body.innerText);
  log('── 采样 ──');
  log(txt.split('\n').filter((l) => l.includes('echo') || l.includes('aurora') || l.includes('允许') || l.includes('mcp')).slice(0, 12).join('\n'));
} finally { await app.close().catch(() => {}); }
log('done');
