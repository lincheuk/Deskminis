// V7 实拍：扩展市场（搜索/源 chips/空态/错误态都要能看）
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
const APP_DIR = '/home/user/Deskminis/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/ef029206-b91f-57eb-8ce8-a84cf713c455/scratchpad';
const SHOTS = path.join(S, 'shots');
const DATA = path.join(S, 'v7-data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true }); fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
const log = (...a) => console.log('[v7]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ss = async (p, n) => { await p.screenshot({ path: path.join(SHOTS, n + '.png') }); log('shot:', n); };
const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45000,
  env: { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA },
});
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { page = app.windows().find(w => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(500); }
  await page.waitForSelector('body', { timeout: 15000 });
  await sleep(4500);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.evaluate(() => [...document.querySelectorAll('.rail .navit')].find(e => e.textContent?.trim().startsWith('扩展市场'))?.click());
  await sleep(4000);
  await ss(page, 'v7-market');
  log('probe:', JSON.stringify(await page.evaluate(() => ({
    market: !!document.querySelector('.market'),
    chips: [...document.querySelectorAll('.chip')].map(e => e.textContent.trim()),
    cards: document.querySelectorAll('.card').length,
    names: [...document.querySelectorAll('.cname')].slice(0, 4).map(e => e.textContent.trim()),
    line: document.querySelector('.line')?.textContent?.trim() ?? null,
    blank: document.querySelector('.blank .t-h2')?.textContent ?? null,
  }))));
  // 搜一个词
  await page.evaluate(() => { const i = document.querySelector('.qin'); i.value = 'ppt'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(3500);
  await ss(page, 'v7-market-search');
  log('search:', JSON.stringify(await page.evaluate(() => ({
    cards: document.querySelectorAll('.card').length,
    names: [...document.querySelectorAll('.cname')].slice(0, 5).map(e => e.textContent.trim()),
  }))));
  // 打开第一张卡的详情
  const opened = await page.evaluate(() => { const c = document.querySelector('.card'); if (!c) return 'NONE'; c.click(); return 'OK'; });
  log('detail open:', opened);
  await sleep(3000);
  await ss(page, 'v7-market-detail');
  log('detail:', JSON.stringify(await page.evaluate(() => ({
    name: document.querySelector('.dname')?.textContent ?? null,
    readme: !!document.querySelector('.readme'),
    err: document.querySelector('.detail .line.err')?.textContent?.trim() ?? null,
  }))));
  // MCP 子类（索引无 MCP → 空态）
  await page.evaluate(() => { document.querySelector('.back')?.click(); });
  await sleep(600);
  await page.evaluate(() => [...document.querySelectorAll('.seg button')].find(b => b.textContent.trim() === 'MCP')?.click());
  await sleep(2500);
  await ss(page, 'v7-market-mcp');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await sleep(500); await ss(page, 'v7-market-dark');
} finally { await app.close().catch(() => {}); }
log('done');
