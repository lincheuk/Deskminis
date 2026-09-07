// V4-V5 实拍：终端抽屉 + 任务面板 tab
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
const APP_DIR = '/home/user/Deskminis/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/ef029206-b91f-57eb-8ce8-a84cf713c455/scratchpad';
const SHOTS = path.join(S, 'shots');
const DATA = path.join(S, 'v45-data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true }); fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
const log = (...a) => console.log('[v45]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ss = async (p, n) => { await p.screenshot({ path: path.join(SHOTS, n + '.png') }); log('shot:', n); };

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45000,
  env: { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA,
         DESKMINIS_FAKE_REPLY: '写完了，你可以在右边的「改动」里看到它。' },
});
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { page = app.windows().find(w => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(500); }
  await page.waitForSelector('body', { timeout: 15000 });
  await sleep(4500);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  // 跑一轮，产出一个文件 + 建立会话（任务面板要有 contextInfo）
  await page.evaluate((payload) => {
    const ta = document.querySelector('textarea.field');
    ta.focus(); ta.value = payload;
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, '__tool__ office_write ' + JSON.stringify({
    path: '周报.docx',
    content: JSON.stringify({ blocks: [{ kind: 'heading', level: 1, text: '本周工作小结' }, { kind: 'para', text: '完成了三件事。' }] }),
    tool_title: '写一份周报',
  }));
  await sleep(250);
  await page.keyboard.press('Enter');
  for (let i = 0; i < 60; i++) { await sleep(500); if (await page.evaluate(() => !document.querySelector('.go.stop'))) break; }
  await sleep(1500);

  // 任务 tab
  await page.evaluate(() => [...document.querySelectorAll('.ws .tabs button')].find(b => b.textContent.includes('任务'))?.click());
  await sleep(1200);
  await ss(page, 'v5-tasks');
  log('task probe:', JSON.stringify(await page.evaluate(() => ({
    tp: !!document.querySelector('.tp'),
    bar: !!document.querySelector('.tp .bar'),
    rows: [...document.querySelectorAll('.tp .brow')].map(e => e.textContent.replace(/\s+/g, ' ').trim()),
    blocks: [...document.querySelectorAll('.tp .bh')].map(e => e.textContent.trim()),
  }))));

  // 改动 tab 认不认 office_write
  await page.evaluate(() => [...document.querySelectorAll('.ws .tabs button')].find(b => b.textContent.includes('改动'))?.click());
  await sleep(700);
  log('changes:', await page.evaluate(() => [...document.querySelectorAll('.chg')].map(e => e.textContent.replace(/\s+/g, ' ').trim())));
  await ss(page, 'v5-changes');

  // 终端抽屉
  await page.evaluate(() => [...document.querySelectorAll('.bar .ib')].find(b => b.getAttribute('title') === '终端')?.click());
  await sleep(2200);
  await ss(page, 'v4-term');
  log('term probe:', JSON.stringify(await page.evaluate(() => ({
    pane: !!document.querySelector('.term'),
    xterm: !!document.querySelector('.term .xterm'),
    rows: document.querySelectorAll('.term .xterm-rows > div').length,
    text: [...document.querySelectorAll('.term .xterm-rows > div')].map(e => e.textContent.trim()).filter(Boolean).slice(0, 4),
  }))));
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await sleep(600); await ss(page, 'v4-term-dark');
} finally { await app.close().catch(() => {}); }
log('done');
