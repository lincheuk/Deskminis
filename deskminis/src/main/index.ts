import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray, utilityProcess, type UtilityProcess } from 'electron';
import electronUpdater from 'electron-updater';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolveAppDirs } from './app-dirs';
import { attachmentPath, decodeImageDataUrl, extFromDataUrl } from './attachments';
import { describeUpdateError, isPortableBuild, manualCheckDialog, type UpdateState } from './update-status';
import { parseMinisdFatal, MinisdFatalError, fatalDialogOptions, withStderrTail } from './minisd-fatal';
import { TailBuffer, STDERR_TAIL_BYTES } from './child-output';
import { MinisdExitWatch, QuitGate, MINISD_STOP_TIMEOUT_MS, type StopOutcome } from './minisd-stop';

// W1a-9 开发态数据隔离：数据根、userData、keyring 服务名、日志目录在这里一次算定。
// fork minisd 与 attachments:save 都用这一份，不再各自调 dataRoot() 各算一遍——两处一漂移，附件就落进另一个根。
// 也不回写 process.env：值经 fork env 显式下发，读代码的人一眼看得出从哪来。
const dirs = resolveAppDirs({ isPackaged: app.isPackaged, env: process.env });
// 必须在模块顶层、抢在一切之前：Chromium 在 ready 之前就按 userData 建配置目录，单实例锁（W1b-3）也按它算，
// 晚一步就有一部分状态落在旧目录里。打包态 dirs.userData 是 undefined，保持 Electron 默认不动。
// 不先 mkdir：Electron 文档说目录不存在会抛，但 38.8.6 在 Linux 上实测不抛，Chromium 在 ready 前自己把目录建好；
// 先 mkdir 反而会让 import 本模块的单测（ipc-contract）在开发机真实的 APPDATA 下建出 DeskMinis-dev。
// Windows 上未实测；打包态不走这一行，最坏只影响 dev 首次启动。
if (dirs.userData) app.setPath('userData', dirs.userData);

let minisd: UtilityProcess | undefined;
// minisd stderr 的末尾 4KB：启动失败时附进错误框（真正的原因在这里，不在主进程自己的堆栈里）。
// 模块级只建这一个，之后的崩溃记录等复用它，不另造第二份（设计稿 §3 第 8 条）。
const minisdStderrTail = new TailBuffer(STDERR_TAIL_BYTES);
let minisdPort = 0;
// per-run token：从握手行里接住并经 minisd:info 通道交给渲染进程；
// 没有它渲染进程连 RPC 会被 401 拒绝（RpcServer 要求 ?token=<authToken>），应用只能开一个空窗口。
let minisdToken = '';
let tray: Tray | undefined;
let quitting = false;
// W1b-5：本次 fork 的退出记录与停止器（exit 监听只有 startMinisdProcess 里那一个，由它写入）
let minisdExit: MinisdExitWatch | undefined;
// 退出闸：before-quit 挡不挡、停完再退、第二次放行（判定在 minisd-stop.ts，行为测试在 tests/minisd-stop.test.ts）。
// minisd 已经停过（优雅停完 / 更新前停完 / 启动失败时硬杀过）就 markStopped，之后的 before-quit 直接放行
const quitGate = new QuitGate();
// 主窗口放在模块级（W1b-3）：second-instance 要把它叫回来，而它以前只是 whenReady 回调里的局部变量。
let mainWindow: BrowserWindow | undefined;
// second-instance 早于主窗口建好（还在等 minisd 握手）时记一笔，建好后立即唤出，别把用户这次双击吞掉。
let revealWhenCreated = false;

// W1b-3 单实例锁：托盘里藏着一个 DeskMinis 时再双击图标，以前会整套再起一遍（第二个 minisd 与第一个同写一个库）；
// 现在第二个进程拿不到锁就退出，由第一个把藏起来的窗口叫回来。
// 放在模块顶层、setPath('userData') 之后：Electron 的锁按 userData 算，dev 与各个临时数据根（W1a-9）各有各的锁，
// driver 能和开着的 dev 应用并存。它挡不住两份 userData 指向同一个数据根——那由 minisd 的数据根锁兜住。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 退出流程中窗口正在关，再 show 会把它翻出来又关掉
    if (quitting) return;
    if (mainWindow === undefined) { revealWhenCreated = true; return; }
    if (mainWindow.isMinimized()) mainWindow.restore();
    // 关窗是隐藏到托盘（close 里 hide），只 focus 叫不回来，必须先 show
    mainWindow.show();
    mainWindow.focus();
  });
}

/** 请 minisd 有序关停（W1b-5）：postMessage shutdown，等它自己退，超时 kill（逻辑在 minisd-stop.ts）。
 *  没 fork 过就立即返回。退出（托盘 / before-quit）与「重启并安装」都走这里，重复调用拿到同一个 promise。 */
function stopMinisdGracefully(timeoutMs: number): Promise<StopOutcome> {
  if (minisd === undefined || minisdExit === undefined) return Promise.resolve('already-exited');
  return minisdExit.stop(minisd, timeoutMs);
}

/** 子进程未在此时限内上报端口就判定启动失败——否则挂死的子进程会让主进程永远停在白屏前。 */
const MINISD_START_TIMEOUT_MS = 30_000;

/** 一行文本是不是握手行 `{"minisdPort":<n>,"authToken":"<uuid>"}`；不是就返回 undefined（调用方把它当普通日志转发）。
 *  必须同时拿到 port 和 token 才算握手——只有 port 没有 token 的行不是握手行，转发它、继续等。 */
export function parseHandshake(line: string): { port: number; token: string } | undefined {
  try {
    const o = JSON.parse(line) as { minisdPort?: unknown; authToken?: unknown } | null;
    const port = o?.minisdPort;
    const token = o?.authToken;
    if (typeof port === 'number' && Number.isFinite(port) && typeof token === 'string' && token.length > 0) {
      return { port, token };
    }
  } catch { /* not the handshake line */ }
  return undefined;
}

function startMinisdProcess(): Promise<number> {
  return new Promise((resolve, reject) => {
    // 开发者一眼看得出这次 dev 用的是哪份数据（dev 默认不再碰正式版的库与 keyring）
    if (dirs.variant === 'dev') process.stderr.write(`开发态数据根：${dirs.dataRoot}（keyring 服务名 ${dirs.keyringService}；userData ${dirs.userData}；日志目录 ${dirs.logRoot}）\n`);
    minisd = utilityProcess.fork(join(__dirname, 'minisd.js'), [], {
      env: {
        ...process.env,
        DESKMINIS_STANDALONE: '1',
        // 三个目录变量写在展开之后：外层 shell 里残留的同名变量不能盖掉主进程算出来的值。
        DESKMINIS_DATA_DIR: dirs.dataRoot,
        DESKMINIS_KEYRING_SERVICE: dirs.keyringService,
        DESKMINIS_LOG_DIR: dirs.logRoot,
      },
      stdio: 'pipe',
    });
    // 停止器（stopMinisdGracefully）与 minisdAlive 读 minisdExit，下面唯一的 exit 监听写 exitWatch——必须是同一份：
    // 少了这行停止器以为没 fork 过、不发 shutdown 直接放行，退出退回硬杀；另建一份则永远等不到退出、每次等满 5 秒才 kill。
    const exitWatch = new MinisdExitWatch();
    minisdExit = exitWatch;

    let settled = false;
    const settle = (fn: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => settle(() => {
      minisd?.kill();
      reject(new Error(`minisd 启动超时：${MINISD_START_TIMEOUT_MS / 1000}s 内没有上报端口（子进程可能卡在 DB / 密钥库初始化）`));
    }), MINISD_START_TIMEOUT_MS);

    // 按「完整行」扫描，而不是只看第一个换行符之前的内容：
    // 子进程只要在握手行之前打印过任何一行日志，旧写法就会把那一行当成 JSON 解析失败，
    // 且 buf 永不推进 —— 端口永远解析不出来，启动永久卡死。现在非握手行一律转发到 stderr。
    let buf = '';
    minisd.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.trim() === '') continue;
        // 致命行先认：minisd 知道自己为什么起不来（库比应用新 / 数据目录被占），
        // 带着结构化原因结束等待，catch 分支才能弹对用户有用的对话框，而不是「code=1」。
        const fatal = parseMinisdFatal(line);
        if (fatal !== undefined) {
          process.stderr.write('[minisd] ' + line + '\n');
          settle(() => reject(new MinisdFatalError(fatal)));
          continue;
        }
        const hs = parseHandshake(line);
        if (hs !== undefined && minisdPort === 0) {
          minisdPort = hs.port;
          minisdToken = hs.token;
          settle(() => resolve(hs.port));
        } else {
          process.stderr.write('[minisd] ' + line + '\n');
        }
      }
    });
    // 转发子进程 stderr：启动失败时这里才是真正的原因所在；同时留住末尾 4KB 给错误框
    minisd.stderr?.on('data', (d: Buffer) => {
      minisdStderrTail.push(d);
      process.stderr.write('[minisd] ' + d.toString());
    });
    // exit 之后 Electron 不再交付管道里剩下的数据，所以这里等也没用；minisd 那边写完先等一小段再退
    // （src/minisd/fatal.ts 的 STARTUP_FAILURE_EXIT_DELAY_MS），致命行与 stderr 末尾都在 exit 之前到。
    // 引擎进程的 exit 监听全文件只有这一个（设计稿 §3 第 11 条）：它写退出记录，优雅停止等的就是这条记录。
    // 握手前退出是启动失败；握手后、exitWatch.stopRequested 为假的退出是崩溃——W2b-7 在这里记 minisd_exit，不另挂监听。
    minisd.on('exit', code => {
      exitWatch.markExited(code);
      if (minisdPort === 0) settle(() => reject(new Error(`minisd 退出 code=${code}`)));
    });
  });
}

function loadTrayIcon(): import('electron').NativeImage {
  return nativeImage.createFromPath(join(__dirname, '../../resources/tray.png'));
}

function createTrayMenu(win: BrowserWindow): import('electron').Menu {
  return Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { win.show(); win.focus(); } },
    { label: '切换右栏', click: () => { win.show(); win.webContents.send('menu:toggle-right'); } },
    { label: '打开设置', click: () => { win.show(); win.webContents.send('menu:open-settings'); } },
    { label: '检查更新…', click: () => { void checkUpdatesFromTray(); } },
    { type: 'separator' as const },
    { label: '退出 DeskMinis', click: () => { app.quit(); } },
  ]);
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    // 无边框 + 自绘标题栏（设计 §4.0）：DOM 里不画窗口控制，
    // titleBarOverlay 让系统在右上角绘制原生 min/max/close（透明底、符号色随明暗）。
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#808080', height: 40 },
    webPreferences: { preload: join(__dirname, '../preload/index.cjs') },
  });
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(join(__dirname, '../renderer/index.html'));

  // 关窗不退出：隐藏到托盘（× / Alt+F4 都走这里；托盘退出 / before-quit 才真放行）
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  return win;
}

// ================== 自动更新（用户 2026-08-11 拍板：GitHub Releases + 启动检查可关）==================
const { autoUpdater } = electronUpdater;

/** 开关**归主进程管**：做检查的是主进程，配置若只存渲染端 localStorage，
 *  启动时主进程读不到——「关掉自动检查」会形同虚设。故落在 userData 下的一个小 JSON。 */
function updatePrefsPath(): string { return join(app.getPath('userData'), 'update-prefs.json'); }
function readUpdatePrefs(): { autoCheck: boolean } {
  try {
    const raw = JSON.parse(readFileSync(updatePrefsPath(), 'utf8')) as { autoCheck?: unknown };
    return { autoCheck: raw.autoCheck !== false };   // 缺省开启
  } catch { return { autoCheck: true }; }
}
function writeUpdatePrefs(p: { autoCheck: boolean }): void {
  try { writeFileSync(updatePrefsPath(), JSON.stringify(p, null, 2)); } catch { /* 写不进就下次再说，不打断启动 */ }
}

/** 最近一次检查结果，供渲染端显示（不做全局状态机，够用即可）。 */
let updateState: UpdateState = { status: 'idle' };

function setupUpdater(): void {
  // 下载完**不自动装**：Agent 应用可能正跑着长任务，自动重启会把用户的活干掉一半。
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => { updateState = { status: 'checking' }; });
  autoUpdater.on('update-available', (i) => { updateState = { status: 'available', version: i?.version }; });
  autoUpdater.on('update-not-available', () => { updateState = { status: 'latest' }; });
  autoUpdater.on('download-progress', () => { updateState = { status: 'downloading' }; });
  autoUpdater.on('update-downloaded', (i) => {
    updateState = { status: 'downloaded', version: i?.version };
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return;
    // 只提示，装不装由用户点。dialog 是模态但不强制——取消即继续用当前版本。
    // 点「重启并安装」（W1b-5）：先停 minisd 再装。quitAndInstall 同步 spawn 安装器、下一拍才 app.quit()，
    // 不先停的话安装器起来时 minisd 还开着库、还挂着 MCP 子进程（NSIS 会连带硬杀同名进程）。
    // 停完 quitGate.markStopped()，quitAndInstall 触发的 before-quit 直接放行。
    // quitAndInstall 调用与收尾的右花括号留在同一行：auto-update 守卫的负向正则认「调用后紧跟换行」。
    void dialog.showMessageBox(w, {
      type: 'info',
      title: '有新版本可用',
      message: `DeskMinis ${i?.version ?? ''} 已下载完成`,
      detail: '现在重启即可用上新版本；也可以继续用当前版本，下次启动时再装。',
      buttons: ['稍后再说', '重启并安装'],
      defaultId: 0,          // 默认焦点**不在**破坏性/打断性选项上
      cancelId: 0,
    }).then(async r => { if (r.response === 1) { quitting = true; await stopMinisdGracefully(MINISD_STOP_TIMEOUT_MS); quitGate.markStopped(); autoUpdater.quitAndInstall(); } });
  });
  // 检查失败是常态（离线、公司网、GitHub 限流、发布仓库还没发过版）——
  // 静默记录即可，绝不弹窗打扰。更新是便利功能，不是必需路径（托盘手动检查的回执另走 checkUpdatesFromTray）。
  // 状态里只放一句中文（W2b-9）：原文带 HttpError 的响应头和内层堆栈，以前原样漏到设置→关于的状态行上。
  // 原文写 stderr 留给排查；检查失败时 electron-updater 既发这个事件、又让 checkForUpdates reject，原文只在这里写一次。
  autoUpdater.on('error', (e) => {
    process.stderr.write('[update] ' + String(e?.stack ?? e) + '\n');
    updateState = { status: 'error', error: describeUpdateError(e) };
  });
}

/** dev 下不检查：electron-updater 在未打包应用里会抛「application is not packed」，
 *  不拦的话每次 npm run dev 都吐一条错误噪音，久了真错误也没人看了。 */
async function checkUpdates(manual: boolean): Promise<UpdateState> {
  if (!app.isPackaged) {
    updateState = { status: 'dev', error: '开发模式不检查更新' };
    return updateState;
  }
  // 便携版（W2b-9）：自动与手动都不检查、不下载。electron-updater 不区分便携版，放它查就会去下载 NSIS 安装包
  // （侦察据源码推断，重启后会在旁边装出一份安装版，未在真机确认）。
  // 排在「关掉自动检查」之前：便携版上那个开关没有意义，该说的是「便携版不自动更新」。
  if (isPortableBuild(process.env)) {
    updateState = { status: 'portable' };
    return updateState;
  }
  if (!manual && !readUpdatePrefs().autoCheck) {
    updateState = { status: 'disabled' };
    return updateState;
  }
  try { await autoUpdater.checkForUpdates(); } catch (e) { updateState = { status: 'error', error: describeUpdateError(e) }; }
  return updateState;
}

/** 托盘「检查更新…」（W2b-9）：手动检查要有回音——以前点了界面上毫无反应，结果只躺在 updateState 里。
 *  对话框不挂父窗口 = 非模态：主窗口可能藏在托盘里，挂上去会把它拽出来，还会挡住正在进行的对话。
 *  启动 8 秒后的自动检查不走这里，维持静默。 */
async function checkUpdatesFromTray(): Promise<void> {
  const r = await checkUpdates(true);
  await dialog.showMessageBox(manualCheckDialog(r, app.getVersion()));
}

ipcMain.handle('update:getPrefs', () => ({ ...readUpdatePrefs(), version: app.getVersion(), state: updateState }));
ipcMain.handle('update:setEnabled', (_e, on: unknown) => {
  writeUpdatePrefs({ autoCheck: on !== false });
  return readUpdatePrefs();
});
ipcMain.handle('update:check', async () => await checkUpdates(true));

// 旧通道保留（无害；渲染层重写后会弃用）：只给端口，连不上带 token 认证的 minisd。
ipcMain.handle('minisd:port', () => minisdPort);
// 新通道：端口 + per-run token。preload 的 minisdInfo() invoke 的就是这个通道——
// 少了它，渲染层调用命中一个未注册的通道、静默失败、每个 WS 连接被 401，应用连不上 minisd。
ipcMain.handle('minisd:info', () => ({ port: minisdPort, token: minisdToken }));

  // 工作区目录选择器（用户 2026-08-11 拍板「原生选择器 + 粘贴路径框两者都要」）。
  // dialog 本就已引入（showErrorBox），invoke 通道模式沿用 minisd:info，无新依赖。
  ipcMain.handle('dialog:pickFolder', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const r = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择工作区目录' })
      : await dialog.showOpenDialog({ properties: ['openDirectory'], title: '选择工作区目录' });
    // 命门：取消时必须回 null 而不是空串。空串若被 workspace.set 当成合法值，
    // 用户点「取消」反而把工作区清了——最难查的那类误操作。
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0];
  });

// MU2b Task 6：渲染端图片粘贴/拖拽 → 落盘会话附件目录（main/preload 白名单：本 Task 仅此一处 handler）。
// sessionId 经 attachmentPath 内 UUID 正则校验防路径逃逸；dataUrl 非图片/坏 base64 拒绝。
// F2a：扩展名随 dataUrl 的 mime（降采样后 jpeg 导出落 .jpg，防 mimeFromPath 与字节不符）。
// 返回会话相对路径 attachments/paste-<ts>.<ext>，渲染端发送时以 attachments 参数带给模型。
ipcMain.handle('attachments:save', (_e, sessionId: unknown, dataUrl: unknown) => {
  if (typeof sessionId !== 'string' || typeof dataUrl !== 'string') throw new Error('非法参数');
  const ext = extFromDataUrl(dataUrl) ?? 'png';
  const ts = Date.now();
  const abs = attachmentPath(dirs.dataRoot, sessionId, ts, ext);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, decodeImageDataUrl(dataUrl));
  return `attachments/paste-${ts}.${ext}`;
});

app.whenReady().then(async () => {
  // 第二个实例：顶层已经 app.quit()，但 ready 仍可能触发。不早退的话它照样 fork minisd（被数据根锁拦下，多弹一个框）、
  // 建窗口、起更新检查。
  if (!gotSingleInstanceLock) return;
  // 启动检查：延迟 8s，让窗口和 minisd 先起来，不和启动抢资源。
  // 未打包 / 用户关掉开关时 checkUpdates 自己会短路，这里不重复判断。
  setupUpdater();
  setTimeout(() => { void checkUpdates(false); }, 8_000);

  // 不 catch 的话：minisd 起不来 → 这里抛出 → createWindow 永远不执行 →
  // 应用「启动了但什么都不显示」，用户和开发者都拿不到任何线索。
  try {
    await startMinisdProcess();
    const win = await createWindow();
    mainWindow = win;
    if (revealWhenCreated) { revealWhenCreated = false; win.show(); win.focus(); }
    tray = new Tray(loadTrayIcon());
    tray.setToolTip('DeskMinis');
    tray.setContextMenu(createTrayMenu(win));
    tray.on('click', () => { if (win.isVisible()) win.hide(); else { win.show(); win.focus(); } });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); else win.show(); });
  } catch (e) {
    if (e instanceof MinisdFatalError) {
      // minisd 报了用户能自己处理的原因（库来自更新版本 / 数据目录被另一个实例占着）：
      // 专用对话框只给「退出」——这时任何清空、重置、覆盖都会毁掉用户数据。
      // 用同步版：异步版在 Linux 上点完按钮，promise 要等主进程下一次被别的事件唤醒才 resolve，
      // 应用迟迟不退（W1a-8 实测空应用约 30s）；启动已失败、没有窗口，阻塞主线程没有代价。
      process.stderr.write('DeskMinis 启动失败: ' + e.message + '\n');
      dialog.showMessageBoxSync(fatalDialogOptions(e.fatal));
    } else {
      const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
      process.stderr.write('DeskMinis 启动失败: ' + message + '\n');
      // 以前框里只有主进程自己的「minisd 退出 code=1」堆栈；真正的原因在 minisd 的 stderr 里，附上末尾。
      dialog.showErrorBox('DeskMinis 启动失败', withStderrTail(message, minisdStderrTail.text()));
    }
    // 握手前的启动失败仍直接 kill，不走优雅停：minisd 可能根本没装配起来、不会应答 shutdown，等满 5 秒没有意义
    minisd?.kill();
    quitGate.markStopped();
    app.quit();
  }
});
// W1b-5 优雅退出：第一次 before-quit 挡住，先把窗口与托盘收掉（用户马上看到已退出），
// 再请 minisd 有序关停（了结权限卡、等 run 收尾、关库、放锁），停完再 app.quit()，那一次直接放行。
// 以前这里直接 kill：Windows 上是 TerminateProcess，半截回复与 toolResult 来不及落库，MCP / PowerShell 子进程成孤儿。
// minisd 已经先退了（崩溃）或从没起来就不等。Windows 注销 / 关机不触发 before-quit，那条路仍是硬杀，靠 WAL 保底。
// 挡不挡、等不等、停完放不放行都在 QuitGate 里；这里只接钩子，不自己挡、不自己停、不自己退。
app.on('before-quit', (e) => {
  quitting = true;
  quitGate.onBeforeQuit(e, {
    minisdAlive: minisd !== undefined && !minisdExit?.exited,
    hideUi: () => {
      for (const w of BrowserWindow.getAllWindows()) w.hide();
      tray?.destroy();
      tray = undefined;
    },
    stop: () => stopMinisdGracefully(MINISD_STOP_TIMEOUT_MS),
    quit: () => app.quit(),
  });
});
app.on('window-all-closed', () => {
  // 托盘常驻：关窗默认隐藏不销毁，退出只走托盘菜单 / before-quit
});
