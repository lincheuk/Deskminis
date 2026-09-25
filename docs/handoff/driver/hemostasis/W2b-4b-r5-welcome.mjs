// W2b-4b 第二次审查意见修正后重拍（W2b-4b-r4-welcome.mjs 的副本，只把默认 TAG 改为 W2b-4b-r5）。r4 原注释：W2b-4b 第四轮修正后重拍（W2b-4b-welcome.mjs 的副本，默认 TAG 改为 W2b-4b-r4；另在 A0 记下未绑空会话在 store 里的原始形状：
// 审查以为是 null，那是旧剧本 `?? null` 写出来的，这里直接看 Object.keys 与原值）。
// 原注释：W2b-4b 实拍：输入卡喂给 assistantToApply / previewBinding 的状态改由纯模块 applyStateOf(chat) 组装之后，
// 欢迎页选助手的整条流程重拍一遍（W2b-4-welcome.mjs 的精简 + 审查点名的两种场景）。
// 真 provider + 剧本内置的本地假 OpenAI 端点：四个免密钥 ollama 类 provider 各走一条路由
// （/def/ 默认、/x/ 助手甲绑、/y/ 助手乙绑、/g/ 模型组「组·甲乙」的首个成员），端点把每次请求的系统提示原样记下——
// 「真的带着助手预设、真的打到胶囊说的那个模型」以请求体为准，不信界面。后端真相用 python3 sqlite3 只读查 minis.db。
//
// 场景（一次冷启动）：
//   N 无会话欢迎页：点乙 → 胶囊 mock-y → 发送 → 库里是乙、请求打到 /y/ 带乙的预设
//   A NavRail「新建会话」→ 空会话胶囊「默认 · mock-def」→ 点甲 → 副标题 / 高亮 / 胶囊 mock-x（此时库里未变）→ 发送
//     → 库里 assistant_id = 甲、绑定 provider:PX；请求打到 /x/ 带甲的预设
//   H 审查场景（变异 1、3 的靶子）：用甲开空会话，再把会话绑定改成模型组 G（接力照抄来的就是这样）→
//     H1 选择仍是甲（镜像）：胶囊显示「组·甲乙」（会话自己的绑定），不是甲的 mock-x，也不是「默认 · …」（变异 3 的谎）
//     H2 改选乙：胶囊 mock-y（变异 1 下会停在组名上）
//     H3 再点回甲：胶囊回「组·甲乙」
//     H4 改选乙发送 → 库里换成乙、绑定 provider:PY；请求打到 /y/ 只带乙的预设（变异 1 下库里仍是甲、打到 /g/）
//   K 同 H 的起点，但不改选直接发送 → 库里仍是甲、绑定仍是 group:G（不重复套用）；请求打到 /g/ 带甲的预设
//   C 用甲开空会话 → 点甲取消选择 → 胶囊「默认 · mock-def」→ 发送 → 库里助手与绑定都清空；请求打到 /def/、无预设
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
const { _electron: electron } = createRequire(import.meta.url)('playwright-core');

const APP_DIR = '/home/user/wt-d2/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const SHOTS = path.join(S, 'hemo-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log('[w2b4b]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
// 变异对照跑时设 W2B4B_TAG（截图与数据根换前缀，不覆盖正式截图）
const TAG = process.env.W2B4B_TAG ?? 'W2b-4b-r5';
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); log(ok ? 'PASS' : 'FAIL', name, ok ? '' : JSON.stringify(detail)); };

// ---------- 假端点：记下每次请求的路由、模型与系统提示 ----------
const hits = [];
const srv = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body || '{}'); } catch { /* 非 JSON 也记一笔 */ }
    const msgs = Array.isArray(j.messages) ? j.messages : [];
    const sys = msgs.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    const isTitle = body.includes('标题生成器');
    const route = (req.url ?? '').split('/')[1];
    hits.push({ route, model: j.model, isTitle, presets: [...sys.matchAll(/<assistant_preset name="([^"]*)">/g)].map((m) => m[1]), at: Date.now() });
    if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    chunk({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
    chunk({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: isTitle ? '自动命名' : `（${route} 路由回复）收到，按当前预设处理。` } }] });
    chunk({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n'); res.end();
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const U = (route) => `http://127.0.0.1:${PORT}/${route}/v1`;

const PDEF = 'AAAAAAAA-0000-4000-8000-00000000000D';
const PX = 'AAAAAAAA-0000-4000-8000-00000000000A';
const PY = 'AAAAAAAA-0000-4000-8000-00000000000B';
const PG = 'AAAAAAAA-0000-4000-8000-00000000000C';

// 数据根一律 mkdtemp 临时目录，经 DESKMINIS_DATA_DIR 注入
const DATA = fs.mkdtempSync(path.join(S, `${TAG}-data-`));
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({
  providers: [
    { id: PDEF, name: '默认模型', kind: 'ollama', baseUrl: U('def'), modelId: 'mock-def' },
    { id: PX, name: '甲的模型', kind: 'ollama', baseUrl: U('x'), modelId: 'mock-x' },
    { id: PY, name: '乙的模型', kind: 'ollama', baseUrl: U('y'), modelId: 'mock-y' },
    { id: PG, name: '组首成员', kind: 'ollama', baseUrl: U('g'), modelId: 'mock-g' },
  ],
  defaultProviderId: PDEF,
}, null, 2));
log('DATA =', DATA);

/** 后端真相：只读打开 minis.db 查 sessions（python3 自带 sqlite3，不碰 Electron ABI 的 better-sqlite3）。 */
function dbSession(id) {
  const py = `import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
r=c.execute('select id,title,assistant_id,model_binding from sessions where id=?',(sys.argv[2],)).fetchone()
n=c.execute('select count(*) from messages where session_id=?',(sys.argv[2],)).fetchone()[0]
print(json.dumps(dict(id=r[0],title=r[1],assistant_id=r[2],model_binding=r[3],messages=n) if r else None,ensure_ascii=False))`;
  return JSON.parse(execFileSync('python3', ['-c', py, path.join(DATA, 'minis.db'), id], { encoding: 'utf8' }));
}

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
await sleep(1500);
await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

const theme = (t) => page.evaluate((t) => { document.documentElement.dataset.theme = t; }, t);
const ss = async (name) => { await page.screenshot({ path: path.join(SHOTS, `${TAG}-${name}.png`) }); log('shot:', name); };
const store = (fn, ...args) => page.evaluate(([fn, args]) => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat')[fn](...args), [fn, args]);
const st = () => page.evaluate(() => {
  const c = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat;
  const cap = [...document.querySelectorAll('.cap')].find((e) => e.querySelector('svg'));
  const act = c.sessions.find((s) => s.id === c.activeId);
  return {
    activeId: c.activeId, running: c.running, lastError: c.lastError, messages: c.messages.length,
    welcomeAssistantId: c.welcomeAssistantId,
    session: act ? { title: act.title, assistantId: act.assistantId ?? null, modelBinding: act.modelBinding ?? null } : null,
    // 原始形状：字段在不在、原值是 undefined 还是 null（JSON 化时 undefined 会丢，所以显式写成字符串）
    raw: act ? { keys: Object.keys(act).sort(), assistantId: act.assistantId === undefined ? '<undefined>' : act.assistantId, modelBinding: act.modelBinding === undefined ? '<undefined>' : act.modelBinding } : null,
    pill: cap ? cap.textContent.trim() : null,
    pillTitle: cap ? cap.getAttribute('title') : null,
    sub: document.querySelector('.hero .sub')?.textContent?.trim() ?? null,
    pressed: [...document.querySelectorAll('.acard[aria-pressed="true"] .aname')].map((e) => e.textContent.trim()),
    welcome: !!document.querySelector('.hero .sub'),
  };
});
const clickCard = (name) => page.evaluate((name) => {
  const el = [...document.querySelectorAll('.acard')].find((e) => e.querySelector('.aname')?.textContent?.trim() === name);
  if (!el) return 'NO_CARD:' + name;
  el.click(); return 'OK';
}, name);
async function waitTurn(maxMs = 30_000) {
  let saw = false;
  for (let t = 0; t < maxMs; t += 50) {
    const r = (await st()).running;
    if (r) saw = true; else if (saw) return true;
    await sleep(50);
  }
  return saw;
}
async function send(text) {
  await page.evaluate((text) => {
    const ta = document.querySelector('textarea.field');
    ta.focus(); ta.value = text; ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(120);
  await page.keyboard.press('Enter');
}
const hitsSince = (n) => hits.slice(n).filter((h) => !h.isTitle);

const X_NAME = '甲·周报写手';
const Y_NAME = '乙·资料研究员';
const G_NAME = '组·甲乙';

try {
  const x = await store('createAssistant', { name: X_NAME, avatar: '📝', rules: '你是甲，只写周报，句子要短。', modelBinding: `provider:${PX}` });
  const y = await store('createAssistant', { name: Y_NAME, avatar: '🔬', rules: '你是乙，查资料要给出处。', modelBinding: `provider:${PY}` });
  const g = await store('createModelGroup', G_NAME, [PG, PX]);
  const X = x.id, Y = y.id, G = g.id;
  out.ids = { X, Y, G };
  await sleep(400);

  // ---------- N：无会话 → 点乙 → 发送 ----------
  out.N0 = await st();
  check('N0 无会话欢迎页、胶囊「默认 · mock-def」', !out.N0.activeId && out.N0.welcome && out.N0.pill === '默认 · mock-def', out.N0);
  log('N pick Y →', await clickCard(Y_NAME));
  await sleep(300);
  out.N1 = await st();
  check('N1 点乙：高亮乙、胶囊 mock-y', out.N1.pressed.join() === Y_NAME && out.N1.pill === 'mock-y', out.N1);
  await ss('N-no-session-picked-Y');
  let n = hits.length;
  await send('查一下 Electron utilityProcess 的资料');
  out.N_turn = await waitTurn();
  await sleep(800);
  out.N2 = await st();
  out.N_hits = hitsSince(n);
  out.N_db = dbSession(out.N2.activeId);
  check('N2 发送：库里是乙、绑定 provider:PY；请求打到 /y/ 带乙的预设', out.N_db?.assistant_id === Y && out.N_db?.model_binding === `provider:${PY}`
    && out.N_hits.length >= 1 && out.N_hits.every((h) => h.route === 'y') && out.N_hits[0].presets.join() === Y_NAME, { db: out.N_db, hits: out.N_hits });

  // ---------- A：NavRail「新建会话」→ 空会话 → 点甲 → 发送 ----------
  log('A new session →', await page.evaluate(() => { const b = document.querySelector('.newbtn'); if (!b) return 'NO_BTN'; b.click(); return 'OK'; }));
  await sleep(800);
  out.A0 = await st();
  check('A0 空会话欢迎页、无高亮、胶囊「默认 · mock-def」', out.A0.activeId && out.A0.messages === 0 && out.A0.welcome && out.A0.pressed.length === 0 && out.A0.pill === '默认 · mock-def', out.A0);
  check('A0 未绑空会话在 store 里的原始形状：assistantId / modelBinding 字段缺席（后端 ?? undefined，经 JSON 丢掉），不是 null',
    out.A0.raw && !out.A0.raw.keys.includes('assistantId') && !out.A0.raw.keys.includes('modelBinding') && out.A0.raw.assistantId === '<undefined>', out.A0.raw);
  await ss('A-empty-session');
  log('A pick X →', await clickCard(X_NAME));
  await sleep(300);
  out.A1 = await st();
  out.A1_db = dbSession(out.A1.activeId);
  check('A1 点甲：副标题「已选」、高亮甲、胶囊 mock-x；库里还没变（点卡只改选择态）',
    out.A1.sub?.includes(`已选 📝 ${X_NAME}`) && out.A1.pressed.join() === X_NAME && out.A1.pill === 'mock-x' && !out.A1_db?.assistant_id, { st: out.A1, db: out.A1_db });
  await ss('A-picked-X-light');
  await theme('dark'); await sleep(300); await ss('A-picked-X-dark'); await theme('light'); await sleep(200);
  n = hits.length;
  await send('把本周进展写成周报');
  out.A_turn = await waitTurn();
  await sleep(800);
  out.A2 = await st();
  out.A_hits = hitsSince(n);
  out.A_db = dbSession(out.A2.activeId);
  check('A2 发送：库里是甲、绑定 provider:PX；请求打到 /x/ 带甲的预设；无错误', out.A_db?.assistant_id === X && out.A_db?.model_binding === `provider:${PX}`
    && out.A_hits.length >= 1 && out.A_hits.every((h) => h.route === 'x') && out.A_hits[0].presets.join() === X_NAME && !out.A2.lastError, { db: out.A_db, hits: out.A_hits, err: out.A2.lastError });
  await ss('A-after-send');

  // ---------- H：甲开的空会话、绑定改成组 G → 镜像 / 改选 / 点回 / 改选发送 ----------
  await store('newSessionWithAssistant', X);
  await sleep(500);
  const sidH = (await st()).activeId;
  await store('setSessionModelBinding', sidH, `group:${G}`);
  await sleep(500);
  out.H1 = await st();
  check('H1 选择仍是甲（镜像）：高亮甲，胶囊显示会话自己的「组·甲乙」——不是甲的 mock-x，也不是「默认 · …」',
    out.H1.activeId === sidH && out.H1.session?.modelBinding === `group:${G}` && out.H1.pressed.join() === X_NAME && out.H1.pill === G_NAME
    && out.H1.pillTitle?.startsWith(`模型组「${G_NAME}」`), out.H1);
  await ss('H1-mirrored-X-session-group');
  log('H pick Y →', await clickCard(Y_NAME));
  await sleep(300);
  out.H2 = await st();
  check('H2 改选乙：高亮乙、胶囊 mock-y（发送前就预告套用后的绑定）', out.H2.pressed.join() === Y_NAME && out.H2.pill === 'mock-y', out.H2);
  await ss('H2-switched-to-Y');
  log('H pick X again →', await clickCard(X_NAME));
  await sleep(300);
  out.H3 = await st();
  check('H3 点回甲：胶囊回到会话自己的「组·甲乙」', out.H3.pressed.join() === X_NAME && out.H3.pill === G_NAME, out.H3);
  log('H pick Y again →', await clickCard(Y_NAME));
  await sleep(300);
  n = hits.length;
  await send('查一下 better-sqlite3 的 ABI 问题');
  out.H_turn = await waitTurn();
  await sleep(800);
  out.H4 = await st();
  out.H_hits = hitsSince(n);
  out.H_db = dbSession(sidH);
  check('H4 改选乙发送：库里换成乙、绑定 provider:PY（组绑定被套用覆盖，胶囊已预告）；请求打到 /y/ 只带乙的预设',
    out.H_db?.assistant_id === Y && out.H_db?.model_binding === `provider:${PY}` && out.H_hits.length >= 1 && out.H_hits.every((h) => h.route === 'y')
    && out.H_hits[0].presets.join() === Y_NAME && !out.H4.lastError, { db: out.H_db, hits: out.H_hits, err: out.H4.lastError });
  await ss('H4-after-send');

  // ---------- K：同 H 的起点，不改选直接发送 ----------
  await store('newSessionWithAssistant', X);
  await sleep(500);
  const sidK = (await st()).activeId;
  await store('setSessionModelBinding', sidK, `group:${G}`);
  await sleep(500);
  out.K0 = await st();
  check('K0 镜像甲、胶囊「组·甲乙」', out.K0.pressed.join() === X_NAME && out.K0.pill === G_NAME, out.K0);
  n = hits.length;
  await send('按周报格式写：组绑定不被重置');
  out.K_turn = await waitTurn();
  await sleep(800);
  out.K1 = await st();
  out.K_hits = hitsSince(n);
  out.K_db = dbSession(sidK);
  check('K1 不改选发送：库里仍是甲、绑定仍是 group:G（不重复套用）；请求打到 /g/ 带甲的预设——与胶囊所示一致',
    out.K_db?.assistant_id === X && out.K_db?.model_binding === `group:${G}` && out.K_hits.length >= 1 && out.K_hits[0].route === 'g'
    && out.K_hits[0].presets.join() === X_NAME && !out.K1.lastError, { db: out.K_db, hits: out.K_hits, err: out.K1.lastError });
  check('K1 会话页胶囊仍显示「组·甲乙」', !out.K1.welcome && out.K1.pill === G_NAME, out.K1);
  await ss('K1-chat-view-group');

  // ---------- C：甲开的空会话 → 取消选择 → 发送 ----------
  await store('newSessionWithAssistant', X);
  await sleep(500);
  const sidC = (await st()).activeId;
  out.C0 = await st();
  check('C0 甲开的空会话：镜像甲、胶囊 mock-x', out.C0.pressed.join() === X_NAME && out.C0.pill === 'mock-x', out.C0);
  log('C unpick X →', await clickCard(X_NAME));
  await sleep(300);
  out.C1 = await st();
  check('C1 取消选择：无高亮、副标题回通用、胶囊「默认 · mock-def」', out.C1.pressed.length === 0 && !out.C1.sub?.includes('已选') && out.C1.pill === '默认 · mock-def', out.C1);
  await ss('C-unpicked');
  n = hits.length;
  await send('随便聊两句');
  out.C_turn = await waitTurn();
  await sleep(1500);
  out.C2 = await st();
  out.C_hits = hitsSince(n);
  out.C_db = dbSession(sidC);
  check('C2 发送：库里助手与绑定都清空；请求打到 /def/、无预设', !out.C_db?.assistant_id && !out.C_db?.model_binding
    && out.C_hits.length >= 1 && out.C_hits.every((h) => h.route === 'def') && out.C_hits[0].presets.length === 0 && !out.C2.lastError, { db: out.C_db, hits: out.C_hits });

  out.errors = errors;
  check('全程无 pageerror / console.error', errors.length === 0, errors);
} finally {
  await app.close().catch(() => {});
  srv.close();
}

console.log(JSON.stringify(out, null, 1));
const bad = checks.filter((c) => !c.ok);
console.log(`[w2b4b] SUMMARY ${checks.length - bad.length}/${checks.length} PASS`);
if (bad.length) { console.log('[w2b4b] FAILED:', bad.map((c) => c.name).join(' | ')); process.exitCode = 1; }
