// L6 终验目视：L 波五项全链路——L1 输入历史 ↑ 召回、L2 @ 文件菜单与补全、
// L3 右缘锚点轨（≥3 回合）、L4 FilesPanel md 渲染/源码段控、L5 会话级 MCP pill + 面板。
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = '/home/user/Deskminis/deskminis';
const SCRATCH = '/tmp/claude-0/-home-user-Deskminis/ef029206-b91f-57eb-8ce8-a84cf713c455/scratchpad';
const SHOTS = path.join(SCRATCH, 'shots');
const DATA = path.join(SCRATCH, 'l6-data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
// L5 前提：存在已启用 MCP server（不必连得上——list 展示条目与否和连接态无关）
fs.mkdirSync(path.join(DATA, 'mcp-servers'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'mcp-servers', 'servers.json'), JSON.stringify({
  mcpServers: { 'demo-tools': { command: 'node', args: ['-e', 'setTimeout(()=>{},1e9)'], startupTimeoutSeconds: 2 } },
}));

const log = (...a) => console.log('[l6]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ss = async (page, name) => { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); log('shot:', name); };
const clickText = (page, sel, text) => page.evaluate(({ sel, text }) => {
  const el = [...document.querySelectorAll(sel)].find(e => e.textContent?.trim() === text)
    ?? [...document.querySelectorAll(sel)].find(e => e.textContent?.includes(text));
  if (!el) return 'NOT_FOUND:' + text;
  el.click(); return 'OK';
}, { sel, text });
const waitIdle = async (page, maxMs = 30_000) => {
  for (let t = 0; t < maxMs; t += 400) {
    const running = await page.evaluate(() => !!document.querySelector('.send.stop'));
    if (!running) { await new Promise((r) => setTimeout(r, 400)); return; }
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log('[l6] waitIdle timeout');
};
const sendMsg = async (page, text) => {
  // 发送 + 落库校验重试：turnEnd 广播先于后端 inFlight 清理的竞态下，紧接着的 send 会被吞
  for (let attempt = 0; attempt < 3; attempt++) {
    await typeInComposer(page, text);
    await page.keyboard.press('Enter');
    await waitIdle(page, 40_000);
    await sleep(1200);
    const st = await page.evaluate((needle) => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const c = pinia.state.value.chat;
      return {
        ok: c.messages.some(m => m.role === 'user' && !String(m.id).startsWith('local-') && JSON.stringify(m.parts ?? []).includes(needle)),
        err: c.lastError,
      };
    }, text.slice(0, 12));
    if (st.ok) return;
    log('send retry', attempt, JSON.stringify(text.slice(0, 16)), 'lastError=', JSON.stringify(st.err));
  }
  log('send FAILED:', JSON.stringify(text.slice(0, 16)));
};
const typeInComposer = async (page, text) => {
  await page.evaluate((text) => {
    const ta = document.querySelector('.composer textarea');
    ta.focus(); ta.value = text;
    ta.setSelectionRange(text.length, text.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(150);
};

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'],
  cwd: APP_DIR,
  timeout: 45_000,
  env: { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA, DESKMINIS_FAKE_REPLY: '已写好会议纪要，行动项在 docs 里。' },
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

  // ---- 三个回合（FakeProvider 每回合重放首条 __tool__，file_write 幂等无妨）----
  await sendMsg(page, '__tool__ file_write {"path":"notes.md","content":"# 会议纪要\\n\\n- 结论一：本周发版\\n- 结论二：下周复盘\\n\\n**行动项**：整理 `docs/todo.md`","tool_title":"写会议纪要"}');
  await sendMsg(page, '第二回合：把纪要再读一遍');
  await sendMsg(page, '第三回合：补充一个行动项');

  // ---- L3 锚点轨：≥3 回合后右缘竖点 ----
  const rail = await page.evaluate(() => ({
    dots: document.querySelectorAll('.trail .tdot').length,
    titles: [...document.querySelectorAll('.trail .tdot')].map(e => e.getAttribute('title')),
  }));
  log('L3 rail:', JSON.stringify(rail));
  await ss(page, 'l6-rail');
  // 点第一个点 → 应滚回第一回合
  await page.evaluate(() => { document.querySelectorAll('.trail .tdot')[0]?.click(); });
  await sleep(900);
  await ss(page, 'l6-rail-jumped');

  // ---- L1 输入历史：空输入 ↑ 召回最近一条 ----
  await page.evaluate(() => { const ta = document.querySelector('.composer textarea'); ta.focus(); ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(150);
  await page.keyboard.press('ArrowUp');
  await sleep(200);
  await page.keyboard.press('ArrowUp');
  await sleep(200);
  const hist = await page.evaluate(() => document.querySelector('.composer textarea').value);
  log('L1 history after ↑↑:', JSON.stringify(hist));
  await ss(page, 'l6-history');

  // ---- L2 @ 文件菜单：@no → notes.md 候选 → Enter 补全 ----
  await typeInComposer(page, '帮我看看 @no');
  await sleep(800); // 首开拉取受限递归名单
  const atState = await page.evaluate(() => ({
    open: !!document.querySelector('.atmenu'),
    items: [...document.querySelectorAll('.atmenu .sname')].map(e => e.textContent),
  }));
  log('L2 atmenu:', JSON.stringify(atState));
  await ss(page, 'l6-atmenu');
  await page.keyboard.press('Enter');
  await sleep(200);
  const afterPick = await page.evaluate(() => document.querySelector('.composer textarea').value);
  log('L2 after pick:', JSON.stringify(afterPick));
  await ss(page, 'l6-atpicked');

  // ---- L5 会话级 MCP pill：demo-tools 已启用 → pill 可见 → 面板勾选禁用 ----
  const pill = await page.evaluate(() => document.querySelector('.mcpbtn')?.textContent?.trim() ?? 'NONE');
  log('L5 pill:', JSON.stringify(pill));
  log('L5 open →', await clickText(page, '.mcpbtn', 'MCP'));
  await sleep(300);
  await ss(page, 'l6-mcp-panel');
  await page.evaluate(() => { document.querySelector('.mcpanel .mcrow input')?.click(); });
  await sleep(600);
  const pillAfter = await page.evaluate(() => document.querySelector('.mcpbtn')?.textContent?.trim() ?? 'NONE');
  log('L5 pill after disable:', JSON.stringify(pillAfter));
  await ss(page, 'l6-mcp-disabled');

  // ---- L4 FilesPanel md 预览：文件 tab → notes.md → 渲染/源码段控 ----
  log('L4 files tab →', await clickText(page, '.wtab-main', '文件'));
  await sleep(800);
  log('L4 open notes.md →', await clickText(page, '.fpanel .nm', 'notes.md'));
  await sleep(800);
  const mdState = await page.evaluate(() => ({
    seg: !!document.querySelector('.pseg'),
    rendered: !!document.querySelector('.pmd'),
    h1: document.querySelector('.pmd h1')?.textContent ?? null,
  }));
  log('L4 md render:', JSON.stringify(mdState));
  await ss(page, 'l6-md-render');
  log('L4 source →', await clickText(page, '.pseg button', '源码'));
  await sleep(300);
  const srcState = await page.evaluate(() => ({ pre: !!document.querySelector('.pbody'), pmd: !!document.querySelector('.pmd') }));
  log('L4 md source:', JSON.stringify(srcState));
  await ss(page, 'l6-md-source');
} finally {
  await app.close().catch(() => {});
}
log('done');
