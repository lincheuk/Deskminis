// W3-updb 实拍（Linux + xvfb）：真 electron-updater（Linux 上是 AppImageUpdater）+ 本地 generic 更新源，针对 b893f6e（W3-updb）。
// 由 W3-upd-live.mjs 复制改来（原驱动不动）：工作目录 /home/user/wt-updb/deskminis，产物 $S/W3-updb-out/，截图 $S/hemo-shots/W3-updb-*；
// 期望值按 b893f6e 改——下载完成框与托盘回执仍直接 import worktree 里的真函数（downloadedDialog / manualCheckDialog）做 isDeepStrictEqual，
// 任务单给的新字另写死一份，与 import 来的函数、SecAbout.vue 源码互证（import 错了版本就对不上）。
//
//   run1（更新源正常，0.3.99）：
//     ① 启动 8 秒后自动检查 → 后台下载 → 原生「有新版本可用」框：X11 截整屏；主进程记下的实参与 downloadedDialog('0.3.99') 逐字段比
//     ② XTest 按 Escape（取消键 = 「稍后再说」）：框关掉、response 0、应用还在
//     ③ 按天日志 [update] 行：「发现新版本 X：后台下载安装包（已经下载过的只核对一遍）」「新版本 X 已下载完成…」，另有 electron-updater 自己的行
//     ④ 设置 → 关于：状态行「新版已下载，还没安装：联网时点「现在检查」会重新弹出安装提示 · 0.3.99」
//     ⑤ 「现在检查」：下载完成框再弹；关于页状态行说「已下载」（W3-updb 修的就是这里，eb70690 上是「有新版本」）；不重下安装包
//     5b 托盘「检查更新…」（调托盘菜单那一项的 click，与用户点托盘同一个处理器）：下载完成框再弹、回执是 downloaded 那一格；两个框的先后与间隔
//     ⑥ app.close()：APPIMAGE 占位文件原样、install / quitAndInstall 零调用、日志里没有安装相关的行、没有残留进程
//   run2（新临时目录，latest-linux.yml 回 404）：
//     ⑦ 自动检查失败：日志原文逐行带 [update]、接「错误码：」；没有弹框；关于页「更新失败 · <一句中文>」
//   run3（新临时目录，latest-linux.yml 正常、安装包本身回 404）——场景 8：
//     ⑧ 自动检查 → 下载失败：关于页「更新失败 · <一句中文>」；日志有出错原文；<数据根>/logs/crashes.json 没有 unhandled_rejection；
//        stderr 没有「未处理的 Promise 拒绝」；主进程里另挂的 unhandledRejection 旁听监听零次。再从关于页「现在检查」手动失败一次，同样看一遍。
//     探针（验证检测手段）：两次都量完后，在同一进程里故意 Promise.reject 一次不接，确认 crashes.json / stderr / 按天日志 / 旁听监听都记得到。
//   每一轮收尾都看 crashes.json、stderr 与旁听记录。
// 第二版（第一次跑之后改的，只改驱动）：
//   - 关于页点击前状态行已是「已下载」，光看它不变不够直接：包一层 ipcMain 的 'update:check' 处理器，记返回值与起止时刻（原样转发）；
//   - 托盘两个框叠着时，第一下 Escape 关掉的是下面的下载完成框、不是上面的回执，单框截图没拍到；
//   - 场景 8 末尾加探针。
// 第三版：第二版「先点回执正文再 Escape」关掉的仍是下载完成框——它有父窗口，在 GTK 下是模态的，抓着整个应用的输入。
//   改成先 Escape 关下载完成框、确认回执还在、单独截回执、再关回执。
//
// 「已打包」：node_modules/electron/dist 硬链接复制到 $S/W3-updb-pkgsim，electron 改名 deskminis（app.isPackaged 为真），
//   resources/app-update.yml 是新建的文件（generic 源 + updaterCacheDirName），不碰硬链接的原文件。
// AppImageUpdater 只在设了 APPIMAGE 时工作：指向 $S/W3-updb-fake.AppImage（占位文件）。XDG_CACHE_HOME 指临时目录，
//   更新缓存不落到真实的 ~/.cache。数据根、Chromium 配置目录都是 mkdtemp 临时目录；不写 update-prefs.json（就是要它自动检查）。
// 主进程里只加「旁听」，不改行为：包一层 dialog.showMessageBox 记实参、调用时刻与返回值；给 autoUpdater 多挂几个事件监听记时间；
//   install / quitAndInstall 记调用（照常转发）；process 上多挂一个 unhandledRejection 监听只做记录
//   （应用自己的崩溃钩子早已挂着，多一个监听不改变 Node 的处理方式）。不碰 downloadPromise（挂任何处理都会把拒绝「接住」，测不出应用自己接没接）。
// 用法：NODE_PATH=$S/driver/node_modules xvfb-run -a node W3-updb-live.mjs
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
const { _electron: electron } = createRequire(import.meta.url)('playwright-core');

const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const APP_DIR = '/home/user/wt-updb/deskminis';
const SIM = path.join(S, 'W3-updb-pkgsim');
const EXE = path.join(SIM, 'deskminis');
const APP_UPDATE_YML = path.join(SIM, 'resources', 'app-update.yml');
const X11 = path.join(S, 'hemo-drivers/W2b-6b-x11.py');
const SHOTS = path.join(S, 'hemo-shots');
const OUT = path.join(S, 'W3-updb-out');
const FAKE_APPIMAGE = path.join(S, 'W3-updb-fake.AppImage');
const CACHE_DIR_NAME = 'deskminis-updater-w3updb';
const VERSION = '0.3.99';
const CURRENT = '0.3.0';
const FILE = `DeskMinis-${VERSION}.AppImage`;
const DIALOG_TITLE = '有新版本可用';
const RECEIPT_TITLE = '检查更新';
const PROBE_TEXT = 'W3-updb 探针：故意不接的拒绝（验证检测手段）';
const shotFile =(name) => path.join(SHOTS, `W3-updb-${name}.png`);
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

// b893f6e 的真函数（Node 22 类型剥离直接 import TS 源），不手抄文案
const { downloadedDialog, manualCheckDialog, describeUpdateError, MANUAL_CHECK_SETTLE_MS } = await import(path.join(APP_DIR, 'src/main/update-status.ts'));
const EXPECTED_DIALOG = downloadedDialog(VERSION);
const EXPECTED_RECEIPT_AVAILABLE = manualCheckDialog({ status: 'available', version: VERSION }, CURRENT);
const EXPECTED_RECEIPT_DOWNLOADED = manualCheckDialog({ status: 'downloaded', version: VERSION }, CURRENT);
// 任务单给的 b893f6e 新字（写死一份，与上面 import 的函数、SecAbout.vue 源码互证）
const NEW_TEXT = {
  dialogFirstTail: '最后一页点完成就会打开新版。',
  dialogSecondTail: '关掉 DeskMinis 不会自动安装，之后联网时从托盘「检查更新…」可以再装。',
  receiptMessage: `新版本 ${VERSION} 已下载完成`,
  receiptDetailHead: '在「有新版本可用」的提示里点「重启并安装」才会安装',
  aboutDownloaded: '新版已下载，还没安装：联网时点「现在检查」会重新弹出安装提示',
};
const ABOUT_DOWNLOADED = `${NEW_TEXT.aboutDownloaded} · ${VERSION}`;
const LOG_FOUND = `[update] 发现新版本 ${VERSION}：后台下载安装包（已经下载过的只核对一遍）`;
const LOG_FOUND_OLD = `[update] 发现新版本 ${VERSION}，开始后台下载`;
const LOG_DOWNLOADED = `[update] 新版本 ${VERSION} 已下载完成，等用户选择何时安装`;
const secAboutSrc = fs.readFileSync(path.join(APP_DIR, 'src/renderer/src/ui/settings/SecAbout.vue'), 'utf8');
const SRC_ABOUT_DOWNLOADED = /\bdownloaded: '([^']*)'/.exec(secAboutSrc)?.[1] ?? null;
const detailLines = String(EXPECTED_DIALOG.detail ?? '').split('\n');
const textGuards = {
  dialogFirstLine: detailLines[0] ?? null,
  dialogSecondLine: detailLines[1] ?? null,
  dialogFirstIsNew: detailLines[0]?.endsWith(NEW_TEXT.dialogFirstTail) === true,
  dialogSecondIsNew: detailLines[1]?.endsWith(NEW_TEXT.dialogSecondTail) === true,
  receiptMessageIsNew: EXPECTED_RECEIPT_DOWNLOADED.message === NEW_TEXT.receiptMessage,
  receiptDetailIsNew: typeof EXPECTED_RECEIPT_DOWNLOADED.detail === 'string' && EXPECTED_RECEIPT_DOWNLOADED.detail.startsWith(NEW_TEXT.receiptDetailHead),
  aboutSrcDownloaded: SRC_ABOUT_DOWNLOADED,
  aboutSrcIsNew: SRC_ABOUT_DOWNLOADED === NEW_TEXT.aboutDownloaded,
  manualCheckSettleMs: MANUAL_CHECK_SETTLE_MS,
};

const T0 = Date.now();
const ts = () => +((Date.now() - T0) / 1000).toFixed(3);
const log = (...a) => console.error(`[W3-updb +${ts()}s]`, ...a);
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
      .filter((l) => /W3-updb-pkgsim|wt-updb\/deskminis/.test(l) && !/\bps -eo\b/.test(l));
  } catch { return []; }
};
const shortHits = (arr) => arr.map((h) => `${h.t}s ${h.run} ${h.method} ${h.url}${h.range ? ` [Range ${h.range}]` : ''} -> ${h.status} ${h.bytes}B${h.finished ? '' : ' (未发完)'}`);
let gitHead = null;
try { gitHead = execFileSync('git', ['-C', APP_DIR, 'log', '--oneline', '-1'], { encoding: 'utf8' }).trim(); } catch (e) { gitHead = `ERR ${e}`; }

const report = {
  startedAt: new Date().toISOString(), exe: EXE, appDir: APP_DIR, gitHead, textGuards,
  expectedDialog: EXPECTED_DIALOG, expectedReceiptDownloaded: EXPECTED_RECEIPT_DOWNLOADED, expectedAboutDownloaded: ABOUT_DOWNLOADED,
  run1: {}, run2: {}, run3: {}, checks: {},
};

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
let feedMode = 'ok';   // ok | yml404 | appimage404
let runTag = 'run1';
const hits = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const hit = { t: ts(), atMs: Date.now(), run: runTag, mode: feedMode, method: req.method, url: req.url, path: u.pathname, range: req.headers.range ?? null, status: 0, bytes: 0, finished: false };
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
  if (req.method === 'GET' && u.pathname === `/${FILE}` && !req.headers.range) {
    // 场景 8：版本信息正常，安装包本身回 404（Release 里漏传了安装包）
    if (feedMode === 'appimage404') return send(404, Buffer.from('Not Found\n'), 'text/plain');
    return send(200, payload, 'application/octet-stream');
  }
  // blockmap、带 Range 的差分请求、别的路径一律 404：差分下载失败会退回整包下载
  return send(404, Buffer.from('Not Found\n'), 'text/plain');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
// 场景 8 状态行的期望：把 builder-util-runtime 下载 404 的原话交给 worktree 里的 describeUpdateError
const EXPECTED_DLFAIL_TEXT = describeUpdateError(new Error(`Cannot download "http://127.0.0.1:${PORT}/${FILE}", status 404: Not Found`));
report.expectedDownloadFailText = EXPECTED_DLFAIL_TEXT;

// 打包形态下 electron-updater 读 process.resourcesPath/app-update.yml：新建文件（先删本目录里的这个名字，不会碰到硬链接的原文件）
fs.rmSync(APP_UPDATE_YML, { force: true });
fs.writeFileSync(APP_UPDATE_YML, `provider: generic\nurl: http://127.0.0.1:${PORT}/\nupdaterCacheDirName: ${CACHE_DIR_NAME}\n`);
report.appUpdateYml = { path: APP_UPDATE_YML, text: fs.readFileSync(APP_UPDATE_YML, 'utf8'), nlink: fs.statSync(APP_UPDATE_YML).nlink };

// ---------------- 主进程里的旁听（不改行为） ----------------
function hookMain({ dialog, BrowserWindow, Menu, ipcMain, app: a }, arg) {
  const { createRequire } = process.getBuiltinModule('node:module');
  const nodeFs = process.getBuiltinModule('node:fs');
  // 与主进程 import 的是同一个 CJS 单例（按真实路径缓存）
  const { autoUpdater } = createRequire(arg.appDir + '/package.json')('electron-updater');
  const g = globalThis;
  const now = () => new Date().toISOString();
  const hr = () => (typeof performance !== 'undefined' ? performance.now() : null);
  g.__w3 = { dialogs: [], events: [], installCalls: [], unhandled: [], ipcCheck: [], trayMenuCapturedAt: null };
  // 关于页「现在检查」走 ipcMain.handle('update:check')：包一层只记返回值与起止时刻，原样转发（Electron 38 的 ipcMain
  // 把处理器放在 _invokeHandlers 这个 Map 里，每次 invoke 现取，所以换掉 Map 里的这一项就行）
  let ipcCheckWrapped = false;
  const ih = ipcMain?._invokeHandlers;
  if (ih instanceof Map && typeof ih.get('update:check') === 'function') {
    const origH = ih.get('update:check');
    ih.set('update:check', async function (...hargs) {
      const rec = { startAt: now(), startAtMs: Date.now(), startHr: hr(), result: null, endAtMs: null, endHr: null, error: null };
      g.__w3.ipcCheck.push(rec);
      try {
        const v = await origH.apply(this, hargs);
        rec.result = JSON.parse(JSON.stringify(v ?? null)); rec.endAtMs = Date.now(); rec.endHr = hr();
        return v;
      } catch (e) { rec.error = String(e); rec.endAtMs = Date.now(); rec.endHr = hr(); throw e; }
    });
    ipcCheckWrapped = true;
  }
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
    const rec = { at: now(), atMs: Date.now(), hr: hr(), hasParent, parentId: hasParent ? args[0].id : null, mainWindowId: main?.id ?? null, options: JSON.parse(JSON.stringify(opts ?? null)), result: null };
    g.__w3.dialogs.push(rec);
    const p = orig.apply(this, args);
    Promise.resolve(p).then((r) => { rec.result = { response: r?.response, checkboxChecked: r?.checkboxChecked, at: now() }; },
      (e) => { rec.result = { error: String(e), at: now() }; });
    return p;
  };
  for (const ev of ['checking-for-update', 'update-available', 'update-not-available', 'update-downloaded', 'update-cancelled', 'error']) {
    autoUpdater.on(ev, (x) => {
      let error = null; let code = null;
      if (ev === 'error') {
        try { error = String(x?.message ?? x).split('\n')[0]; } catch { error = '（转不成文字）'; }
        try { code = typeof x?.code === 'string' ? x.code : null; } catch { code = null; }
      }
      g.__w3.events.push({ at: now(), atMs: Date.now(), hr: hr(), ev, version: x?.version ?? null, downloadedFile: x?.downloadedFile ?? null, error, code });
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
  // 旁听：只记录主进程里的未处理拒绝（应用的 W2b-7 钩子照常记 crashes.json；这里是第二个见证）
  process.on('unhandledRejection', (reason) => {
    let text; try { text = String(reason?.stack ?? reason); } catch { text = '（转不成文字）'; }
    g.__w3.unhandled.push({ at: now(), text: text.slice(0, 4000) });
  });
  return {
    isPackaged: a.isPackaged, execPath: process.execPath, resourcesPath: process.resourcesPath, version: a.getVersion(),
    userData: a.getPath('userData'), updaterClass: autoUpdater.constructor.name,
    envAPPIMAGE: process.env.APPIMAGE ?? null, envXDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? null,
    dialogPatched: dialog.showMessageBox !== orig,
    unhandledListenersAfterHook: process.listenerCount('unhandledRejection'),
    ipcCheckWrapped,
  };
}
const mainSnap = (app) => app.evaluate(({ BrowserWindow }, arg) => {
  const { createRequire } = process.getBuiltinModule('node:module');
  const { autoUpdater: u } = createRequire(arg.appDir + '/package.json')('electron-updater');
  const lg = u.logger;
  return {
    windows: BrowserWindow.getAllWindows().map((x) => ({ id: x.id, visible: x.isVisible(), destroyed: x.isDestroyed(), title: x.getTitle() })),
    autoDownload: u.autoDownload, autoInstallOnAppQuit: u.autoInstallOnAppQuit,
    quitHandlerAdded: u.quitHandlerAdded ?? null, quitAndInstallCalled: u.quitAndInstallCalled ?? null,
    installerPath: u.installerPath ?? null, cacheDir: u.downloadedUpdateHelper?.cacheDir ?? null,
    logger: { isConsole: lg === console, info: typeof lg?.info, warn: typeof lg?.warn, error: typeof lg?.error, debug: typeof lg?.debug },
    unhandledListeners: process.listenerCount('unhandledRejection'),
    w3: globalThis.__w3,
  };
}, { appDir: APP_DIR });

// ---------------- 启动 ----------------
async function launch(tag) {
  const DATA = fs.mkdtempSync(path.join(S, `W3-updb-${tag}-data-`));
  const XDG = fs.mkdtempSync(path.join(S, `W3-updb-${tag}-xdg-`));
  const CACHE = fs.mkdtempSync(path.join(S, `W3-updb-${tag}-cache-`));
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
  const full = x11('shot', shotFile(name));
  let crop = null;
  if (d && full?.w) {
    const pad = 24;
    const cx = Math.max(0, d.x - pad); const cy = Math.max(0, d.y - pad);
    const cw = Math.min(full.w - cx, d.w + pad * 2); const ch = Math.min(full.h - cy, d.h + pad * 2);
    crop = x11('shot', shotFile(`${name}-crop`), String(cx), String(cy), String(cw), String(ch));
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

// ---------------- 按天日志、崩溃记录、stderr ----------------
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
    updater: lines.filter((l) => / \[update\] electron-updater/.test(l)),
    // 时间戳之后不以「[」开头的行：没带前缀混进来的续行（堆栈后几行之类）
    orphans: lines.filter((l) => !STAMP.test(l) || !l.replace(STAMP, '').startsWith('[')),
    installish: lines.filter((l) => /重启并安装|quitAndInstall|[Ii]nstall/.test(l)),
    // W2b-7 崩溃钩子顺手写进按天日志的那两种行
    mainCrash: lines.filter((l) => /\[main\] (未处理的 Promise 拒绝|未捕获异常)/.test(l)),
    all: lines,
  };
}
function crashInfo(DATA) {
  const p = path.join(DATA, 'logs', 'crashes.json');
  if (!fs.existsSync(p)) return { path: p, exists: false, records: [], unhandledRejection: [] };
  let records = null; let parseError = null;
  try { records = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { parseError = String(e); }
  const arr = Array.isArray(records) ? records : [];
  return { path: p, exists: true, parseError, records: arr, unhandledRejection: arr.filter((x) => x?.kind === 'unhandled_rejection') };
}
function stderrScan(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = text.split('\n');
  return {
    bytes: text.length,
    unhandled: lines.filter((l) => /未处理的 Promise 拒绝|未捕获异常|unhandled ?rejection|UnhandledPromiseRejection/i.test(l)),
    update: lines.filter((l) => l.startsWith('[update]')),
  };
}
const noCrash = (c) => c && (!c.exists || (c.parseError === null && c.unhandledRejection.length === 0));

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
  try { await card.screenshot({ path: shotFile(`${name}-card`) }); return shotFile(`${name}-card`); } catch (e) { return `ERR ${e}`; }
}
// 渲染端记下状态行与按钮文字的每一次变化（Date.now() 与主进程同一个时钟），好算「状态行比下载完成框晚多少」
const watchAbout = (page) => page.evaluate(() => {
  const sec = [...document.querySelectorAll('section.f-sec')].find((s) => s.querySelector('h2')?.textContent?.trim() === '关于');
  const sl = sec?.querySelector('.statusline');
  const btn = sec?.querySelector('.f-btn');
  const rec = [];
  window.__w3about = rec;
  const snap = (why) => rec.push({ atMs: Date.now(), why, status: sl?.textContent?.replace(/\s+/g, ' ').trim() ?? null, btn: btn?.textContent?.trim() ?? null });
  snap('start');
  window.__w3aboutMo?.disconnect();
  const mo = new MutationObserver(() => snap('mutation'));
  if (sl) mo.observe(sl, { childList: true, characterData: true, subtree: true, attributes: true });
  if (btn) mo.observe(btn, { childList: true, characterData: true, subtree: true, attributes: true });
  window.__w3aboutMo = mo;
  return rec.length;
});
const readAboutWatch = (page) => page.evaluate(() => { window.__w3aboutMo?.disconnect(); return window.__w3about ?? null; });
const clickCheckNow = (page) => page.locator('section.f-sec .f-btn').filter({ hasText: '现在检查' }).first().click();
const uniqSeq = (arr) => arr.filter((v, i) => i === 0 || v !== arr[i - 1]);

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
  const pendingFile = path.join(cacheRoot, 'pending', FILE);
  try {
    r.xwindowsAtStart = x11('list');
    // ① 等自动检查 → 下载 → 下载完成框
    const d1 = await waitDialog(90_000);
    r.dialog1 = { xwin: d1, appearedAt: ts(), secondsAfterLaunch: d1 ? +(ts() - L.launchedAt).toFixed(2) : null };
    if (!d1) throw new Error('90 秒内没等到「有新版本可用」对话框');
    log('dialog1', JSON.stringify(d1));
    await sleep(1200);
    r.dialog1.shot = shotDialog('1-downloaded-dialog', d1);
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
      logger: snap.logger,
      unhandledListeners: snap.unhandledListeners,
      updater: { autoDownload: snap.autoDownload, autoInstallOnAppQuit: snap.autoInstallOnAppQuit, quitHandlerAdded: snap.quitHandlerAdded, installerPath: snap.installerPath, cacheDir: snap.cacheDir },
    };
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
    await page.screenshot({ path: shotFile('2-about-downloaded') });
    r.about1.card = await shotAboutCard(page, '2-about-downloaded');
    log('about1', JSON.stringify(r.about1.status));

    // ⑤ 现在检查 → 下载完成框再弹；关于页状态行应说「已下载」
    const hitsBefore = hits.length;
    const cacheBefore = listTree(cacheRoot);
    const pendingBefore = statOf(pendingFile);
    const snapB = await mainSnap(app);
    const dialogsBefore = snapB.w3.dialogs.length;
    const eventsBefore = snapB.w3.events.length;
    const ipcBefore = snapB.w3.ipcCheck.length;
    const logBefore = dailyLogs(L.DATA).update.length;
    await watchAbout(page);
    r.recheck = { clickedAt: ts(), clickedAtMs: Date.now() };
    await clickCheckNow(page);
    const d2 = await waitDialog(30_000);
    r.recheck.dialog = d2; r.recheck.appearedAt = ts(); r.recheck.x11SeenAtMs = Date.now();
    if (!d2) throw new Error('点「现在检查」后 30 秒内没有再弹出下载完成框');
    for (let i = 0; i < 50; i++) { const s = await aboutState(page); if (!s.buttons.includes('检查中…')) break; await sleep(100); }
    await sleep(1200);
    r.recheck.aboutWhileDialog = await aboutState(page);
    r.recheck.aboutWatch = await readAboutWatch(page);
    r.recheck.shot = shotDialog('3-recheck-dialog', d2);
    r.recheck.aboutCardWhileDialog = await shotAboutCard(page, '3a-about-after-check');
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
    r.recheck.events = snap.w3.events.slice(eventsBefore);
    r.recheck.ipcCheck = snap.w3.ipcCheck.slice(ipcBefore);
    r.recheck.newLogLines = dailyLogs(L.DATA).update.slice(logBefore);
    {
      const w = r.recheck.aboutWatch ?? [];
      const evAt = (name) => r.recheck.events.find((e) => e.ev === name) ?? null;
      const iChecking = w.findIndex((x) => x.btn === '检查中…');
      const btnBack = iChecking >= 0 ? w.slice(iChecking).find((x) => x.btn === '现在检查') ?? null : null;
      const ipc = r.recheck.ipcCheck[0] ?? null;
      r.recheck.timing = {
        // 注：旁听的事件监听挂在应用自己的监听之后，update-downloaded 的时刻里含应用处理器同步建 GTK 对话框的那几毫秒；
        // 「下载完成」的时刻以主进程 showMessageBox 被调用的时刻（dialogCall）为准
        statusBeforeClick: w[0]?.status ?? null,
        availableEventToDialogCallMs: evAt('update-available') && rec2?.hr != null ? +(rec2.hr - evAt('update-available').hr).toFixed(2) : null,
        ipcResult: ipc?.result ?? null,
        ipcDurationMs: ipc?.endHr != null ? +(ipc.endHr - ipc.startHr).toFixed(2) : null,
        ipcReturnAfterDialogCallMs: ipc?.endHr != null && rec2?.hr != null ? +(ipc.endHr - rec2.hr).toFixed(2) : null,
        ipcReturnAfterDownloadedEventMs: ipc?.endHr != null && evAt('update-downloaded') ? +(ipc.endHr - evAt('update-downloaded').hr).toFixed(2) : null,
        checkingEventAtMs: evAt('checking-for-update')?.atMs ?? null,
        availableEventAtMs: evAt('update-available')?.atMs ?? null,
        downloadedEventAtMs: evAt('update-downloaded')?.atMs ?? null,
        availableToDownloadedEventMs: evAt('update-available') && evAt('update-downloaded') ? +(evAt('update-downloaded').hr - evAt('update-available').hr).toFixed(2) : null,
        dialogCallAtMs: rec2?.atMs ?? null,
        buttonBackAtMs: btnBack?.atMs ?? null,
        buttonBackAfterDialogCallMs: btnBack && rec2 ? btnBack.atMs - rec2.atMs : null,
        statusesSeen: uniqSeq(w.map((x) => x.status)),
        buttonsSeen: uniqSeq(w.map((x) => x.btn)),
      };
    }
    log('recheck dialog', JSON.stringify(d2), 'about', JSON.stringify(r.recheck.aboutWhileDialog.status), 'timing', JSON.stringify(r.recheck.timing));
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
    await page.screenshot({ path: shotFile('3b-about-after-recheck') });
    const lg2 = dailyLogs(L.DATA);
    r.log2 = { update: lg2.update, orphans: lg2.orphans };

    // 5b 托盘「检查更新…」：调托盘菜单那一项的 click（与用户点托盘是同一个处理器 checkUpdatesFromTray）
    const tb = r.trayRecheck = {};
    const snapT0 = await mainSnap(app);
    const hitsBeforeTray = hits.length;
    const dlgBeforeTray = snapT0.w3.dialogs.length;
    const evBeforeTray = snapT0.w3.events.length;
    const logBeforeTray = dailyLogs(L.DATA).update.length;
    const pendingBeforeTray = statOf(pendingFile);
    tb.trayMenuCapturedAt = snapT0.w3.trayMenuCapturedAt;
    tb.clickedAt = ts();
    const clickRes = await app.evaluate(() => {
      const it = globalThis.__w3TrayMenu?.items?.find((i) => i.label === '检查更新…');
      if (!it) return { click: 'NO_MENU' };
      const atMs = Date.now(); const hr = typeof performance !== 'undefined' ? performance.now() : null;
      it.click();
      return { click: 'CLICKED', atMs, hr };
    });
    Object.assign(tb, { click: clickRes.click, clickAtMs: clickRes.atMs ?? null, clickHr: clickRes.hr ?? null });
    if (tb.click === 'CLICKED') {
      // 紧着轮询 X11，记两个框各自第一次被看到的时刻（每次 list 要起一个 python，分辨率几十毫秒；精确的先后看主进程的调用时刻）
      const firstSeen = {};
      const until = Date.now() + 30_000;
      let ws = [];
      while (Date.now() < until) {
        ws = x11('list');
        const seenAt = Date.now();
        if (Array.isArray(ws)) {
          for (const w of ws) if ((w.name === DIALOG_TITLE || w.name === RECEIPT_TITLE) && !firstSeen[w.name]) firstSeen[w.name] = { atMs: seenAt, id: w.id, stackIndex: ws.indexOf(w), stackAtThatMoment: ws.map((x) => x.name) };
        }
        if (firstSeen[DIALOG_TITLE] && firstSeen[RECEIPT_TITLE]) break;
        await sleep(10);
      }
      tb.x11FirstSeen = firstSeen;
      await sleep(1200);
      ws = x11('list');
      tb.xwindows = ws; // XQueryTree 按叠放次序给出：最后一个在最上面（没有窗口管理器，后映射的在上面）
      tb.stackOrderBottomToTop = Array.isArray(ws) ? ws.map((w) => w.name) : null;
      tb.shotBoth = x11('shot', shotFile('5-tray-recheck-both'));
      const snapT = await mainSnap(app);
      tb.dialogRecords = snapT.w3.dialogs.slice(dlgBeforeTray);
      const dDl = (Array.isArray(ws) ? ws : []).find((w) => w.name === DIALOG_TITLE) ?? null;
      const dRc = (Array.isArray(ws) ? ws : []).find((w) => w.name === RECEIPT_TITLE) ?? null;
      tb.closes = [];
      // 关框顺序（第三版）：有父窗口的下载完成框在 GTK 下是模态的，抓着整个应用的键盘与鼠标；叠在它上面的回执（没有父窗口）
      // 在它关掉之前收不到 Escape——第二版「先点回执正文再 Escape」实测关掉的仍是下载完成框。所以：
      //   ① 两框同屏时截一张叠放区域的裁剪（回执在上，下载完成框只露出按钮行）；② Escape 关下载完成框，确认回执还在；
      //   ③ 单独截回执；④ Escape 关回执。每步都记关前关后 X11 上还剩哪些框、主进程里哪个框的返回值落定了。
      const names = (w) => (Array.isArray(w) ? w.map((x) => `${x.name}#${x.id}`) : w);
      const mainResults = async () => (await mainSnap(app)).w3.dialogs.slice(dlgBeforeTray).map((x) => ({ title: x.options?.title, response: x.result?.response ?? null, at: x.result?.at ?? null }));
      if (dDl && dRc) {
        const union = { x: 0, y: 0, w: Math.max(dDl.x + dDl.w, dRc.x + dRc.w), h: Math.max(dDl.y + dDl.h, dRc.y + dRc.h) };
        tb.shotStacked = shotDialog('5-tray-1-stacked', union);
        const before1 = x11('list');
        const res1 = await escapeDialog(dDl);
        await sleep(800);
        const after1 = x11('list');
        tb.closes.push({ step: 'Escape → 下载完成框', kind: 'downloaded-dialog', ...res1, windowsBefore: names(before1), windowsAfter: names(after1), mainResultsAfter: await mainResults() });
        const stillRc = Array.isArray(after1) ? after1.find((w) => w.id === dRc.id) ?? null : null;
        if (stillRc) {
          await sleep(300);
          tb.shotReceiptAlone = shotDialog('5-tray-2-receipt-alone', stillRc);
          const before2 = x11('list');
          const res2 = await escapeDialog(stillRc);
          await sleep(800);
          const after2 = x11('list');
          tb.closes.push({ step: 'Escape → 回执', kind: 'receipt', ...res2, windowsBefore: names(before2), windowsAfter: names(after2), mainResultsAfter: await mainResults() });
        } else {
          tb.closes.push({ step: '回执已不在', kind: 'receipt', closed: null, windowsAfter: names(after1) });
        }
      }
      await sleep(600);
      const snapT2 = await mainSnap(app);
      const recs = tb.dialogRecordsAfter = snapT2.w3.dialogs.slice(dlgBeforeTray);
      const receiptRec = recs.find((x) => x.options?.title === RECEIPT_TITLE) ?? null;
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
      tb.callOrder = recs.map((x) => ({ at: x.at, atMs: x.atMs, hr: x.hr, title: x.options?.title }));
      const evs = tb.events = snapT2.w3.events.slice(evBeforeTray);
      const evDl = evs.find((e) => e.ev === 'update-downloaded') ?? null;
      const evAv = evs.find((e) => e.ev === 'update-available') ?? null;
      const fsDlg = firstSeen[DIALOG_TITLE]; const fsRcp = firstSeen[RECEIPT_TITLE];
      tb.timing = {
        mainCallOrder: recs.map((x) => x.options?.title),
        clickToAvailableEventMs: evAv && tb.clickHr != null ? +(evAv.hr - tb.clickHr).toFixed(2) : null,
        clickToDownloadedEventMs: evDl && tb.clickHr != null ? +(evDl.hr - tb.clickHr).toFixed(2) : null,
        clickToDownloadedDialogMs: downloadedRec && tb.clickHr != null ? +(downloadedRec.hr - tb.clickHr).toFixed(2) : null,
        clickToReceiptMs: receiptRec && tb.clickHr != null ? +(receiptRec.hr - tb.clickHr).toFixed(2) : null,
        availableEventToDownloadedDialogMs: evAv && downloadedRec ? +(downloadedRec.hr - evAv.hr).toFixed(2) : null,
        receiptAfterDownloadedDialogMs: receiptRec && downloadedRec ? +(receiptRec.hr - downloadedRec.hr).toFixed(2) : null,
        receiptAfterDownloadedDialogWallMs: receiptRec && downloadedRec ? receiptRec.atMs - downloadedRec.atMs : null,
        receiptAfterDownloadedEventMs: receiptRec && evDl ? +(receiptRec.hr - evDl.hr).toFixed(2) : null,
        x11FirstSeenOrder: Object.entries(firstSeen).sort((p, q) => p[1].atMs - q[1].atMs).map(([n, v]) => ({ name: n, atMs: v.atMs, afterClickMs: tb.clickAtMs != null ? v.atMs - tb.clickAtMs : null })),
        x11ReceiptSeenAfterDialogMs: fsDlg && fsRcp ? fsRcp.atMs - fsDlg.atMs : null,
        stackOrderBottomToTop: tb.stackOrderBottomToTop,
        manualCheckSettleMs: MANUAL_CHECK_SETTLE_MS,
      };
      tb.newHits = shortHits(hits.slice(hitsBeforeTray));
      tb.newHitsRaw = hits.slice(hitsBeforeTray);
      tb.pendingBefore = pendingBeforeTray;
      tb.pendingAfter = statOf(pendingFile);
      tb.newLogLines = dailyLogs(L.DATA).update.slice(logBeforeTray);
      tb.installCalls = snapT2.w3.installCalls;
      tb.alive = { exitCode: L.proc.exitCode, windows: snapT2.windows };
      log('tray recheck', JSON.stringify(tb.callOrder.map((x) => x.title)), JSON.stringify(tb.receiptMatches), JSON.stringify(tb.timing));
    }

    // ⑥ 关掉之前的底
    const snapC = await mainSnap(app);
    r.beforeClose = {
      appimage: statOf(FAKE_APPIMAGE), cache: listTree(cacheRoot),
      updater: { autoInstallOnAppQuit: snapC.autoInstallOnAppQuit, quitHandlerAdded: snapC.quitHandlerAdded, quitAndInstallCalled: snapC.quitAndInstallCalled, installerPath: snapC.installerPath, installCalls: snapC.w3.installCalls },
      logger: snapC.logger, unhandledListeners: snapC.unhandledListeners, unhandled: snapC.w3.unhandled, allEvents: snapC.w3.events, allDialogs: snapC.w3.dialogs.map((x) => ({ at: x.at, title: x.options?.title, message: x.options?.message, response: x.result?.response ?? null })),
    };
  } catch (e) {
    r.error = String(e?.stack ?? e);
    log('run1 error', r.error);
    try { r.errorShot = x11('shot', shotFile('run1-error-x11')); } catch { /* 旁路 */ }
  } finally {
    await shutdown(L, r);
    const lg = dailyLogs(L.DATA);
    const stdout = fs.readFileSync(L.outFile, 'utf8');
    r.afterClose = {
      appimage: statOf(FAKE_APPIMAGE),
      appimageUnchanged: isDeepStrictEqual(statOf(FAKE_APPIMAGE), r.appimageBefore),
      cache: listTree(cacheRoot),
      marker: fs.existsSync(L.MARKER) ? fs.readFileSync(L.MARKER, 'utf8') : null,
      logUpdate: lg.update,
      logUpdater: lg.updater,
      logOrphans: lg.orphans,
      logInstallish: lg.installish,
      logMainCrash: lg.mainCrash,
      logTail: lg.all.slice(-8),
      crash: crashInfo(L.DATA),
      stderr: stderrScan(L.errFile),
      stdoutUpdaterLines: stdout.split('\n').filter((l) => /Checking for update|Found version|Downloading update|has been downloaded|already been downloaded|differentially/.test(l)),
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
    r.errorAt = ts();
    await sleep(2500);
    snap = await mainSnap(app);
    r.events = snap.w3.events;
    r.dialogCalls = snap.w3.dialogs;
    r.unhandled = snap.w3.unhandled;
    r.unhandledListeners = snap.unhandledListeners;
    r.xwindows = x11('list');
    r.nativeDialogShown = Array.isArray(r.xwindows) && r.xwindows.some((w) => w.name === DIALOG_TITLE || (w.w < 900 && w.h < 600 && w.w > 100 && w.name !== 'DeskMinis'));
    const lg = dailyLogs(L.DATA);
    r.log = { files: lg.files, update: lg.update, updater: lg.updater, orphans: lg.orphans, mainCrash: lg.mainCrash };
    await openAbout(page);
    r.about = await aboutState(page);
    r.about.bridge = await bridgeState(page);
    await page.screenshot({ path: shotFile('4-about-error') });
    r.about.card = await shotAboutCard(page, '4-about-error');
    r.hits = shortHits(hits.filter((h) => h.run === 'run2'));
    log('run2 about', JSON.stringify(r.about.status));
  } catch (e) {
    r.error = String(e?.stack ?? e);
    log('run2 error', r.error);
  } finally {
    await shutdown(L, r);
    r.crash = crashInfo(L.DATA);
    r.stderr = stderrScan(L.errFile);
    r.allHits = shortHits(hits.filter((h) => h.run === 'run2'));
  }
}

// ================= run3（场景 8）：latest-linux.yml 正常，安装包本身回 404 =================
async function run3() {
  const r = report.run3;
  runTag = 'run3'; feedMode = 'appimage404';
  r.procsBefore = procs();
  const L = await launch('run3');
  Object.assign(r, { dataDir: L.DATA, xdgConfig: L.XDG, xdgCache: L.CACHE, stdoutFile: L.outFile, stderrFile: L.errFile, hook: L.hook, launchedAt: L.launchedAt });
  const { app, page } = L;
  const cacheRoot = path.join(L.CACHE, CACHE_DIR_NAME);
  try {
    // 8a 自动检查：等下载失败的 error 事件（最多 60 秒），再等 2.5 秒让拒绝走完（有没人接的话 unhandledRejection 在这之前早就发了）
    let snap = null;
    for (let i = 0; i < 240; i++) {
      snap = await mainSnap(app);
      if (snap.w3.events.some((e) => e.ev === 'error')) break;
      await sleep(250);
    }
    const a = r.auto = { errorSeenAt: ts() };
    await sleep(2500);
    snap = await mainSnap(app);
    a.events = snap.w3.events;
    a.dialogCalls = snap.w3.dialogs;
    a.unhandled = snap.w3.unhandled;
    a.unhandledListeners = snap.unhandledListeners;
    a.logger = snap.logger;
    a.xwindows = x11('list');
    a.nativeDialogShown = Array.isArray(a.xwindows) && a.xwindows.some((w) => w.name === DIALOG_TITLE || w.name === RECEIPT_TITLE || (w.w < 900 && w.h < 600 && w.w > 100 && w.name !== 'DeskMinis'));
    a.hitsRaw = hits.filter((h) => h.run === 'run3');
    a.hits = shortHits(a.hitsRaw);
    a.cache = listTree(cacheRoot);
    const lgA = dailyLogs(L.DATA);
    a.log = { files: lgA.files, update: lgA.update, updater: lgA.updater, orphans: lgA.orphans, mainCrash: lgA.mainCrash };
    a.crash = crashInfo(L.DATA);
    a.stderr = stderrScan(L.errFile);
    await openAbout(page);
    a.about = await aboutState(page);
    a.about.bridge = await bridgeState(page);
    await page.screenshot({ path: shotFile('8-about-dlfail-auto') });
    a.about.card = await shotAboutCard(page, '8-about-dlfail-auto');
    log('run3 auto about', JSON.stringify(a.about.status), 'unhandled', a.unhandled.length, 'crash', JSON.stringify({ exists: a.crash.exists, n: a.crash.records.length }));

    // 8b 关于页「现在检查」再手动失败一次
    const hitsBefore = hits.length; const evBefore = snap.w3.events.length; const dlgBefore = snap.w3.dialogs.length; const logBefore = lgA.update.length;
    const ipcBefore = snap.w3.ipcCheck.length;
    const m = r.manual = {};
    await watchAbout(page);
    m.clickedAt = ts(); m.clickedAtMs = Date.now();
    await clickCheckNow(page);
    for (let i = 0; i < 120; i++) {
      const sn = await mainSnap(app);
      if (sn.w3.events.slice(evBefore).some((e) => e.ev === 'error')) break;
      await sleep(250);
    }
    for (let i = 0; i < 50; i++) { const s = await aboutState(page); if (!s.buttons.includes('检查中…')) break; await sleep(100); }
    await sleep(2500);
    m.about = await aboutState(page);
    m.aboutWatch = await readAboutWatch(page);
    m.about.bridge = await bridgeState(page);
    await page.screenshot({ path: shotFile('8b-about-dlfail-manual') });
    m.about.card = await shotAboutCard(page, '8b-about-dlfail-manual');
    snap = await mainSnap(app);
    m.events = snap.w3.events.slice(evBefore);
    m.ipcCheck = snap.w3.ipcCheck.slice(ipcBefore);
    m.dialogCalls = snap.w3.dialogs.slice(dlgBefore);
    m.unhandled = snap.w3.unhandled;
    m.xwindows = x11('list');
    m.nativeDialogShown = Array.isArray(m.xwindows) && m.xwindows.some((w) => w.name === DIALOG_TITLE || w.name === RECEIPT_TITLE || (w.w < 900 && w.h < 600 && w.w > 100 && w.name !== 'DeskMinis'));
    m.newHitsRaw = hits.slice(hitsBefore);
    m.newHits = shortHits(m.newHitsRaw);
    const lgM = dailyLogs(L.DATA);
    m.newLogLines = lgM.update.slice(logBefore);
    m.orphans = lgM.orphans;
    m.mainCrash = lgM.mainCrash;
    m.crash = crashInfo(L.DATA);
    m.stderr = stderrScan(L.errFile);
    {
      const w = m.aboutWatch ?? [];
      const err = m.events.find((e) => e.ev === 'error') ?? null;
      const iChecking = w.findIndex((x) => x.btn === '检查中…');
      const btnBack = iChecking >= 0 ? w.slice(iChecking).find((x) => x.btn === '现在检查') ?? null : null;
      const ipc = m.ipcCheck[0] ?? null;
      m.timing = {
        ipcResult: ipc?.result ?? null,
        ipcDurationMs: ipc?.endHr != null ? +(ipc.endHr - ipc.startHr).toFixed(2) : null,
        ipcReturnAfterErrorEventMs: ipc?.endHr != null && err?.hr != null ? +(ipc.endHr - err.hr).toFixed(2) : null,
        errorEventAtMs: err?.atMs ?? null,
        buttonCheckingAtMs: iChecking >= 0 ? w[iChecking].atMs : null,
        buttonBackAtMs: btnBack?.atMs ?? null,
        buttonBackAfterErrorEventMs: btnBack && err ? btnBack.atMs - err.atMs : null,
        checkDurationMs: btnBack && iChecking >= 0 ? btnBack.atMs - w[iChecking].atMs : null,
        statusesSeen: uniqSeq(w.map((x) => x.status)),
        buttonsSeen: uniqSeq(w.map((x) => x.btn)),
      };
    }
    log('run3 manual about', JSON.stringify(m.about.status), 'timing', JSON.stringify(m.timing), 'unhandled', m.unhandled.length);

    // 探针（验证检测手段，不是应用的行为）：上面两次都量完之后，在同一个进程里故意制造一次没人接的拒绝，
    // 看应用的 W2b-7 钩子（crashes.json、stderr、按天日志）与旁听监听是不是都记得到——都记得到，上面两次下载失败的「零记录」才有分量。
    const pr = r.probe = { marker: PROBE_TEXT };
    pr.crashBefore = crashInfo(L.DATA);
    pr.unhandledBefore = (await mainSnap(app)).w3.unhandled.length;
    pr.firedAt = ts();
    pr.evaluate = await app.evaluate((_electron, msg) => { Promise.reject(new Error(msg)); return 'rejected-without-handler'; }, PROBE_TEXT);
    await sleep(1500);
    const sp = await mainSnap(app);
    pr.unhandledAfter = sp.w3.unhandled;
    pr.crashAfter = crashInfo(L.DATA);
    pr.stderrUnhandled = stderrScan(L.errFile).unhandled;
    pr.mainCrashLines = dailyLogs(L.DATA).mainCrash;
    pr.appAlive = { exitCode: L.proc.exitCode, windows: sp.windows.length, rendererAnswers: await page.evaluate(() => 1 + 1).catch(() => null) };
    log('run3 probe', JSON.stringify({ side: pr.unhandledAfter.length, crash: pr.crashAfter.unhandledRejection.length, stderr: pr.stderrUnhandled.length }));
  } catch (e) {
    r.error = String(e?.stack ?? e);
    log('run3 error', r.error);
    try { r.errorShot = x11('shot', shotFile('run3-error-x11')); } catch { /* 旁路 */ }
  } finally {
    await shutdown(L, r);
    const lg = dailyLogs(L.DATA);
    const crash = crashInfo(L.DATA);
    const stderr = stderrScan(L.errFile);
    const isProbe = (s) => String(s ?? '').includes('探针');
    r.afterClose = {
      crash,
      stderr,
      // 去掉探针那一条之后还剩的（应当为空）
      crashNonProbe: crash.records.filter((x) => !isProbe(x?.message)),
      stderrUnhandledNonProbe: stderr.unhandled.filter((l) => !isProbe(l)),
      logMainCrashNonProbe: lg.mainCrash.filter((l) => !isProbe(l)),
      logUpdate: lg.update,
      logUpdater: lg.updater,
      logOrphans: lg.orphans,
      logMainCrash: lg.mainCrash,
      logTail: lg.all.slice(-6),
      cache: listTree(cacheRoot),
    };
    r.allHits = shortHits(hits.filter((h) => h.run === 'run3'));
  }
}

try {
  report.procsAtStart = procs();
  await run1();
  await run2();
  await run3();
} catch (e) {
  report.error = String(e?.stack ?? e);
} finally {
  server.close();
  const r1 = report.run1; const r2 = report.run2; const r3 = report.run3; const c = report.checks;
  const has = (arr, s) => Array.isArray(arr) && arr.some((l) => l.includes(s));
  const hasRe = (arr, re) => Array.isArray(arr) && arr.some((l) => re.test(l));
  const chineseOneLiner = (st) => {
    if (typeof st !== 'string' || !st.startsWith('更新失败 · ')) return false;
    const rest = st.slice('更新失败 · '.length);
    return /[一-鿿]/.test(rest) && !/Error|http|status|\n/.test(rest);
  };
  // 期望值本身是 b893f6e 的新字
  c.expectedTextsAreB893f6e = textGuards.dialogFirstIsNew && textGuards.dialogSecondIsNew && textGuards.receiptMessageIsNew && textGuards.receiptDetailIsNew && textGuards.aboutSrcIsNew;
  c.isPackaged = r1.hook?.isPackaged === true;
  c.appImageUpdater = r1.hook?.updaterClass === 'AppImageUpdater';
  c.loggerWired = r1.afterDownload?.logger?.isConsole === false && r1.afterDownload?.logger?.info === 'function' && r1.afterDownload?.logger?.warn === 'function' && r1.afterDownload?.logger?.error === 'function';
  // ① ②
  c.s1_dialogAppeared = !!r1.dialog1?.xwin;
  c.s1_dialogEqualsDownloadedDialog = r1.dialog1?.optionsEqualDownloadedDialog === true;
  c.s1_dialogParentIsMainWindow = r1.dialog1?.parentIsMainWindow === true;
  c.s1_downloadedPayloadVerified = r1.afterDownload?.pendingEqualsPayload === true;
  c.s2_escapeClosedWithCancel = r1.escape1?.closed === true && r1.escape1?.result?.response === 0;
  c.s2_appAliveAfterEscape = r1.escape1?.alive?.exitCode === null && (r1.escape1?.alive?.windows?.length ?? 0) >= 1 && r1.escape1?.alive?.rendererAnswers === 2;
  // ③
  c.s3_logFoundNewText = has(r1.log1?.update, LOG_FOUND);
  c.s3_logDownloaded = has(r1.log1?.update, LOG_DOWNLOADED);
  c.s3_noOldFoundText = Array.isArray(r1.afterClose?.logUpdate) && !has(r1.afterClose.logUpdate, LOG_FOUND_OLD);
  c.s3_noOrphanLines = Array.isArray(r1.afterClose?.logOrphans) && r1.afterClose.logOrphans.length === 0;
  // ④
  c.s4_aboutDownloadedNewText = r1.about1?.status === ABOUT_DOWNLOADED;
  // ⑤ + 核实 2（关于页）
  c.s5_recheckDialogAgain = !!r1.recheck?.dialog && r1.recheck?.optionsEqualDownloadedDialog === true && r1.recheck?.parentIsMainWindow === true;
  c.s5_recheckFetchedYml = (r1.recheck?.newHitsRaw ?? []).some((h) => h.path === '/latest-linux.yml' && h.status === 200);
  c.s5_recheckNoAppImageDownload = Array.isArray(r1.recheck?.newHitsRaw) && !r1.recheck.newHitsRaw.some((h) => h.path === `/${FILE}`);
  c.s5_recheckCacheFileUntouched = !!r1.recheck?.pendingBefore?.ino && isDeepStrictEqual(r1.recheck.pendingBefore, r1.recheck.pendingAfter);
  c.v2_aboutRecheckSaysDownloaded = r1.recheck?.aboutWhileDialog?.status === ABOUT_DOWNLOADED;
  // 点击前状态行已经是「已下载」（④ 读的），所以另记 update:check 的返回值：它才是点击之后关于页显示的来源
  c.v2_aboutRecheckIpcReturnedDownloaded = r1.hook?.ipcCheckWrapped === true && (r1.recheck?.ipcCheck?.length ?? 0) === 1
    && isDeepStrictEqual(r1.recheck.ipcCheck[0].result, { status: 'downloaded', version: VERSION });
  c.v2_aboutRecheckIpcAfterDialog = typeof r1.recheck?.timing?.ipcReturnAfterDialogCallMs === 'number' && r1.recheck.timing.ipcReturnAfterDialogCallMs > 0
    && r1.recheck.timing.ipcDurationMs < MANUAL_CHECK_SETTLE_MS;
  c.v2_aboutNeverShowedAvailable = Array.isArray(r1.recheck?.timing?.statusesSeen) && !r1.recheck.timing.statusesSeen.some((s) => typeof s === 'string' && s.startsWith('有新版本'));
  c.v2_aboutAfterReenterDownloaded = r1.aboutAfterReenter?.status === ABOUT_DOWNLOADED && r1.aboutAfterEscapeSamePage?.status === ABOUT_DOWNLOADED;
  c.s5_escape2ClosedWithCancel = r1.escape2?.closed === true && r1.escape2?.result?.response === 0;
  // 核实 2（托盘）
  const tb = r1.trayRecheck ?? {};
  c.v2_trayClicked = tb.click === 'CLICKED';
  c.v2_trayDownloadedDialogAgain = tb.downloadedDialogAgain === true && tb.downloadedDialogParentIsMain === true;
  c.v2_trayReceiptIsDownloaded = tb.receiptMatches?.downloaded === true;
  c.v2_trayReceiptAfterDialog = typeof tb.timing?.receiptAfterDownloadedDialogMs === 'number' && tb.timing.receiptAfterDownloadedDialogMs > 0;
  c.v2_trayNoAppImageDownload = Array.isArray(tb.newHitsRaw) && !tb.newHitsRaw.some((h) => h.path === `/${FILE}`);
  c.v2_trayClosedBoth = Array.isArray(tb.closes) && tb.closes.length === 2 && tb.closes.every((x) => x.closed) && tb.receiptResult?.response === 0 && tb.downloadedResult?.response === 0;
  // 关框顺序与单独截到回执：第一下 Escape 只关掉下载完成框、回执还在；第二下关掉回执
  c.v2_trayCloseSequence = Array.isArray(tb.closes) && tb.closes.length === 2
    && tb.closes[0].kind === 'downloaded-dialog' && tb.closes[0].closed === true
    && Array.isArray(tb.closes[0].windowsAfter) && tb.closes[0].windowsAfter.some((n) => n.startsWith(`${RECEIPT_TITLE}#`))
    && !tb.closes[0].windowsAfter.some((n) => n.startsWith(`${DIALOG_TITLE}#`))
    && tb.closes[1].kind === 'receipt' && tb.closes[1].closed === true
    && Array.isArray(tb.closes[1].windowsAfter) && !tb.closes[1].windowsAfter.some((n) => n.startsWith(`${RECEIPT_TITLE}#`) || n.startsWith(`${DIALOG_TITLE}#`));
  // ⑥
  c.s6_noInstallCalls = (r1.beforeClose?.updater?.installCalls?.length ?? -1) === 0 && r1.afterClose?.marker === null;
  c.s6_appimageUnchanged = r1.afterClose?.appimageUnchanged === true;
  c.s6_noInstallLinesInLog = Array.isArray(r1.afterClose?.logInstallish) && r1.afterClose.logInstallish.length === 0;
  c.s6_run1ExitedClean = r1.exit?.code === 0 && (r1.procsAfter?.length ?? 1) === 0;
  c.run1NoCrashNoUnhandled = noCrash(r1.afterClose?.crash) && (r1.beforeClose?.unhandled?.length ?? -1) === 0 && (r1.afterClose?.stderr?.unhandled?.length ?? -1) === 0 && (r1.afterClose?.logMainCrash?.length ?? -1) === 0;
  // 核实 4：electron-updater 自己的记录
  const u1 = r1.afterClose?.logUpdater;
  c.v4_updaterChecking = has(u1, '[update] electron-updater: Checking for update');
  c.v4_updaterFoundVersion = has(u1, `[update] electron-updater: Found version ${VERSION}`);
  c.v4_updaterDownloading = has(u1, '[update] electron-updater: Downloading update from');
  c.v4_updaterDownloaded = has(u1, `[update] electron-updater: New version ${VERSION} has been downloaded`);
  // 核实 5：再查时「发现新版本」那行
  c.v5_recheckFoundLineNewText = has(r1.recheck?.newLogLines, LOG_FOUND) && !has(r1.recheck?.newLogLines, LOG_FOUND_OLD);
  c.v5_trayFoundLineNewText = has(tb.newLogLines, LOG_FOUND) && !has(tb.newLogLines, LOG_FOUND_OLD);
  // ⑦
  c.s7_errorLoggedMultiline = (r2.log?.update?.length ?? 0) >= 2 && (r2.log?.orphans?.length ?? 1) === 0;
  c.s7_errorCodeLine = has(r2.log?.update, '[update] 错误码：ERR_UPDATER_CHANNEL_FILE_NOT_FOUND');
  c.s7_noDialog = Array.isArray(r2.dialogCalls) && r2.dialogCalls.length === 0 && r2.nativeDialogShown === false;
  c.s7_aboutError = chineseOneLiner(r2.about?.status) && r2.about?.bad === true;
  c.s7_noCrashNoUnhandled = noCrash(r2.crash) && (r2.unhandled?.length ?? -1) === 0 && (r2.stderr?.unhandled?.length ?? -1) === 0 && (r2.log?.mainCrash?.length ?? -1) === 0;
  c.s7_exitedClean = r2.exit?.code === 0 && (r2.procsAfter?.length ?? 1) === 0;
  // ⑧ 场景 8
  const a = r3.auto ?? {}; const m = r3.manual ?? {};
  const dlFailed = (evs, hs) => Array.isArray(evs) && evs.some((e) => e.ev === 'update-available') && evs.some((e) => e.ev === 'error' && /Cannot download/.test(e.error ?? ''))
    && !evs.some((e) => e.ev === 'update-downloaded') && Array.isArray(hs) && hs.some((h) => h.path === '/latest-linux.yml' && h.status === 200) && hs.some((h) => h.path === `/${FILE}` && h.status === 404);
  c.s8_autoDownloadFailed = dlFailed(a.events, a.hitsRaw);
  c.s8_autoAboutError = chineseOneLiner(a.about?.status) && a.about?.bad === true;
  c.s8_autoAboutIsDescribedText = a.about?.status === `更新失败 · ${EXPECTED_DLFAIL_TEXT}`;
  c.s8_autoLogHasError = hasRe(a.log?.update, / \[update\] Error: Cannot download "/) && (a.log?.orphans?.length ?? 1) === 0;
  c.s8_autoNoCrashRecord = noCrash(a.crash);
  c.s8_autoNoUnhandled = Array.isArray(a.unhandled) && a.unhandled.length === 0 && (a.stderr?.unhandled?.length ?? -1) === 0 && (a.log?.mainCrash?.length ?? -1) === 0;
  c.s8_autoNoDialog = Array.isArray(a.dialogCalls) && a.dialogCalls.length === 0 && a.nativeDialogShown === false;
  c.s8_manualDownloadFailed = dlFailed(m.events, m.newHitsRaw) && m.events.some((e) => e.ev === 'checking-for-update');
  c.s8_manualAboutError = chineseOneLiner(m.about?.status) && m.about?.bad === true && m.about?.status === `更新失败 · ${EXPECTED_DLFAIL_TEXT}`;
  c.s8_manualIpcReturnedError = (m.ipcCheck?.length ?? 0) === 1 && isDeepStrictEqual(m.ipcCheck[0].result, { status: 'error', error: EXPECTED_DLFAIL_TEXT })
    && typeof m.timing?.ipcDurationMs === 'number' && m.timing.ipcDurationMs < MANUAL_CHECK_SETTLE_MS;
  c.s8_manualLogHasError = hasRe(m.newLogLines, / \[update\] Error: Cannot download "/) && (m.orphans?.length ?? 1) === 0;
  c.s8_manualNoCrashNoUnhandled = noCrash(m.crash) && Array.isArray(m.unhandled) && m.unhandled.length === 0 && (m.stderr?.unhandled?.length ?? -1) === 0 && (m.mainCrash?.length ?? -1) === 0;
  c.s8_manualNoDialog = Array.isArray(m.dialogCalls) && m.dialogCalls.length === 0 && m.nativeDialogShown === false;
  // 收尾时 crashes.json 里只有探针那一条（去掉它什么也不剩）
  c.s8_afterCloseOnlyProbe = (r3.afterClose?.crashNonProbe?.length ?? -1) === 0 && (r3.afterClose?.stderrUnhandledNonProbe?.length ?? -1) === 0
    && (r3.afterClose?.logMainCrashNonProbe?.length ?? -1) === 0;
  c.s8_exitedClean = r3.exit?.code === 0 && (r3.procsAfter?.length ?? 1) === 0;
  // 探针：检测手段在这个环境里确实记得到未处理拒绝（探针之前 crashes.json 不存在、旁听零次；之后各多一条，内容就是探针）
  const pr = r3.probe ?? {};
  c.probe_beforeClean = pr.crashBefore?.exists === false && pr.unhandledBefore === 0;
  c.probe_crashJsonRecorded = (pr.crashAfter?.unhandledRejection?.length ?? 0) === 1 && pr.crashAfter.unhandledRejection[0].process === 'main'
    && String(pr.crashAfter.unhandledRejection[0].message).includes(PROBE_TEXT);
  c.probe_sideListenerRecorded = Array.isArray(pr.unhandledAfter) && pr.unhandledAfter.length === 1 && pr.unhandledAfter[0].text.includes(PROBE_TEXT);
  c.probe_stderrAndDailyLog = Array.isArray(pr.stderrUnhandled) && pr.stderrUnhandled.some((l) => l.includes('未处理的 Promise 拒绝') && l.includes(PROBE_TEXT))
    && Array.isArray(pr.mainCrashLines) && pr.mainCrashLines.some((l) => l.includes(PROBE_TEXT));
  report.pass = Object.values(c).every(Boolean);
  report.failedChecks = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  report.observations = {
    aboutRecheckTiming: r1.recheck?.timing ?? null,
    trayTiming: tb.timing ?? null,
    trayReceiptMessage: tb.receiptOptions?.message ?? null,
    trayReceiptDetail: tb.receiptOptions?.detail ?? null,
    run3ManualTiming: m.timing ?? null,
    trayCloses: Array.isArray(tb.closes) ? tb.closes.map((x) => ({ step: x.step, kind: x.kind, closed: x.closed, windowsBefore: x.windowsBefore, windowsAfter: x.windowsAfter, mainResultsAfter: x.mainResultsAfter })) : null,
    probe: { crashAfter: pr.crashAfter?.unhandledRejection ?? null, sideAfter: pr.unhandledAfter ?? null },
    run3AboutAuto: a.about?.status ?? null,
    run3AboutManual: m.about?.status ?? null,
  };
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'W3-updb-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, failedChecks: report.failedChecks, checks: c, observations: report.observations }, null, 2));
}
