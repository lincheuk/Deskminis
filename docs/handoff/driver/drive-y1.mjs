// Y 波：换壳遗失的入口成批补回——五项各自实拍（设计稿 docs/specs/2026-09-10-lost-entries-restore-design.md §4）。
//   menu   会话行 ⋮ 菜单：记忆开关 / 绑定模型（先经 store 建一个 ollama 类 provider，免 key）/ 重命名（含后端拒绝空标题）/ 删除二次确认
//   mcp    会话级禁用 MCP：种一台连不上的 MCP → pill「MCP」→ 面板勾禁用 → 「MCP · 禁 1」+ sessions[].mcpDisabled
//   sync   设备页暂停 / 恢复同步 → syncPaused + 标题栏状态点 title
//   skills 先导入一个种子技能 → 助手编辑器勾上 → 保存 → assistants[].skillIds + 列表「1 项技能」
//   rail   三回合（长回复撑出滚动）→ 右缘 .trail 三个点 → 点第一个 → scrollTop 回顶
// 用法：xvfb-run -a node drive-y1.mjs <menu|mcp|sync|skills|rail|all>
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = '/home/user/Deskminis/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const SHOTS = path.join(S, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const scenario = process.argv[2] ?? 'all';
const log = (...a) => console.log('[y1]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshData(name, { mcpSeed = false } = {}) {
  const DATA = path.join(S, `y1-data-${name}-${Date.now()}`);
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
  if (mcpSeed) {
    fs.mkdirSync(path.join(DATA, 'mcp-servers'), { recursive: true });
    fs.writeFileSync(path.join(DATA, 'mcp-servers', 'servers.json'), JSON.stringify({
      mcpServers: { 'demo-tools': { command: 'node', args: ['-e', 'setTimeout(()=>{},1e9)'], startupTimeoutSeconds: 2 } },
    }));
  }
  return DATA;
}
async function launch(DATA, reply = '收到。') {
  const app = await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
    args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45_000,
    env: { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA, DESKMINIS_FAKE_REPLY: reply },
  });
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null;
    if (!page) await sleep(250);
  }
  if (!page) page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e?.message ?? e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.waitForSelector('textarea.field', { timeout: 20_000 });
  await sleep(1500);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  return { app, page, errors };
}
const ss = async (page, name) => { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); log('shot:', name); };
const st = (page) => page.evaluate(() => {
  const c = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat;
  return {
    activeId: c.activeId, sessions: c.sessions.map(s => ({ id: s.id, title: s.title, memoryEnabled: s.memoryEnabled, modelBinding: s.modelBinding, mcpDisabled: s.mcpDisabled })),
    providers: c.providers.map(p => p.id), syncPaused: c.syncPaused, allSkills: c.allSkills.map(s => s.id),
    assistants: c.assistants.map(a => ({ name: a.name, skillIds: a.skillIds })), running: c.running, lastError: c.lastError,
    welcome: !!document.querySelector('.wrap.hero'), title: document.querySelector('.ttl')?.textContent?.trim(),
  };
});
const storeCall = (page, action, arg) => page.evaluate(([action, arg]) =>
  document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat')[action](arg), [action, arg]);
/** 先等 running 起来再等它落下（drive-x1 同款；drive-l6 那种按下就轮询的判定会误判首条）。 */
async function waitTurn(page, maxMs = 30_000) {
  let saw = false;
  for (let t = 0; t < maxMs; t += 50) {
    const r = await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat.running);
    if (r) saw = true; else if (saw) return true;
    await sleep(50);
  }
  return saw;
}
async function sendMsg(page, text) {
  await page.evaluate((text) => {
    const ta = document.querySelector('textarea.field');
    ta.focus(); ta.value = text; ta.setSelectionRange(text.length, text.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(120);
  await page.keyboard.press('Enter');
  const ok = await waitTurn(page);
  await sleep(500);
  return ok;
}
const clickText = (page, sel, text) => page.evaluate(({ sel, text }) => {
  const el = [...document.querySelectorAll(sel)].find(e => e.textContent?.trim() === text)
    ?? [...document.querySelectorAll(sel)].find(e => e.textContent?.includes(text));
  if (!el) return 'NOT_FOUND:' + text;
  el.click(); return 'OK';
}, { sel, text });

const rows = [];

// ---------------------------------------------------------------- menu
if (scenario === 'menu' || scenario === 'all') {
  const DATA = freshData('menu');
  const { app, page, errors } = await launch(DATA);
  try {
    log('menu: send →', await sendMsg(page, '第一条消息：会话菜单实拍'));
    const p = await storeCall(page, 'createProvider', { name: '本地 Ollama', kind: 'ollama', modelId: 'qwen3', baseUrl: 'http://127.0.0.1:11434' });
    await sleep(300);
    const s0 = await st(page);
    const pid = s0.providers[0];
    log('menu: provider created', pid, 'sessions', s0.sessions.length);
    // ⋮ 在 hover 时才显形，click() 不需要可见；aria-expanded 反映开合
    log('menu: open ⋮ →', await page.evaluate(() => { const b = document.querySelector('.srw.on .smore'); if (!b) return 'NO_BTN'; b.click(); return 'OK'; }));
    await sleep(250);
    await ss(page, 'y1-menu');
    // 记忆开关
    log('menu: memory →', await clickText(page, '.smenu .mi', '记忆'));
    await sleep(400);
    const afterMem = (await st(page)).sessions[0];
    // 绑定模型
    const bound = await page.evaluate((pid) => {
      const sel = document.querySelector('.smenu select'); if (!sel) return 'NO_SELECT';
      sel.value = 'provider:' + pid; sel.dispatchEvent(new Event('change', { bubbles: true })); return sel.value;
    }, pid);
    await sleep(400);
    const afterBind = (await st(page)).sessions[0];
    await ss(page, 'y1-menu-bound');
    // 重命名：先试空标题（后端应拒绝并把原因显示在菜单里）
    log('menu: rename →', await clickText(page, '.smenu .mi', '重命名'));
    await sleep(200);
    await page.evaluate(() => { const i = document.querySelector('.smenu input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); });
    await page.keyboard.press('Enter');
    await sleep(400);
    const renameErr = await page.evaluate(() => document.querySelector('.smenu-err')?.textContent?.trim() ?? '');
    await ss(page, 'y1-rename-err');
    await page.evaluate(() => { const i = document.querySelector('.smenu input'); i.value = '已改名的会话'; i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); });
    await page.keyboard.press('Enter');
    await sleep(500);
    const afterRename = await st(page);
    // 删除：二次确认
    log('menu: open ⋮ again →', await page.evaluate(() => { const b = document.querySelector('.srw.on .smore'); if (!b) return 'NO_BTN'; b.click(); return 'OK'; }));
    await sleep(200);
    log('menu: delete →', await clickText(page, '.smenu .mi', '删除会话'));
    await sleep(200);
    const askText = await page.evaluate(() => document.querySelector('.smenu .mask')?.textContent?.trim() ?? '');
    await ss(page, 'y1-delete-ask');
    log('menu: confirm →', await clickText(page, '.smenu .mrow .mi', '删除'));
    await sleep(700);
    const afterDelete = await st(page);
    await ss(page, 'y1-deleted');
    const row = { scenario: 'menu', pid, memoryAfterToggle: afterMem.memoryEnabled, bindValue: bound, modelBinding: afterBind.modelBinding, renameErr, titleAfter: afterRename.sessions[0]?.title, topbarTitle: afterRename.title, askText, sessionsAfterDelete: afterDelete.sessions.length, welcomeAfterDelete: afterDelete.welcome, errors };
    log(JSON.stringify(row)); rows.push(row);
  } finally { await app.close().catch(() => {}); }
}

// ---------------------------------------------------------------- mcp
if (scenario === 'mcp' || scenario === 'all') {
  const DATA = freshData('mcp', { mcpSeed: true });
  const { app, page, errors } = await launch(DATA);
  try {
    log('mcp: send →', await sendMsg(page, '第一条消息：MCP 实拍'));
    await sleep(800);
    const pill0 = await page.evaluate(() => document.querySelector('.mcpbtn')?.textContent?.trim() ?? 'NONE');
    log('mcp: open →', await clickText(page, '.mcpbtn', 'MCP'));
    await sleep(300);
    const panel = await page.evaluate(() => ({
      open: !!document.querySelector('.mcpanel'),
      rows: [...document.querySelectorAll('.mcpanel .mrow')].map(r => r.textContent.replace(/\s+/g, ' ').trim()),
    }));
    await ss(page, 'y1-mcp-panel');
    await page.evaluate(() => { document.querySelector('.mcpanel .mrow input')?.click(); });
    await sleep(700);
    const pill1 = await page.evaluate(() => document.querySelector('.mcpbtn')?.textContent?.trim() ?? 'NONE');
    const s1 = await st(page);
    await ss(page, 'y1-mcp-disabled');
    const row = { scenario: 'mcp', pill0, panel, pill1, mcpDisabled: s1.sessions[0]?.mcpDisabled, errors };
    log(JSON.stringify(row)); rows.push(row);
  } finally { await app.close().catch(() => {}); }
}

// ---------------------------------------------------------------- sync
if (scenario === 'sync' || scenario === 'all') {
  const DATA = freshData('sync');
  const { app, page, errors } = await launch(DATA);
  try {
    log('sync: devices view →', await clickText(page, '.navit', '设备'));
    await sleep(500);
    await ss(page, 'y1-sync');
    log('sync: pause →', await clickText(page, '.f-btn', '暂停同步'));
    await sleep(600);
    const paused = await st(page);
    const dot = await page.evaluate(() => ({ title: document.querySelector('.bar .dot')?.getAttribute('title'), bg: getComputedStyle(document.querySelector('.bar .dot')).backgroundColor }));
    const sub = await page.evaluate(() => document.querySelector('.syncsub')?.textContent?.trim());
    await ss(page, 'y1-sync-paused');
    log('sync: resume →', await clickText(page, '.f-btn', '恢复同步'));
    await sleep(600);
    const resumed = await st(page);
    const row = { scenario: 'sync', pausedFlag: paused.syncPaused, dot, sub, resumedFlag: resumed.syncPaused, errors };
    log(JSON.stringify(row)); rows.push(row);
  } finally { await app.close().catch(() => {}); }
}

// ---------------------------------------------------------------- skills
if (scenario === 'skills' || scenario === 'all') {
  const DATA = freshData('skills');
  const seed = path.join(S, `y1-seed-skill-${Date.now()}`);
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'SKILL.md'), '---\nname: 演示技能\ndescription: Y4 实拍用的种子技能\n---\n# 演示技能\n照着做。\n');
  const { app, page, errors } = await launch(DATA);
  try {
    const t = await storeCall(page, 'importSkillFolder', seed);
    log('skills: import task', JSON.stringify(t));
    for (let i = 0; i < 40; i++) { if ((await st(page)).allSkills.length > 0) break; await sleep(250); }
    log('skills: assistants view →', await clickText(page, '.navit', '助手'));
    await sleep(500);
    log('skills: edit first →', await page.evaluate(() => { const b = document.querySelector('.acard .aacts .f-btn[title="编辑"]'); if (!b) return 'NO_BTN'; b.click(); return 'OK'; }));
    await sleep(300);
    const before = await page.evaluate(() => ({ boxes: document.querySelectorAll('.skl input').length, hint: document.querySelector('.skills')?.parentElement?.textContent?.includes('不勾任何项') }));
    await page.evaluate(() => { document.querySelector('.skl input')?.click(); });
    await sleep(200);
    await ss(page, 'y1-skills-form');
    log('skills: save →', await clickText(page, 'button[type="submit"]', '保存'));
    await sleep(700);
    const after = await st(page);
    const tag = await page.evaluate(() => [...document.querySelectorAll('.acard .f-tag')].map(e => e.textContent.trim()).find(t => t.includes('项技能')) ?? '');
    await ss(page, 'y1-skills-list');
    const row = { scenario: 'skills', allSkills: after.allSkills, before, firstAssistant: after.assistants[0], tag, errors };
    log(JSON.stringify(row)); rows.push(row);
  } finally { await app.close().catch(() => {}); }
}

// ---------------------------------------------------------------- rail
if (scenario === 'rail' || scenario === 'all') {
  const DATA = freshData('rail');
  const longReply = Array.from({ length: 28 }, (_, i) => `第 ${i + 1} 行：这是一段用来把对话撑出滚动条的回复。`).join('\n\n');
  const { app, page, errors } = await launch(DATA, longReply);
  try {
    for (const t of ['第一回合：讲讲这个项目', '第二回合：再展开一点', '第三回合：总结一下']) log('rail: send →', t.slice(0, 5), await sendMsg(page, t));
    await sleep(600);
    const rail = await page.evaluate(() => ({
      dots: document.querySelectorAll('.trail .tdot').length,
      titles: [...document.querySelectorAll('.trail .tdot')].map(e => e.getAttribute('title')),
      scrollTop: document.querySelector('.stage .scroll')?.scrollTop, scrollHeight: document.querySelector('.stage .scroll')?.scrollHeight, clientHeight: document.querySelector('.stage .scroll')?.clientHeight,
    }));
    await ss(page, 'y1-rail');
    await page.evaluate(() => { document.querySelectorAll('.trail .tdot')[0]?.click(); });
    await sleep(900);
    const after = await page.evaluate(() => document.querySelector('.stage .scroll')?.scrollTop);
    await ss(page, 'y1-rail-jumped');
    const row = { scenario: 'rail', rail, scrollTopAfterJump: after, errors };
    log(JSON.stringify(row)); rows.push(row);
  } finally { await app.close().catch(() => {}); }
}

fs.writeFileSync(path.join(S, `y1-${scenario}-${Date.now()}.json`), JSON.stringify(rows, null, 2));
log('done', rows.length, 'rows');
