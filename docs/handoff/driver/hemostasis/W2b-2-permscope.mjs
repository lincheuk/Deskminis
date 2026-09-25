// W2b-2 实拍：权限卡按会话区分。
// FakeProvider（DESKMINIS_FAKE_PROVIDER=1）；权限卡用 web_fetch 触发（askOnce，放行前不出网；设计稿 §1 第 7 条，
// 不用 POSIX 绝对路径的 file_write），抓的是剧本内起的本地 HTTP 服务。数据根 mkdtemp，经 DESKMINIS_DATA_DIR 注入。
// 一次冷启动顺序走：
//   1 会话 A 发一条普通消息（有历史，切回来是会话页而不是欢迎页）
//   2 新建会话 B，发 __tool__ web_fetch → 卡出现在 B 自己的对话流里
//   3 NavRail 点 A：A 不显示那张卡；顶部「另有 1 个会话在等你批准」；B 行有盾牌标；任务 tab 没有警示点、任务面板没有「等你批准」
//   4 同一画面暗色
//   5 A 打开产出物预览（NavRail 收成图标条、看不到行上的盾牌标）：窄列顶部照样有提示行
//   6 新建会话 C 也卡在权限上，回到 A：「另有 2 个会话在等你批准」，B、C 两行都有盾牌标
//   7 点顶部提示 → 切到最早在等的 B：卡出现、任务 tab 有点、任务面板「1 个请求等在对话里」；顶部提示只剩 C
//   8 在 B 点「允许」：卡消失、回合跑完（本地服务被请求）、B 行盾牌标消失
//   9 点提示切到 C、允许：全部清空，没有提示、没有盾牌标
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createServer } from 'node:http';
// ESM 的 import 不认 NODE_PATH，CJS 的 require 认：playwright-core 不入库，经 NODE_PATH 指向 scratchpad/driver/node_modules
const { _electron: electron } = createRequire(import.meta.url)('playwright-core');

const APP_DIR = '/home/user/wt-f1/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const SHOTS = path.join(S, 'hemo-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log('[w2b2]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
const errors = [];

// ---------- 本地抓取目标：记请求次数，批准之前一次都不该被请求 ----------
let hits = 0;
const target = createServer((req, res) => {
  hits++;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<html><head><title>示例页</title></head><body><p>抓到了。</p></body></html>');
});
await new Promise((r) => target.listen(0, '127.0.0.1', r));
const URL_OF = (p) => `http://127.0.0.1:${target.address().port}/${p}`;

const DATA = fs.mkdtempSync(path.join(S, 'W2b-2-data-'));
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45_000,
  env: { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA },
});
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(250); }
  if (!page) page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e?.message ?? e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.waitForSelector('textarea.field', { timeout: 20_000 });
  await sleep(1500);
  const theme = (t) => page.evaluate((t) => { document.documentElement.dataset.theme = t; }, t);
  await theme('light');

  const ss = async (name) => { await page.screenshot({ path: path.join(SHOTS, `W2b-2-${name}.png`) }); log('shot:', name); };
  const store = (fn, ...args) => page.evaluate(([fn, args]) => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat')[fn](...args), [fn, args]);
  const setState = (k, v) => page.evaluate(([k, v]) => { document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat')[k] = v; }, [k, v]);
  const st = () => page.evaluate(() => {
    const c = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat;
    const title = (id) => c.sessions.find((s) => s.id === id)?.title ?? id;
    const tasksTab = [...document.querySelectorAll('.tabs button')].find((b) => b.textContent.trim().startsWith('任务'));
    const waitBlk = [...document.querySelectorAll('.tp .blk')].find((b) => b.querySelector('.bh')?.textContent.trim() === '等你批准');
    return {
      active: title(c.activeId), running: c.running,
      pendingPerms: c.pendingPerms.map((p) => `${title(p.sessionId)}:${p.kind}`),
      notes: c.eventNotes.map((n) => `${n.kind}:${n.detail ?? ''}`),
      lastError: c.lastError,
      cards: [...document.querySelectorAll('.perm')].map((e) => e.querySelector('.v')?.textContent?.trim() ?? ''),
      hint: document.querySelector('.waitbar')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
      hintAboveScroll: (() => {
        const h = document.querySelector('.waitbar'); const s = document.querySelector('.scroll');
        return h && s ? h.getBoundingClientRect().bottom <= s.getBoundingClientRect().top + 0.5 : null;
      })(),
      shields: [...document.querySelectorAll('.srw')].filter((r) => r.querySelector('.swait')).map((r) => r.querySelector('.stitle')?.textContent.trim()),
      shieldTitle: document.querySelector('.swait')?.getAttribute('title') ?? null,
      railCompact: !!document.querySelector('.rail.compact'),
      tasksDot: !!tasksTab?.querySelector('.dot'),
      tasksWaiting: waitBlk ? waitBlk.textContent.replace(/\s+/g, ' ').trim() : null,
      hits: 0,
    };
  });
  const snap = async (k) => { const s = await st(); s.hits = hits; out[k] = s; log(k, JSON.stringify(s)); return s; };
  const clickRow = (title) => page.evaluate((title) => {
    const el = [...document.querySelectorAll('.srow')].find((b) => b.querySelector('.stitle')?.textContent?.trim() === title);
    if (!el) return 'NOT_FOUND:' + title;
    el.click(); return 'OK';
  }, title);
  async function waitRunning(want, maxMs = 20_000) {
    for (let t = 0; t < maxMs; t += 50) { if ((await st()).running === want) return true; await sleep(50); }
    return false;
  }
  async function waitTurn(maxMs = 20_000) {
    let saw = false;
    for (let t = 0; t < maxMs; t += 50) {
      const r = (await st()).running;
      if (r) saw = true; else if (saw) return true;
      await sleep(50);
    }
    return saw;
  }
  async function waitCard(maxMs = 15_000) {
    for (let t = 0; t < maxMs; t += 150) { if (await page.evaluate(() => !!document.querySelector('.perm'))) return true; await sleep(150); }
    return false;
  }
  async function send(text) {
    await page.evaluate((text) => {
      const ta = document.querySelector('textarea.field');
      ta.focus(); ta.value = text; ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await sleep(200);
    await page.keyboard.press('Enter');
  }
  const activeId = () => page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat.activeId);
  const newChat = () => page.evaluate(() => { const b = document.querySelector('.newbtn'); if (!b) return 'NO_BTN'; b.click(); return 'OK'; });
  const clickHint = () => page.evaluate(() => { const b = document.querySelector('.waitbar'); if (!b) return 'NO_HINT'; b.click(); return 'OK'; });
  const allow = () => page.evaluate(() => {
    const b = [...document.querySelectorAll('.perm .pb')].find((e) => e.textContent.trim() === '允许');
    if (!b) return 'NO_ALLOW'; b.click(); return 'OK';
  });
  const fetchCmd = (p, title) => '__tool__ web_fetch ' + JSON.stringify({ url: URL_OF(p), tool_title: title });

  // 右栏切到「任务」tab：警示点与「等你批准」一节都要看得见
  log('tasks tab →', await page.evaluate(() => { const b = [...document.querySelectorAll('.tabs button')].find((e) => e.textContent.trim().startsWith('任务')); if (!b) return 'NO_TAB'; b.click(); return 'OK'; }));

  // ---------- 1 会话 A：一条普通消息 ----------
  await send('你好，这是会话 A');
  out.aTurn = await waitTurn();
  await sleep(600);
  const A = await activeId();
  await store('renameSession', A, '会话 A');
  await sleep(300);

  // ---------- 2 新建会话 B，卡在权限上 ----------
  log('new B →', await newChat());
  await sleep(700);
  await send(fetchCmd('b', '抓取 B 的示例页'));
  out.bCard = await waitCard();
  const B = await activeId();
  await store('renameSession', B, '会话 B（等批准）');
  await sleep(700);
  await snap('s2_B_ownCard');
  await ss('1-B-own-card');

  // ---------- 3 切到 A ----------
  log('click A →', await clickRow('会话 A'));
  await sleep(900);
  await snap('s3_A_hint');
  await ss('2-A-hint-shield');

  // ---------- 4 暗色 ----------
  await theme('dark'); await sleep(300);
  await ss('3-A-hint-dark');
  await theme('light'); await sleep(200);

  // ---------- 5 A 打开产出物预览：NavRail 收成图标条，顶部提示照样在 ----------
  const wsRoot = await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat.workspaceRoot);
  fs.mkdirSync(wsRoot, { recursive: true });
  fs.writeFileSync(path.join(wsRoot, '说明.md'), '# 说明\n\n这是会话 A 的一份产出物，用来打开预览、让左栏收成图标条。\n');
  await setState('pendingFilePreview', '说明.md');
  await sleep(1200);
  await snap('s5_A_narrow');
  await ss('4-A-narrow-hint');
  log('close preview →', await page.evaluate(() => { const b = document.querySelector('.pv .x, .pvbar .x, [title="关闭预览"], [aria-label="关闭预览"]'); if (!b) return 'NO_CLOSE'; b.click(); return 'OK'; }));
  await sleep(600);
  if (await page.evaluate(() => !!document.querySelector('.rail.compact'))) {
    // 找不到关闭钮就经标签栏关：AppShell 的 closeDoc 由 TabBar 的 × 触发
    log('close via tab →', await page.evaluate(() => { const x = document.querySelector('.tabbar .x, .tabs-doc .x, .tb .x'); if (!x) return 'NO_TAB_X'; x.click(); return 'OK'; }));
    await sleep(600);
  }
  out.s5_railBack = !(await page.evaluate(() => !!document.querySelector('.rail.compact')));

  // ---------- 6 新建会话 C 也卡在权限上，回到 A ----------
  log('new C →', await newChat());
  await sleep(700);
  await send(fetchCmd('c', '抓取 C 的示例页'));
  out.cCard = await waitCard();
  const C = await activeId();
  await store('renameSession', C, '会话 C（等批准）');
  await sleep(700);
  await snap('s6_C_ownCard');
  log('click A →', await clickRow('会话 A'));
  await sleep(900);
  await snap('s6_A_two');
  await ss('5-A-two-waiting');

  // ---------- 7 点顶部提示：切到最早在等的 B ----------
  log('hint →', await clickHint());
  await sleep(1000);
  await snap('s7_B_viaHint');
  await ss('6-B-via-hint');

  // ---------- 8 B 里批准 ----------
  const hitsBefore = hits;
  log('allow B →', await allow());
  out.s8_turnEnded = await waitRunning(false, 20_000);
  await sleep(1000);
  await snap('s8_B_approved');
  out.s8_hitsDelta = hits - hitsBefore;
  await ss('7-B-approved');

  // ---------- 9 点提示切到 C 并批准 ----------
  log('hint →', await clickHint());
  await sleep(1000);
  await snap('s9_C_viaHint');
  log('allow C →', await allow());
  out.s9_turnEnded = await waitRunning(false, 20_000);
  await sleep(1000);
  await snap('s9_C_approved');
  await ss('8-C-approved-all-clear');
  out.ids = { A, B, C };
} catch (e) {
  errors.push('driver: ' + String(e?.stack ?? e));
} finally {
  out.errors = errors;
  out.totalHits = hits;
  console.log(JSON.stringify(out, null, 2));
  await app.close().catch(() => {});
  target.closeAllConnections(); target.close();
}
