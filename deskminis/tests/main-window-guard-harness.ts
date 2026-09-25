/** W2b-6 两个接线测试共用的 electron 桩与启动器（本文件不是测试：vitest 只收 *.test.ts）。
 *
 *  - tests/main-window-guard-wiring.test.ts：打包形态（没设 ELECTRON_RENDERER_URL，createWindow 走 loadFile）与源码守卫；
 *  - tests/main-window-guard-wiring-dev.test.ts：dev 形态（设了 ELECTRON_RENDERER_URL，走 loadURL）。
 *  两种形态都要各起一次主进程：本应用页面在 dev 下是开发服务器的 http 源，打包后是 file://…/index.html，
 *  只跑一种的话，另一种形态下「加载的页面」与「守卫认的本应用」分了叉也没有测试会红。
 *  每个测试文件一个 worker、一份本模块实例，桩的状态 h 不会互相串。
 *
 *  用法：vi.mock 会被提到文件最前面，工厂里不能引用文件里的变量，所以在工厂里 import 本模块——
 *    vi.mock('electron', async () => (await import('./main-window-guard-harness')).fakeElectron());
 *    vi.mock('electron-updater', async () => (await import('./main-window-guard-harness')).fakeElectronUpdater());
 *  工厂要等 src/main/index.ts 第一次 import electron 时才跑，拿到的是测试文件已经 import 的同一份模块。
 *
 *  注意：这里的桩让 app.whenReady() 立即 resolve，whenReady 回调里的东西都会在测试的 worker 里真跑一遍
 *  （tests/ipc-contract.test.ts 的桩永不 resolve，跑不到）。所以 bootMain 把数据根指向 mkdtemp 临时目录
 *  （DESKMINIS_DATA_DIR），以后在 whenReady 里装的东西（例如 W2b-7 的崩溃钩子、按天日志）落盘也只落进这个临时目录；
 *  要桩掉或测完卸载，改这一处，两个接线测试一起生效。 */
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
      return Promise.resolve();
    }
    loadFile(filePath: string): Promise<void> {
      h.calls.push('loadFile');
      // 与 Electron 38 的 loadFile 同一个拼法：url.format({ protocol: 'file', slashes: true, pathname: path.resolve(…) })
      // （不转义 %，# 转成 %23），再按 URL 规则规范化。不用 pathToFileURL：那是守卫基址的来路，
      // 拿它当「实际加载的页面」，两边的转义差异就被测试自己抹平了。
      const page = new URL(format({ protocol: 'file', slashes: true, pathname: resolve(filePath) })).href;
      h.loads.push({ via: 'loadFile', arg: filePath, url: page });
      return Promise.resolve();
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
  // minisd 子进程：一挂 stdout 监听就交出握手行，startMinisdProcess 立即 resolve
  const handshake = Buffer.from(JSON.stringify({ minisdPort: 45678, authToken: 'wiring-test-token' }) + '\n');
  const child = {
    stdout: { on: (_event: string, cb: (d: Buffer) => void) => { cb(handshake); } },
    stderr: { on: () => {} },
    on: () => {},
    kill: () => true,
    postMessage: () => {},
  };
  return {
    app: {
      whenReady: () => Promise.resolve(), on: () => {}, quit: () => {},
      getPath: () => '.', getVersion: () => '0.0.0-test', isPackaged: false,
      setPath: () => {}, requestSingleInstanceLock: () => true, relaunch: () => {}, exit: () => {},
    },
    ipcMain: { handle: () => {} },
    BrowserWindow: FakeBrowserWindow,
    dialog: { showErrorBox: () => {}, showMessageBox: () => Promise.resolve({ response: 0 }), showMessageBoxSync: () => 0 },
    Menu: { buildFromTemplate: () => ({}) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) },
    Tray: class {
      constructor() { h.trayCreated = true; }
      setToolTip(): void {}
      setContextMenu(): void {}
      on(): void {}
      destroy(): void {}
    },
    utilityProcess: { fork: () => child },
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
 *  undefined 表示没设（打包形态）。数据根指向 mkdtemp 临时目录。返回收尾函数：还原环境变量、删掉临时数据根。 */
export async function bootMain(opts: { rendererUrl: string | undefined }): Promise<() => void> {
  const saved = { renderer: process.env.ELECTRON_RENDERER_URL, dataDir: process.env.DESKMINIS_DATA_DIR };
  if (opts.rendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL;
  else process.env.ELECTRON_RENDERER_URL = opts.rendererUrl;
  const tmpData = mkdtempSync(join(tmpdir(), 'w2b6-wiring-'));
  process.env.DESKMINIS_DATA_DIR = tmpData;
  const restore = (): void => {
    if (saved.renderer === undefined) delete process.env.ELECTRON_RENDERER_URL; else process.env.ELECTRON_RENDERER_URL = saved.renderer;
    if (saved.dataDir === undefined) delete process.env.DESKMINIS_DATA_DIR; else process.env.DESKMINIS_DATA_DIR = saved.dataDir;
    rmSync(tmpData, { recursive: true, force: true });
  };
  // 启动流程往 stderr 写的「开发态数据根：…」只是噪音，跑完这段再放开
  const quiet = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await import('../src/main/index');
    await vi.waitFor(() => { if (!h.trayCreated) throw new Error('whenReady 回调还没走到建托盘'); }, { timeout: 10_000, interval: 20 });
  } catch (e) {
    restore();
    throw e;
  } finally {
    quiet.mockRestore();
  }
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
