// 排版 A/B 试验台：同一界面注入不同 token 覆写，逐组截图，供目视选档。
// 用法：node drive-typo-ab.mjs   （变体定义见 VARIANTS）
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
const APP_DIR = '/home/user/Deskminis/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/ef029206-b91f-57eb-8ce8-a84cf713c455/scratchpad';
const SHOTS = path.join(S, 'shots');
const DATA = path.join(S, 'typo-data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));

// 每个变体 = 一组 CSS 覆写（注入 <style id="ab">，切换时整体替换）
const VARIANTS = JSON.parse(fs.readFileSync(path.join(S, 'typo-variants.json'), 'utf8'));

const log = (...a) => console.log('[ab]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apply = (page, css) => page.evaluate((css) => {
  let el = document.getElementById('ab');
  if (!el) { el = document.createElement('style'); el.id = 'ab'; document.head.appendChild(el); }
  el.textContent = css;
}, css);

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45_000,
  env: { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA, DESKMINIS_FAKE_REPLY: '好的，我已经读完这个目录：共 12 个文件，核心逻辑集中在 `src/minisd/` 下。要点整理如下——第一，入口在 index.ts；第二，工具注册表在 tools/registry.ts。' },
});
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(500); }
  await page.waitForSelector('body', { timeout: 15_000 });
  await sleep(4500);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  // 先在欢迎态逐变体截一轮（hero 字号/助手 chips/示例卡的排版差异只在这里看得到）
  for (const v of VARIANTS) {
    await apply(page, v.css);
    await sleep(400);
    await page.screenshot({ path: path.join(SHOTS, `ab-${v.name}-welcome.png`) });
    log('shot: ab-' + v.name + '-welcome');
  }
  await apply(page, '');
  await sleep(300);

  // 造一个有正文的会话（排版差异要在真实文字上看）
  await page.evaluate(() => {
    const ta = document.querySelector('.composer textarea');
    ta.focus(); ta.value = '帮我读一下这个项目的目录结构，说说核心模块都在哪';
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(200);
  await page.keyboard.press('Enter');
  for (let t = 0; t < 40; t++) { await sleep(500); if (!(await page.evaluate(() => !!document.querySelector('.send.stop')))) break; }
  await sleep(1200);

  for (const v of VARIANTS) {
    await apply(page, v.css);
    await sleep(500);
    await page.screenshot({ path: path.join(SHOTS, `ab-${v.name}-chat.png`) });
    log('shot: ab-' + v.name + '-chat');
  }
} finally { await app.close().catch(() => {}); }
log('done');
