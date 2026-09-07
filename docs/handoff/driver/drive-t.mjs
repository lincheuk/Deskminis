// T 波实拍：新 UI 骨架 + 欢迎屏 + 会话全链路（浅/深）
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
const APP_DIR = '/home/user/Deskminis/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/ef029206-b91f-57eb-8ce8-a84cf713c455/scratchpad';
const SHOTS = path.join(S, 'shots');
const DATA = path.join(S, 't-data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({
  providers: [
    { id: 'p-openai', name: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-5.4' },
    { id: 'p-claude', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', modelId: 'claude-opus-5' },
    { id: 'p-gemini', name: 'Gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', modelId: 'gemini-3-pro' },
    { id: 'p-qwen', name: 'Qwen', kind: 'openai-compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: 'qwen-max' },
    { id: 'p-ollama', name: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', modelId: 'qwen3:32b' },
  ],
  defaultProviderId: '__fake__',
}));
const log = (...a) => console.log('[t]', ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ss = async (p, n) => { await p.screenshot({ path: path.join(SHOTS, n + '.png') }); log('shot:', n); };
const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45_000,
  env: { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA,
         DESKMINIS_FAKE_REPLY: '读完了。这个项目的入口在 `src/minisd/index.ts`，核心分三块：\n\n- **Agent 循环**：`agent/loop.ts` 驱动工具调用\n- **工具注册表**：`tools/registry.ts` 做参数校验\n- **存储层**：`store/db.ts` 追加式迁移\n\n要我从哪块细讲？' },
});
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { page = app.windows().find(w => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(500); }
  await page.waitForSelector('body', { timeout: 15000 });
  await sleep(4500);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await sleep(300);
  await ss(page, 't-welcome-light');
  const probe = await page.evaluate(() => ({
    rail: !!document.querySelector('.rail'), hero: document.querySelector('.hero h1')?.textContent,
    cards: document.querySelectorAll('.acard').length, composer: !!document.querySelector('.card .field'),
  }));
  log('probe:', JSON.stringify(probe));

  // 选一个助手 → 看选中态
  await page.evaluate(() => document.querySelectorAll('.acard')[1]?.click());
  await sleep(400);
  await ss(page, 't-welcome-picked');

  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await sleep(300);
  await ss(page, 't-welcome-dark');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await sleep(300);

  // 发消息（带工具调用）→ 会话视图
  await page.evaluate(() => {
    const ta = document.querySelector('.card .field');
    ta.focus(); ta.value = '__tool__ file_list {"path":".","tool_title":"看一眼工作区"}';
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(200);
  await page.keyboard.press('Enter');
  for (let i = 0; i < 40; i++) { await sleep(500); const done = await page.evaluate(() => !document.querySelector('.go.stop')); if (done) break; }
  await sleep(1500);
  await ss(page, 't-chat-light');
  const c2 = await page.evaluate(() => ({
    turns: document.querySelectorAll('.turn').length,
    steps: !!document.querySelector('.grp'),
    md: !!document.querySelector('.ablock .md'),
    rail: document.querySelectorAll('.srow').length,
  }));
  log('chat probe:', JSON.stringify(c2));
  // 展开步骤组
  await page.evaluate(() => document.querySelector('.grp .head')?.click());
  await sleep(400);
  await ss(page, 't-chat-steps');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await sleep(400);
  await ss(page, 't-chat-dark');
} finally { await app.close().catch(() => {}); }
log('done');
