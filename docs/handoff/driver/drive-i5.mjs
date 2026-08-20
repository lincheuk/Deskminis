// I5 终验目视：AionUi 换向全景——欢迎态（工作台退场+hero）/ 会话流（蓝气泡+平铺）/
// 权限卡 / 设置页 × 暗浅双主题。FakeProvider 全链路，零真实 provider。
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = '/home/user/Deskminis/deskminis';
const SCRATCH = '/tmp/claude-0/-home-user-Deskminis/ef029206-b91f-57eb-8ce8-a84cf713c455/scratchpad';
const SHOTS = path.join(SCRATCH, 'shots');
const DATA = path.join(SCRATCH, 'i5-data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));

const REPLY = 'AionUi 换向验收回复。\n\n检查点：助手输出应为无背景满行宽平铺，用户消息应为右对齐浅蓝气泡。\n\n- 列表项一\n- 列表项二\n\n结束行：mono 读数与层次检查。';

const log = (...a) => console.log('[i5]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ss = async (page, name) => { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); log('shot:', name); };
const setTheme = (page, m) => page.evaluate((mm) => { document.documentElement.dataset.theme = mm; return getComputedStyle(document.body).backgroundColor; }, m);

async function send(page, text) {
  const r = await page.evaluate((t) => {
    const ta = document.querySelector('.composer textarea, textarea');
    if (!ta) return 'NO_TEXTAREA';
    ta.focus(); ta.value = t;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'OK';
  }, text);
  if (r !== 'OK') return r;
  await sleep(200);
  await page.keyboard.press('Enter');
  await sleep(600);
  const cleared = await page.evaluate(() => (document.querySelector('.composer textarea, textarea')?.value ?? '') === '' ? 'SENT' : 'PENDING');
  if (cleared === 'PENDING') {
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.composer button, button')];
      const b = btns.find((x) => (x.getAttribute('title') ?? '').includes('发送')) ?? btns.at(-1);
      b?.click();
    });
  }
  return 'OK';
}
const waitText = async (page, needle, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    if ((await page.evaluate(() => document.body.innerText)).includes(needle)) return true;
    await sleep(400);
  }
  return false;
};

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'],
  cwd: APP_DIR,
  timeout: 45_000,
  env: { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA, DESKMINIS_FAKE_REPLY: REPLY },
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

  // 欢迎态：工作台应不在、hero 问候应在、composer 居中
  const welcomeProbe = await page.evaluate(() => ({
    heroText: document.querySelector('.empty h2')?.textContent ?? 'NO_HERO',
    workbenchVisible: !!document.querySelector('.pane-w') && getComputedStyle(document.querySelector('.pane-w')).display !== 'none',
    wbrailVisible: !!document.querySelector('.wbrail') && getComputedStyle(document.querySelector('.wbrail')).display !== 'none',
  }));
  log('welcome probe:', JSON.stringify(welcomeProbe));
  log('light bg =', await setTheme(page, 'light'));
  await sleep(400);
  await ss(page, 'i5-welcome-light');
  await setTheme(page, 'dark');
  await sleep(400);
  await ss(page, 'i5-welcome-dark');

  // 发消息：欢迎态应退场、工作台回场；蓝气泡 + 平铺
  await setTheme(page, 'light');
  log('send#1 →', await send(page, '介绍一下 AionUi 换向后的消息流形态'));
  log('reply rendered:', await waitText(page, '满行宽平铺'));
  await sleep(800);
  const chatProbe = await page.evaluate(() => ({
    workbenchBack: !!document.querySelector('.pane-w') && getComputedStyle(document.querySelector('.pane-w')).display !== 'none',
    utextBg: document.querySelector('.utext') ? getComputedStyle(document.querySelector('.utext')).backgroundColor : 'NO_UTEXT',
    ublockAlign: document.querySelector('.ublock') ? getComputedStyle(document.querySelector('.ublock')).alignItems : 'NO_UBLOCK',
  }));
  log('chat probe:', JSON.stringify(chatProbe));
  await ss(page, 'i5-chat-light');
  await setTheme(page, 'dark');
  await sleep(500);
  await ss(page, 'i5-chat-dark');

  // 工具调用 → 权限卡
  await setTheme(page, 'light');
  log('send#2 →', await send(page, '__tool__ file_write {"path":"demo.txt","content":"hello aionui","tool_title":"写文件 demo.txt"}'));
  log('perm card:', await waitText(page, '允许'));
  await sleep(600);
  await ss(page, 'i5-perm-light');

  // 设置页双主题
  const open = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[title]')].find((e) => (e.getAttribute('title') ?? '').includes('设置'));
    if (!el) return 'NOT_FOUND';
    el.click(); return 'OK';
  });
  log('openSettings →', open);
  await page.waitForSelector('.sitem', { timeout: 8_000 }).catch(() => log('no .sitem'));
  await sleep(600);
  await ss(page, 'i5-settings-light');
  await setTheme(page, 'dark');
  await sleep(400);
  await ss(page, 'i5-settings-dark');
} finally {
  await app.close().catch(() => {});
}
log('done');
