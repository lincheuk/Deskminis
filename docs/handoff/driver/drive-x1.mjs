// X 波：首发竞态排查——「紧跟启动的首条 Enter 偶发被吞」（L6 候选池条目）的复现与拆解。
//
// 四个场景，每个都是**冷启动 + 全新数据根**（首发只有第一次才是首发）：
//   startup  紧跟启动直发：textarea 一出现就（延迟 0 / 150 / 600ms）真键盘输入 + Enter，
//            记录 Enter→running=true / Enter→用户消息落库 的毫秒数，看消息到底丢不丢。
//   l6       L6 判定法回放：照抄 drive-l6.mjs 的 sendMsg（waitIdle 400ms 宽限 + 1200ms + 落库校验）
//            与它的种子（一台永远连不上的 MCP、startupTimeoutSeconds 2），看那套判定会不会误报。
//   double   双击 Enter：首条消息 Enter 连按两次（真按键各一次 + 同步派发两次两种），
//            数会话数 / 用户消息数 / lastError / running。
//   noprov   无模型首发：不种 FakeProvider，全新用户第一次按 Enter，看界面有没有交代。
//
// 用法：xvfb-run -a node drive-x1.mjs <startup|l6|double|noprov|all> [runs]
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = '/home/user/Deskminis/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const SHOTS = path.join(S, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const scenario = process.argv[2] ?? 'all';
const RUNS = Number(process.argv[3] ?? 1);
const log = (...a) => console.log('[x1]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshData(name, { fake = true, mcpSeed = false } = {}) {
  const DATA = path.join(S, `x1-data-${name}-${Date.now()}`);
  fs.mkdirSync(DATA, { recursive: true });
  if (fake) fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
  if (mcpSeed) {
    // drive-l6.mjs 的种子原样：一台永远不应答的 MCP，启动超时 2s
    fs.mkdirSync(path.join(DATA, 'mcp-servers'), { recursive: true });
    fs.writeFileSync(path.join(DATA, 'mcp-servers', 'servers.json'), JSON.stringify({
      mcpServers: { 'demo-tools': { command: 'node', args: ['-e', 'setTimeout(()=>{},1e9)'], startupTimeoutSeconds: 2 } },
    }));
  }
  return DATA;
}

async function launch(DATA, { fake = true } = {}) {
  const env = { ...process.env, DESKMINIS_DATA_DIR: DATA, DESKMINIS_FAKE_REPLY: '收到，首条消息已处理。' };
  if (fake) env.DESKMINIS_FAKE_PROVIDER = '1'; else delete env.DESKMINIS_FAKE_PROVIDER;
  const app = await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
    args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45_000, env,
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
  return { app, page, errors };
}

/** 页内探针：2ms 轮询 pinia，记 running 首次为 true / 用户消息首次落库（非 local- id）的时刻。 */
const installProbe = (page) => page.evaluate(() => {
  const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
  const c = pinia.state.value.chat;
  const p = { t0: performance.now(), running: null, persisted: null, optimistic: null };
  window.__x1 = p;
  window.__x1timer = setInterval(() => {
    const now = performance.now() - p.t0;
    if (p.running === null && c.running) p.running = Math.round(now);
    if (p.optimistic === null && c.messages.some(m => m.role === 'user' && String(m.id).startsWith('local-'))) p.optimistic = Math.round(now);
    if (p.persisted === null && c.messages.some(m => m.role === 'user' && !String(m.id).startsWith('local-'))) p.persisted = Math.round(now);
  }, 2);
});
const readProbe = (page) => page.evaluate(() => window.__x1);
const snapshot = (page) => page.evaluate(() => {
  const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
  const c = pinia.state.value.chat;
  return {
    sessions: c.sessions.length,
    activeId: c.activeId ? c.activeId.slice(0, 8) : '',
    userMsgs: c.messages.filter(m => m.role === 'user').length,
    localMsgs: c.messages.filter(m => String(m.id).startsWith('local-')).length,
    assistantMsgs: c.messages.filter(m => m.role === 'assistant').length,
    running: c.running,
    lastError: c.lastError,
    welcome: !!document.querySelector('.wrap.hero'),
    errShown: [...document.querySelectorAll('.err, .cerr')].map(e => e.textContent.trim()).filter(Boolean),
    draft: document.querySelector('textarea.field')?.value ?? null,
  };
});
/** 等回合结束：running 曾为 true 再回 false，或超时。 */
async function waitTurn(page, maxMs = 20_000) {
  let sawRunning = false;
  for (let t = 0; t < maxMs; t += 50) {
    const r = await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat.running);
    if (r) sawRunning = true;
    else if (sawRunning) return true;
    await sleep(50);
  }
  return sawRunning;
}
/** 后端真相：直接数数据根里 sessions 目录（每会话一个桶），不信任前端列表。 */
function countSessionDirs(DATA) {
  const d = path.join(DATA, 'sessions');
  try { return fs.readdirSync(d).length; } catch { return 0; }
}

// ---------------------------------------------------------------- startup
async function runStartup(delayMs, idx) {
  const DATA = freshData(`startup-${delayMs}-${idx}`);
  const { app, page, errors } = await launch(DATA);
  try {
    await page.waitForSelector('textarea.field', { timeout: 20_000 });
    const tAppear = Date.now();
    if (delayMs) await sleep(delayMs);
    await page.click('textarea.field');
    await page.keyboard.type('首发第一句：读一下工作区目录', { delay: 0 });
    await installProbe(page);
    await page.keyboard.press('Enter');
    const ended = await waitTurn(page, 20_000);
    await sleep(600);
    const probe = await readProbe(page);
    const snap = await snapshot(page);
    const row = { scenario: 'startup', delayMs, idx, sinceAppearMs: Date.now() - tAppear, ended, probe, snap, sessionDirs: countSessionDirs(DATA), errors };
    log(JSON.stringify(row));
    if (idx === 0 && delayMs === 0) await page.screenshot({ path: path.join(SHOTS, 'x1-startup-0ms.png') });
    return row;
  } finally { await app.close().catch(() => {}); }
}

// ---------------------------------------------------------------- l6 判定法回放
async function runL6(idx, { mcpSeed }) {
  const DATA = freshData(`l6-${mcpSeed ? 'mcp' : 'nomcp'}-${idx}`, { mcpSeed });
  const { app, page, errors } = await launch(DATA);
  try {
    await page.waitForSelector('body', { timeout: 15_000 });
    await sleep(4000); // drive-l6.mjs 原样：固定等 4s
    // ---- 以下三段照抄 drive-l6.mjs（选择器改成新树的 .go.stop / textarea.field）----
    const typeInComposer = async (text) => {
      await page.evaluate((text) => {
        const ta = document.querySelector('textarea.field');
        ta.focus(); ta.value = text; ta.setSelectionRange(text.length, text.length);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, text);
      await sleep(150);
    };
    const waitIdle = async (maxMs = 30_000) => {
      for (let t = 0; t < maxMs; t += 400) {
        const running = await page.evaluate(() => !!document.querySelector('.go.stop'));
        if (!running) { await sleep(400); return t; }
        await sleep(400);
      }
      return -1;
    };
    const text = '__tool__ file_write {"path":"notes.md","content":"# 纪要\\n","tool_title":"写纪要"}';
    const attempts = [];
    let verdict = 'FAILED';
    for (let attempt = 0; attempt < 3; attempt++) {
      await typeInComposer(text);
      await installProbe(page);
      await page.keyboard.press('Enter');
      const idleAt = await waitIdle(40_000);
      await sleep(1200);
      const st = await page.evaluate((needle) => {
        const c = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat;
        return {
          ok: c.messages.some(m => m.role === 'user' && !String(m.id).startsWith('local-') && JSON.stringify(m.parts ?? []).includes(needle)),
          err: c.lastError, running: c.running,
        };
      }, text.slice(0, 12));
      const probe = await readProbe(page);
      attempts.push({ attempt, idleAt, l6Ok: st.ok, lastError: st.err, runningAtCheck: st.running, probe });
      if (st.ok) { verdict = attempt === 0 ? 'OK_FIRST' : 'OK_AFTER_RETRY'; break; }
    }
    // 真相：再等回合彻底结束后看，首条到底有没有落库
    await waitTurn(page, 30_000); await sleep(800);
    const snap = await snapshot(page);
    const row = { scenario: 'l6', mcpSeed, idx, verdict, attempts, truth: snap, sessionDirs: countSessionDirs(DATA), errors };
    log(JSON.stringify(row));
    return row;
  } finally { await app.close().catch(() => {}); }
}

// ---------------------------------------------------------------- double Enter
async function runDouble(mode, idx) {
  const DATA = freshData(`double-${mode}-${idx}`);
  const { app, page, errors } = await launch(DATA);
  try {
    await page.waitForSelector('textarea.field', { timeout: 20_000 });
    await sleep(1500); // 让 init 走完——这里考的不是启动，是首条消息建会话期间的重入
    await page.click('textarea.field');
    await page.keyboard.type('双击 Enter 的首条消息', { delay: 0 });
    await installProbe(page);
    if (mode === 'real') {
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
    } else {
      // 同步派发两次：两次 send() 都在第一个 await 落定前启动——确定性复现
      await page.evaluate(() => {
        const ta = document.querySelector('textarea.field');
        for (let i = 0; i < 2; i++) ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      });
    }
    // 观察窗口：期间记录 lastError / running 的最坏值
    let sawError = ''; let sawRunningFalseWhileInflight = false;
    for (let t = 0; t < 12_000; t += 40) {
      const s = await snapshot(page);
      if (s.lastError && !sawError) sawError = s.lastError;
      await sleep(40);
      if (t > 1500 && !s.running && s.userMsgs > 0 && s.localMsgs === 0) break;
    }
    await sleep(800);
    const snap = await snapshot(page);
    const probe = await readProbe(page);
    const row = { scenario: 'double', mode, idx, sawError, snap, probe, sessionDirs: countSessionDirs(DATA), errors };
    log(JSON.stringify(row));
    await page.screenshot({ path: path.join(SHOTS, `x1-double-${mode}-${idx}.png`) });
    return row;
  } finally { await app.close().catch(() => {}); }
}

// ---------------------------------------------------------------- no provider
async function runNoProv(idx) {
  const DATA = freshData(`noprov-${idx}`, { fake: false });
  const { app, page, errors } = await launch(DATA, { fake: false });
  try {
    await page.waitForSelector('textarea.field', { timeout: 20_000 });
    await sleep(1500);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.click('textarea.field');
    await page.keyboard.type('全新用户的第一句话：帮我看看这个项目', { delay: 0 });
    await installProbe(page);
    await page.keyboard.press('Enter');
    await sleep(2500);
    const snap = await snapshot(page);
    const probe = await readProbe(page);
    const row = { scenario: 'noprov', idx, snap, probe, sessionDirs: countSessionDirs(DATA), errors };
    log(JSON.stringify(row));
    await page.screenshot({ path: path.join(SHOTS, `x1-noprov-${idx}.png`) });
    return row;
  } finally { await app.close().catch(() => {}); }
}

const rows = [];
if (scenario === 'startup' || scenario === 'all') {
  for (const d of [0, 150, 600]) for (let i = 0; i < RUNS; i++) rows.push(await runStartup(d, i));
}
if (scenario === 'l6' || scenario === 'all') {
  for (let i = 0; i < RUNS; i++) rows.push(await runL6(i, { mcpSeed: true }));
  for (let i = 0; i < RUNS; i++) rows.push(await runL6(i, { mcpSeed: false }));
}
if (scenario === 'double' || scenario === 'all') {
  for (let i = 0; i < RUNS; i++) rows.push(await runDouble('real', i));
  for (let i = 0; i < RUNS; i++) rows.push(await runDouble('sync', i));
}
if (scenario === 'noprov' || scenario === 'all') {
  for (let i = 0; i < RUNS; i++) rows.push(await runNoProv(i));
}
fs.writeFileSync(path.join(S, `x1-${scenario}-${Date.now()}.json`), JSON.stringify(rows, null, 2));
log('done', rows.length, 'rows');
