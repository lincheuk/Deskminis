// W1b-3 实拍（lifecycle.md xvfb 节第二、三条）：npm run build 之后跑真实的 `electron .`，数据根一律 mkdtemp、经 DESKMINIS_DATA_DIR 注入。
//
// 用法：NODE_PATH=<scratchpad>/driver/node_modules xvfb-run -a node W1b-3-gui.mjs <locked|single>
//   locked  先用 ELECTRON_RUN_AS_NODE 起一个 standalone minisd 占住临时根，再启动应用：
//           应弹「DeskMinis 已在运行」，正文带进程号与数据目录，detail 带锁文件路径，只有「退出」；
//           原生对话框 playwright 看不到，用 W1a-8-x11.py 列窗口、截根窗口、真点按钮（坐标由人看图后写进 .click 文件）。
//           点后应用整组退出，占着根的 minisd 不受影响、锁文件一个字节不变。
//   single  playwright 起实例 A，点 ×（close → 隐藏到托盘），再直接 spawn 同一个应用 B（同一个数据根 → 同一个 userData）：
//           B 秒退、不打 dev 数据根日志（whenReady 早退，没 fork minisd），A 的窗口被唤回；进程表里只剩 A 这一组，minisd 只有一个。
//           再试「最小化后唤出」（裸 Xvfb 没有窗口管理器，最小化可能不生效，如实记录）。
//           然后 SIGKILL 整组模拟崩溃：锁留在盘上；重启应用照常进主界面（陈旧锁接管）。
//           最后放一个空锁文件再启动：走「等 50ms 再读」这条路（utilityProcess 里的 Atomics.wait），照常进主界面。
import { createRequire } from 'node:module';
import { spawn, execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const { _electron: electron } = createRequire(import.meta.url)('playwright-core');

const APP = '/home/user/wt-d1/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const SHOTS = join(S, 'hemo-shots');
const X11 = join(S, 'hemo-drivers/W1a-8-x11.py');
const ELECTRON = join(APP, 'node_modules/electron/dist/electron');
const scenario = process.argv[2] ?? 'single';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const x11 = (...args) => JSON.parse(execFileSync('python3', [X11, ...args], { encoding: 'utf8' }));
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
const appEnv = (root) => { const e = { ...process.env, DESKMINIS_DATA_DIR: root }; delete e.ELECTRON_RUN_AS_NODE; delete e.DESKMINIS_FAKE_PROVIDER; return e; };
const lockOf = (root) => join(root, 'minisd.lock');
const readLock = (root) => { try { return JSON.parse(readFileSync(lockOf(root), 'utf8')); } catch { return null; } };

/** 进程表里 environ 带 DESKMINIS_DATA_DIR=<root> 的进程（按 args 粗分类）。 */
function procsOf(root) {
  const out = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let env; let args;
    try { env = readFileSync(`/proc/${d}/environ`, 'utf8'); args = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' '); } catch { continue; }
    if (!env.split('\0').includes(`DESKMINIS_DATA_DIR=${root}`)) continue;
    out.push({ pid: +d, kind: args.includes('node.mojom.NodeService') ? 'minisd' : args.includes('--type=') ? (/--type=(\S+)/.exec(args)?.[1] ?? 'child') : 'main', args: args.slice(0, 120) });
  }
  return out;
}

async function launchA(root) {
  const app = await electron.launch({ executablePath: ELECTRON, args: ['--no-sandbox', '.'], cwd: APP, timeout: 45_000, env: appEnv(root) });
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(250); }
  if (!page) page = await app.firstWindow();
  await page.waitForSelector('textarea.field', { timeout: 30_000 });
  await sleep(1500);
  return { app, page };
}
const winState = (app) => app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  return w ? { count: BrowserWindow.getAllWindows().length, visible: w.isVisible(), minimized: w.isMinimized(), focused: w.isFocused() } : null;
});

/** 直接 spawn 第二个实例，等它退出；返回退出码、耗时与 stderr。 */
function secondInstance(root, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const b = spawn(ELECTRON, ['--no-sandbox', '.'], { cwd: APP, env: appEnv(root), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    b.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => { try { b.kill('SIGKILL'); } catch { /* */ } }, timeoutMs);
    b.on('exit', (code, signal) => { clearTimeout(t); resolve({ pid: b.pid, code, signal, ms: Date.now() - t0, stderr }); });
  });
}

async function scenarioLocked() {
  const root = mkdtempSync(join(S, 'W1b-3-gui-locked-'));
  // 占住根的 standalone minisd
  const holder = spawn(ELECTRON, [join(APP, 'out/main/minisd.js')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DESKMINIS_STANDALONE: '1', DESKMINIS_DATA_DIR: root, DESKMINIS_TEST: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let hout = ''; holder.stdout.on('data', (d) => { hout += d; });
  for (let i = 0; i < 100 && !hout.includes('minisdPort'); i++) await sleep(100);
  check('占位 minisd 已握手', hout.includes('minisdPort'), `pid=${holder.pid}`);
  const lockBefore = sha(lockOf(root));
  check('锁里是占位 minisd 的 pid', readLock(root)?.pid === holder.pid);

  const t0 = Date.now();
  const app = spawn(ELECTRON, ['--no-sandbox', '.'], { cwd: APP, env: appEnv(root), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let appOut = '';
  app.stdout.on('data', (d) => { appOut += d; }); app.stderr.on('data', (d) => { appOut += d; });
  let exitInfo = null;
  app.on('exit', (code, signal) => { exitInfo = { code, signal, atMs: Date.now() - t0 }; });
  let win = null;
  for (let i = 0; i < 120 && !win && !exitInfo; i++) {
    win = x11('list').find((w) => /DeskMinis/.test(w.name ?? '')) ?? null;
    if (!win) await sleep(250);
  }
  check('弹出「DeskMinis 已在运行」对话框', win?.name === 'DeskMinis 已在运行', JSON.stringify(win));
  if (!win) { console.log(appOut); return { root }; }
  await sleep(1200);
  x11('shot', join(SHOTS, 'W1b-3-locked-full.png'));
  const pad = 24; const cx = Math.max(0, win.x - pad); const cy = Math.max(0, win.y - pad);
  x11('shot', join(SHOTS, 'W1b-3-locked-dialog.png'), String(cx), String(cy), String(Math.min(1280 - cx, win.w + pad * 2)), String(Math.min(1024 - cy, win.h + pad * 2)));
  check('主进程转发了致命行', /\[minisd\] \{"minisdFatal":\{"code":"DATA_ROOT_LOCKED","pid":\d+/.test(appOut));

  const clickFile = join(S, 'hemo-drivers/W1b-3-locked.click');
  rmSync(clickFile, { force: true });
  writeFileSync(join(S, 'hemo-drivers/W1b-3-locked.ready'), JSON.stringify(win));
  console.log('READY：看 W1b-3-locked-dialog.png 后把「退出」按钮的屏幕坐标写进', clickFile);
  let coords = process.env.AUTO_CLICK ? process.env.AUTO_CLICK.trim().split(/\s+/).map(Number) : null;
  for (let i = 0; i < 600 && !coords; i++) {
    if (existsSync(clickFile)) coords = readFileSync(clickFile, 'utf8').trim().split(/\s+/).map(Number);
    else await sleep(500);
  }
  const tClick = Date.now();
  if (coords) x11('click', String(coords[0]), String(coords[1])); else x11('key', 'Return');
  for (let i = 0; i < 100 && !exitInfo; i++) await sleep(100);
  check('点「退出」后应用退出', !!exitInfo, `${coords ? '真点 ' + coords.join(',') : '回车兜底'}；${exitInfo ? Date.now() - tClick : '-'}ms 内退出，code=${exitInfo?.code}`);
  await sleep(1500);
  x11('shot', join(SHOTS, 'W1b-3-locked-after.png'));
  const left = procsOf(root).filter((p) => p.pid !== holder.pid);
  check('应用整组退出，没有残留', left.length === 0, JSON.stringify(left));
  check('占位 minisd 仍在运行', holder.exitCode === null && holder.signalCode === null);
  check('锁文件一个字节不变', sha(lockOf(root)) === lockBefore);
  holder.kill('SIGKILL');
  return { root, appOut: appOut.split('\n').filter((l) => /minisd|DeskMinis|启动/.test(l)).slice(0, 20) };
}

async function scenarioSingle() {
  const root = mkdtempSync(join(S, 'W1b-3-gui-single-'));
  let { app } = await launchA(root);
  const mainPid = app.process().pid;
  const before = procsOf(root);
  const minisdA = before.filter((p) => p.kind === 'minisd');
  check('A 起来了：一个主进程组、一个 minisd', minisdA.length === 1, JSON.stringify(before.map((p) => `${p.pid}:${p.kind}`)));
  check('锁里是 A 的 minisd 的 pid', readLock(root)?.pid === minisdA[0]?.pid, JSON.stringify(readLock(root)));

  // 点 ×：close 处理器 hide 到托盘
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  await sleep(800);
  const hidden = await winState(app);
  check('点 × 后窗口隐藏到托盘', hidden?.visible === false, JSON.stringify(hidden));
  x11('shot', join(SHOTS, 'W1b-3-single-hidden.png'));

  const b = await secondInstance(root);
  check('第二个实例秒退、退出码 0', b.code === 0 && b.ms < 15_000, `pid=${b.pid} code=${b.code} signal=${b.signal} ${b.ms}ms`);
  check('第二个实例没走到 fork minisd（stderr 没有「开发态数据根」那一行）', !b.stderr.includes('开发态数据根'), b.stderr.split('\n').filter(Boolean).slice(0, 3).join(' | '));
  let shown = null;
  for (let i = 0; i < 25; i++) { shown = await winState(app); if (shown?.visible) break; await sleep(200); }
  check('A 的窗口被唤回：可见', shown?.visible === true, JSON.stringify(shown));
  check('窗口仍只有一个', shown?.count === 1);
  await sleep(800);
  x11('shot', join(SHOTS, 'W1b-3-single-revealed.png'));
  const after = procsOf(root);
  check('进程表里没有第二组：主进程只有 A，minisd 只有一个且是原来那个',
    after.filter((p) => p.kind === 'main').map((p) => p.pid).join(',') === String(mainPid)
      && after.filter((p) => p.kind === 'minisd').map((p) => p.pid).join(',') === String(minisdA[0]?.pid),
    JSON.stringify(after.map((p) => `${p.pid}:${p.kind}`)));
  check('B 的进程已不在', !existsSync(`/proc/${b.pid}`));

  // 最小化后唤出（裸 Xvfb 没有窗口管理器，iconify 可能不生效）
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].minimize(); });
  await sleep(800);
  const mini = await winState(app);
  if (mini?.minimized) {
    const c = await secondInstance(root);
    let st = null;
    for (let i = 0; i < 25; i++) { st = await winState(app); if (st && !st.minimized) break; await sleep(200); }
    check('最小化后再启动：窗口被 restore', st?.minimized === false && st?.visible === true, `${JSON.stringify(st)} C:${c.code}/${c.ms}ms`);
  } else {
    results.push({ name: '最小化后唤出', ok: true, detail: `未验证：裸 Xvfb 无窗口管理器，minimize() 后 isMinimized=${mini?.minimized}` });
    console.log('SKIP  最小化后唤出  裸 Xvfb 无窗口管理器，minimize() 不生效', JSON.stringify(mini));
  }

  // 模拟崩溃：SIGKILL 整组，锁留在盘上
  const lockBeforeCrash = readLock(root);
  for (const p of procsOf(root)) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* */ } }
  await sleep(1500);
  check('崩溃后进程全清', procsOf(root).length === 0);
  const lockAfterCrash = readLock(root);
  let procState = 'gone';
  try { procState = readFileSync(`/proc/${lockBeforeCrash?.pid}/stat`, 'utf8').split(' ').slice(0, 3).join(' '); } catch { /* 不在了 */ }
  check('崩溃后锁文件还在，里面仍是那个已被杀的 minisd', lockAfterCrash?.pid === lockBeforeCrash?.pid && !procState.includes(' R') && !procState.includes(' S'),
    `lock=${JSON.stringify(lockAfterCrash)} /proc 状态=${procState}`);
  ({ app } = await launchA(root));
  const m2 = procsOf(root).filter((p) => p.kind === 'minisd');
  check('重启照常进主界面，锁换成新 minisd 的 pid（陈旧锁接管）', m2.length === 1 && readLock(root)?.pid === m2[0].pid, JSON.stringify(readLock(root)));
  x11('shot', join(SHOTS, 'W1b-3-single-stale-takeover.png'));
  for (const p of procsOf(root)) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* */ } }
  await sleep(1500);

  // 空锁：utilityProcess 里走「等 50ms 再读」
  writeFileSync(lockOf(root), '');
  ({ app } = await launchA(root));
  const m3 = procsOf(root).filter((p) => p.kind === 'minisd');
  check('空锁文件：重启照常进主界面，锁换成新 minisd 的 pid', m3.length === 1 && readLock(root)?.pid === m3[0].pid, JSON.stringify(readLock(root)));
  x11('shot', join(SHOTS, 'W1b-3-single-empty-lock.png'));
  await app.close().catch(() => {});
  await sleep(1000);
  for (const p of procsOf(root)) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* */ } }
  return { root };
}

let extra = {};
try {
  extra = scenario === 'locked' ? await scenarioLocked() : await scenarioSingle();
} catch (e) {
  results.push({ name: '剧本异常', ok: false, detail: String(e?.stack ?? e) });
  console.log(String(e?.stack ?? e));
}
writeFileSync(join(S, `hemo-logs/W1b-3-xvfb-${scenario}.json`), JSON.stringify({ scenario, ...extra, results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? `ALL ${results.length} PASS` : `${failed.length} FAIL`);
process.exit(failed.length === 0 ? 0 : 1);
