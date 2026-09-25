/** W2b-6 两个接线测试共用的 electron 桩与启动器（本文件不是测试：vitest 只收 *.test.ts）。
 *
 *  - tests/main-window-guard-wiring.test.ts：打包形态（没设 ELECTRON_RENDERER_URL，createWindow 走 loadFile）与源码守卫；
 *  - tests/main-window-guard-wiring-dev.test.ts：dev 形态（设了 ELECTRON_RENDERER_URL，走 loadURL）。
 *  两种形态都要各起一次主进程：本应用页面在 dev 下是开发服务器的 http 源，打包后是 file://…/index.html，
 *  只跑一种的话，另一种形态下「加载的页面」与「守卫认的本应用」分了叉也没有测试会红。
 *  每个测试文件一个 worker、一份本模块实例，桩的状态 h 不会互相串。
 *
 *  W2b-7 的五个接线测试也用它：tests/crash-log-wiring.test.ts（桩子进程：直接喂 stdout / stderr、触发 exit，
 *  取 before-quit 处理器走一遍优雅退出；bootMain 的 beforeImport 预置旧的按天日志，看启动时删没删）、
 *  tests/crash-log-fork.test.ts（h.forkImpl 换成真起一个 minisd 子进程）、
 *  tests/crash-log-startup-fail.test.ts（h.forkImpl 换成握手前就退出的桩子进程，bootMain 改等错误框）、
 *  tests/crash-log-window-fail.test.ts（h.loadFails 让握手之后建窗口失败，h.quitEmitsBeforeQuit 让 app.quit() 像真的一样发 before-quit）
 *  与 tests/crash-log-logroot.test.ts（bootMain 的 platformDirs：不设 DESKMINIS_DATA_DIR，数据根与日志目录分开算）。
 *  为此桩子进程把主进程挂上来的监听记进 h.child，app.on 的处理器记进 h.appOn，showErrorBox 记进 h.errorBoxes，
 *  fork 收到的 opts 记进 h.forks；h.onBlockingDialog 让测试在弹框那一刻看盘上有什么。
 *
 *  用法：vi.mock 会被提到文件最前面，工厂里不能引用文件里的变量，所以在工厂里 import 本模块——
 *    vi.mock('electron', async () => (await import('./main-window-guard-harness')).fakeElectron());
 *    vi.mock('electron-updater', async () => (await import('./main-window-guard-harness')).fakeElectronUpdater());
 *  工厂要等 src/main/index.ts 第一次 import electron 时才跑，拿到的是测试文件已经 import 的同一份模块。
 *
 *  注意：这里的桩让 app.whenReady() 立即 resolve，whenReady 回调里的东西都会在测试的 worker 里真跑一遍
 *  （tests/ipc-contract.test.ts 的桩永不 resolve，跑不到）。所以 bootMain 把数据根指向 mkdtemp 临时目录
 *  （DESKMINIS_DATA_DIR；platformDirs 时改为 APPDATA 与 LOCALAPPDATA 各指向一个），以后在 whenReady 里装的东西
 *  （例如 W2b-7 的崩溃钩子、按天日志）落盘也只落进临时目录；
 *  要桩掉或测完卸载，改这一处，两个接线测试一起生效。
 *  W2b-7 起 whenReady 会在 process 上挂 uncaughtException / unhandledRejection 两个崩溃监听：bootMain 记下它新挂的
 *  （h.crashListeners），收尾函数把它们卸掉——不卸的话它们留在 worker 里，之后的未捕获异常会被当成主进程崩溃记一笔。 */
import { expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { format } from 'node:url';

export type PermDetails = { requestingUrl?: string; isMainFrame?: boolean };
type WindowOpenHandler = (d: { url: string }) => { action: string };
type NavigateHandler = (e: { url: string; preventDefault: () => void }) => void;
type PermRequestHandler = (wc: unknown, p: string, cb: (ok: boolean) => void, d: PermDetails) => void;
type PermCheckHandler = (wc: unknown, p: string, origin: string, d: PermDetails) => boolean;
export type LoadRecord = { via: 'loadURL' | 'loadFile'; arg: string; url: string };
/** utilityProcess.fork 的实参（W2b-7 真 fork 测试按它起子进程：env 就是主进程下发给 minisd 的那一份） */
export type ForkOptions = { env?: Record<string, string | undefined>; stdio?: unknown };
/** 桩只转手监听，不关心参数形状 */
type AnyListener = (...args: any[]) => void;

export const h = {
  /** 主进程调 electron 的先后顺序（只记本步关心的几个调用） */
  calls: [] as string[],
  /** 主窗口加载了什么：via 是 loadURL / loadFile，arg 是实参，url 是窗口里实际的页面地址（规范化后的形态，
   *  will-navigate 的 e.url 与权限处理器的 details.requestingUrl 都是这个形态） */
  loads: [] as LoadRecord[],
  windowOpen: undefined as WindowOpenHandler | undefined,
  willNavigate: undefined as NavigateHandler | undefined,
  permRequest: undefined as PermRequestHandler | undefined,
  permCheck: undefined as PermCheckHandler | undefined,
  /** shell.openExternal 收到的地址 */
  opened: [] as string[],
  /** 让 shell.openExternal reject（没有默认邮件客户端的机器上 mailto: 就是这样） */
  openFails: false,
  /** 走到建托盘 = whenReady 回调走完了 */
  trayCreated: false,
  /** 桩子进程上主进程挂的监听与发来的消息（W2b-7：测试直接喂 stdout / stderr 数据、触发 exit）；kills 是主进程调 kill() 的次数 */
  child: {
    stdout: [] as AnyListener[],
    stderr: [] as AnyListener[],
    exit: [] as AnyListener[],
    posted: [] as unknown[],
    kills: 0,
  },
  /** app.on 注册的处理器，按事件名（W2b-7：取 before-quit 走一遍优雅退出） */
  appOn: new Map<string, AnyListener[]>(),
  /** 让主窗口的 loadURL / loadFile reject（W2b-7：握手之后建窗口失败，走 whenReady 的 catch） */
  loadFails: false,
  /** 让 app.quit() 像真 Electron 一样，当场（同步）把 before-quit 发给已注册的处理器。缺省关：别的用例用不着，
   *  开了会改变它们的走向。W2b-7 握手后建窗口失败的用例要它：catch 里 app.quit() 之后 quitting 才为真 */
  quitEmitsBeforeQuit: false,
  /** app.quit() 的调用记录：开了 quitEmitsBeforeQuit 时记这次发出的 before-quit 有没有被挡（preventDefault = 这次不退） */
  quits: [] as Array<{ prevented?: boolean }>,
  /** dialog.showErrorBox 收到的 [标题, 正文] */
  errorBoxes: [] as Array<[string, string]>,
  /** dialog.showErrorBox / showMessageBoxSync 被调用的那一刻先调它（W2b-7）。真 Electron 里这两个框都阻塞主线程，
   *  框后面的代码要等用户点掉才跑；托盘常驻的应用，框可能一直没人点，接着就关机、注销或被结束进程。
   *  测试在这里看「弹框之前该落盘的」是不是已经在盘上。只做快照、不要在里面断言：主进程的崩溃钩子会吞掉弹框抛的错 */
  onBlockingDialog: undefined as (() => void) | undefined,
  /** 设了就由它代替桩子进程（W2b-7 真 fork 测试在这里真起一个 minisd）；返回值当 UtilityProcess 用 */
  forkImpl: undefined as ((modulePath: string, args: string[], opts: ForkOptions) => unknown) | undefined,
  /** utilityProcess.fork 每次收到的 opts（W2b-7：看主进程下发给 minisd 的 env，例如 DESKMINIS_LOG_DIR） */
  forks: [] as ForkOptions[],
  /** bootMain 期间主进程在 process 上新挂的崩溃监听（收尾时卸掉） */
  crashListeners: { uncaught: [] as AnyListener[], rejection: [] as AnyListener[] },
};

export function fakeElectron(): Record<string, unknown> {
  class FakeWebContents {
    setWindowOpenHandler(fn: WindowOpenHandler): void { h.calls.push('setWindowOpenHandler'); h.windowOpen = fn; }
    on(event: string, fn: NavigateHandler): this {
      h.calls.push(`webContents.on:${event}`);
      if (event === 'will-navigate') h.willNavigate = fn;
      return this;
    }
    send(): void {}
  }
  class FakeBrowserWindow {
    webContents = new FakeWebContents();
    constructor() { h.calls.push('new BrowserWindow'); }
    loadURL(url: string): Promise<void> {
      h.calls.push('loadURL');
      h.loads.push({ via: 'loadURL', arg: url, url: new URL(url).href });
      // 失败时与真 Electron 同形：reject 一个带网络错误码的 Error（开发服务器没起来）
      return h.loadFails ? Promise.reject(new Error(`ERR_CONNECTION_REFUSED (-102) loading '${url}'`)) : Promise.resolve();
    }
    loadFile(filePath: string): Promise<void> {
      h.calls.push('loadFile');
      // 与 Electron 38 的 loadFile 同一个拼法：url.format({ protocol: 'file', slashes: true, pathname: path.resolve(…) })
      // （不转义 %，# 转成 %23），再按 URL 规则规范化。不用 pathToFileURL：那是守卫基址的来路，
      // 拿它当「实际加载的页面」，两边的转义差异就被测试自己抹平了。
      const page = new URL(format({ protocol: 'file', slashes: true, pathname: resolve(filePath) })).href;
      h.loads.push({ via: 'loadFile', arg: filePath, url: page });
      // 失败时与真 Electron 同形（打包产物里缺了页面文件；真 Electron 38 实测 reject 的就是这句）
      return h.loadFails ? Promise.reject(new Error(`ERR_FILE_NOT_FOUND (-6) loading '${page}'`)) : Promise.resolve();
    }
    on(): this { return this; }
    show(): void {}
    focus(): void {}
    hide(): void {}
    restore(): void {}
    isVisible(): boolean { return true; }
    isMinimized(): boolean { return false; }
    static getAllWindows(): unknown[] { return []; }
    static getFocusedWindow(): null { return null; }
  }
  // minisd 子进程：一挂 stdout 监听就交出握手行，startMinisdProcess 立即 resolve。
  // 主进程挂上来的监听都记进 h.child，测试可以接着喂数据、触发退出。
  const handshake = Buffer.from(JSON.stringify({ minisdPort: 45678, authToken: 'wiring-test-token' }) + '\n');
  const child = {
    stdout: { on: (_event: string, cb: (d: Buffer) => void) => { h.child.stdout.push(cb); cb(handshake); } },
    stderr: { on: (_event: string, cb: (d: Buffer) => void) => { h.child.stderr.push(cb); } },
    on: (event: string, cb: AnyListener) => { if (event === 'exit') h.child.exit.push(cb); },
    kill: () => { h.child.kills++; return true; },
    postMessage: (message: unknown) => { h.child.posted.push(message); },
  };
  return {
    app: {
      whenReady: () => Promise.resolve(),
      on: (event: string, fn: AnyListener) => { h.appOn.set(event, [...(h.appOn.get(event) ?? []), fn]); },
      quit: () => {
        if (!h.quitEmitsBeforeQuit) { h.quits.push({}); return; }
        // 真 Electron 的 app.quit() 在调用当场同步发 before-quit，处理器里 preventDefault 就取消这次退出
        // （真 Electron 38 实测：挡与不挡两种情形，app.quit() 返回时处理器都已经跑过）
        let prevented = false;
        const e = { preventDefault: (): void => { prevented = true; } };
        for (const fn of h.appOn.get('before-quit') ?? []) fn(e);
        h.quits.push({ prevented });
      },
      getPath: () => '.', getVersion: () => '0.0.0-test', isPackaged: false,
      setPath: () => {}, requestSingleInstanceLock: () => true, relaunch: () => {}, exit: () => {},
    },
    ipcMain: { handle: () => {} },
    BrowserWindow: FakeBrowserWindow,
    dialog: {
      showErrorBox: (title: string, content: string) => { h.onBlockingDialog?.(); h.errorBoxes.push([title, content]); },
      showMessageBox: () => Promise.resolve({ response: 0 }),
      showMessageBoxSync: () => { h.onBlockingDialog?.(); return 0; },
    },
    Menu: { buildFromTemplate: () => ({}) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) },
    Tray: class {
      constructor() { h.trayCreated = true; }
      setToolTip(): void {}
      setContextMenu(): void {}
      on(): void {}
      destroy(): void {}
    },
    utilityProcess: {
      fork: (modulePath: string, args: string[], opts: ForkOptions) => {
        h.forks.push(opts);
        return h.forkImpl ? h.forkImpl(modulePath, args, opts) : child;
      },
    },
    shell: {
      openExternal: (url: string): Promise<void> => {
        h.opened.push(url);
        return h.openFails ? Promise.reject(new Error('没有与之关联的应用程序')) : Promise.resolve();
      },
    },
    session: {
      defaultSession: {
        setPermissionRequestHandler: (fn: PermRequestHandler) => { h.calls.push('setPermissionRequestHandler'); h.permRequest = fn; },
        setPermissionCheckHandler: (fn: PermCheckHandler) => { h.calls.push('setPermissionCheckHandler'); h.permCheck = fn; },
      },
    },
  };
}

export function fakeElectronUpdater(): Record<string, unknown> {
  return {
    default: { autoUpdater: { on: () => {}, checkForUpdates: () => Promise.resolve(null), quitAndInstall: () => {},
      autoDownload: true, autoInstallOnAppQuit: false } },
  };
}

/** 把 src/main/index.ts 从 import 跑到 whenReady 建好托盘。rendererUrl 是这次的 ELECTRON_RENDERER_URL，
 *  undefined 表示没设（打包形态）。数据根指向 mkdtemp 临时目录（process.env.DESKMINIS_DATA_DIR，收尾前一直有效）。
 *  platformDirs：不设 DESKMINIS_DATA_DIR（外面设着的连同 DESKMINIS_LOG_DIR 一起清掉），改让 APPDATA 与 LOCALAPPDATA
 *  各指向一个 mkdtemp 临时目录（process.env 里这两项收尾前一直有效），主进程按平台缺省规则算目录：桩的 isPackaged 是 false，
 *  数据根 <APPDATA>/DeskMinis-dev，日志目录 <LOCALAPPDATA>/DeskMinis-dev/logs。设了 DATA_DIR 时日志目录恰好是 <数据根>/logs，
 *  「写进日志目录」与「写进数据根下的 logs」分不出来，要分开看的用例用它（W2b-7：tests/crash-log-logroot.test.ts）。
 *  timeoutMs：等 whenReady 走完的上限，缺省 10s（真 fork 的测试要等子进程握手，给得更长）。
 *  until：什么时候算「走完了」，缺省是建好托盘；启动失败的用例走不到建托盘，改等错误框。
 *  beforeImport：建好临时数据根之后、import 主进程之前调一次，传入数据根——往里预置文件，看启动流程怎么处理它们
 *  （W2b-7：预置旧的按天日志，看 whenReady 删没删）。platformDirs 时没有 DATA_DIR，两者不能同用。
 *  返回收尾函数：卸掉主进程新挂的崩溃监听、还原环境变量、删掉临时目录。 */
export async function bootMain(opts: {
  rendererUrl: string | undefined; timeoutMs?: number; until?: () => boolean; beforeImport?: (dataDir: string) => void;
  platformDirs?: boolean;
}): Promise<() => void> {
  if (opts.platformDirs && opts.beforeImport) throw new Error('bootMain：platformDirs 不设 DESKMINIS_DATA_DIR，beforeImport 拿不到数据根');
  const done = opts.until ?? ((): boolean => h.trayCreated);
  // 收尾时逐项还原（原来没设的删掉）
  const saved = ['ELECTRON_RENDERER_URL', 'DESKMINIS_DATA_DIR', 'DESKMINIS_LOG_DIR', 'APPDATA', 'LOCALAPPDATA']
    .map(k => ({ k, v: process.env[k] }));
  if (opts.rendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL;
  else process.env.ELECTRON_RENDERER_URL = opts.rendererUrl;
  const tmpDirs: string[] = [];
  const mkTmp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); tmpDirs.push(d); return d; };
  let tmpData = '';
  if (opts.platformDirs) {
    delete process.env.DESKMINIS_DATA_DIR;
    delete process.env.DESKMINIS_LOG_DIR;
    process.env.APPDATA = mkTmp('w2b7-appdata-');
    process.env.LOCALAPPDATA = mkTmp('w2b7-localappdata-');
  } else {
    tmpData = mkTmp('w2b6-wiring-');
    process.env.DESKMINIS_DATA_DIR = tmpData;
  }
  // 只认启动这段时间里新挂的：worker 里测试框架自己的监听不能被收尾函数卸掉
  const before = {
    uncaught: process.listeners('uncaughtException') as AnyListener[],
    rejection: process.listeners('unhandledRejection') as AnyListener[],
  };
  const noteAdded = (): void => {
    h.crashListeners = {
      uncaught: (process.listeners('uncaughtException') as AnyListener[]).filter(fn => !before.uncaught.includes(fn)),
      rejection: (process.listeners('unhandledRejection') as AnyListener[]).filter(fn => !before.rejection.includes(fn)),
    };
  };
  const restore = (): void => {
    for (const fn of h.crashListeners.uncaught) process.off('uncaughtException', fn);
    for (const fn of h.crashListeners.rejection) process.off('unhandledRejection', fn);
    for (const { k, v } of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  };
  // 启动流程往 stderr 写的「开发态数据根：…」只是噪音，跑完这段再放开
  const quiet = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    opts.beforeImport?.(tmpData);
    await import('../src/main/index');
    await vi.waitFor(() => { if (!done()) throw new Error('whenReady 回调还没走完（缺省：还没建托盘）'); }, { timeout: opts.timeoutMs ?? 10_000, interval: 20 });
  } catch (e) {
    noteAdded();
    restore();
    throw e;
  } finally {
    quiet.mockRestore();
  }
  noteAdded();
  return restore;
}

/** 主窗口实际加载的页面地址（只加载过一次；没加载过是空串，断言会红在调用处） */
export const loadedPage = (): string => (h.loads.length === 1 ? h.loads[0].url : '');

export const openWindow = (url: string): { action: string } => {
  expect(h.windowOpen, '主进程没有给主窗口的 webContents 注册 setWindowOpenHandler').toBeTypeOf('function');
  return h.windowOpen!({ url });
};
export const navigate = (url: string): { prevented: boolean } => {
  expect(h.willNavigate, "主进程没有给主窗口的 webContents 挂 'will-navigate'").toBeTypeOf('function');
  let prevented = false;
  h.willNavigate!({ url, preventDefault: () => { prevented = true; } });
  return { prevented };
};
export const request = (permission: string, details: PermDetails): boolean | undefined => {
  expect(h.permRequest, '主进程没有调 session.defaultSession.setPermissionRequestHandler').toBeTypeOf('function');
  let granted: boolean | undefined;
  h.permRequest!({}, permission, (ok) => { granted = ok; }, details);
  return granted;
};
export const check = (permission: string, origin: string, details: PermDetails): boolean => {
  expect(h.permCheck, '主进程没有调 session.defaultSession.setPermissionCheckHandler').toBeTypeOf('function');
  return h.permCheck!(null, permission, origin, details);
};
/** 调 fn 期间 shell.openExternal 新收到的地址 */
export const openedDuring = (fn: () => void): string[] => {
  const before = h.opened.length;
  fn();
  return h.opened.slice(before);
};
