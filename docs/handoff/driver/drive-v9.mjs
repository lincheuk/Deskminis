// V9 实拍：选中助手正文 → 浮条 → 注释 → 高亮 → 气泡改笔记
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
const APP_DIR = '/home/user/Deskminis/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/ef029206-b91f-57eb-8ce8-a84cf713c455/scratchpad';
const SHOTS = path.join(S, 'shots');
const DATA = path.join(S, 'v9-data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true }); fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
const log = (...a) => console.log('[v9]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ss = async (p, n) => { await p.screenshot({ path: path.join(SHOTS, n + '.png') }); log('shot:', n); };
const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45000,
  env: { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA,
         DESKMINIS_FAKE_REPLY: '这个项目的入口在 src/main/index.ts，它拉起 minisd 子进程并开一个 frameless 窗口。渲染层走 Vue 3 + Pinia，与后端之间是一条 JSON-RPC over WebSocket 的通道。数据都落在本机 SQLite，没有云端。' },
});
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { page = app.windows().find(w => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(500); }
  await page.waitForSelector('body', { timeout: 15000 });
  await sleep(4500);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.evaluate(() => {
    const ta = document.querySelector('textarea.field');
    ta.focus(); ta.value = '这个项目怎么跑起来的？';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(250);
  await page.keyboard.press('Enter');
  for (let i = 0; i < 60; i++) { await sleep(500); if (await page.evaluate(() => !document.querySelector('.go.stop'))) break; }
  await sleep(2000);
  log('anno roots:', await page.evaluate(() => document.querySelectorAll('[data-anno-root]').length));

  // 用真实鼠标拖选助手正文里的一段
  const box = await page.evaluate(() => {
    const p = document.querySelector('[data-anno-root] .md-p');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2, w: r.width };
  });
  log('para box:', JSON.stringify(box));
  if (box) {
    await page.mouse.move(box.x + 6, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.min(box.w - 12, 260), box.y, { steps: 12 });
    await page.mouse.up();
    await sleep(700);
    await ss(page, 'v9-bar');
    log('bar:', await page.evaluate(() => document.querySelector('.abar')?.textContent?.replace(/\s+/g, ' ').trim() ?? null));

    // 点「注释」
    await page.evaluate(() => [...document.querySelectorAll('.abar button')].find(b => b.textContent.includes('注释'))?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await sleep(1500);
    await ss(page, 'v9-highlight');
    log('annotations:', await page.evaluate(() => ({
      count: window.__annoCount ?? null,
      hl: (CSS.highlights?.get('dm-anno')?.size) ?? null,
    })));

    // 点高亮开气泡
    await page.mouse.click(box.x + 40, box.y);
    await sleep(900);
    await ss(page, 'v9-pop');
    log('pop:', await page.evaluate(() => document.querySelector('.apop .aq')?.textContent?.trim() ?? null));

    // 写笔记保存
    await page.evaluate(() => {
      const ta = document.querySelector('.apop .an');
      if (ta) { ta.value = '这段要写进交接文档'; ta.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    await sleep(200);
    await page.evaluate(() => [...document.querySelectorAll('.apop .f-btn')].find(b => b.textContent.trim() === '保存')?.click());
    await sleep(1400);
    await ss(page, 'v9-noted');
    log('noted hl:', await page.evaluate(() => (CSS.highlights?.get('dm-anno-noted')?.size) ?? null));

    // 引用到输入框
    await page.mouse.move(box.x + 6, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.min(box.w - 12, 200), box.y, { steps: 10 });
    await page.mouse.up();
    await sleep(600);
    await page.evaluate(() => [...document.querySelectorAll('.abar button')].find(b => b.textContent.includes('引用'))?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await sleep(800);
    await ss(page, 'v9-quote');
    log('draft:', JSON.stringify((await page.evaluate(() => document.querySelector('textarea.field')?.value ?? '')).slice(0, 80)));
  }
} finally { await app.close().catch(() => {}); }
log('done');
