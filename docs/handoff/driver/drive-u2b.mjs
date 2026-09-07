// U2 边界实拍：legacy .doc 走「明说不支持」；坏掉的 .docx 走「解析失败 + 出路」。
// 两条都不能是一片空白，也不能是一句红字堆栈——这是 OfficeCLI 那份源码里最值钱的教训。
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
const APP_DIR = '/home/user/Deskminis/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/ef029206-b91f-57eb-8ce8-a84cf713c455/scratchpad';
const SHOTS = path.join(S, 'shots');
const DATA = path.join(S, 'u2b-data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
const log = (...a) => console.log('[u2b]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ss = async (p, n) => { await p.screenshot({ path: path.join(SHOTS, n + '.png') }); log('shot:', n); };

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45000,
  env: { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA,
         DESKMINIS_FAKE_REPLY: '这份是 2019 年的老稿，格式是旧版 .doc。' },
});
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { page = app.windows().find(w => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(500); }
  await page.waitForSelector('body', { timeout: 15000 });
  await sleep(4500);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.evaluate((payload) => {
    const ta = document.querySelector('textarea.field');
    ta.focus(); ta.value = payload;
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, '__tool__ file_write ' + JSON.stringify({ path: '旧稿.doc', content: '这是一份 2019 年的旧版 Word 文档占位内容。', tool_title: '放一份旧稿' }));
  await sleep(250);
  await page.keyboard.press('Enter');
  for (let i = 0; i < 60; i++) { await sleep(500); if (await page.evaluate(() => !document.querySelector('.go.stop'))) break; }
  await sleep(1500);

  // 直接往工作区丢一个"坏掉的 .docx"（不是 zip），验解析失败分支
  const wsDir = fs.readdirSync(path.join(DATA, 'sessions')).map(d => path.join(DATA, 'sessions', d, 'workspace')).find(p => fs.existsSync(p));
  fs.writeFileSync(path.join(wsDir, '损坏文件.docx'), 'NOT-A-ZIP-AT-ALL 这不是一个 OOXML 包');
  log('ws:', wsDir, fs.readdirSync(wsDir).join(','));
  await page.evaluate(() => document.querySelector('.ws .rfr, .ws button[title*="刷新"]')?.click());
  await sleep(1200);

  for (const [key, needle] of [['legacy', '旧稿'], ['broken', '损坏文件']]) {
    const r = await page.evaluate((n) => {
      const el = [...document.querySelectorAll('.ws .row')].find(e => e.textContent?.includes(n));
      if (!el) return 'NOT_FOUND'; el.click(); return 'OK';
    }, needle);
    log(key, 'open →', r);
    await sleep(1400);
    await ss(page, `u2-${key}`);
    log(key, 'probe:', JSON.stringify(await page.evaluate(() => ({
      card: !!document.querySelector('.pane .card'),
      office: !!document.querySelector('.office'),
      text: document.querySelector('.pane .card')?.textContent?.replace(/\s+/g, ' ').slice(0, 160) ?? null,
    }))));
  }
} finally { await app.close().catch(() => {}); }
log('done');
