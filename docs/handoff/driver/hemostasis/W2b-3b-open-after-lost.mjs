// W2b-3b 实拍：断线之后点左栏别的会话，当前视图原样不动（标题、对话流、半截正文都还是 A 的）。
// 用法：NODE_PATH=<scratchpad>/driver/node_modules xvfb-run -a node W2b-3b-open-after-lost.mjs
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright-core');
const APP = '/home/user/wt-f1/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const SHOTS = join(S, 'hemo-shots');
const ELECTRON = join(APP, 'node_modules/electron/dist/electron');
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
function procTable() {
  const t = new Map();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      t.set(+d, { ppid: +rest[1], cmd: readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' ') });
    } catch { /* 已退 */ }
  }
  return t;
}
function treeOf(rootPid) {
  const t = procTable(); const out = [];
  const walk = (pid) => { const p = t.get(pid); if (!p) return; out.push({ pid, cmd: p.cmd }); for (const [c, q] of t) if (q.ppid === pid) walk(c); };
  walk(rootPid); return out;
}
const st = (page) => page.evaluate(() => {
  const c = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat;
  return { connection: c.connection, activeId: c.activeId, messages: c.messages.map((m) => m.parts.map((p) => p.value?.toString?.() ?? '').join('')).join(' | '), streamingText: c.streamingText };
});
const store = (page, fn, ...args) => page.evaluate(([fn, args]) => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat')[fn](...args), [fn, args]);

const root = mkdtempSync(join(S, 'W2b-3b-data-'));
writeFileSync(join(root, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
const env = { ...process.env, DESKMINIS_DATA_DIR: root, DESKMINIS_FAKE_PROVIDER: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: ELECTRON, args: ['--no-sandbox', '.'], cwd: APP, timeout: 45_000, env });
const mainPid = app.process().pid;
const pageErrors = [];
let page = null;
for (let i = 0; i < 60 && !page; i++) { page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(250); }
page.on('pageerror', (e) => pageErrors.push('pageerror: ' + String(e?.message ?? e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console.error: ' + m.text()); });
await page.waitForSelector('textarea.field', { timeout: 30_000 });
await sleep(1200);
await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

// 造两个会话：A 先发一句，再新建 B 发一句；最后停在 A
async function say(text) {
  await page.evaluate((text) => { const ta = document.querySelector('textarea.field'); ta.focus(); ta.value = text; ta.dispatchEvent(new Event('input', { bubbles: true })); }, text);
  await sleep(150); await page.keyboard.press('Enter');
  for (let i = 0; i < 60; i++) { await sleep(200); const r = await page.evaluate(() => !document.querySelector('.go.stop')); if (r) break; }
  await sleep(500);
}
await say('这是会话 A 的第一句');
const A = (await st(page)).activeId;
await store(page, 'newSession');
await sleep(500);
await say('这是会话 B 的第一句');
const B = (await st(page)).activeId;
await store(page, 'open', A);
await sleep(800);
const s0 = await st(page);
check('两个会话都建好，停在 A', A && B && A !== B && s0.activeId === A && s0.messages.includes('会话 A'), JSON.stringify({ A, B, active: s0.activeId }));
await page.evaluate(() => { document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat').streamingText = '答了一半、想复制下来的正文'; });
await sleep(200);

// 杀掉 minisd → 横幅
const minisd = treeOf(mainPid).find((p) => p.cmd.includes('utility-sub-type=node.mojom.NodeService'));
process.kill(minisd.pid, 'SIGKILL');
for (let i = 0; i < 40; i++) { await sleep(100); if (await page.$('.lost')) break; }
check('断线横幅出现', !!(await page.$('.lost')));
await page.screenshot({ path: join(SHOTS, 'W2b-3b-1-lost-on-A.png') });

// 真鼠标点左栏 B 那一行：两行标题都被自动命名成同一句，按 NavRail 渲染顺序与 store 里分组后的会话 id 对上
const rows = await page.$$('button.srow');
const order = await page.evaluate(() => {
  const vm = [...document.querySelectorAll('button.srow')].map((b) => b.closest('[data-sid]')?.getAttribute('data-sid') ?? null);
  const c = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat;
  return { dataSid: vm, sessions: c.sessions.map((s) => s.id) };
});
console.log('order', JSON.stringify(order));
// 没有 data-sid 时退回 store 的会话顺序（NavRail 按 sessions 顺序分组渲染，同一天分组内顺序不变）
const idx = order.dataSid.every(Boolean) ? order.dataSid.indexOf(B) : order.sessions.indexOf(B);
let clicked = false;
if (idx >= 0 && rows[idx]) { await rows[idx].click(); clicked = true; }
await sleep(1200);
const s1 = await st(page);
check('点了左栏 B 那一行', clicked, `rows=${rows.length} idx=${idx}`);
check('activeId 仍是 A，对话流仍是 A 的消息', s1.activeId === A && s1.messages.includes('会话 A') && !s1.messages.includes('会话 B'), JSON.stringify(s1));
check('半截正文还在（能复制）', s1.streamingText === '答了一半、想复制下来的正文');
const pageTitle = await page.evaluate(() => document.querySelector('.stage')?.innerText?.slice(0, 200) ?? '');
check('对话区里没有 B 的内容', !pageTitle.includes('会话 B 的第一句'), pageTitle.replace(/\s+/g, ' ').slice(0, 120));
await page.screenshot({ path: join(SHOTS, 'W2b-3b-2-click-B-after-lost.png') });
check('没有 pageerror', !pageErrors.some((e) => e.startsWith('pageerror')), pageErrors.join(' ; ').slice(0, 300));
await app.close().catch(() => {});
const fails = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} PASS`);
process.exit(fails ? 1 : 0);
