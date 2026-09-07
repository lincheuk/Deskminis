// T5 实拍：把四个占位视图 + 搜索视图逐个走一遍。
// 预置两个 provider 与一份助手/定时任务，避免每张图都是空态——空态好看不代表有内容时也好看。
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
const APP_DIR = '/home/user/Deskminis/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/ef029206-b91f-57eb-8ce8-a84cf713c455/scratchpad';
const SHOTS = path.join(S, 'shots');
const DATA = path.join(S, 't5-data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({
  providers: [
    { id: 'P1', name: '工作号', kind: 'openai-compat', baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-4o' },
    { id: 'P2', name: 'Claude 主力', kind: 'anthropic', modelId: 'claude-sonnet-4-5' },
    { id: 'P3', name: '本地 Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', modelId: 'qwen2.5:14b' },
  ],
  defaultProviderId: 'P2',
}, null, 2));
const log = (...a) => console.log('[t5]', ...a);
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

  // 先造一个助手 + 一个定时任务，让列表有内容
  await page.evaluate(async () => {
    const s = window.__pinia_chat__;
    void s;
  });

  const go = async (label) => {
    const r = await page.evaluate((l) => {
      const b = [...document.querySelectorAll('.rail .navit')].find(e => e.textContent?.trim().startsWith(l));
      if (!b) return 'NOT_FOUND'; b.click(); return 'OK';
    }, label);
    await sleep(900);
    return r;
  };

  // ---- 设置：七节逐个 ----
  log('设置 →', await go('设置'));
  const secs = await page.evaluate(() => [...document.querySelectorAll('.secnav .secit')].map(e => e.textContent.trim()));
  log('sections:', JSON.stringify(secs));
  for (const [i, name] of secs.entries()) {
    await page.evaluate((idx) => document.querySelectorAll('.secnav .secit')[idx].click(), i);
    await sleep(700);
    await ss(page, `t5-set-${['models','perm','skills','mcp','search','look','about'][i] ?? i}`);
  }

  // 模型：打开新增表单
  await page.evaluate(() => document.querySelectorAll('.secnav .secit')[0].click());
  await sleep(500);
  await page.evaluate(() => [...document.querySelectorAll('.f-btn')].find(b => b.textContent.includes('添加 provider'))?.click());
  await sleep(600);
  await ss(page, 't5-set-models-form');

  // ---- 助手 ----
  log('助手 →', await go('助手'));
  await page.evaluate(() => [...document.querySelectorAll('.f-btn')].find(b => b.textContent.includes('新建助手'))?.click());
  await sleep(700);
  await ss(page, 't5-assistants-form');
  await page.evaluate(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } };
    set('.f-card input.f-input', 'PPT 助手');
    const tas = document.querySelectorAll('.f-card textarea.f-area');
    if (tas[0]) { tas[0].value = '你是幻灯片助手。用户给你一份材料，你先列大纲再逐页写内容，每页不超过 4 个要点。'; tas[0].dispatchEvent(new Event('input', { bubbles: true })); }
    if (tas[1]) { tas[1].value = '把这份报告做成 10 页汇报\n给这个方案配一版给领导看的开场'; tas[1].dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll('.f-btn.primary')].find(b => b.textContent.trim() === '创建')?.click());
  await sleep(1200);
  await ss(page, 't5-assistants');
  log('assistants:', await page.evaluate(() => document.querySelectorAll('.acard').length));

  // ---- 定时 ----
  log('定时 →', await go('定时任务'));
  await page.evaluate(() => [...document.querySelectorAll('.f-btn')].find(b => b.textContent.includes('新建任务'))?.click());
  await sleep(700);
  await ss(page, 't5-cron-form');
  await page.evaluate(() => {
    const el = document.querySelector('.f-card input.f-input');
    if (el) { el.value = '每天早上汇总昨日日志'; el.dispatchEvent(new Event('input', { bubbles: true })); }
    const ta = document.querySelector('.f-card textarea.f-area');
    if (ta) { ta.value = '读 logs/ 下昨天的日志文件，按错误级别分组统计，写成 reports/日期.md。有 ERROR 就在开头列出来。'; ta.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll('.f-btn.primary')].find(b => b.textContent.trim() === '创建')?.click());
  await sleep(1200);
  await ss(page, 't5-cron');
  log('cron:', await page.evaluate(() => document.querySelectorAll('.job').length));

  // ---- 设备 ----
  log('设备 →', await go('设备'));
  await sleep(600);
  await ss(page, 't5-devices');
  await page.evaluate(() => [...document.querySelectorAll('.f-btn.primary')].find(b => b.textContent.includes('生成配对码'))?.click());
  await sleep(1400);
  await ss(page, 't5-devices-pairing');
  log('pairing code:', await page.evaluate(() => document.querySelector('.code')?.textContent ?? null));

  // ---- 搜索 ----
  log('搜索 →', await go('搜索会话'));
  await sleep(600);
  await ss(page, 't5-search');

  // 暗色抽查两张
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await sleep(500);
  await ss(page, 't5-search-dark');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.rail .navit')].find(e => e.textContent?.trim().startsWith('设置'));
    b?.click();
  });
  await sleep(900);
  await ss(page, 't5-set-dark');
} finally { await app.close().catch(() => {}); }
log('done');
