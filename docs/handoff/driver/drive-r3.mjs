// R3 打包产物冒烟：dist/linux-unpacked 二进制真跑——asar 态 main→minisd→renderer 全链路 + FakeProvider 一回合。
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
const S = '/tmp/claude-0/-home-user-Deskminis/ef029206-b91f-57eb-8ce8-a84cf713c455/scratchpad';
const DATA = path.join(S, 'r3-data');
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
const log = (...a) => console.log('[r3]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = await electron.launch({
  executablePath: '/home/user/Deskminis/deskminis/dist/linux-unpacked/deskminis',
  args: ['--no-sandbox'],
  timeout: 60_000,
  env: { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA, DESKMINIS_FAKE_REPLY: '打包产物冒烟通过。' },
});
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(500); }
  await page.waitForSelector('body', { timeout: 20_000 });
  await sleep(5000);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  const hasComposer = await page.evaluate(() => !!document.querySelector('.composer textarea'));
  log('welcome ok, composer:', hasComposer);
  await page.evaluate(() => {
    const ta = document.querySelector('.composer textarea');
    ta.focus(); ta.value = '打个招呼';
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(200);
  await page.keyboard.press('Enter');
  for (let t = 0; t < 30; t++) { await sleep(1000); const done = await page.evaluate(() => document.body.innerText.includes('打包产物冒烟通过')); if (done) break; }
  const replied = await page.evaluate(() => document.body.innerText.includes('打包产物冒烟通过'));
  log('fake turn replied:', replied);
  await page.screenshot({ path: path.join(S, 'shots', 'r3-packed-smoke.png') });
  log('shot: r3-packed-smoke');
} finally { await app.close().catch(() => {}); }
log('done');
