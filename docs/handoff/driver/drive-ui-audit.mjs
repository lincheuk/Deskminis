// UI 对齐审计：抓当前界面全套给用户目视对照 AionUi 参考——
// 欢迎屏(浅/深)、选中助手态、会话视图+文件预览(浅/深)。
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
const APP_DIR = '/home/user/Deskminis/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/ef029206-b91f-57eb-8ce8-a84cf713c455/scratchpad';
const SHOTS = path.join(S, 'shots');
const DATA = path.join(S, 'uiaudit-data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
fs.mkdirSync(path.join(DATA, 'mcp-servers'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'mcp-servers', 'servers.json'), JSON.stringify({
  mcpServers: { 'demo-tools': { command: 'node', args: ['-e', 'setTimeout(()=>{},1e9)'], startupTimeoutSeconds: 2 } },
}));
const log = (...a) => console.log('[ui]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ss = async (page, name) => { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); log('shot:', name); };
const theme = (page, t) => page.evaluate((t) => { document.documentElement.dataset.theme = t; }, t);
const typeIn = async (page, text) => {
  await page.evaluate((text) => {
    const ta = document.querySelector('.composer textarea');
    ta.focus(); ta.value = text;
    ta.setSelectionRange(text.length, text.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(150);
};
const waitIdle = async (page, maxMs = 40_000) => {
  for (let t = 0; t < maxMs; t += 400) {
    if (!(await page.evaluate(() => !!document.querySelector('.send.stop')))) { await sleep(400); return; }
    await sleep(400);
  }
};
const sendMsg = async (page, text) => {
  for (let a = 0; a < 3; a++) {
    await typeIn(page, text);
    await page.keyboard.press('Enter');
    await waitIdle(page);
    await sleep(1000);
    const ok = await page.evaluate((n) => {
      const c = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat;
      return c.messages.some(m => m.role === 'user' && !String(m.id).startsWith('local-') && JSON.stringify(m.parts ?? []).includes(n));
    }, text.slice(0, 10));
    if (ok) return;
    log('send retry', a);
  }
};
const clickText = (page, sel, text) => page.evaluate(({ sel, text }) => {
  const el = [...document.querySelectorAll(sel)].find(e => e.textContent?.trim() === text)
    ?? [...document.querySelectorAll(sel)].find(e => e.textContent?.includes(text));
  if (!el) return 'NOT_FOUND:' + text;
  el.click(); return 'OK';
}, { sel, text });

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45_000,
  env: { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA, DESKMINIS_FAKE_REPLY: '已写好会议纪要。要点：本周发版、下周复盘；行动项整理进 `docs/todo.md`。' },
});
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(500); }
  await page.waitForSelector('body', { timeout: 15_000 });
  await sleep(4500);

  // 1) 欢迎屏 浅/深
  await theme(page, 'light'); await sleep(300);
  await ss(page, 'ui-welcome-light');
  await theme(page, 'dark'); await sleep(300);
  await ss(page, 'ui-welcome-dark');
  await theme(page, 'light'); await sleep(300);

  // 2) 选中助手态（chip 高亮 + 预设 prompts + hero 换身份）
  log('pick assistant →', await clickText(page, '.ascard', '通用协作'));
  await sleep(400);
  await ss(page, 'ui-welcome-picked');

  // 3) 会话视图：两回合（首条带 file_write 造工作区文件）→ 文件 tab 开 md 预览
  await sendMsg(page, '__tool__ file_write {"path":"notes.md","content":"# 会议纪要\\n\\n- 结论一：本周发版\\n- 结论二：下周复盘\\n\\n**行动项**：整理 `docs/todo.md`","tool_title":"写会议纪要"}');
  await sendMsg(page, '再帮我核对一遍行动项，列成清单');
  await sendMsg(page, '好，按这个执行');
  log('files tab →', await clickText(page, '.wtab-main', '文件'));
  await sleep(700);
  log('open notes.md →', await clickText(page, '.fpanel .nm', 'notes.md'));
  await sleep(700);
  await ss(page, 'ui-chat-light');
  await theme(page, 'dark'); await sleep(400);
  await ss(page, 'ui-chat-dark');
} finally { await app.close().catch(() => {}); }
log('done');
