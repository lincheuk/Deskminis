// W2b-7 取证：用构建产物起真的 Electron（主进程 + utilityProcess.fork 的 minisd），证明崩溃记录与按天日志真的落盘。
// 不是界面改动，不截界面；只在主进程未捕获异常那一段截一张原生错误框（X11 根窗口），证明「与 Electron 默认一样看得见」。
//
// 三段，各用一个新的临时数据根（日志落 <数据根>/logs）：
//   main    ① 起来后按天日志有 fork / 握手两行 ② 主进程未处理拒绝 → main/unhandled_rejection、不弹框
//           ③ SIGKILL 引擎 → 主进程记 minisd_exit（握手后、没请求关停），日志记退出码
//           ④ 主进程未捕获异常 → main/uncaught_exception、弹错误框（截图后按 Return 关掉），主进程照常活着
//   engine  NODE_OPTIONS 预加载 W2b-7-engine-inject.cjs（只在 utility 进程里动手）：
//           ① 引擎未处理拒绝 → minisd/unhandled_rejection，引擎照常服务（ws 调一次 RPC）
//           ② 引擎未捕获异常 → minisd/uncaught_exception + 主进程记的 minisd_exit（code=1），日志记退出码
//   quit    app.quit()：before-quit 同步触发（确认 exit 监听里「主进程已在退出」的判定前提）→ 优雅停 → 不记 minisd_exit，
//           日志有「请求引擎关停」与退出码
// 用法：NODE_PATH=<scratchpad>/driver/node_modules xvfb-run -a node W2b-7-crashlog.mjs
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const APP = '/home/user/wt-f2/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const SHOTS = join(S, 'hemo-shots');
const X11 = join(S, 'hemo-drivers/W1a-8-x11.py');
const INJECT = join(S, 'hemo-drivers/W2b-7-engine-inject.cjs');
const ELECTRON = join(APP, 'node_modules/electron/dist/electron');
const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright-core');
const WebSocket = createRequire(join(APP, 'package.json'))('ws');
mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const x11 = (...args) => JSON.parse(execFileSync('python3', [X11, ...args], { encoding: 'utf8' }));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
const log = (...a) => console.log('[W2b-7]', ...a);

const crashes = (root) => { try { return JSON.parse(readFileSync(join(root, 'logs', 'crashes.json'), 'utf8')); } catch { return []; } };
const dailyLog = (root) => {
  try {
    const dir = join(root, 'logs');
    return readdirSync(dir).filter((f) => /^minisd-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort().map((f) => readFileSync(join(dir, f), 'utf8')).join('');
  } catch { return ''; }
};
async function waitFor(what, cond, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('等待超时: ' + what);
    await sleep(100);
  }
}
const alive = (pid) => { try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return !/\) [ZX] /.test(s); } catch { return false; } };

function envFor(root, extra = {}) {
  const e = { ...process.env, DESKMINIS_DATA_DIR: root, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_TEST: '1', ...extra };
  delete e.ELECTRON_RUN_AS_NODE;
  return e;
}
async function launch(root, extra) {
  const app = await electron.launch({ executablePath: ELECTRON, args: ['--no-sandbox', '.'], cwd: APP, timeout: 45_000, env: envFor(root, extra) });
  const page = await app.firstWindow();
  await page.waitForSelector('textarea.field', { timeout: 30_000 });
  return app;
}
async function rpcAlive(root) {
  const { port, authToken } = JSON.parse(readFileSync(join(root, 'minisd-port.json'), 'utf8'));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(authToken)}`);
  try {
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    const reply = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('RPC 无应答')), 5000);
      ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id === 1) { clearTimeout(t); res(m); } });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chat.sessions.list' }));
    });
    return Array.isArray(reply.result);
  } finally { ws.close(); }
}
const brief = (r) => ({ ...r, stack: r.stack ? r.stack.split('\n').slice(0, 2).join(' | ') : r.stack, stderrTail: r.stderrTail === undefined ? undefined : `(${r.stderrTail.length} 字) …${r.stderrTail.slice(-160).replace(/\n/g, '⏎')}` });

// ───────────────────────── main ─────────────────────────
async function scenarioMain() {
  const root = mkdtempSync(join(S, 'W2b-7-main-'));
  log('main 数据根', root);
  const app = await launch(root);
  const mainPid = app.process().pid;
  try {
    await waitFor('握手行进按天日志', () => /\[main\] 引擎握手完成，端口 \d+/.test(dailyLog(root)));
    const text0 = dailyLog(root);
    check('main①：按天日志有 fork 与握手两行，token 不落盘',
      /\[main\] 启动引擎进程（fork minisd）/.test(text0) && !text0.includes(JSON.parse(readFileSync(join(root, 'minisd-port.json'), 'utf8')).authToken));

    await app.evaluate(() => { Promise.reject(new Error('W2b-7 取证：主进程未处理拒绝')); });
    await waitFor('main/unhandled_rejection', () => crashes(root).some((r) => r.process === 'main' && r.kind === 'unhandled_rejection'));
    const winsAfterReject = x11('list').filter((w) => w.name && /出错/.test(w.name));
    check('main②：主进程未处理拒绝 → main/unhandled_rejection，不弹框', winsAfterReject.length === 0, JSON.stringify(brief(crashes(root).find((r) => r.kind === 'unhandled_rejection'))));

    const lock = JSON.parse(readFileSync(join(root, 'minisd.lock'), 'utf8'));
    log('引擎 pid（来自数据根锁）', lock.pid);
    process.kill(lock.pid, 'SIGKILL');
    await waitFor('minisd_exit', () => crashes(root).some((r) => r.kind === 'minisd_exit'));
    const exitRec = crashes(root).find((r) => r.kind === 'minisd_exit');
    check('main③：SIGKILL 引擎 → 主进程记 minisd_exit（握手后、没请求关停）', exitRec.process === 'minisd' && typeof exitRec.exitCode === 'number', JSON.stringify(brief(exitRec)));
    await waitFor('退出码进日志', () => /\[main\] 引擎进程退出 code=\S+（意外退出，已记入崩溃记录）/.test(dailyLog(root)));
    check('main③：按天日志记下退出码与「意外退出」', true, dailyLog(root).split('\n').find((l) => l.includes('引擎进程退出')));

    await app.evaluate(() => { setTimeout(() => { throw new Error('W2b-7 取证：主进程未捕获异常'); }, 0); });
    await waitFor('main/uncaught_exception', () => crashes(root).some((r) => r.process === 'main' && r.kind === 'uncaught_exception'));
    // GTK 的错误框窗口标题固定是「Error」，我们给的标题「DeskMinis 主进程出错」画在框里（看截图）
    let box;
    await waitFor('错误框出现', () => { box = x11('list').find((w) => w.name === 'Error'); return !!box; }, 10_000).catch(() => {});
    const shot = join(SHOTS, 'W2b-7-main-errorbox.png');
    x11('shot', shot);
    check('main④：主进程未捕获异常 → main/uncaught_exception，并弹错误框（框内标题「DeskMinis 主进程出错」见截图）', !!box, box ? `窗口 ${JSON.stringify(box)}；截图 ${shot}` : JSON.stringify(x11('list')));
    execFileSync('python3', [X11, 'key', 'Return']);
    await waitFor('错误框关掉', () => !x11('list').some((w) => w.name === 'Error'), 5_000).catch(() => {});
    const stillOk = await Promise.race([app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), sleep(5000).then(() => -1)]);
    check('main④：关掉错误框后主进程照常运行（与 Electron 默认一样不退出）', alive(mainPid) && stillOk >= 1, `窗口数 ${stillOk}`);
  } finally {
    try { await Promise.race([app.close(), sleep(8000)]); } catch { /* */ }
    try { app.process().kill('SIGKILL'); } catch { /* */ }
  }
  writeFileSync(join(S, 'hemo-logs', 'W2b-7-real-main-crashes.json'), JSON.stringify(crashes(root), null, 2));
  writeFileSync(join(S, 'hemo-logs', 'W2b-7-real-main-daily.log'), dailyLog(root));
}

// ───────────────────────── engine ─────────────────────────
async function scenarioEngine() {
  const root = mkdtempSync(join(S, 'W2b-7-engine-'));
  log('engine 数据根', root);
  // playwright 起 Electron 时会把 NODE_OPTIONS 从环境里拿掉（实测），注入件进不了 utility 进程；这一段直接 spawn 构建产物，
  // 只靠文件与 ws 交互，不需要 evaluate
  const env = envFor(root, { NODE_OPTIONS: `--require ${INJECT}`, W2B7_TRIGGER_DIR: root });
  const child = spawn(ELECTRON, ['--no-sandbox', '.'], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const app = { close: async () => { child.kill('SIGTERM'); }, process: () => child };
  try {
    await waitFor('握手行进按天日志', () => /引擎握手完成/.test(dailyLog(root)), 45_000);
    await sleep(1500); // 等窗口起来（取证不看界面，只是别在启动中途动手）
    writeFileSync(join(root, 'inject-reject'), '');
    await waitFor('minisd/unhandled_rejection', () => crashes(root).some((r) => r.process === 'minisd' && r.kind === 'unhandled_rejection'));
    const rej = crashes(root).find((r) => r.kind === 'unhandled_rejection');
    check('engine①：引擎未处理拒绝 → minisd/unhandled_rejection（版本号由主进程下发）', rej.version !== 'unknown' && /未处理拒绝/.test(rej.message), JSON.stringify(brief(rej)));
    check('engine①：记完之后引擎照常服务（ws 调 chat.sessions.list）', await rpcAlive(root));
    await waitFor('那句说明进按天日志', () => /\[minisd:err\] minisd 未处理的 Promise 拒绝.*引擎继续运行/.test(dailyLog(root)));
    check('engine①：引擎 stderr 那句经主进程落进按天日志', true, dailyLog(root).split('\n').find((l) => l.includes('[minisd:err] minisd 未处理')).slice(0, 160));

    writeFileSync(join(root, 'inject-throw'), '');
    await waitFor('minisd_exit', () => crashes(root).some((r) => r.kind === 'minisd_exit'));
    const recs = crashes(root);
    check('engine②：引擎未捕获异常 → minisd/uncaught_exception 在前、主进程的 minisd_exit（code=1）在后',
      JSON.stringify(recs.map((r) => [r.process, r.kind])) === JSON.stringify([['minisd', 'unhandled_rejection'], ['minisd', 'uncaught_exception'], ['minisd', 'minisd_exit']])
        && recs[2].exitCode === 1,
      JSON.stringify(recs.map(brief)));
    await waitFor('退出码进日志', () => /\[main\] 引擎进程退出 code=1（意外退出，已记入崩溃记录）/.test(dailyLog(root)));
    check('engine②：按天日志记下 code=1 与「意外退出」', true);
    log('minisd_exit 的 stderrTail 里有没有引擎退出前那句（Electron 收到 exit 后不再交付管道里剩下的数据）：',
      /引擎退出/.test(recs[2].stderrTail ?? '') ? '有' : '没有（只有更早的输出）');
  } finally {
    try { await Promise.race([app.close(), sleep(8000)]); } catch { /* */ }
    try { app.process().kill('SIGKILL'); } catch { /* */ }
  }
  writeFileSync(join(S, 'hemo-logs', 'W2b-7-real-engine-crashes.json'), JSON.stringify(crashes(root), null, 2));
  writeFileSync(join(S, 'hemo-logs', 'W2b-7-real-engine-daily.log'), dailyLog(root));
  writeFileSync(join(S, 'hemo-logs', 'W2b-7-real-engine-stdio.log'), out);
}

// ───────────────────────── quit ─────────────────────────
async function scenarioQuit() {
  const root = mkdtempSync(join(S, 'W2b-7-quit-'));
  log('quit 数据根', root);
  const app = await launch(root);
  const proc = app.process();
  const exited = new Promise((r) => proc.once('exit', (code, signal) => r({ code, signal })));
  await waitFor('握手行进按天日志', () => /引擎握手完成/.test(dailyLog(root)));
  const sync = await app.evaluate(({ app: a }) => {
    let seen = false;
    a.prependOnceListener('before-quit', () => { seen = true; });
    a.quit();
    return seen;
  });
  check('quit：app.quit() 同步触发 before-quit（exit 监听按 quitting 排除「主进程自己 kill」的前提）', sync === true, `seen=${sync}`);
  const r = await Promise.race([exited, sleep(10_000).then(() => 'timeout')]);
  check('quit：应用在 10 秒内退出', r !== 'timeout', JSON.stringify(r));
  const text = dailyLog(root);
  check('quit：按天日志有「请求引擎关停」与退出码', /\[main\] 请求引擎关停（shutdown）/.test(text) && /\[main\] 引擎进程退出 code=0\n/.test(text),
    text.split('\n').filter((l) => /请求引擎关停|引擎进程退出/.test(l)).join(' ‖ '));
  check('quit：优雅退出不记 minisd_exit', !crashes(root).some((r2) => r2.kind === 'minisd_exit'), JSON.stringify(crashes(root)));
  check('quit：数据根锁已释放（close 走完）', !existsSync(join(root, 'minisd.lock')));
  writeFileSync(join(S, 'hemo-logs', 'W2b-7-real-quit-daily.log'), text);
}

for (const [name, fn] of [['main', scenarioMain], ['engine', scenarioEngine], ['quit', scenarioQuit]]) {
  try { await fn(); } catch (e) { check(`${name} 段跑完`, false, String(e?.stack ?? e)); }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length === 0 ? 0 : 1);
