// W2b-11d 实拍：右栏「改动」清单按工具结果判。
// 一个会话里造三个写工具步骤——成功一个、失败一个、中断一个：
//   回合 1  file_write 成功.txt（工作区内，免审）                  → 成功
//   回合 2  file_edit  失败.txt（文件不存在，ENOENT）               → 失败（success:false）
//   回合 3  file_write /var/minis/skills/demo/SKILL.md（技能目录写，走权限卡）
//           卡挂着的时候 toolUse 已落库、结果还没有：先拍一张运行中的「改动」（还没结果的照旧列），
//           再 kill -9 minisd（数据根锁里的 pid），关掉应用。
// 同一数据根重开、点回这个会话：回合 3 那一步是「已中断 · 结果未知」，「改动」tab 只该剩成功的那一个。
// 模型是本地假 OpenAI 兼容端点（照 docs/handoff/driver/mock-openai.mjs 的写法），按最后一条用户消息回不同的工具调用：
// FakeProvider 同一会话每回合重放首条 __tool__，造不出三个不同的写工具。
// 用法：NODE_PATH=<scratchpad>/driver/node_modules xvfb-run -a node W2b-11d-changes.mjs [截图前缀，缺省 W2b-11d]
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
// ESM 的 import 不认 NODE_PATH，CJS 的 require 认：playwright-core 不入库，经 NODE_PATH 指向 scratchpad/driver/node_modules
const { _electron: electron } = createRequire(import.meta.url)('playwright-core');

const APP_DIR = '/home/user/wt-r/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const SHOTS = path.join(S, 'hemo-shots');
const PREFIX = process.argv[2] || 'W2b-11d';
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log('[w2b11d]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { prefix: PREFIX, checks: {} };

// ---------- 假 OpenAI 兼容端点：按最后一条用户消息回工具调用 ----------
const SKILL_PATH = '/var/minis/skills/demo/SKILL.md';
const SCRIPT = [
  { when: /写成功/, name: 'file_write', args: { path: '成功.txt', content: '第一行\n第二行\n', tool_title: '写一个会成功的文件' } },
  { when: /改失败/, name: 'file_edit', args: { path: '失败.txt', old_string: '旧的一行', new_string: '新的一行', tool_title: '改一个不存在的文件' } },
  { when: /写中断/, name: 'file_write', args: { path: SKILL_PATH, content: '---\nname: demo\ndescription: 实拍用\n---\n正文\n', tool_title: '往技能目录写一个文件' } },
];
const hits = [];
let callSeq = 0;
const srv = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* 记一笔照回文本 */ }
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const last = msgs[msgs.length - 1] ?? {};
    const text = typeof last.content === 'string' ? last.content : '';
    // 取标题的请求不带工具（auto-title.ts：tools: []），一律回文本
    const withTools = Array.isArray(body.tools) && body.tools.length > 0;
    const step = withTools && last.role === 'user' ? SCRIPT.find((s) => s.when.test(text)) : undefined;
    hits.push({ url: req.url, lastRole: last.role, text: text.slice(0, 40), tool: step?.name ?? null });
    if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    chunk({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
    if (step) {
      const id = `call_${++callSeq}`;
      chunk({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] } }] });
      chunk({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      const reply = !withTools ? '改动清单实拍' : last.role === 'tool' ? '这一步做完了。' : '好的。';
      chunk({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: reply } }] });
      chunk({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;

const DATA = fs.mkdtempSync(path.join(S, 'W2b-11d-data-'));
const PID = 'AAAAAAAA-0000-4000-8000-00000000011D';
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({
  providers: [{ id: PID, name: '假模型', kind: 'ollama', baseUrl: `http://127.0.0.1:${PORT}/v1`, modelId: 'mock-writer' }],
  defaultProviderId: PID,
}, null, 2));
out.dataRoot = DATA;

async function launch() {
  const env = { ...process.env, DESKMINIS_DATA_DIR: DATA };
  delete env.DESKMINIS_FAKE_PROVIDER;
  const app = await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
    args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45_000, env,
  });
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(250); }
  if (!page) page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e?.message ?? e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.waitForSelector('textarea.field', { timeout: 20_000 });
  await sleep(1200);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  return { app, page, errors };
}
const chatState = (page) => page.evaluate(() => {
  const c = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat;
  return { activeId: c.activeId, running: c.running, midRun: c.midRun, perms: c.pendingPerms.length, lastError: c.lastError,
    toolCards: c.toolCards.map((t) => ({ name: t.name, success: t.success })) };
});
const store = (page, fn, ...args) => page.evaluate(([fn, args]) =>
  document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat')[fn](...args), [fn, args]);
async function until(page, pred, maxMs = 20_000, what = '') {
  for (let t = 0; t < maxMs; t += 100) { if (pred(await chatState(page))) return true; await sleep(100); }
  throw new Error('等待超时：' + what);
}
/** 先等 running 起来再等它落下（drive-x1 的 waitTurn：按下 Enter 立刻轮询会在首条消息上误判）。 */
async function waitTurn(page, maxMs = 30_000) {
  let saw = false;
  for (let t = 0; t < maxMs; t += 50) {
    const r = (await chatState(page)).running;
    if (r) saw = true; else if (saw) return true;
    await sleep(50);
  }
  throw new Error('回合没有结束');
}
async function send(page, text) {
  await page.evaluate((text) => {
    const ta = document.querySelector('textarea.field');
    ta.focus(); ta.value = text; ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(150);
  await page.keyboard.press('Enter');
}
const clickRow = (page, title) => page.evaluate((title) => {
  const el = [...document.querySelectorAll('.srow')].find((b) => b.querySelector('.stitle')?.textContent?.trim() === title);
  if (!el) return 'NOT_FOUND:' + title; el.click(); return 'OK';
}, title);
const clickTab = (page, name) => page.evaluate((name) => {
  const b = [...document.querySelectorAll('.ws .tabs button')].find((x) => x.textContent.trim().startsWith(name));
  if (!b) return 'NO_TAB:' + name; b.click(); return 'OK';
}, name);
/** 「改动」tab：tab 上的计数与清单每一行（标记、路径、增删数）。 */
const changes = (page) => page.evaluate(() => {
  const tab = [...document.querySelectorAll('.ws .tabs button')].find((x) => x.textContent.trim().startsWith('改动'));
  return {
    badge: tab?.querySelector('.n')?.textContent?.trim() ?? null,
    rows: [...document.querySelectorAll('.ws .body .chg')].map((c) => ({
      tag: c.querySelector('.tag')?.textContent?.trim(),
      path: c.querySelector('.cpath')?.textContent?.trim(),
      num: c.querySelector('.cnum')?.textContent?.replace(/\s+/g, '') ?? null,
    })),
    empty: document.querySelector('.ws .body .hint')?.textContent?.trim() ?? null,
  };
});
/** 会话页里全部历史步骤组展开（实时块不动）。 */
const expandAll = (page) => page.evaluate(() => {
  let n = 0;
  for (const b of document.querySelectorAll('section.turn:not([data-turn-id="live"]) .grp > .head')) {
    if (b.getAttribute('aria-expanded') !== 'true') { b.click(); n++; }
  }
  return n;
});
const groups = (page) => page.evaluate(() => [...document.querySelectorAll('section.turn:not([data-turn-id="live"]) .grp')].map((g) => ({
  head: g.querySelector('.head')?.textContent?.replace(/\s+/g, ' ').trim(),
  steps: [...g.querySelectorAll('.step')].map((s) => ({
    title: s.querySelector('.stitle')?.textContent?.trim(),
    dot: s.querySelector('.dot')?.className,
    note: s.querySelector('.snote')?.textContent?.trim() ?? null,
  })),
})));
const ss = async (page, name) => { const f = path.join(SHOTS, `${PREFIX}-${name}.png`); await page.screenshot({ path: f }); log('shot:', f); };

// =============== 第一次启动 ===============
const first = await launch();
try {
  const { page } = first;
  await send(page, '第一步：写成功一个文件');
  await waitTurn(page);
  await sleep(700);
  const S1 = (await chatState(page)).activeId;
  await store(page, 'renameSession', S1, '改动清单实拍');
  await sleep(300);
  await send(page, '第二步：改失败一个不存在的文件');
  await waitTurn(page);
  await sleep(700);
  await send(page, '第三步：写中断——等批准时引擎被杀');
  await until(page, (s) => s.perms === 1 && s.running, 20_000, '回合 3 权限卡');
  await sleep(500);
  out.liveState = await chatState(page);
  log('tab 改动 →', await clickTab(page, '改动'));
  await sleep(400);
  out.liveChanges = await changes(page);
  await ss(page, '1-live-pending');
  // 数据根锁里记着 minisd 的 pid（W1b-3）
  const lock = JSON.parse(fs.readFileSync(path.join(DATA, 'minisd.lock'), 'utf8'));
  log('kill -9 minisd pid', lock.pid);
  process.kill(lock.pid, 'SIGKILL');
  await sleep(1500);
  out.firstErrors = first.errors;
} finally {
  await Promise.race([first.app.close().catch(() => {}), sleep(8000)]);
  try { first.app.process().kill('SIGKILL'); } catch { /* 已退出 */ }
  await sleep(1500);
}

// =============== 第二次启动：同一数据根 ===============
const second = await launch();
try {
  const { page } = second;
  log('open session →', await clickRow(page, '改动清单实拍'));
  await sleep(1200);
  out.reopenState = await chatState(page);
  log('tab 改动 →', await clickTab(page, '改动'));
  await sleep(400);
  out.reopenChanges = await changes(page);
  log('expand →', await expandAll(page));
  await sleep(400);
  out.groups = await groups(page);
  // 三个回合的步骤组在长输出下面，滚到对话底部，回合 2、3 的组头与右栏清单同屏
  await page.evaluate(() => { const s = document.querySelector('.stage .scroll'); if (s) s.scrollTop = s.scrollHeight; });
  await sleep(400);
  await ss(page, '2-reopen-only-success');
  // 回合 1、2 滚进视口：成功的那一步与失败的那一步
  await page.evaluate(() => { const gs = document.querySelectorAll('section.turn:not([data-turn-id="live"]) .grp'); gs[0]?.scrollIntoView({ block: 'start' }); });
  await sleep(400);
  await ss(page, '3-reopen-turns-1-2');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.evaluate(() => { const s = document.querySelector('.stage .scroll'); if (s) s.scrollTop = s.scrollHeight; });
  await sleep(400);
  await ss(page, '4-reopen-only-success-dark');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  // 工作区里确实只有成功的那个文件（失败的 file_edit 没建出文件；中断的那一步在技能目录，不在工作区）
  out.workspaceFiles = fs.readdirSync(path.join(DATA, 'sessions', out.reopenState.activeId, 'workspace'));
  out.skillWritten = fs.existsSync(path.join(DATA, 'skills', 'demo', 'SKILL.md'));
  out.secondErrors = second.errors;
} finally {
  await Promise.race([second.app.close().catch(() => {}), sleep(8000)]);
  try { second.app.process().kill('SIGKILL'); } catch { /* 已退出 */ }
  srv.close();
}

// ---------- 判定 ----------
out.hits = hits;
const paths = (c) => (c?.rows ?? []).map((r) => r.path);
out.checks.liveListsSuccessAndPending = JSON.stringify(paths(out.liveChanges)) === JSON.stringify(['成功.txt', 'skills/demo/SKILL.md']);
out.checks.liveBadge2 = out.liveChanges?.badge === '2';
out.checks.reopenOnlySuccess = JSON.stringify(paths(out.reopenChanges)) === JSON.stringify(['成功.txt']);
out.checks.reopenBadge1 = out.reopenChanges?.badge === '1';
const g = out.groups ?? [];
out.checks.chatThreeGroups = g.length === 3;
out.checks.turn1Ok = !!g[0] && !/失败|已中断/.test(g[0].head) && g[0].steps.every((s) => !s.note && !/bad|intr/.test(s.dot ?? ''));
out.checks.turn2Failed = /1 步失败/.test(g[1]?.head ?? '');
out.checks.turn3Interrupted = /1 步已中断/.test(g[2]?.head ?? '') && g[2]?.steps?.[0]?.note === '已中断 · 结果未知';
out.checks.noPageErrors = [...(out.firstErrors ?? []), ...(out.secondErrors ?? [])].filter((e) => /pageerror/.test(e)).length === 0;
const file = path.join(S, 'hemo-logs', `${PREFIX}-changes-${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2));
log('result →', file);
log(JSON.stringify(out.checks));
log('live:', JSON.stringify(out.liveChanges));
log('reopen:', JSON.stringify(out.reopenChanges));
process.exit(Object.values(out.checks).every(Boolean) ? 0 : 1);
