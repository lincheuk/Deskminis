// E1 审核：Aurora 色板真渲染目视——主界面与设置页 × 暗/亮双主题四张截图。
// 强制 data-theme 截图（appearanceMode 机制本波未动，不在验收面；看的是色板渲染）。
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = '/home/user/Deskminis/deskminis';
const SHOTS = '/tmp/claude-0/-home-user-Deskminis/de13f871-02f4-5133-95e9-9105e3bca00b/scratchpad/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log('[drive]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ss = async (page, name) => {
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  log('screenshot:', name);
};
const setTheme = (page, mode) => page.evaluate((m) => {
  document.documentElement.dataset.theme = m;
  return getComputedStyle(document.body).backgroundColor;
}, mode);

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'],
  cwd: APP_DIR,
  timeout: 45_000,
});
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null;
    if (!page) await sleep(500);
  }
  if (!page) page = await app.firstWindow();
  await page.waitForSelector('body', { timeout: 15_000 });
  await sleep(4000);

  log('dark bg =', await setTheme(page, 'dark'));
  await sleep(400);
  await ss(page, 'e2-main-dark');
  log('light bg =', await setTheme(page, 'light'));
  await sleep(400);
  await ss(page, 'e2-main-light');

  // 打开设置（rail 齿轮，title=设置）
  const open = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[title]')].find((e) => (e.getAttribute('title') ?? '').includes('设置'));
    if (!el) return 'NOT_FOUND';
    el.click();
    return 'OK';
  });
  log('openSettings →', open);
  await page.waitForSelector('.sitem', { timeout: 8_000 });
  await sleep(600);
  await ss(page, 'e2-settings-light');
  log('dark bg =', await setTheme(page, 'dark'));
  await sleep(400);
  await ss(page, 'e2-settings-dark');
} finally {
  await app.close().catch(() => {});
}
log('done');
