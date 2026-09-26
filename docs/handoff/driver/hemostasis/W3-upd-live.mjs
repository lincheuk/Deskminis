// W3-upd 实拍（Linux + xvfb）：真 electron-updater（Linux 上是 AppImageUpdater）+ 本地 generic 更新源，
// 把 eb70690 的更新交接在真 Electron 里走一遍，看改动接不接得上、文案许诺的行为成不成立。
//
//   run1（更新源正常，0.3.99）：
//     ① 启动 8 秒后主进程自动检查 → 后台下载 → 原生「有新版本可用」框：X11 截整屏；主进程里记下的实参与
//        eb70690 的真函数 downloadedDialog('0.3.99')（直接 import worktree 里的 update-status.ts）逐字段比
//     ② XTest 按 Escape（取消键 = 「稍后再说」）：框关掉、返回值 response 0、应用还在
//     ③ 读按天日志 <DATA>/logs/minisd-<本地日期>.log 的 [update] 行
//     ④ playwright 点 设置 → 关于：状态行、截图
//     ⑤ 点「现在检查」：下载完成框应再次弹出（截整屏）；对照更新源请求记录与缓存文件（inode / mtime）看是否重下
//     5b（额外，不计入 pass）托盘「检查更新…」：下载完成框正文许诺「之后从托盘『检查更新…』可以再装」——调托盘菜单项的 click
//        （同一个处理器 checkUpdatesFromTray），看下载完成框是否再弹、托盘回执是 manualCheckDialog 的哪一格
//     ⑥ app.close()（主进程里就是 app.quit()，与托盘「退出 DeskMinis」同一条路）：APPIMAGE 占位文件原样、
//        install / quitAndInstall 零调用、日志里没有安装相关的行、没有残留进程
//   run2（新的临时目录，更新源对 latest-linux.yml 回 404）：
//     ⑦ 等自动检查失败：按天日志里错误原文逐行带 [update]；没有弹框；关于页「更新失败 · <一句中文>」（截图）
//
// 「已打包」：node_modules/electron/dist 硬链接复制到 $S/W3-upd-pkgsim，electron 改名 deskminis（app.isPackaged 为真），
//   resources/app-update.yml 是新建的文件（generic 源 + updaterCacheDirName），不碰硬链接的原文件。
// AppImageUpdater 只在设了 APPIMAGE 时工作：指向 $S/W3-upd-fake.AppImage（50 字节占位）。XDG_CACHE_HOME 指临时目录，
//   更新缓存不落到真实的 ~/.cache。数据根、Chromium 配置目录都是 mkdtemp 临时目录；不写 update-prefs.json（就是要它自动检查）。
// 主进程里只加「旁听」，不改行为：包一层 dialog.showMessageBox 记实参与返回值；给 autoUpdater 多挂几个事件监听记时间；
//   install / quitAndInstall 记调用（照常转发，另写一个进程退出后还在的标记文件）。
// 用法：NODE_PATH=$S/driver/node_modules xvfb-run -a node W3-upd-live.mjs
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
const { _electron: electron } = createRequire(import.meta.url)('playwright-core');

const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const APP_DIR = '/home/user/wt-upd/deskminis';
const SIM = path.join(S, 'W3-upd-pkgsim');
const EXE = path.join(SIM, 'deskminis');
const APP_UPDATE_YML = path.join(SIM, 'resources', 'app-update.yml');
const X11 = path.join(S, 'hemo-drivers/W2b-6b-x11.py');
const SHOTS = path.join(S, 'hemo-shots');
const OUT = path.join(S, 'W3-upd-out');
const FAKE_APPIMAGE = path.join(S, 'W3-upd-fake.AppImage');
const CACHE_DIR_NAME = 'deskminis-updater-w3upd';
const VERSION = '0.3.99';
const FILE = `DeskMinis-${VERSION}.AppImage`;
const DIALOG_TITLE = '有新版本可用';
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

// eb70690 的真函数（Node 22 类型剥离直接 import TS 源），不手抄文案
const { downloadedDialog, manualCheckDialog } = await import(path.join(APP_DIR, 'src/main/update-status.ts'));
const EXPECTED_DIALOG = downloadedDialog(VERSION);
// 托盘回执的两种可能：checkUpdates 返回时状态若是 available / downloaded（当前版本 0.3.0，即 package.json 的 version）
const EXPECTED_RECEIPT_AVAILABLE = manualCheckDialog({ status: 'available', version: VERSION }, '0.3.0');
const EXPECTED_RECEIPT_DOWNLOADED = manualCheckDialog({ status: 'downloaded', version: VERSION }, '0.3.0');

const T0 = Date.now();
const ts = () => +((Date.now() - T0) / 1000).toFixed(2);
const log = (...a) => console.error(`[W3-upd +${ts()}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const x11 = (...args) => { try { return JSON.parse(execFileSync('python3', [X11, ...args], { encoding: 'utf8' })); } catch (e) { return { error: String(e?.message ?? e) }; } };
const hash = (buf, alg = 'sha256', enc = 'hex') => crypto.createHash(alg).update(buf).digest(enc);
const statOf = (p) => {
  try { const st = fs.statSync(p); return { size: st.size, ino: st.ino, nlink: st.nlink, mtimeMs: st.mtimeMs, sha256: hash(fs.readFileSync(p)) }; }
  catch (e) { return { missing: e.code }; }
};
const listTree = (dir) => {
  const out = {};
  const walk = (d) => {
    let names; try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n); const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = { size: st.size, ino: st.ino, mtimeMs: st.mtimeMs, ...(st.size < 4096 && n.endsWith('.json') ? { text: fs.readFileSync(p, 'utf8') } : {}) };
    }
  };
  walk(dir);
  return out;
};
const procs = () => {
  try {
    return execFileSync('ps', ['-eo', 'pid,ppid,args'], { encoding: 'utf8' }).split('\n')
      .filter((l) => /W3-upd-pkgsim|wt-upd\/deskminis/.test(l) && !/\bps -eo\b/.test(l));
  } catch { return []; }
};
const shortHits = (arr) => arr.map((h) => `${h.t}s ${h.run} ${h.method} ${h.url}${h.range ? ` [Range ${h.range}]` : ''} -> ${h.status} ${h.bytes}B${h.finished ? '' : ' (未发完)'}`);

const report = { startedAt: new Date().toISOString(), exe: EXE, appDir: APP_DIR, expectedDialog: EXPECTED_DIALOG, run1: {}, run2: {}, checks: {} };

// ---------------- 本地更新源（node:http） ----------------
const payload = crypto.randomBytes(384 * 1024);
const sha512 = hash(payload, 'sha512', 'base64');
const FEED_DIR = path.join(OUT, 'feed');
fs.mkdirSync(FEED_DIR, { recursive: true });
const ymlText = [
  `version: ${VERSION}`, 'files:', `  - url: ${FILE}`, `    sha512: ${sha512}`, `    size: ${payload.length}`,
  `path: ${FILE}`, `sha512: ${sha512}`, "releaseDate: '2026-09-26T00:00:00.000Z'", '',
].join('\n');
fs.writeFileSync(path.join(FEED_DIR, 'latest-linux.yml'), ymlText);
fs.writeFileSync(path.join(FEED_DIR, FILE), payload);
report.feed = { version: VERSION, file: FILE, size: payload.length, sha512, yml: ymlText };
let feedMode = 'ok';
let runTag = 'run1';
const hits = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const hit = { t: ts(), run: runTag, mode: feedMode, method: req.method, url: req.url, path: u.pathname, range: req.headers.range ?? null, status: 0, bytes: 0, finished: false };
  hits.push(hit);
  const send = (status, body, type) => {
    hit.status = status; hit.bytes = body.length;
    res.on('finish', () => { hit.finished = true; });
    res.writeHead(status, { 'content-type': type, 'content-length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (req.method === 'GET' && u.pathname === '/latest-linux.yml') {
    if (feedMode === 'yml404') return send(404, Buffer.from('Not Found\n'), 'text/plain');
    return send(200, Buffer.from(ymlText), 'text/yaml; charset=utf-8');
  }
  if (req.method === 'GET' && u.pathname === `/${FILE}` && !req.headers.range) return send(200, payload, 'application/octet-stream');
  // blockmap、带 Range 的差分请求、别的路径一律 404：差分下载失败会退回整包下载
  return send(404, Buffer.from('Not Found\n'), 'text/plain');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

// 打包形态下 electron-updater 读 process.resourcesPath/app-update.yml：新建文件（先删本目录里的这个名字，不会碰到硬链接的原文件）
fs.rmSync(APP_UPDATE_YML, { force: true });
fs.writeFileSync(APP_UPDATE_YML, `provider: generic\nurl: http://127.0.0.1:${PORT}/\nupdaterCacheDirName: ${CACHE_DIR_NAME}\n`);
report.appUpdateYml = { path: APP_UPDATE_YML, text: fs.readFileSync(APP_UPDATE_YML, 'utf8'), nlink: fs.statSync(APP_UPDATE_YML).nlink };

// ---------------- 主进程里的旁听（不改行为） ----------------
function hookMain({ dialog, BrowserWindow, Menu, app: a }, arg) {
  const { createRequire } = process.getBuiltinModule('node:module');
  const nodeFs = process.getBuiltinModule('node:fs');
  // 与主进程 import 的是同一个 CJS 单例（按真实路径缓存）
  const { autoUpdater } = createRequire(arg.appDir + '/package.json')('electron-updater');
  const g = globalThis;
  const now = () => new Date().toISOString();
  g.__w3 = { dialogs: [], events: [], installCalls: [], trayMenuCapturedAt: null };
  // 留住托盘菜单（托盘在引擎握手之后才建，这里抢在它之前）：5b 步调它「检查更新…」那一项的 click，与用户点托盘同一个处理器
  const origBuild = Menu.buildFromTemplate;
  Menu.buildFromTemplate = function (t) {
    const m = origBuild.call(this, t);
    if (Array.isArray(t) && t.some((i) => i && i.label === '检查更新…')) { g.__w3TrayMenu = m; g.__w3.trayMenuCapturedAt = now(); }
    return m;
  };
  const orig = dialog.showMessageBox;
  dialog.showMessageBox = function (...args) {
    const hasParent = args.length > 1 && args[0] != null && typeof args[0] === 'object' && typeof args[0].isDestroyed === 'function';
    const opts = hasParent ? args[1] : args[0];
    const main = BrowserWindow.getAllWindows()[0];
    const rec = { at: now(), hasParent, parentId: hasParent ? args[0].id : null, mainWindowId: main?.id ?? null, options: JSON.parse(JSON.stringify(opts ?? null)), result: null };
    g.__w3.dialogs.push(rec);
    const p = orig.apply(this, args);
    Promise.resolve(p).then((r) => { rec.result = { response: r?.response, checkboxChecked: r?.checkboxChecked, at: now() }; },
      (e) => { rec.result = { error: String(e), at: now() }; });
    return p;
  };
  for (const ev of ['checking-for-update', 'update-available', 'update-not-available', 'update-downloaded', 'update-cancelled', 'error']) {
    autoUpdater.on(ev, (x) => {
      g.__w3.events.push({ at: now(), ev, version: x?.version ?? null, downloadedFile: x?.downloadedFile ?? null,
        error: ev === 'error' ? String(x?.message ?? x).split('\n')[0] : null });
    });
  }
  for (const m of ['quitAndInstall', 'install']) {
    const o = autoUpdater[m];
    autoUpdater[m] = function (...a2) {
      g.__w3.installCalls.push({ at: now(), m, args: a2 });
      try { nodeFs.appendFileSync(arg.marker, `${now()} ${m} ${JSON.stringify(a2)}\n`); } catch { /* 旁路 */ }
      return o.apply(this, a2);
    };
  }
  return {
    isPackaged: a.isPackaged, execPath: process.execPath, resourcesPath: process.resourcesPath, version: a.getVersion(),
    userData: a.getPath('userData'), updaterClass: autoUpdater.constructor.name,
    envAPPIMAGE: process.env.APPIMAGE ?? null, envXDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? null,
    dialogPatched: dialog.showMessageBox !== orig,
  };
}
const mainSnap = (app) => app.evaluate(({ BrowserWindow }, arg) => {
  const { createRequire } = process.getBuiltinModule('node:module');
  const { autoUpdater: u } = createRequire(arg.appDir + '/package.json')('electron-updater');
  return {
    windows: BrowserWindow.getAllWindows().map((x) => ({ id: x.id, visible: x.isVisible(), destroyed: x.isDestroyed(), title: x.getTitle() })),
    autoDownload: u.autoDownload, autoInstallOnAppQuit: u.autoInstallOnAppQuit,
    quitHandlerAdded: u.quitHandlerAdded ?? null, quitAndInstallCalled: u.quitAndInstallCalled ?? null,
    installerPath: u.installerPath ?? null, cacheDir: u.downloadedUpdateHelper?.cacheDir ?? null,
    w3: globalThis.__w3,
  };
}, { appDir: APP_DIR });

// ---------------- 启动 ----------------
async function launch(tag) {
  const DATA = fs.mkdtempSync(path.join(S, `W3-upd-${tag}-data-`));
  const XDG = fs.mkdtempSync(path.join(S, `W3-upd-${tag}-xdg-`));
  const CACHE = fs.mkdtempSync(path.join(S, `W3-upd-${tag}-cache-`));
  fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
  const env = { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA, XDG_CONFIG_HOME: XDG, XDG_CACHE_HOME: CACHE, APPIMAGE: FAKE_APPIMAGE };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.PORTABLE_EXECUTABLE_DIR;
  const MARKER = path.join(OUT, `${tag}-install-calls.txt`);
  fs.rmSync(MARKER, { force: true });
  const outFile = path.join(OUT, `${tag}-stdout.log`);
  const errFile = path.join(OUT, `${tag}-stderr.log`);
  fs.writeFileSync(outFile, ''); fs.writeFileSync(errFile, '');
  const launchedAt = ts();
  const app = await electron.launch({ executablePath: EXE, args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 60_000, env });
  const proc = app.process();
  proc.stdout?.on('data', (d) => fs.appendFileSync(outFile, d));
  proc.stderr?.on('data', (d) => fs.appendFileSync(errFile, d));
  const exited = new Promise((r) => proc.once('exit', (code, signal) => r({ code, signal, at: ts() })));
  const hook = await app.evaluate(hookMain, { appDir: APP_DIR, marker: MARKER });
  log(tag, 'launched pid', proc.pid, JSON.stringify(hook));
  let page = null;
  for (let i = 0; i < 120 && !page; i++) { page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(250); }
  if (!page) throw new Error(`${tag}: 主窗口没出来`);
  await page.waitForSelector('.rail', { timeout: 30_000 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  return { app, proc, page, exited, DATA, XDG, CACHE, MARKER, outFile, errFile, hook, launchedAt, pid: proc.pid };
}
async function shutdown(L, r) {
  r.closeAt = ts();
  const closed = await Promise.race([L.app.close().then(() => 'closed', (e) => `close-error: ${e}`), sleep(30_000).then(() => 'close-timeout')]);
  r.close = closed;
  r.exit = await Promise.race([L.exited, sleep(15_000).then(() => 'exit-timeout')]);
  if (r.exit === 'exit-timeout') { try { process.kill(L.pid, 'SIGKILL'); r.killed = true; } catch { /* 已经没了 */ } }
  await sleep(1500);
  r.procsAfter = procs();
}

// ---------------- X11：原生对话框 ----------------
async function waitDialog(timeoutMs, name = DIALOG_TITLE) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const ws = x11('list');
    const d = Array.isArray(ws) ? ws.find((w) => w.name === name) : null;
    if (d) return d;
    await sleep(200);
  }
  return null;
}
function shotDialog(name, d) {
  const full = x11('shot', path.join(SHOTS, `${name}.png`));
  let crop = null;
  if (d && full?.w) {
    const pad = 24;
    const cx = Math.max(0, d.x - pad); const cy = Math.max(0, d.y - pad);
    const cw = Math.min(full.w - cx, d.w + pad * 2); const ch = Math.min(full.h - cy, d.h + pad * 2);
    crop = x11('shot', path.join(SHOTS, `${name}-crop.png`), String(cx), String(cy), String(cw), String(ch));
  }
  return { full, crop };
}
async function escapeDialog(d) {
  // 指针放到对话框上部（正文区，不在按钮上）：没有窗口管理器时键盘焦点可能跟着指针走
  x11('move', String(d.x + Math.round(d.w / 2)), String(d.y + 24));
  await sleep(250);
  x11('key', 'Escape');
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const ws = x11('list');
    if (Array.isArray(ws) && !ws.some((w) => w.id === d.id)) return { closed: true, afterMs: (i + 1) * 250 };
  }
  // 没关掉：键可能没落到这个框上。点一下正文区（标签，不是按钮）把焦点给它，再按一次 Escape（两个框的取消键都是 0 号，安全）
  x11('click', String(d.x + Math.round(d.w / 2)), String(d.y + 24));
  await sleep(250);
  x11('key', 'Escape');
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    const ws = x11('list');
    if (Array.isArray(ws) && !ws.some((w) => w.id === d.id)) return { closed: true, afterMs: 10_000 + (i + 1) * 250, neededClickFocus: true };
  }
  return { closed: false };
}

// ---------------- 按天日志 ----------------
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} /;
function dailyLogs(DATA) {
  const dir = path.join(DATA, 'logs');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^minisd-\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort(); } catch { /* 还没有 */ }
  const text = names.map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('');
  const lines = text.split('\n').filter((l) => l !== '');
  return {
    dir, files: names,
    update: lines.filter((l) => / \[update\] /.test(l)),
    // 时间戳之后不以「[」开头的行：没带前缀混进来的续行（堆栈后几行之类）
    orphans: lines.filter((l) => !STAMP.test(l) || !l.replace(STAMP, '').startsWith('[')),
    installish: lines.filter((l) => /重启并安装|quitAndInstall|[Ii]nstall/.test(l)),
    all: lines,
  };
}

// ---------------- 设置 → 关于 ----------------
async function openAbout(page) {
  const settingsBtn = page.locator('.rail .navit').filter({ hasText: '设置' });
  if (await settingsBtn.count()) await settingsBtn.first().click();
  else await page.locator('.rail .foot .navit').first().click();
  await page.locator('.secnav .secit').first().waitFor({ timeout: 10_000 });
  // 先切「模型」再切「关于」：SecAbout 在 onMounted 里读一次状态，重进才会重读
  await page.locator('.secnav .secit').filter({ hasText: '模型' }).first().click();
  await sleep(300);
  await page.locator('.secnav .secit').filter({ hasText: '关于' }).first().click();
  await page.locator('section.f-sec h2').filter({ hasText: '关于' }).first().waitFor({ timeout: 10_000 });
  await sleep(900);
}
const aboutState = (page) => page.evaluate(() => {
  const sec = [...document.querySelectorAll('section.f-sec')].find((s) => s.querySelector('h2')?.textContent?.trim() === '关于');
  const sl = sec?.querySelector('.statusline');
  return {
    status: sl?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
    bad: sl?.classList.contains('bad') ?? null,
    ver: sec?.querySelector('.ver')?.textContent?.trim() ?? null,
    buttons: [...(sec?.querySelectorAll('.f-btn') ?? [])].map((b) => b.textContent.trim()),
    autoCheckOn: sec?.querySelector('.f-switch input')?.checked ?? null,
  };
});
const bridgeState = (page) => page.evaluate(async () => {
  try { return await window.deskminis.getUpdatePrefs(); } catch (e) { return { error: String(e) }; }
});
async function shotAboutCard(page, name) {
  const card = page.locator('section.f-sec').filter({ has: page.locator('h2', { hasText: '关于' }) }).first();
  try { await card.screenshot({ path: path.join(SHOTS, `${name}-card.png`) }); return true; } catch { return false; }
}

// ================= run1：更新源正常 =================
async function run1() {
  const r = report.run1;
  runTag = 'run1'; feedMode = 'ok';
  r.procsBefore = procs();
  r.appimageBefore = statOf(FAKE_APPIMAGE);
  const L = await launch('run1');
  Object.assign(r, { dataDir: L.DATA, xdgConfig: L.XDG, xdgCache: L.CACHE, stdoutFile: L.outFile, stderrFile: L.errFile, hook: L.hook, launchedAt: L.launchedAt });
  const { app, page } = L;
  const cacheRoot = path.join(L.CACHE, CACHE_DIR_NAME);
  try {
    r.xwindowsAtStart = x11('list');
    // ① 等自动检查 → 下载 → 下载完成框
    const d1 = await waitDialog(90_000);
    r.dialog1 = { xwin: d1, appearedAt: ts(), secondsAfterLaunch: d1 ? +(ts() - L.launchedAt).toFixed(2) : null };
    if (!d1) throw new Error('90 秒内没等到「有新版本可用」对话框');
    log('dialog1', JSON.stringify(d1));
    await sleep(1200);
    r.dialog1.shot = shotDialog('W3-upd-1-downloaded-dialog', d1);
    r.dialog1.xwindows = x11('list');
    let snap = await mainSnap(app);
    const rec1 = snap.w3.dialogs[0] ?? null;
    r.dialog1.mainRecord = rec1;
    r.dialog1.dialogCallsSoFar = snap.w3.dialogs.length;
    r.dialog1.optionsEqualDownloadedDialog = isDeepStrictEqual(rec1?.options, EXPECTED_DIALOG);
    r.dialog1.parentIsMainWindow = rec1?.hasParent === true && rec1.parentId === rec1.mainWindowId;
    r.afterDownload = {
      hits: shortHits(hits.filter((h) => h.run === 'run1')),
      cache: listTree(cacheRoot),
      events: snap.w3.events,
      updater: { autoDownload: snap.autoDownload, autoInstallOnAppQuit: snap.autoInstallOnAppQuit, quitHandlerAdded: snap.quitHandlerAdded, installerPath: snap.installerPath, cacheDir: snap.cacheDir },
    };
    const pendingFile = path.join(cacheRoot, 'pending', FILE);
    r.afterDownload.pendingFile = { path: pendingFile, ...statOf(pendingFile), sha512: fs.existsSync(pendingFile) ? hash(fs.readFileSync(pendingFile), 'sha512', 'base64') : null };
    r.afterDownload.pendingEqualsPayload = r.afterDownload.pendingFile.sha512 === sha512;

    // ② Escape = 「稍后再说」
    r.escape1 = await escapeDialog(d1);
    await sleep(600);
    snap = await mainSnap(app);
    r.escape1.result = snap.w3.dialogs[0]?.result ?? null;
    r.escape1.alive = { exitCode: L.proc.exitCode, signalCode: L.proc.signalCode, windows: snap.windows, pageTitle: await page.title().catch((e) => `ERR ${e}`), rendererAnswers: await page.evaluate(() => 1 + 1).catch(() => null) };
    r.escape1.installCalls = snap.w3.installCalls;
    r.escape1.xwindows = x11('list');
    r.escape1.bridge = await bridgeState(page);
    log('escape1', JSON.stringify(r.escape1.result), r.escape1.closed);

    // ③ 按天日志
    const lg1 = dailyLogs(L.DATA);
    r.log1 = { files: lg1.files, update: lg1.update, orphans: lg1.orphans };

    // ④ 设置 → 关于
    await openAbout(page);
    r.about1 = await aboutState(page);
    r.about1.bridge = await bridgeState(page);
    await page.screenshot({ path: path.join(SHOTS, 'W3-upd-2-about-downloaded.png') });
    r.about1.card = await shotAboutCard(page, 'W3-upd-2-about-downloaded');
    log('about1', JSON.stringify(r.about1.status));

    // ⑤ 现在检查 → 下载完成框再弹
    const hitsBefore = hits.length;
    const cacheBefore = listTree(cacheRoot);
    const pendingBefore = statOf(pendingFile);
    const dialogsBefore = (await mainSnap(app)).w3.dialogs.length;
    r.recheck = { clickedAt: ts() };
    await page.locator('section.f-sec .f-btn').filter({ hasText: '现在检查' }).first().click();
    const d2 = await waitDialog(30_000);
    r.recheck.dialog = d2; r.recheck.appearedAt = ts();
    if (!d2) throw new Error('点「现在检查」后 30 秒内没有再弹出下载完成框');
    for (let i = 0; i < 50; i++) { const s = await aboutState(page); if (!s.buttons.includes('检查中…')) break; await sleep(100); }
    await sleep(1200);
    r.recheck.aboutWhileDialog = await aboutState(page);
    r.recheck.shot = shotDialog('W3-upd-3-recheck-dialog', d2);
    snap = await mainSnap(app);
    const rec2 = snap.w3.dialogs[dialogsBefore] ?? null;
    r.recheck.mainRecord = rec2;
    r.recheck.dialogCallsTotal = snap.w3.dialogs.length;
    r.recheck.optionsEqualDownloadedDialog = isDeepStrictEqual(rec2?.options, EXPECTED_DIALOG);
    r.recheck.parentIsMainWindow = rec2?.hasParent === true && rec2.parentId === rec2.mainWindowId;
    r.recheck.newHits = shortHits(hits.slice(hitsBefore));
    r.recheck.newHitsRaw = hits.slice(hitsBefore);
    r.recheck.cacheBefore = cacheBefore;
    r.recheck.cacheAfter = listTree(cacheRoot);
    r.recheck.pendingBefore = pendingBefore;
    r.recheck.pendingAfter = statOf(pendingFile);
    r.recheck.events = snap.w3.events;
    log('recheck dialog', JSON.stringify(d2), 'newHits', JSON.stringify(r.recheck.newHits));
    r.escape2 = await escapeDialog(d2);
    await sleep(600);
    snap = await mainSnap(app);
    r.escape2.result = rec2 ? snap.w3.dialogs[dialogsBefore]?.result ?? null : null;
    r.escape2.installCalls = snap.w3.installCalls;
    r.escape2.alive = { exitCode: L.proc.exitCode, windows: snap.windows };
    r.aboutAfterEscapeSamePage = await aboutState(page);
    await openAbout(page);
    r.aboutAfterReenter = await aboutState(page);
    r.aboutAfterReenter.bridge = await bridgeState(page);
    await page.screenshot({ path: path.join(SHOTS, 'W3-upd-3b-about-after-recheck.png') });
    const lg2 = dailyLogs(L.DATA);
    r.log2 = { update: lg2.update, orphans: lg2.orphans };

    // 5b（额外）：托盘「检查更新…」——下载完成框的正文许诺「之后从托盘『检查更新…』可以再装」，
    // eb70690 也改了托盘回执 downloaded 一格的说法。调托盘菜单那一项的 click（与用户点托盘是同一个处理器 checkUpdatesFromTray）。
    const tb = r.trayRecheck = {};
    const hitsBeforeTray = hits.length;
    const dlgBeforeTray = (await mainSnap(app)).w3.dialogs.length;
    const logBeforeTray = dailyLogs(L.DATA).update.length;
    const pendingBeforeTray = statOf(pendingFile);
    tb.trayMenuCapturedAt = (await mainSnap(app)).w3.trayMenuCapturedAt;
    tb.clickedAt = ts();
    tb.click = await app.evaluate(() => {
      const it = globalThis.__w3TrayMenu?.items?.find((i) => i.label === '检查更新…');
      if (!it) return 'NO_MENU';
      it.click();
      return 'CLICKED';
    });
    if (tb.click === 'CLICKED') {
      const RECEIPT = '检查更新';
      const until = Date.now() + 30_000;
      let ws = [];
      while (Date.now() < until) {
        ws = x11('list');
        if (Array.isArray(ws) && ws.some((w) => w.name === DIALOG_TITLE) && ws.some((w) => w.name === RECEIPT)) break;
        await sleep(200);
      }
      await sleep(1200);
      ws = x11('list');
      tb.xwindows = ws; // XQueryTree 按叠放次序给出：最后一个在最上面
      tb.shotBoth = x11('shot', path.join(SHOTS, 'W3-upd-5-tray-recheck-both.png'));
      const snapT = await mainSnap(app);
      tb.dialogRecords = snapT.w3.dialogs.slice(dlgBeforeTray);
      const kind = (w) => (w.name === DIALOG_TITLE ? 'downloaded-dialog' : 'receipt');
      const dlgs = (Array.isArray(ws) ? ws : []).filter((w) => w.name === DIALOG_TITLE || w.name === RECEIPT);
      tb.closes = [];
      // 从最上面的开始：先截它、Escape 关掉，再截下面那个、再关
      for (let k = dlgs.length - 1; k >= 0; k--) {
        const d = dlgs[k];
        await sleep(500);
        const shot = shotDialog(`W3-upd-5-tray-${dlgs.length - k}-${kind(d)}`, d);
        const res = await escapeDialog(d);
        tb.closes.push({ order: dlgs.length - k, name: d.name, kind: kind(d), shot, ...res });
      }
      await sleep(600);
      const snapT2 = await mainSnap(app);
      tb.dialogRecordsAfter = snapT2.w3.dialogs.slice(dlgBeforeTray);
      const recs = tb.dialogRecordsAfter;
      const receiptRec = recs.find((x) => x.options?.title === RECEIPT) ?? null;
      const downloadedRec = recs.find((x) => x.options?.title === DIALOG_TITLE) ?? null;
      tb.receiptOptions = receiptRec?.options ?? null;
      tb.receiptResult = receiptRec?.result ?? null;
      tb.receiptHasParent = receiptRec?.hasParent ?? null;
      tb.receiptMatches = {
        available: isDeepStrictEqual(receiptRec?.options, EXPECTED_RECEIPT_AVAILABLE),
        downloaded: isDeepStrictEqual(receiptRec?.options, EXPECTED_RECEIPT_DOWNLOADED),
      };
      tb.downloadedDialogAgain = !!downloadedRec && isDeepStrictEqual(downloadedRec.options, EXPECTED_DIALOG);
      tb.downloadedDialogParentIsMain = downloadedRec?.hasParent === true && downloadedRec.parentId === downloadedRec.mainWindowId;
      tb.downloadedResult = downloadedRec?.result ?? null;
      tb.callOrder = recs.map((x) => ({ at: x.at, title: x.options?.title }));
      tb.newHits = shortHits(hits.slice(hitsBeforeTray));
      tb.newHitsRaw = hits.slice(hitsBeforeTray);
      tb.pendingBefore = pendingBeforeTray;
      tb.pendingAfter = statOf(pendingFile);
      tb.newLogLines = dailyLogs(L.DATA).update.slice(logBeforeTray);
      tb.events = snapT2.w3.events.slice(-3);
      tb.installCalls = snapT2.w3.installCalls;
      tb.alive = { exitCode: L.proc.exitCode, windows: snapT2.windows };
      log('tray recheck', JSON.stringify(tb.callOrder), JSON.stringify(tb.receiptMatches), JSON.stringify(tb.closes.map((c) => [c.kind, c.closed])));
    }

    // ⑥ 关掉之前的底
    r.beforeClose = { appimage: statOf(FAKE_APPIMAGE), cache: listTree(cacheRoot), updater: await mainSnap(app).then((s) => ({ autoInstallOnAppQuit: s.autoInstallOnAppQuit, quitHandlerAdded: s.quitHandlerAdded, quitAndInstallCalled: s.quitAndInstallCalled, installerPath: s.installerPath, installCalls: s.w3.installCalls })) };
  } catch (e) {
    r.error = String(e?.stack ?? e);
    log('run1 error', r.error);
    try { r.errorShot = x11('shot', path.join(SHOTS, 'W3-upd-run1-error-x11.png')); } catch { /* 旁路 */ }
  } finally {
    await shutdown(L, r);
    const lg = dailyLogs(L.DATA);
    const stdout = fs.readFileSync(L.outFile, 'utf8');
    const stderr = fs.readFileSync(L.errFile, 'utf8');
    r.afterClose = {
      appimage: statOf(FAKE_APPIMAGE),
      appimageUnchanged: isDeepStrictEqual(statOf(FAKE_APPIMAGE), r.appimageBefore),
      cache: listTree(cacheRoot),
      marker: fs.existsSync(L.MARKER) ? fs.readFileSync(L.MARKER, 'utf8') : null,
      logUpdate: lg.update,
      logInstallish: lg.installish,
      logTail: lg.all.slice(-12),
      stdoutUpdaterLines: stdout.split('\n').filter((l) => /update|Update|install|Install|download|Download|Checking|Found version|blockmap|differentially/.test(l)),
      stderrUpdaterLines: stderr.split('\n').filter((l) => /\[update\]|update|Update|install|Install|Error/.test(l)).slice(0, 40),
    };
    r.allHits = shortHits(hits.filter((h) => h.run === 'run1'));
  }
}

// ================= run2：latest-linux.yml 回 404 =================
async function run2() {
  const r = report.run2;
  runTag = 'run2'; feedMode = 'yml404';
  r.procsBefore = procs();
  const L = await launch('run2');
  Object.assign(r, { dataDir: L.DATA, xdgConfig: L.XDG, xdgCache: L.CACHE, stdoutFile: L.outFile, stderrFile: L.errFile, hook: L.hook, launchedAt: L.launchedAt });
  const { app, page } = L;
  try {
    // 等 8 秒后的自动检查失败（error 事件），最多 60 秒
    let snap = null;
    for (let i = 0; i < 240; i++) {
      snap = await mainSnap(app);
      if (snap.w3.events.some((e) => e.ev === 'error')) break;
      await sleep(250);
    }
    r.events = snap?.w3.events ?? null;
    r.errorAt = ts();
    await sleep(1500);
    snap = await mainSnap(app);
    r.dialogCalls = snap.w3.dialogs;
    r.xwindows = x11('list');
    r.nativeDialogShown = Array.isArray(r.xwindows) && r.xwindows.some((w) => w.name === DIALOG_TITLE || (w.w < 900 && w.h < 600 && w.w > 100 && w.name !== 'DeskMinis'));
    const lg = dailyLogs(L.DATA);
    r.log = { files: lg.files, update: lg.update, orphans: lg.orphans };
    await openAbout(page);
    r.about = await aboutState(page);
    r.about.bridge = await bridgeState(page);
    await page.screenshot({ path: path.join(SHOTS, 'W3-upd-4-about-error.png') });
    r.about.card = await shotAboutCard(page, 'W3-upd-4-about-error');
    r.hits = shortHits(hits.filter((h) => h.run === 'run2'));
    log('run2 about', JSON.stringify(r.about.status));
  } catch (e) {
    r.error = String(e?.stack ?? e);
    log('run2 error', r.error);
  } finally {
    await shutdown(L, r);
    r.stderrUpdate = fs.readFileSync(L.errFile, 'utf8').split('\n').filter((l) => l.startsWith('[update]')).slice(0, 20);
    r.allHits = shortHits(hits.filter((h) => h.run === 'run2'));
  }
}

try {
  report.procsAtStart = procs();
  await run1();
  await run2();
} catch (e) {
  report.error = String(e?.stack ?? e);
} finally {
  server.close();
  const r1 = report.run1; const r2 = report.run2; const c = report.checks;
  const has = (arr, s) => Array.isArray(arr) && arr.some((l) => l.includes(s));
  c.isPackaged = r1.hook?.isPackaged === true;
  c.appImageUpdater = r1.hook?.updaterClass === 'AppImageUpdater';
  c.dialog1Appeared = !!r1.dialog1?.xwin;
  c.dialog1EqualsDownloadedDialog = r1.dialog1?.optionsEqualDownloadedDialog === true;
  c.dialog1ParentIsMainWindow = r1.dialog1?.parentIsMainWindow === true;
  c.downloadedPayloadVerified = r1.afterDownload?.pendingEqualsPayload === true;
  c.escape1ClosedWithCancel = r1.escape1?.closed === true && r1.escape1?.result?.response === 0;
  c.appAliveAfterEscape1 = r1.escape1?.alive?.exitCode === null && (r1.escape1?.alive?.windows?.length ?? 0) >= 1 && r1.escape1?.alive?.rendererAnswers === 2;
  c.logFound = has(r1.log1?.update, `[update] 发现新版本 ${VERSION}，开始后台下载`);
  c.logDownloaded = has(r1.log1?.update, `[update] 新版本 ${VERSION} 已下载完成，等用户选择何时安装`);
  c.aboutDownloadedText = r1.about1?.status === `新版已下载，还没安装：点「现在检查」会重新弹出安装提示 · ${VERSION}`;
  c.recheckDialogAgain = !!r1.recheck?.dialog && r1.recheck?.optionsEqualDownloadedDialog === true;
  c.recheckFetchedYml = (r1.recheck?.newHitsRaw ?? []).some((h) => h.path === '/latest-linux.yml' && h.status === 200);
  c.recheckNoAppImageDownload = Array.isArray(r1.recheck?.newHitsRaw) && !r1.recheck.newHitsRaw.some((h) => h.path === `/${FILE}`);
  c.recheckCacheFileUntouched = !!r1.recheck?.pendingBefore?.ino && isDeepStrictEqual(r1.recheck.pendingBefore, r1.recheck.pendingAfter);
  c.escape2ClosedWithCancel = r1.escape2?.closed === true && r1.escape2?.result?.response === 0;
  c.noInstallCalls = (r1.beforeClose?.updater?.installCalls?.length ?? -1) === 0 && r1.afterClose?.marker === null;
  c.appimageUnchanged = r1.afterClose?.appimageUnchanged === true;
  c.noInstallLinesInLog = Array.isArray(r1.afterClose?.logInstallish) && r1.afterClose.logInstallish.length === 0;
  c.run1ExitedClean = r1.exit?.code === 0 && (r1.procsAfter?.length ?? 1) === 0;
  c.run2ErrorLoggedMultiline = (r2.log?.update?.length ?? 0) >= 2 && (r2.log?.orphans?.length ?? 1) === 0;
  c.run2NoDialog = Array.isArray(r2.dialogCalls) && r2.dialogCalls.length === 0 && r2.nativeDialogShown === false;
  c.run2AboutError = typeof r2.about?.status === 'string' && r2.about.status.startsWith('更新失败 · ') && r2.about?.bad === true;
  c.run2ExitedClean = r2.exit?.code === 0 && (r2.procsAfter?.length ?? 1) === 0;
  report.pass = Object.values(c).every(Boolean);
  // 额外观察（不计入 pass）：托盘路径与重检后关于页的状态行
  const tb = r1.trayRecheck ?? {};
  report.observations = {
    trayMenuCaptured: tb.click === 'CLICKED',
    trayDownloadedDialogAgain: tb.downloadedDialogAgain ?? null,
    trayReceiptIs: tb.receiptMatches?.downloaded ? 'downloaded' : tb.receiptMatches?.available ? 'available' : (tb.receiptOptions ? 'other' : null),
    trayReceiptMessage: tb.receiptOptions?.message ?? null,
    trayNoAppImageDownload: Array.isArray(tb.newHitsRaw) ? !tb.newHitsRaw.some((h) => h.path === `/${FILE}`) : null,
    trayClosedBoth: Array.isArray(tb.closes) ? tb.closes.every((x) => x.closed) && tb.receiptResult?.response === 0 && tb.downloadedResult?.response === 0 : null,
    aboutStatusRightAfterRecheck: r1.recheck?.aboutWhileDialog?.status ?? null,
    aboutStatusAfterReenter: r1.aboutAfterReenter?.status ?? null,
  };
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'W3-upd-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: c, pass: report.pass, observations: report.observations }, null, 2));
}
