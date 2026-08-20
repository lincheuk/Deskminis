// J3 终验目视：助手体系全链路——欢迎页助手卡（种子 3 个）→ 点卡建绑定会话（两态切换）
// → 预设 prompt 填入 → 设置·助手管理页 → 会话行 emoji。FakeProvider 全链路。
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = '/home/user/Deskminis/deskminis';
const SCRATCH = '/tmp/claude-0/-home-user-Deskminis/ef029206-b91f-57eb-8ce8-a84cf713c455/scratchpad';
const SHOTS = path.join(SCRATCH, 'shots');
const DATA = path.join(SCRATCH, 'j3-data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));

const log = (...a) => console.log('[j3]', ...a);
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

  // 1) 未绑态欢迎页：种子助手卡应在
  const cards = await page.evaluate(() => [...document.querySelectorAll('.ascard .aname')].map(e => e.textContent));
  log('assistant cards:', JSON.stringify(cards));
  await ss(page, 'j3-welcome-cards-light');
  await setTheme(page, 'dark');
  await sleep(300);
  await ss(page, 'j3-welcome-cards-dark');
  await setTheme(page, 'light');

  // 2) 点第一张卡 → 绑定会话，欢迎页换绑定态
  await page.evaluate(() => (document.querySelector('.ascard'))?.click());
  await sleep(1200);
  const bound = await page.evaluate(() => ({
    hero: document.querySelector('.empty h2')?.textContent?.trim() ?? 'NO_HERO',
    prompts: [...document.querySelectorAll('.pcard .pfull')].map(e => e.textContent?.slice(0, 12)),
    genericCards: !!document.querySelector('.extitle'),
  }));
  log('bound state:', JSON.stringify(bound));
  await ss(page, 'j3-bound-light');

  // 3) 点一条预设 prompt → 应填入输入框不发送
  await page.evaluate(() => (document.querySelector('.pcard'))?.click());
  await sleep(300);
  const filled = await page.evaluate(() => (document.querySelector('.composer textarea'))?.value?.slice(0, 16));
  log('composer filled:', JSON.stringify(filled));

  // 4) 侧栏展开 → 会话行 emoji 前缀
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('[title]')].find(e => (e.getAttribute('title') ?? '') === '展开会话列表');
    el?.click();
  });
  await sleep(500);
  const emoji = await page.evaluate(() => [...document.querySelectorAll('.semoji')].map(e => e.textContent));
  log('session emoji:', JSON.stringify(emoji));
  await ss(page, 'j3-sessionlist-light');

  // 5) 设置 · 助手管理页（编辑态）
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('[title]')].find(e => (e.getAttribute('title') ?? '').includes('设置'));
    el?.click();
  });
  await page.waitForSelector('.sitem', { timeout: 8_000 });
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.sitem')].find(e => e.textContent?.trim() === '助手');
    el?.click();
  });
  await sleep(500);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.arbtn')].find(e => e.textContent?.trim() === '编辑');
    el?.click();
  });
  await sleep(400);
  await ss(page, 'j3-settings-assistants-light');
  await setTheme(page, 'dark');
  await sleep(300);
  await ss(page, 'j3-settings-assistants-dark');
} finally {
  await app.close().catch(() => {});
}
log('done');
