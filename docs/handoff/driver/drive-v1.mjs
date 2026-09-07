// V1 实拍：权限卡真出现、真能按。写一个工作区之外的绝对路径 → guardWrite 触发权限门。
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
const APP_DIR = '/home/user/Deskminis/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/ef029206-b91f-57eb-8ce8-a84cf713c455/scratchpad';
const SHOTS = path.join(S, 'shots');
const DATA = path.join(S, 'v1-data');
const OUT = path.join(S, 'v1-outside');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true }); fs.mkdirSync(DATA, { recursive: true });
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'notes.txt'), '第一行\n第二行\n第三行\n');
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
// 触发方式由命令行给：shell（每次确认档位下命令必过权限门）或 write（工作区外写文件）
const MODE = process.argv[2] ?? 'shell';
const TOOL = MODE === 'shell' ? 'shell_execute' : 'file_write';
const ARGS = MODE === 'shell'
  // 必须是 gated 类命令：只读命令（Get-ChildItem 等）默认 bypass，不会弹卡
  ? { command: 'npm install --save-dev vitest', tool_title: '装一个开发依赖' }
  : { path: 'C:\\Users\\me\\Documents\\notes.txt',
      content: '第一行\n第二行改过了\n第三行\n第四行是新加的\n', tool_title: '更新文档目录里的笔记' };
const log = (...a) => console.log('[v1]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ss = async (p, n) => { await p.screenshot({ path: path.join(SHOTS, n + '.png') }); log('shot:', n); };

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45000,
  env: { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA,
         DESKMINIS_FAKE_REPLY: '写好了。这个路径在工作区之外，所以刚才问了你一次。' },
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
  }, '__tool__ ' + TOOL + ' ' + JSON.stringify(ARGS));
  await sleep(250);
  await page.keyboard.press('Enter');

  // 等权限卡出现（不等回合结束——回合此刻正卡在权限门上）
  let seen = false;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    if (await page.evaluate(() => !!document.querySelector('.perm'))) { seen = true; break; }
  }
  log('perm card visible:', seen);
  await sleep(600);
  await ss(page, `v1-perm-${MODE}`);
  log('probe:', JSON.stringify(await page.evaluate(() => {
    const el = document.querySelector('.perm');
    if (!el) return null;
    return {
      title: el.querySelector('.title')?.textContent ?? null,
      detail: el.querySelector('.v')?.textContent ?? null,
      diff: !!el.querySelector('.diff'),
      addDel: [...el.querySelectorAll('.dh span')].map(e => e.textContent).join(' '),
      diffLines: el.querySelectorAll('.dline').length,
      btns: [...el.querySelectorAll('.pb')].map(b => b.textContent.trim()),
      pre: el.querySelector('.pb.pre')?.textContent?.trim() ?? null,
      countdown: el.querySelector('.cd')?.textContent ?? null,
    };
  })));

  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await sleep(400); await ss(page, `v1-perm-${MODE}-dark`);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await sleep(300);

  // 按「允许」→ 回合应当继续并落地
  const DECIDE = MODE === 'shell' ? '拒绝' : '允许';
  await page.evaluate((d) => [...document.querySelectorAll('.pb')].find(b => b.textContent.trim() === d)?.click(), DECIDE);
  log('decided:', DECIDE);
  for (let i = 0; i < 50; i++) { await sleep(400); if (await page.evaluate(() => !document.querySelector('.go.stop'))) break; }
  await sleep(1500);
  await ss(page, `v1-after-${MODE}`);

  log('perm gone:', await page.evaluate(() => !document.querySelector('.perm')));
} finally { await app.close().catch(() => {}); }
log('done');
