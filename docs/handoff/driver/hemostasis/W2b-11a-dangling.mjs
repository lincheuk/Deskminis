// W2b-11a 实拍：历史回合里没有结果的工具显示「已中断 · 结果未知」；正在跑的回合保持原样、收尾不闪假的中断标。
// FakeProvider（每回合重放首条 __tool__，每次 prompt 新建一个实例，所以每回合都调一次 web_fetch）+ 本地 HTTP 测试页。
// web_fetch 走权限卡（askOnce）：卡挂着的时候工具正「在跑」——assistant 的 toolUse 已落库、toolResult 还没有。
//
// 一次数据根、两次启动：
//   第一次：回合 1 允许（成功）→ 回合 2 拒绝（失败）→ 回合 3 卡挂着时切到别的会话再切回（midRun）：
//           这一步是 pending，照旧画（不标中断）→ 装 MutationObserver → 允许 → 回合收尾，全程不许出现「已中断」→
//           回合 4 卡挂着时 kill -9 minisd（数据根锁里的 pid），然后关掉应用。
//   第二次：同一数据根重开，点回这个会话：回合 4 那一步「已中断 · 结果未知」，组头「1 步已中断」；成功、失败照旧。
// 用法：NODE_PATH=<scratchpad>/driver/node_modules xvfb-run -a node W2b-11a-dangling.mjs
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
// ESM 的 import 不认 NODE_PATH，CJS 的 require 认：playwright-core 不入库，经 NODE_PATH 指向 scratchpad/driver/node_modules
const { _electron: electron } = createRequire(import.meta.url)('playwright-core');

const APP_DIR = '/home/user/wt-h/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const SHOTS = path.join(S, 'hemo-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log('[w2b11a]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { checks: {} };

// ---------- web_fetch 的目标：本地测试页 ----------
const srv = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<html><head><title>本地测试页</title></head><body><p>这是 W2b-11a 实拍用的测试页。</p></body></html>');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const TOOL_MSG = `__tool__ web_fetch ${JSON.stringify({ url: `http://127.0.0.1:${PORT}/ok`, tool_title: '抓取本地测试页' })}`;

const DATA = fs.mkdtempSync(path.join(S, 'W2b-11a-data-'));
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));

async function launch() {
  const app = await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
    args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45_000,
    env: { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA, DESKMINIS_FAKE_REPLY: '已处理。' },
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
  return { activeId: c.activeId, running: c.running, midRun: c.midRun, runningSessions: [...c.runningSessions], perms: c.pendingPerms.length, lastError: c.lastError,
    sessions: c.sessions.map((s) => ({ id: s.id, title: s.title })) };
});
const store = (page, fn, ...args) => page.evaluate(([fn, args]) =>
  document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat')[fn](...args), [fn, args]);
async function until(page, pred, maxMs = 20_000, what = '') {
  for (let t = 0; t < maxMs; t += 100) { if (pred(await chatState(page))) return true; await sleep(100); }
  throw new Error('等待超时：' + what);
}
async function send(page, text) {
  await page.evaluate((text) => {
    const ta = document.querySelector('textarea.field');
    ta.focus(); ta.value = text; ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(150);
  await page.keyboard.press('Enter');
}
const clickPerm = (page, which) => page.evaluate((which) => {
  const b = document.querySelector(which === 'allow' ? '.perm .pb.primary' : '.perm .pb.deny');
  if (!b) return 'NO_BTN'; b.click(); return 'OK';
}, which);
const clickRow = (page, title) => page.evaluate((title) => {
  const el = [...document.querySelectorAll('.srow')].find((b) => b.querySelector('.stitle')?.textContent?.trim() === title);
  if (!el) return 'NOT_FOUND:' + title; el.click(); return 'OK';
}, title);
/** 展开会话页里全部历史步骤组（实时块的不动）。 */
const expandAll = (page) => page.evaluate(() => {
  let n = 0;
  for (const b of document.querySelectorAll('section.turn:not([data-turn-id="live"]) .grp > .head')) {
    if (b.getAttribute('aria-expanded') !== 'true') { b.click(); n++; }
  }
  return n;
});
/** 历史里每个步骤组：组头文字、每一步的点的类与中断标。 */
const groups = (page) => page.evaluate(() => [...document.querySelectorAll('section.turn:not([data-turn-id="live"]) .grp')].map((g) => ({
  head: g.querySelector('.head')?.textContent?.replace(/\s+/g, ' ').trim(),
  steps: [...g.querySelectorAll('.step')].map((s) => ({
    title: s.querySelector('.stitle')?.textContent?.trim(),
    dot: s.querySelector('.dot')?.className,
    dotBg: getComputedStyle(s.querySelector('.dot')).backgroundColor,
    dotRing: getComputedStyle(s.querySelector('.dot')).boxShadow,
    note: s.querySelector('.snote')?.textContent?.trim() ?? null,
  })),
})));
const ss = async (page, name) => { await page.screenshot({ path: path.join(SHOTS, `W2b-11a-${name}.png`) }); log('shot:', name); };

// =============== 第一次启动 ===============
let first = await launch();
try {
  const { page } = first;
  // 回合 1：允许 → 成功
  await send(page, TOOL_MSG);
  await until(page, (s) => s.perms === 1, 20_000, '回合 1 权限卡');
  log('turn1 allow →', await clickPerm(page, 'allow'));
  await until(page, (s) => !s.running && s.perms === 0, 20_000, '回合 1 结束');
  await sleep(600);
  const S1 = (await chatState(page)).activeId;
  await store(page, 'renameSession', S1, '悬空工具实拍');
  // 回合 2：拒绝 → 失败
  await send(page, '第二回合：这一次拒绝抓取');
  await until(page, (s) => s.perms === 1, 20_000, '回合 2 权限卡');
  log('turn2 deny →', await clickPerm(page, 'deny'));
  await until(page, (s) => !s.running && s.perms === 0, 20_000, '回合 2 结束');
  await sleep(600);
  // 回合 3：卡挂着（工具在跑）→ 切到别的会话再切回 → midRun
  await send(page, '第三回合：卡在权限上时切走再切回');
  await until(page, (s) => s.perms === 1 && s.running, 20_000, '回合 3 权限卡');
  await sleep(400);
  log('new session →', await page.evaluate(() => { const b = document.querySelector('.newbtn'); if (!b) return 'NO_BTN'; b.click(); return 'OK'; }));
  await sleep(600);
  await send(page, '旁边的会话：随便说一句');
  await until(page, (s) => s.activeId !== S1 && !s.running, 20_000, '旁边的会话回合结束');
  await sleep(500);
  const S2 = (await chatState(page)).activeId;
  await store(page, 'renameSession', S2, '旁边的会话');
  await sleep(300);
  log('back to S1 →', await clickRow(page, '悬空工具实拍'));
  await until(page, (s) => s.activeId === S1, 10_000, '切回 S1');
  await sleep(900);
  out.midRunState = await chatState(page);
  log('expand →', await expandAll(page));
  await sleep(300);
  out.midRunGroups = await groups(page);
  // 回合 3 那一组滚到视口顶端：它的步骤（pending，画法同以前）、下面实时块的 midRun 占位与权限卡同屏
  await page.evaluate(() => { const gs = document.querySelectorAll('section.turn:not([data-turn-id="live"]) .grp'); gs[gs.length - 1]?.scrollIntoView({ block: 'start' }); });
  await sleep(400);
  out.midRunLive = await page.evaluate(() => document.querySelector('[data-turn-id="live"]')?.textContent?.trim() ?? null);
  await ss(page, '1-midrun-pending');
  // 装观察器：回合收尾到历史重取完的整段，文档里任何时候出现「已中断」都记下来
  await page.evaluate(() => {
    window.__flash = [];
    const check = () => { const t = document.body.innerText; if (/已中断/.test(t)) window.__flash.push(performance.now()); };
    window.__flashObs = new MutationObserver(check);
    window.__flashObs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    check();
  });
  log('turn3 allow →', await clickPerm(page, 'allow'));
  await until(page, (s) => !s.running && s.perms === 0, 20_000, '回合 3 结束');
  await sleep(1500);
  out.flash = await page.evaluate(() => { window.__flashObs.disconnect(); return window.__flash.length; });
  log('expand →', await expandAll(page));
  await sleep(300);
  out.afterTurn3Groups = await groups(page);
  await ss(page, '2-midrun-ended-no-flash');
  // 回合 4：卡挂着时 kill -9 minisd
  await send(page, '第四回合：等权限时引擎被杀');
  await until(page, (s) => s.perms === 1 && s.running, 20_000, '回合 4 权限卡');
  await sleep(500);
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
  log('open S1 →', await clickRow(page, '悬空工具实拍'));
  await sleep(1200);
  out.reopenState = await chatState(page);
  out.collapsed = await groups(page);
  // 收起状态：滚到底，回合 3（成功）与回合 4（中断）的组头同屏——不点开也看得到「1 步已中断」
  await page.evaluate(() => { const s = document.querySelector('.stage .scroll'); if (s) s.scrollTop = s.scrollHeight; });
  await sleep(400);
  await ss(page, '3-reopen-collapsed');
  log('expand →', await expandAll(page));
  await sleep(400);
  out.expanded = await groups(page);
  // 把最后一个回合滚进视口
  await page.evaluate(() => { const s = document.querySelector('.stage .scroll'); if (s) s.scrollTop = s.scrollHeight; });
  await sleep(400);
  await ss(page, '4-reopen-interrupted');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await sleep(400);
  await ss(page, '5-reopen-interrupted-dark');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  out.secondErrors = second.errors;
} finally {
  await Promise.race([second.app.close().catch(() => {}), sleep(8000)]);
  try { second.app.process().kill('SIGKILL'); } catch { /* 已退出 */ }
  srv.close();
}

// ---------- 判定 ----------
const flat = (gs) => gs.flatMap((g) => g.steps);
const g3 = out.midRunGroups ?? [];
out.checks.midRunTurn3NoInterruptedLabel = g3.length >= 3 && !flat(g3).some((s) => s.note) && !g3.some((g) => /已中断/.test(g.head));
out.checks.midRunPlaceholder = /仍在运行/.test(out.midRunLive ?? '');
out.checks.noFlashAtEnd = out.flash === 0;
out.checks.afterTurn3AllResolved = (out.afterTurn3Groups ?? []).length === 3 && !flat(out.afterTurn3Groups).some((s) => s.note);
const ex = out.expanded ?? [];
out.checks.reopenFourGroups = ex.length === 4;
out.checks.turn2Failed = /1 步失败/.test(ex[1]?.head ?? '') && /\bbad\b/.test(ex[1]?.steps?.[0]?.dot ?? '');
out.checks.turn4Interrupted = /1 步已中断/.test(ex[3]?.head ?? '') && ex[3]?.steps?.[0]?.note === '已中断 · 结果未知' && /\bintr\b/.test(ex[3]?.steps?.[0]?.dot ?? '');
out.checks.turn1And3Ok = [ex[0], ex[2]].every((g) => g && !/失败|已中断/.test(g.head) && g.steps.every((s) => !s.note && !/bad|intr/.test(s.dot)));
out.checks.noPageErrors = [...(out.firstErrors ?? []), ...(out.secondErrors ?? [])].filter((e) => /pageerror/.test(e)).length === 0;
const file = path.join(S, 'hemo-logs', `W2b-11a-dangling-${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2));
log('result →', file);
log(JSON.stringify(out.checks));
process.exit(Object.values(out.checks).every(Boolean) ? 0 : 1);
