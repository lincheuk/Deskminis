// E3 审核：带真实消息流的目视——FakeProvider 走全链路（用户消息/助手浮岛卡/工具行/权限卡/输入卡聚焦）。
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = '/home/user/Deskminis/deskminis';
const SCRATCH = '/tmp/claude-0/-home-user-Deskminis/de13f871-02f4-5133-95e9-9105e3bca00b/scratchpad';
const SHOTS = path.join(SCRATCH, 'shots');
const DATA = path.join(SCRATCH, 'e3-data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
// 零 provider 也能走 fake：defaultId === '__fake__' 分支不查 providers 数组
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));

const REPLY = 'Aurora 换皮验收回复。\n\n这是助手消息卡的浮岛形态检查：实心底、顶缘高光、柔影。\n\n- 列表项一\n- 列表项二\n\n结束行：等宽读数与层次检查。';

const log = (...a) => console.log('[drive]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ss = async (page, name) => { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); log('screenshot:', name); };
const setTheme = (page, m) => page.evaluate((mm) => { document.documentElement.dataset.theme = mm; return getComputedStyle(document.body).backgroundColor; }, m);

async function send(page, text) {
  const r = await page.evaluate((t) => {
    const ta = document.querySelector('.composer textarea, textarea');
    if (!ta) return 'NO_TEXTAREA';
    ta.focus();
    ta.value = t;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'OK';
  }, text);
  if (r !== 'OK') return r;
  await sleep(200);
  await page.keyboard.press('Enter');
  await sleep(600);
  // Enter 若只换行未发送：找发送钮点一次
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
  await setTheme(page, 'dark');

  log('send#1 →', await send(page, '介绍一下 Aurora 换皮的浮岛形态'));
  log('reply rendered:', await waitText(page, '浮岛形态检查'));
  await sleep(600);
  await ss(page, 'e3b-chat-dark');

  log('send#2 →', await send(page, '__tool__ file_write {"path":"/tmp/e3-perm-probe.txt","content":"x"}'));
  log('perm card:', await waitText(page, '仅此次') || waitText(page, '允许'));
  await sleep(600);
  await ss(page, 'e3b-perm-dark');

  await setTheme(page, 'light');
  await sleep(500);
  await ss(page, 'e3b-chat-light');
} finally {
  await app.close().catch(() => {});
}
log('done');
