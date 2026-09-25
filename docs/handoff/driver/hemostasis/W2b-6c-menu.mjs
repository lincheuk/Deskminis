// W2b-6b xvfb 实拍②：打包版去掉应用菜单、不认 ELECTRON_RENDERER_URL；开发态保留默认菜单（对照）。
// 跑的是工作区 /home/user/wt-q/deskminis 的 npm run build 产物。
//
// 「打包形态的等价开关」：Electron 按可执行文件名判 app.isPackaged（Linux 上不叫 electron 就算打包），
// 所以把 node_modules/electron/dist 硬链接复制一份到 scratchpad/W2b-6b-pkgsim、可执行文件改名 deskminis，
// 用它起同一份 out/ 产物——主进程里 app.isPackaged 为真，其余与未打包一模一样（仓库里的 node_modules 不动）。
//
// 三种形态（第一个参数）：
//   pkg    —— 改名的可执行文件（isPackaged 为真），并且设着 ELECTRON_RENDERER_URL 指向本地一个假「开发服务器」：
//             应当加载 out/renderer/index.html、假开发服务器零请求；应用菜单为 null；
//             Ctrl+C / Ctrl+V 在输入框里照常可用；Ctrl+R 不重载（页面上预先放的标记还在）；Ctrl+Shift+I 不开开发者工具。
//   dev    —— 原名的 electron（未打包），不设 ELECTRON_RENDERER_URL：默认菜单在；同样的按键 Ctrl+R 会重载、Ctrl+Shift+I 会开
//             开发者工具——证明下面的按键方式确实按得到菜单快捷键，pkg 形态里「没反应」不是因为按键没送到。
//   devurl —— 原名的 electron（未打包），设着 ELECTRON_RENDERER_URL：照旧加载那个地址（开发态仍认它）。
// 按键用 X11 的 XTest 发（W2b-6b-x11.py，像真键盘一样经 X 服务器送到窗口），不走 CDP。
// 用法：NODE_PATH=<scratchpad>/driver/node_modules xvfb-run -a node W2b-6b-menu.mjs <pkg|dev|devurl>
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
const { _electron: electron } = createRequire(import.meta.url)('playwright-core');

const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const APP_DIR = '/home/user/wt-q/deskminis';
const SHOTS = path.join(S, 'hemo-shots');
const X11 = path.join(S, 'hemo-drivers/W2b-6b-x11.py');
const MODE = ['pkg', 'dev', 'devurl'].includes(process.argv[2]) ? process.argv[2] : 'pkg';
const EXE = MODE === 'pkg' ? path.join(S, 'W2b-6b-pkgsim/deskminis') : path.join(APP_DIR, 'node_modules/electron/dist/electron');
const log = (...a) => console.error(`[W2b-6c menu ${MODE}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const x11 = (...args) => { try { return JSON.parse(execFileSync('python3', [X11, ...args], { encoding: 'utf8' })); } catch (e) { return { error: String(e?.message ?? e) }; } };
const report = { mode: MODE, exe: EXE, checks: {} };

// 假「开发服务器」：ELECTRON_RENDERER_URL 指向它；谁来要页面就记一笔
const devHits = [];
const dev = http.createServer((req, res) => {
  devHits.push(req.url);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>DEVSERVER</title><h1 id="devserver">假开发服务器的页面</h1>');
});
await new Promise((r) => dev.listen(0, '127.0.0.1', r));
const DEV_URL = `http://127.0.0.1:${dev.address().port}`;

const DATA = fs.mkdtempSync(path.join(S, `W2b-6c-menu-${MODE}-data-`));
const XDG = fs.mkdtempSync(path.join(S, `W2b-6c-menu-${MODE}-xdg-`));
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
// 打包形态下 userData 是 Electron 缺省（XDG_CONFIG_HOME/deskminis）：先关掉启动 8 秒后的自动检查更新，免得 electron-updater 去找更新源
fs.mkdirSync(path.join(XDG, 'deskminis'), { recursive: true });
fs.writeFileSync(path.join(XDG, 'deskminis', 'update-prefs.json'), JSON.stringify({ autoCheck: false }));
const env = { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA, XDG_CONFIG_HOME: XDG, DESKMINIS_FAKE_REPLY: '好的。' };
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
if (MODE !== 'dev') env.ELECTRON_RENDERER_URL = DEV_URL;

const app = await electron.launch({ executablePath: EXE, args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 60_000, env });
const mainInfo = () => app.evaluate(({ app: a, Menu, BrowserWindow }) => {
  const m = Menu.getApplicationMenu();
  const walk = (menu) => (menu?.items ?? []).flatMap((it) => [{ label: it.label, role: it.role ?? null, accel: it.accelerator ?? null }, ...walk(it.submenu)]);
  const items = walk(m);
  const w = BrowserWindow.getAllWindows()[0];
  return {
    isPackaged: a.isPackaged, execPath: process.execPath, userData: a.getPath('userData'),
    hasAppMenu: !!m,
    reloadItems: items.filter((i) => /reload/i.test(String(i.role))),
    devtoolsItems: items.filter((i) => /devtools/i.test(String(i.role))),
    windows: BrowserWindow.getAllWindows().length,
    url: w?.webContents.getURL() ?? null,
    devtoolsOpen: w?.webContents.isDevToolsOpened() ?? null,
    loads: globalThis.__loads ?? null,
  };
});
try {
  let page = null;
  for (let i = 0; i < 120 && !page; i++) { page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(250); }
  // 记主窗口每次开始加载（整页重载也算一次）
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__loads = 0;
    BrowserWindow.getAllWindows()[0]?.webContents.on('did-start-loading', () => { globalThis.__loads++; });
  });
  await sleep(1500);
  report.start = await mainInfo();
  report.devHitsAtStart = devHits.slice();
  log('start', JSON.stringify(report.start));

  if (MODE === 'devurl') {
    report.checks.devurlNotPackaged = report.start.isPackaged === false;
    report.checks.devurlLoadsDevServer = String(report.start.url).startsWith(DEV_URL);
    report.checks.devServerHit = devHits.length > 0;
    await page.screenshot({ path: path.join(SHOTS, 'W2b-6c-menu-devurl.png') });
  } else {
    await page.waitForSelector('textarea.field', { timeout: 30_000 });
    await sleep(1000);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    // 页面上预先放一个标记：整页重载就没了
    await page.evaluate(() => {
      window.__w2b6bMarker = 'alive';
      const b = document.createElement('div');
      b.id = 'w2b6b-marker';
      b.textContent = 'W2b-6b 标记：按快捷键之前放的（整页重载就会消失）';
      b.style.cssText = 'position:fixed;left:50%;top:48px;transform:translateX(-50%);z-index:99999;padding:6px 12px;border-radius:8px;background:#ffe9a8;color:#5a4300;font:13px sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.2)';
      document.body.appendChild(b);
    });
    // 主窗口在 X 上的位置：页面坐标加上它就是屏幕坐标（无边框窗口，网页铺满整个窗口）
    const xwin = (x11('list') ?? []).find?.((w) => w.name === 'DeskMinis') ?? { x: 0, y: 0 };
    report.xwin = xwin;
    const ta = await page.evaluate(() => { const r = document.querySelector('textarea.field').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const sx = Math.round(xwin.x + ta.x), sy = Math.round(xwin.y + ta.y);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.focus(); });
    x11('move', String(sx), String(sy));
    x11('click', String(sx), String(sy));   // 真点一下输入框，焦点落进去
    await sleep(400);
    report.focusInTextarea = await page.evaluate(() => document.activeElement?.classList.contains('field') ?? false);

    // ① Ctrl+C：选中输入框里的探针文字，按 Ctrl+C，主进程读剪贴板
    const PROBE = 'W2b6b-clipboard-probe-粘贴探针';
    await app.evaluate(({ clipboard }) => { clipboard.writeText('sentinel-before-ctrl-c'); });
    await page.evaluate((p) => { const t = document.querySelector('textarea.field'); t.value = p; t.dispatchEvent(new Event('input', { bubbles: true })); t.focus(); t.select(); }, PROBE);
    await sleep(200);
    x11('key', 'ctrl+c');
    await sleep(500);
    report.clipboardAfterCtrlC = await app.evaluate(({ clipboard }) => clipboard.readText());
    // ② Ctrl+V：清空输入框，按 Ctrl+V，看粘回来的字
    await page.evaluate(() => { const t = document.querySelector('textarea.field'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); t.focus(); });
    await sleep(200);
    x11('key', 'ctrl+v');
    await sleep(600);
    report.textareaAfterCtrlV = await page.evaluate(() => document.querySelector('textarea.field').value);
    await page.screenshot({ path: path.join(SHOTS, `W2b-6c-menu-${MODE}-paste.png`) });

    // ③ Ctrl+Shift+I：开发者工具开没开
    x11('key', 'ctrl+shift+i');
    await sleep(2000);
    report.afterDevtoolsKey = await mainInfo();
    report.x11DevtoolsShot = x11('shot', path.join(SHOTS, `W2b-6c-menu-${MODE}-after-ctrl-shift-i-x11.png`));
    if (report.afterDevtoolsKey.devtoolsOpen) {
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.webContents.closeDevTools(); });
      await sleep(800);
    }

    // ③b 缩放（W2b-6c）：Ctrl+减号缩小、Ctrl+0 复原、Ctrl+加号放大——打包版的最小菜单要留着这几个快捷键
    const zoom = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomLevel() ?? null);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.focus(); });
    x11('move', String(sx), String(sy));
    report.zoom = { start: await zoom() };
    x11('key', 'ctrl+minus'); await sleep(600); report.zoom.afterMinus = await zoom();
    await page.screenshot({ path: path.join(SHOTS, `W2b-6c-menu-${MODE}-zoomed-out.png`) });
    x11('key', 'ctrl+0'); await sleep(600); report.zoom.afterZero = await zoom();
    x11('key', 'ctrl+shift+equal'); await sleep(600); report.zoom.afterPlus = await zoom();
    x11('key', 'ctrl+0'); await sleep(600); report.zoom.end = await zoom();

    // ④ Ctrl+R：页面上的标记还在不在
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.focus(); });
    x11('move', String(sx), String(sy));
    const loadsBefore = (await mainInfo()).loads;
    x11('key', 'ctrl+r');
    await sleep(3000);
    report.afterReloadKey = await mainInfo();
    report.reloadCount = report.afterReloadKey.loads - loadsBefore;
    report.markerAfterCtrlR = await page.evaluate(() => ({ js: window.__w2b6bMarker ?? null, dom: !!document.getElementById('w2b6b-marker') })).catch((e) => ({ error: String(e) }));
    await page.screenshot({ path: path.join(SHOTS, `W2b-6c-menu-${MODE}-after-ctrl-r.png`) });
    report.x11ReloadShot = x11('shot', path.join(SHOTS, `W2b-6c-menu-${MODE}-after-ctrl-r-x11.png`));

    const c = report.checks;
    c.focusInTextarea = report.focusInTextarea === true;
    c.ctrlCCopies = report.clipboardAfterCtrlC === PROBE;
    c.ctrlVPastes = report.textareaAfterCtrlV === PROBE;
    if (MODE === 'pkg') {
      c.isPackaged = report.start.isPackaged === true;
      c.loadsIndexHtml = String(report.start.url).startsWith('file://') && String(report.start.url).endsWith('/out/renderer/index.html');
      c.devServerZeroRequests = devHits.length === 0;
      // W2b-6c：有应用菜单（最小菜单），但里面没有重载、没有开发者工具
      c.minimalAppMenu = report.start.hasAppMenu === true && report.start.reloadItems.length === 0 && report.start.devtoolsItems.length === 0;
      c.zoomOutWorks = typeof report.zoom.afterMinus === 'number' && report.zoom.afterMinus < report.zoom.start;
      c.zoomResetWorks = report.zoom.afterZero === 0;
      c.zoomInWorks = typeof report.zoom.afterPlus === 'number' && report.zoom.afterPlus > 0;
      c.ctrlShiftINoDevtools = report.afterDevtoolsKey.devtoolsOpen === false;
      c.ctrlRNoReload = report.reloadCount === 0 && report.markerAfterCtrlR.js === 'alive' && report.markerAfterCtrlR.dom === true;
      c.oneWindow = report.afterReloadKey.windows === 1;
    } else {
      c.notPackaged = report.start.isPackaged === false;
      c.defaultMenu = report.start.hasAppMenu === true && report.start.reloadItems.length > 0 && report.start.devtoolsItems.length > 0;
      c.ctrlShiftIOpensDevtools = report.afterDevtoolsKey.devtoolsOpen === true;
      c.ctrlRReloads = report.reloadCount >= 1 && report.markerAfterCtrlR.js === null && report.markerAfterCtrlR.dom === false;
    }
  }
  report.pass = Object.values(report.checks).every(Boolean);
} catch (e) {
  report.error = String(e?.stack ?? e);
} finally {
  report.devHits = devHits.slice();
  await app.close().catch(() => {});
  dev.close();
  console.log(JSON.stringify(report, null, 2));
}
