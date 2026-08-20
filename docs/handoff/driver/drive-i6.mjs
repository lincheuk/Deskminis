// J3 终验目视：助手体系全链路——欢迎页助手卡（种子 3 个）→ 点卡建绑定会话（两态切换）
// → 预设 prompt 填入 → 设置·助手管理页 → 会话行 emoji。FakeProvider 全链路。
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = '/home/user/Deskminis/deskminis';
const SCRATCH = '/tmp/claude-0/-home-user-Deskminis/ef029206-b91f-57eb-8ce8-a84cf713c455/scratchpad';
const SHOTS = path.join(SCRATCH, 'shots');
const DATA = path.join(SCRATCH, 'i6-data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));

const log = (...a) => console.log('[i6]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ss = async (page, name) => { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); log('shot:', name); };
const setTheme = (page, m) => page.evaluate((mm) => { document.documentElement.dataset.theme = mm; }, m);

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'],
  cwd: APP_DIR,
  timeout: 45_000,
  env: { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA },
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
  await setTheme(page, 'light');

  // 1) 欢迎屏新次序：hero → composer → 助手 chips（下方）
  const probe1 = await page.evaluate(() => {
    const y = (sel) => document.querySelector(sel)?.getBoundingClientRect().top ?? -1;
    return { hero: y('.ehero'), composer: y('.composer'), below: y('.wbelow'),
             chips: [...document.querySelectorAll('.ascard .acname')].map(e => e.textContent),
             sidebarWide: !!document.querySelector('.pane-l') && getComputedStyle(document.querySelector('.pane-l')).display !== 'none' };
  });
  log('order probe:', JSON.stringify(probe1));
  await ss(page, 'i6-welcome-light');
  await setTheme(page, 'dark');
  await sleep(300);
  await ss(page, 'i6-welcome-dark');
  await setTheme(page, 'light');

  // 2) 点 chip 选择（不建会话）→ prompts 预览 + 占位符换名
  await page.evaluate(() => document.querySelector('.ascard')?.click());
  await sleep(400);
  const probe2 = await page.evaluate(() => ({
    picked: !!document.querySelector('.ascard.on'),
    sessions: document.querySelectorAll('.scard').length,
    placeholder: document.querySelector('.composer textarea')?.placeholder,
    prompts: document.querySelectorAll('.prow').length,
  }));
  log('pick probe:', JSON.stringify(probe2));
  await ss(page, 'i6-picked-light');

  // 3) 输入并发送 → 才建绑定会话
  await page.evaluate(() => {
    const ta = document.querySelector('.composer textarea');
    ta.focus(); ta.value = '你好，介绍一下你自己';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(200);
  await page.keyboard.press('Enter');
  await sleep(2500);
  const probe3 = await page.evaluate(() => ({
    title: document.querySelector('.tb-title')?.textContent?.trim(),
    emoji: [...document.querySelectorAll('.semoji')].map(e => e.textContent),
  }));
  log('sent probe:', JSON.stringify(probe3));
  await ss(page, 'i6-chat-light');
} finally {
  await app.close().catch(() => {});
}
log('done');
