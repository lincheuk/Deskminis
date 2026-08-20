// K3 终验目视：定时任务全链路——发首条消息离开欢迎态 → 开「定时」tab → 新建任务
// （interval + 绑定助手）→ 立即运行 → FakeProvider 实跑 → 状态/会话回流。
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = '/home/user/Deskminis/deskminis';
const SCRATCH = '/tmp/claude-0/-home-user-Deskminis/ef029206-b91f-57eb-8ce8-a84cf713c455/scratchpad';
const SHOTS = path.join(SCRATCH, 'shots');
const DATA = path.join(SCRATCH, 'k3-data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));

const REPLY = '定时任务验收回复：已按指令巡检完毕，一切正常。';
const log = (...a) => console.log('[k3]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ss = async (page, name) => { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); log('shot:', name); };
const clickText = (page, sel, text) => page.evaluate(({ sel, text }) => {
  const el = [...document.querySelectorAll(sel)].find(e => e.textContent?.trim() === text)
    ?? [...document.querySelectorAll(sel)].find(e => e.textContent?.includes(text));
  if (!el) return 'NOT_FOUND:' + text;
  el.click(); return 'OK';
}, { sel, text });

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
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  // 1) 发条消息离开欢迎态（工作台随之回场）
  await page.evaluate(() => {
    const ta = document.querySelector('.composer textarea');
    ta.focus(); ta.value = '先随便打个招呼';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(200);
  await page.keyboard.press('Enter');
  await sleep(2000);

  // 2) 开「定时」tab → 新建任务（interval 5 分钟 + 绑定通用协作）
  log('open cron tab →', await clickText(page, '.wtab-main', '定时'));
  await sleep(600);
  await ss(page, 'k3-panel-empty');
  log('new job →', await clickText(page, 'button', '新建定时任务'));
  await sleep(300);
  await page.evaluate(() => {
    const form = document.querySelector('.cform');
    const name = form.querySelector('input.cfinput');
    name.value = '目录巡检';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    const ta = form.querySelector('textarea');
    ta.value = '__tool__ file_list {"path":".","tool_title":"看一眼工作区"}';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const sel = form.querySelectorAll('select')[1]; // 第二个 select = 助手
    if (sel && sel.options.length > 1) { sel.value = sel.options[1].value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await sleep(200);
  await ss(page, 'k3-form');
  log('save →', await clickText(page, '.cfsave', '保存'));
  await sleep(800);
  const row = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('.crname')].map(e => e.textContent?.replace(/\s+/g, ' ').trim()),
    sub: document.querySelector('.crsub')?.textContent?.replace(/\s+/g, ' ').trim(),
  }));
  log('job row:', JSON.stringify(row));
  await ss(page, 'k3-job-created');

  // 3) 立即运行 → FakeProvider 实跑 → 状态回流
  log('run now →', await clickText(page, '.crbtn', '运行'));
  await sleep(4000);
  const after = await page.evaluate(() => ({
    sub: document.querySelector('.crsub')?.textContent?.replace(/\s+/g, ' ').trim(),
    sessions: [...document.querySelectorAll('.stitle')].map(e => e.textContent?.trim()).slice(0, 4),
  }));
  log('after run:', JSON.stringify(after));
  await ss(page, 'k3-after-run');

  // 4) 跳最近会话看实跑内容
  log('jump →', await clickText(page, '.crjump', '查看会话'));
  await sleep(1200);
  const chatTxt = await page.evaluate(() => document.body.innerText.includes('定时任务验收回复') || document.body.innerText.includes('看一眼工作区'));
  log('cron session content visible:', chatTxt);
  await ss(page, 'k3-cron-session');
} finally {
  await app.close().catch(() => {});
}
log('done');
