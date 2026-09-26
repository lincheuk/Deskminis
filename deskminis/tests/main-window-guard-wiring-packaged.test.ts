/** W2b-6b（设计稿 §4.1 W2b-6b）：打包版的主进程——不认 ELECTRON_RENDERER_URL、去掉应用菜单，窗口守卫照样挂。
 *
 *  为什么：
 *  - 打包版以前也认 ELECTRON_RENDERER_URL（W2b-6 实现者申报、三轮审查都留作待裁）：用户环境里残留这个变量（装过 electron-vite
 *    的开发机最常见），或者能改用户环境变量的人设了它，安装好的应用就去加载那个 http 地址，而导航守卫与权限白名单也把那个源
 *    当成本应用——放行导航、放行剪贴板写入。它只该给 npm run dev 用：打包后一律 loadFile(out/renderer/index.html)，守卫的基址也不认它。
 *  - 打包版以前不设应用菜单，Electron 自动装一套默认菜单：无边框窗口里看不见，快捷键却都生效——Ctrl+R 在回合中途把界面整页重载
 *    （流式正文、待批的权限卡、输入框里没发出去的字都没了），Ctrl+Shift+I 打开开发者工具（W2b-11a 第三轮审查 nit）。
 *    打包版在建窗口之前换上 app-menu 的最小菜单（W2b-6c，以前是 null）；开发态保留默认菜单（开发要用重载与开发者工具），在 dev 形态的文件里钉。
 *  - 以前接线测试里桩的 isPackaged 恒为假，把两道窗口守卫包进 if (!app.isPackaged) 也全绿（W2b-6 第三轮审查 P1）：
 *    这里在打包版上把新窗口、页内导航、权限三道守卫再走一遍。
 *
 *  本文件起一次主进程：桩的 isPackaged 为真，并且设着 ELECTRON_RENDERER_URL（electron-vite 的真实形状）。
 *  electron 桩与启动器在 tests/main-window-guard-harness.ts（whenReady 在 worker 里真跑，数据根用 mkdtemp 临时目录）。 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootMain, check, h, loadedPage, navigate, openWindow, openedDuring, request } from './main-window-guard-harness';
import { PACKAGED_MENU_TEMPLATE } from '../src/main/app-menu';

vi.mock('electron', async () => (await import('./main-window-guard-harness')).fakeElectron());
vi.mock('electron-updater', async () => (await import('./main-window-guard-harness')).fakeElectronUpdater());

/** 残留在环境里的开发服务器地址（electron-vite 设的就是这个形状） */
const DEV = 'http://localhost:5173';
/** 打包版的本应用页面：主进程 loadFile 的是 src/main 旁边的 ../renderer/index.html */
const APP = pathToFileURL(join(__dirname, '..', 'src/renderer/index.html')).href;

let restore = (): void => {};
// 全量并发时起主进程可能慢，钩子时限放宽到 30s
beforeAll(async () => { restore = await bootMain({ rendererUrl: DEV, isPackaged: true }); }, 30_000);
afterAll(() => { restore(); });

describe('打包版不认 ELECTRON_RENDERER_URL：加载的与守卫认的都是 out/renderer/index.html', () => {
  it('设着 ELECTRON_RENDERER_URL 也只加载一次、走 loadFile，加载的正是 index.html，不是开发服务器', () => {
    expect(h.loads.map((l) => l.via), '打包版应当 loadFile').toEqual(['loadFile']);
    expect(h.calls).not.toContain('loadURL');
    expect(loadedPage()).toBe(APP);
  });

  it.each([
    ['加载的页面', ''],
    ['加载的页面带 #hash', '#/settings'],
    ['加载的页面带 ?query（整页重载）', '?r=1'],
  ])('页内导航到%s：放行、不交出去', (_label, suffix) => {
    expect(loadedPage(), '主窗口没有加载页面').not.toBe('');
    let r: { prevented: boolean } | undefined;
    const opened = openedDuring(() => { r = navigate(loadedPage() + suffix); });
    expect(r).toEqual({ prevented: false });
    expect(opened).toEqual([]);
  });

  it('页内导航到 ELECTRON_RENDERER_URL 那个源：不是本应用，拦下，当普通网页交给系统浏览器', () => {
    for (const url of [`${DEV}/`, `${DEV}/#/settings`]) {
      let r: { prevented: boolean } | undefined;
      const opened = openedDuring(() => { r = navigate(url); });
      expect(r, url).toEqual({ prevented: true });
      expect(opened, url).toEqual([url]);
    }
  });

  it('ELECTRON_RENDERER_URL 那个源的页面要剪贴板写入：请求与检查都拒绝', () => {
    expect(request('clipboard-sanitized-write', { requestingUrl: `${DEV}/`, isMainFrame: true })).toBe(false);
    expect(check('clipboard-sanitized-write', DEV, { requestingUrl: `${DEV}/`, isMainFrame: true })).toBe(false);
  });

  it('加载的页面要剪贴板写入：请求与检查都放行；要别的权限一律拒绝', () => {
    expect(loadedPage(), '主窗口没有加载页面').not.toBe('');
    expect(request('clipboard-sanitized-write', { requestingUrl: loadedPage(), isMainFrame: true })).toBe(true);
    expect(check('clipboard-sanitized-write', 'file:///', { requestingUrl: loadedPage(), isMainFrame: true })).toBe(true);
    for (const p of ['clipboard-read', 'notifications', 'media', 'geolocation', 'openExternal']) {
      expect(request(p, { requestingUrl: loadedPage(), isMainFrame: true }), p).toBe(false);
      expect(check(p, 'file:///', { requestingUrl: loadedPage(), isMainFrame: true }), p).toBe(false);
    }
  });
});

describe('打包版照样挂窗口守卫（以前桩的 isPackaged 恒为假，这一侧从没跑过）', () => {
  it('新窗口与导航两道守卫、两个权限处理器都挂在 loadFile 之前', () => {
    const iLoad = h.calls.indexOf('loadFile');
    expect(iLoad).toBeGreaterThanOrEqual(0);
    for (const c of ['setPermissionRequestHandler', 'setPermissionCheckHandler', 'setWindowOpenHandler', 'webContents.on:will-navigate']) {
      const i = h.calls.indexOf(c);
      expect(i, `${c} 没有注册`).toBeGreaterThanOrEqual(0);
      expect(i, `${c} 必须在 loadFile 之前`).toBeLessThan(iLoad);
    }
  });

  it.each([
    ['https://example.com/', ['https://example.com/']],
    ['mailto:someone@example.com', ['mailto:someone@example.com']],
    ['javascript:alert(1)', []],
    ['about:blank', []],
  ])('新窗口 %s：{ action: \'deny\' }，交给系统默认程序的是 %j', (url, expected) => {
    let r: { action: string } | undefined;
    const opened = openedDuring(() => { r = openWindow(url); });
    expect(r).toEqual({ action: 'deny' });
    expect(opened).toEqual(expected);
  });

  it('页内导航到外站：拦下并交给系统浏览器；到别处的 file://：拦下、不交出去', () => {
    let r: { prevented: boolean } | undefined;
    let opened = openedDuring(() => { r = navigate('https://example.com/x'); });
    expect(r).toEqual({ prevented: true });
    expect(opened).toEqual(['https://example.com/x']);
    opened = openedDuring(() => { r = navigate('file:///etc/passwd'); });
    expect(r).toEqual({ prevented: true });
    expect(opened).toEqual([]);
  });
});

describe('打包版换掉默认菜单', () => {
  it('Menu.setApplicationMenu 恰好调一次、设的是 app-menu 的模板，在建窗口之前（没有 Ctrl+R 重载、Ctrl+Shift+I 开发者工具，缩放还在）', () => {
    // W2b-6c：不再设 null——那样缩放与 F11 全屏也没了；模板里有什么、没什么由 tests/app-menu.test.ts 钉
    expect(h.appMenus, '打包版应当恰好设一次应用菜单').toHaveLength(1);
    expect((h.appMenus[0] as { template?: unknown } | null)?.template, '设的是 PACKAGED_MENU_TEMPLATE 建出来的菜单').toBe(PACKAGED_MENU_TEMPLATE);
    const iMenu = h.calls.indexOf('Menu.setApplicationMenu');
    const iWin = h.calls.indexOf('new BrowserWindow');
    expect(iWin, '走到了建窗口').toBeGreaterThanOrEqual(0);
    expect(iMenu, '去菜单要在建窗口之前').toBeLessThan(iWin);
  });
});

describe('W3-aumid：打包版的 AppUserModelID', () => {
  // 只有 Windows 上才设（app.setAppUserModelId 是 Windows 专有的方法）；在 Windows 上跑 npm test 时这一例钉住「真的设了、设的是 appId」，
  // Linux 上钉住「不在没有这个方法的平台上调它」。判定本身三种情形都在 tests/app-identity.test.ts
  it('win32 上在 import 期恰好设一次 com.deskminis.app，别的平台一次也不设', () => {
    expect(h.appUserModelIds).toEqual(process.platform === 'win32' ? ['com.deskminis.app'] : []);
  });
});
