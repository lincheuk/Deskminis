// W2b-3 实拍（renderer.md xvfb 节「断线横幅」「点重启应用」；cross.md S20：权限卡改用 web_fetch 触发）。
//
// 第一段：FakeProvider 让回合挂在 web_fetch 的权限卡上（askOnce，放行前不出网），此时停止键可见；
//        另开一个窗口经同一个 preload 请求重启，主进程必须拒绝（只认主窗口）；
//        然后按 pgrep 的办法（进程树里 utility-sub-type=node.mojom.NodeService）SIGKILL 掉 minisd。
//        2 秒内应看到：40px 标题栏下方独立一行横幅「与后台服务的连接已断开…」「重启应用」；输入卡回到发送键且置灰
//        （框里有字也灰）；权限卡消失。按 Enter 硬发：不落库，给一句「与后台服务的连接已断开」，字留在框里。
//        明暗各一张；窄窗（900px）下横幅不溢出、不被右上系统按钮区遮住。
// 第二段：真鼠标点「重启应用」：主进程里记下 app.relaunch 被调（探针包一层原函数，照样调用）、before-quit / will-quit；
//        旧进程退出，新实例起来（/proc 里认同一个数据根的新主进程），数据根锁被新 minisd 接管（旧锁是被杀留下的陈旧锁）；
//        经新实例的 DevToolsActivePort 连 CDP，确认握手成功（输入卡在、连接 ok、没有横幅）并截图；最后收掉新实例。
//
// 用法：NODE_PATH=<scratchpad>/driver/node_modules xvfb-run -a node W2b-3-disconnect.mjs
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { _electron: electron, chromium } = require('playwright-core');

const APP = '/home/user/wt-f1/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const SHOTS = join(S, 'hemo-shots');
const X11 = join(S, 'hemo-drivers/W1a-8-x11.py');
const ELECTRON = join(APP, 'node_modules/electron/dist/electron');
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
const log = (...a) => console.log('[W2b-3]', ...a);
const x11 = (...args) => JSON.parse(execFileSync('python3', [X11, ...args], { encoding: 'utf8' }));

/** /proc 里全部进程的 pid → { ppid, cmd, env }。 */
function procTable() {
  const t = new Map();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' ');
      let env = ''; try { env = readFileSync(`/proc/${d}/environ`, 'utf8'); } catch { /* */ }
      t.set(+d, { ppid: +rest[1], state: rest[0], cmd, env });
    } catch { /* 进程已退 */ }
  }
  return t;
}
function treeOf(rootPid) {
  const t = procTable();
  const out = [];
  const walk = (pid) => { const p = t.get(pid); if (!p) return; out.push({ pid, cmd: p.cmd }); for (const [c, q] of t) if (q.ppid === pid) walk(c); };
  walk(rootPid);
  return out;
}
const alive = (pid) => { try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return !/\) [ZX] /.test(s); } catch { return false; } };
/** 用同一个数据根起来的 Electron 主进程（不带 --type= 的就是主进程）。 */
function mainProcsFor(root) {
  const out = [];
  for (const [pid, p] of procTable()) {
    if (p.state === 'Z') continue;
    if (!p.cmd.startsWith(ELECTRON) || p.cmd.includes('--type=')) continue;
    if (!p.env.split('\0').includes(`DESKMINIS_DATA_DIR=${root}`)) continue;
    out.push(pid);
  }
  return out;
}

function env(root) {
  const e = { ...process.env, DESKMINIS_DATA_DIR: root, DESKMINIS_FAKE_PROVIDER: '1' };
  delete e.ELECTRON_RUN_AS_NODE;
  return e;
}
const store = (page, fn, ...args) => page.evaluate(([fn, args]) => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat')[fn](...args), [fn, args]);
const st = (page) => page.evaluate(() => {
  const c = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat;
  return { connection: c.connection, running: c.running, runningSessions: [...c.runningSessions], pendingPerms: c.pendingPerms.length, lastError: c.lastError, activeId: c.activeId, messages: c.messages.length, toolCards: c.toolCards.length };
});
/** 横幅与周边几何：标题栏底边、横幅上下边与宽度、按钮是否整个在视口里、有没有横向溢出。 */
const geom = (page) => page.evaluate(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right), bottom: Math.round(b.bottom) }; };
  const lost = document.querySelector('.lost');
  const btn = lost?.querySelector('button');
  const cs = lost ? getComputedStyle(lost) : null;
  return {
    vw: window.innerWidth, vh: window.innerHeight,
    header: r(document.querySelector('header.bar')), lost: r(lost), btn: r(btn), msg: r(lost?.querySelector('.lmsg')),
    text: lost?.textContent?.replace(/\s+/g, ' ').trim() ?? null, role: lost?.getAttribute('role') ?? null,
    btnText: btn?.textContent?.trim() ?? null,
    msgText: lost?.querySelector('.lmsg')?.textContent?.trim() ?? null,
    icon: !!lost?.querySelector('svg'),
    overflowX: lost ? lost.scrollWidth > lost.clientWidth : null,
    bg: cs?.backgroundColor ?? null, color: cs?.color ?? null, zIndex: cs?.zIndex ?? null, position: cs?.position ?? null,
    appRegion: cs ? (cs.webkitAppRegion ?? cs.getPropertyValue('-webkit-app-region')) : null,
    stage: r(document.querySelector('.stage')),
    perm: document.querySelectorAll('.perm').length,
    stop: !!document.querySelector('.go.stop'),
    send: (() => { const b = document.querySelector('button.go:not(.stop)'); return b ? { disabled: b.disabled } : null; })(),
    hit: (() => { if (!btn) return null; const b = btn.getBoundingClientRect(); const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return el === btn || btn.contains(el); })(),
  };
});
async function typeInto(page, text) {
  await page.evaluate((text) => {
    const ta = document.querySelector('textarea.field');
    ta.focus(); ta.value = text;
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(150);
}

const root = mkdtempSync(join(S, 'W2b-3-data-'));
writeFileSync(join(root, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
log('data root', root);

const app = await electron.launch({ executablePath: ELECTRON, args: ['--no-sandbox', '.'], cwd: APP, timeout: 45_000, env: env(root) });
const mainPid = app.process().pid;
let stderr = '';
app.process().stderr?.on('data', (d) => { stderr += d; });
const pageErrors = [];
let page = null;
for (let i = 0; i < 60 && !page; i++) { page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(250); }
if (!page) page = await app.firstWindow();
page.on('pageerror', (e) => pageErrors.push('pageerror: ' + String(e?.message ?? e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console.error: ' + m.text()); });
await page.waitForSelector('textarea.field', { timeout: 30_000 });
await sleep(1500);
await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

// ---------- 第一段：回合挂在权限卡上 ----------
check('启动后连接正常、没有横幅', (await st(page)).connection === 'ok' && !(await page.$('.lost')));
await typeInto(page, '__tool__ web_fetch ' + JSON.stringify({ url: 'http://127.0.0.1:9/w2b3', tool_title: '抓取示例页' }));
await page.keyboard.press('Enter');
let seen = false;
for (let i = 0; i < 50 && !seen; i++) { await sleep(300); seen = await page.evaluate(() => !!document.querySelector('.perm') && !!document.querySelector('.go.stop')); }
check('权限卡出现、停止键可见（回合正卡在权限上）', seen);
await sleep(500);
await page.screenshot({ path: join(SHOTS, 'W2b-3-1-before-kill.png') });

// 主进程探针：包一层 app.relaunch（照样调原函数），记下 before-quit / will-quit；写文件——主进程退得快，来不及回头问
const PROBE = join(S, `W2b-3-probe-${Date.now()}.json`);
await app.evaluate(({ app: a }, file) => {
  const fs = process.getBuiltinModule('fs');
  const rec = { relaunch: [], beforeQuit: [], willQuit: null };
  const flush = () => { try { fs.writeFileSync(file, JSON.stringify(rec)); } catch { /* */ } };
  const orig = a.relaunch.bind(a);
  a.relaunch = (opts) => { rec.relaunch.push({ at: Date.now(), opts: opts ?? null }); flush(); return orig(opts); };
  a.on('before-quit', (e) => { rec.beforeQuit.push({ at: Date.now(), prevented: e.defaultPrevented }); flush(); });
  a.on('will-quit', () => { rec.willQuit = Date.now(); flush(); });
  flush();
}, PROBE);

// 别的窗口（同一个 preload）来请求重启：主进程只认主窗口，必须拒绝、且不登记 relaunch
const foreign = await app.evaluate(async ({ app: a, BrowserWindow }) => {
  const path = process.getBuiltinModule('path');
  const w = new BrowserWindow({ show: false, webPreferences: { preload: path.join(a.getAppPath(), 'out/preload/index.cjs') } });
  try {
    await w.loadURL('data:text/html,<p>foreign</p>');
    return await w.webContents.executeJavaScript('typeof window.deskminis?.relaunchApp === "function" ? window.deskminis.relaunchApp().then(() => "resolved", (e) => "rejected: " + e.message) : "no-bridge"');
  } finally { w.destroy(); }
});
const probe0 = JSON.parse(readFileSync(PROBE, 'utf8'));
check('别的窗口请求重启：被主进程拒绝（只接受主窗口的重启请求），没有登记 relaunch', /^rejected: .*只接受主窗口的重启请求/.test(foreign) && probe0.relaunch.length === 0, foreign);
check('被拒之后应用照常：连接仍 ok、权限卡还在', (await st(page)).connection === 'ok' && (await page.evaluate(() => !!document.querySelector('.perm'))));

// 杀掉 minisd（进程树里的 NodeService 工具进程）
const tree = treeOf(mainPid);
const minisd = tree.find((p) => p.cmd.includes('utility-sub-type=node.mojom.NodeService'));
check('找到 minisd 进程', !!minisd, `mainPid=${mainPid} minisd=${minisd?.pid}`);
const lockBefore = existsSync(join(root, 'minisd.lock')) ? readFileSync(join(root, 'minisd.lock'), 'utf8') : null;
log('lock before kill:', lockBefore);
const tKill = Date.now();
process.kill(minisd.pid, 'SIGKILL');
let bannerAt = null;
for (let i = 0; i < 40 && bannerAt === null; i++) { await sleep(50); if (await page.$('.lost')) bannerAt = Date.now(); }
check('2 秒内出现断线横幅', bannerAt !== null && bannerAt - tKill < 2000, `${bannerAt === null ? '没出现' : bannerAt - tKill + 'ms'}`);
await sleep(400);
const s1 = await st(page);
check('store：connection=lost、running=false、runningSessions 与 pendingPerms 清空、没写 lastError',
  s1.connection === 'lost' && !s1.running && s1.runningSessions.length === 0 && s1.pendingPerms === 0 && s1.lastError === '', JSON.stringify(s1));
const g1 = await geom(page);
check('横幅：alert 图标、文案、「重启应用」按钮、role=alert', g1.icon && g1.msgText === '与后台服务的连接已断开。进行中的任务可能已中止，新的操作不会执行。' && g1.btnText === '重启应用' && g1.role === 'alert', `${g1.msgText} | ${g1.btnText} | role=${g1.role} | icon=${g1.icon}`);
check('横幅在 40px 标题栏正下方独立一行（上边贴标题栏底边），整行宽、不定位、不设层级',
  g1.header?.bottom === 40 && g1.lost?.y === g1.header.bottom && g1.lost.x === 0 && g1.lost.w === g1.vw && g1.position === 'static' && g1.zIndex === 'auto',
  JSON.stringify({ header: g1.header, lost: g1.lost, position: g1.position, zIndex: g1.zIndex }));
check('舞台随之下移一行（不被横幅压住）', g1.stage?.y >= g1.lost?.bottom, JSON.stringify({ stage: g1.stage, lost: g1.lost }));
check('按钮点得到（命中测试落在按钮上）、不在拖拽区', g1.hit === true && g1.appRegion !== 'drag', `hit=${g1.hit} region=${g1.appRegion}`);
check('权限卡消失、停止键回到发送键', g1.perm === 0 && !g1.stop && !!g1.send, JSON.stringify({ perm: g1.perm, stop: g1.stop, send: g1.send }));
check('没有字时发送键置灰', g1.send?.disabled === true);
await typeInto(page, '断线之后还想接着问');
const g1b = await geom(page);
check('框里有字，发送键照样置灰（断线条件）', g1b.send?.disabled === true, JSON.stringify(g1b.send));
check('横幅色：错误浅底 + 错误色字', g1.bg === 'rgb(255, 236, 232)' && g1.color === 'rgb(203, 38, 52)', `${g1.bg} / ${g1.color}`);
await page.screenshot({ path: join(SHOTS, 'W2b-3-2-lost-light.png') });

// 按 Enter 硬发：canSend 管不到键盘，走到 chat.send → rpc 立即拒绝 → 交代一句，字交回框里，不落乐观消息
const msgsBefore = (await st(page)).messages;
await page.keyboard.press('Enter');
await sleep(600);
const s2 = await st(page);
const box = await page.evaluate(() => document.querySelector('textarea.field').value);
check('Enter 硬发：不落消息，给出「与后台服务的连接已断开」，字留在框里，不在跑', s2.messages === msgsBefore && s2.lastError.includes('与后台服务的连接已断开') && box === '断线之后还想接着问' && !s2.running,
  JSON.stringify({ msgs: [msgsBefore, s2.messages], lastError: s2.lastError, box, running: s2.running }));
// 断线已过 2 秒以上：sync.dirty 的回落定时器早该到点——同步点不能翻成绿的「已连接其它设备」
const dot = await page.evaluate(() => { const d = document.querySelector('header.bar .dot'); return d ? { title: d.getAttribute('title'), bg: getComputedStyle(d).backgroundColor } : null; });
check('断线 2 秒后同步点是「未连接其它设备」（不是绿点「已连接其它设备」）', dot?.title === '未连接其它设备', JSON.stringify({ dot, sinceKill: Date.now() - tKill }));
await page.screenshot({ path: join(SHOTS, 'W2b-3-3-enter-after-lost.png') });

await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
await sleep(400);
const gd = await geom(page);
check('暗色：横幅照样在、配色随主题', !!gd.lost && gd.bg === 'rgb(42, 26, 26)' && gd.color === 'rgb(247, 105, 101)', `${gd.bg} / ${gd.color}`);
await page.screenshot({ path: join(SHOTS, 'W2b-3-4-lost-dark.png') });

// 窄窗：900px（minWidth）。横幅不溢出，按钮整颗在视口里，也不跑到右上系统按钮区（那一区在 40px 标题栏里）
await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.isVisible()); w.setSize(900, 700); });
await sleep(700);
const gn = await geom(page);
check('窄窗 900px：横幅不横向溢出，按钮整颗在视口内、在标题栏之下、点得到',
  gn.vw <= 900 && gn.overflowX === false && gn.btn.right <= gn.vw && gn.btn.y >= 40 && gn.hit === true,
  JSON.stringify({ vw: gn.vw, lost: gn.lost, btn: gn.btn, msg: gn.msg, overflowX: gn.overflowX }));
await page.screenshot({ path: join(SHOTS, 'W2b-3-5-lost-narrow.png') });
await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.isVisible()); w.setSize(1280, 800); });
await sleep(500);

// ---------- 第二段：点「重启应用」 ----------
const devtoolsFile = join(root, 'electron', 'DevToolsActivePort');
const oldPort = existsSync(devtoolsFile) ? readFileSync(devtoolsFile, 'utf8').split('\n')[0] : null;
let exitAt = null;
app.process().on('exit', () => { exitAt = Date.now(); });
const tClick = Date.now();
await page.click('.lost button', { noWaitAfter: true, timeout: 5000 }).catch((e) => log('click error (进程在退出，可忽略):', String(e).slice(0, 120)));
for (let i = 0; i < 100 && exitAt === null; i++) await sleep(100);
check('点「重启应用」后旧进程退出', exitAt !== null, exitAt === null ? '10s 内没退' : `${exitAt - tClick}ms`);
const probe = JSON.parse(readFileSync(PROBE, 'utf8'));
check('主进程登记了 app.relaunch 恰好一次（开发态不带参数：同一个 exe、同一组参数）', probe.relaunch.length === 1 && probe.relaunch[0].opts === null, JSON.stringify(probe.relaunch));
check('relaunch 之后走 before-quit（minisd 已死，放行）→ will-quit', probe.beforeQuit.length >= 1 && probe.beforeQuit[0].at >= probe.relaunch[0]?.at && probe.beforeQuit.at(-1).prevented === false && probe.willQuit !== null,
  JSON.stringify({ beforeQuit: probe.beforeQuit, willQuit: probe.willQuit }));

// 新实例：同一个数据根上、不是旧 pid 的主进程
let newPid = null;
for (let i = 0; i < 150 && newPid === null; i++) {
  const pids = mainProcsFor(root).filter((p) => p !== mainPid);
  if (pids.length) newPid = pids[0];
  else await sleep(100);
}
check('新实例起来了（同一个数据根上的新主进程）', newPid !== null, `newPid=${newPid} old=${mainPid} +${Date.now() - tClick}ms`);
let newMinisd = null;
for (let i = 0; i < 150 && newPid !== null && !newMinisd; i++) {
  newMinisd = treeOf(newPid).find((p) => p.cmd.includes('utility-sub-type=node.mojom.NodeService')) ?? null;
  if (!newMinisd) await sleep(100);
}
let lockAfter = null;
for (let i = 0; i < 100 && newMinisd; i++) {
  lockAfter = existsSync(join(root, 'minisd.lock')) ? readFileSync(join(root, 'minisd.lock'), 'utf8') : null;
  if (lockAfter && lockAfter !== lockBefore && lockAfter.includes(String(newMinisd.pid))) break;
  await sleep(100);
}
check('新 minisd 接管了数据根锁（旧锁是被杀留下的陈旧锁）', !!newMinisd && !!lockAfter && lockAfter.includes(String(newMinisd.pid)) && !lockAfter.includes(String(minisd.pid)),
  JSON.stringify({ newMinisd: newMinisd?.pid, lockBefore, lockAfter }));
check('只起了一份新实例', mainProcsFor(root).length === 1, JSON.stringify(mainProcsFor(root)));

// 连新实例的 CDP（它沿用了原命令行，带着 --remote-debugging-port=0，端口写在 userData 的 DevToolsActivePort）
let port = null;
for (let i = 0; i < 150; i++) {
  if (existsSync(devtoolsFile)) {
    const p = readFileSync(devtoolsFile, 'utf8').split('\n')[0];
    if (p && p !== oldPort) { port = p; break; }
  }
  await sleep(100);
}
check('新实例开了 DevTools 端口', !!port, `old=${oldPort} new=${port}`);
let browser = null;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 });
  let np = null;
  for (let i = 0; i < 60 && !np; i++) {
    np = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith('devtools://')) ?? null;
    if (!np) await sleep(250);
  }
  await np.waitForSelector('textarea.field', { timeout: 30_000 });
  await sleep(1500);
  await np.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await sleep(300);
  const s3 = await st(np);
  const hasBanner = !!(await np.$('.lost'));
  const sessions = await np.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat.sessions.length);
  check('新实例握手成功：输入卡在、connection=ok、没有横幅，会话列表读得回来', s3.connection === 'ok' && !hasBanner && sessions >= 1, JSON.stringify({ ...s3, hasBanner, sessions }));
  await np.screenshot({ path: join(SHOTS, 'W2b-3-6-relaunched.png') });
  log('x11 windows:', JSON.stringify(x11('list')));
  x11('shot', join(SHOTS, 'W2b-3-7-relaunched-x11-root.png'));
} catch (e) {
  check('连上新实例', false, String(e?.stack ?? e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
}

// 收掉新实例（SIGTERM；不退再 SIGKILL）
if (newPid !== null) {
  const newTree = treeOf(newPid);
  try { process.kill(newPid, 'SIGTERM'); } catch { /* */ }
  for (let i = 0; i < 80 && alive(newPid); i++) await sleep(100);
  if (alive(newPid)) { try { process.kill(newPid, 'SIGKILL'); } catch { /* */ } }
  await sleep(500);
  for (const p of [...newTree.map((x) => x.pid), ...mainProcsFor(root)]) { if (alive(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* */ } } }
  await sleep(300);
  const left = newTree.filter((p) => alive(p.pid));
  log('new instance cleaned up; leftovers:', JSON.stringify(left.map((p) => p.pid)));
}
const errs = pageErrors.filter((e) => !/与后台服务的连接已断开|WebSocket/.test(e));
check('第一段页面没有别的报错（断线本身的拒绝除外）', errs.length === 0, errs.slice(0, 3).join(' | '));
log('page errors (all):', JSON.stringify(pageErrors.slice(0, 6)));
const errLines = stderr.split('\n').filter((l) => /Unhandled|uncaught|TypeError|启动失败/i.test(l));
check('旧主进程 stderr 没有未处理异常', errLines.length === 0, errLines.slice(0, 3).join(' | '));

const failed = results.filter((r) => !r.ok);
console.log(`\n== ${results.length - failed.length}/${results.length} PASS ==`);
if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('；')); process.exitCode = 1; }
