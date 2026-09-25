/** W2b-6（侦察 lifecycle.md「W2b-guards」· cross.md S24 · 设计稿 §4 W2b-6）：窗口导航守卫与权限白名单的接线——dev 形态。
 *
 *  npm run dev 时 electron-vite 设 ELECTRON_RENDERER_URL，createWindow 走 loadURL 加载开发服务器的 http 源；
 *  打包后不认这个变量（W2b-6b，见 tests/main-window-guard-wiring-packaged.test.ts），走 loadFile 加载 file://…/index.html。
 *  两种都是本应用，都要放行（本步补充要求）。
 *  loadFile 形态与源码守卫在 tests/main-window-guard-wiring.test.ts，这里另起一次主进程跑 dev 形态：
 *  以前只跑打包形态，守卫的基址若不认 ELECTRON_RENDERER_URL，dev 下页面发起权限的 requestingUrl 是
 *  http://localhost:5173/、基址却是 file://…/index.html，剪贴板写入被拒，代码块「复制」与「复制完整路径」静默失效
 *  （MarkdownView / PreviewPane catch 后不提示），测试照样全绿（W2b-6 审查的变异 A）。
 *  electron 桩与启动器在 tests/main-window-guard-harness.ts（whenReady 在 worker 里真跑，数据根用 mkdtemp 临时目录）。 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootMain, check, h, loadedPage, navigate, openWindow, openedDuring, request } from './main-window-guard-harness';

vi.mock('electron', async () => (await import('./main-window-guard-harness')).fakeElectron());
vi.mock('electron-updater', async () => (await import('./main-window-guard-harness')).fakeElectronUpdater());

/** electron-vite 设的就是这个形状：`${protocol}//${host}:${port}`，不带尾斜杠；端口随开发服务器，不固定 */
const DEV = 'http://localhost:5173';
/** 打包形态的本应用页面：dev 下它不是本应用 */
const PACKAGED = pathToFileURL(join(__dirname, '..', 'src/renderer/index.html')).href;

let restore = (): void => {};
// 全量并发时起主进程可能慢，钩子时限放宽到 30s
beforeAll(async () => { restore = await bootMain({ rendererUrl: DEV }); }, 30_000);
afterAll(() => { restore(); });

describe('dev 形态：加载的是 ELECTRON_RENDERER_URL', () => {
  it('只加载一次、走 loadURL，实参就是 ELECTRON_RENDERER_URL', () => {
    expect(h.loads.map((l) => [l.via, l.arg])).toEqual([['loadURL', DEV]]);
    expect(h.calls).not.toContain('loadFile');
    expect(loadedPage()).toBe('http://localhost:5173/');
  });

  it('两道窗口守卫与两个权限处理器都挂在 loadURL 之前', () => {
    const iLoad = h.calls.indexOf('loadURL');
    for (const c of ['setPermissionRequestHandler', 'setPermissionCheckHandler', 'setWindowOpenHandler', 'webContents.on:will-navigate']) {
      const i = h.calls.indexOf(c);
      expect(i, `${c} 没有注册`).toBeGreaterThanOrEqual(0);
      expect(i, `${c} 必须在 loadURL 之前`).toBeLessThan(iLoad);
    }
  });
});

describe('dev 形态：页内导航只放行开发服务器的源', () => {
  it.each([
    ['加载的页面', ''],
    ['加载的页面带 #hash', '#/settings'],
    ['加载的页面带 ?query（整页重载）', '?r=1'],
    ['同源的别的路径', 'index.html'],
  ])('%s：放行、不交出去', (_label, suffix) => {
    expect(loadedPage(), '主窗口没有加载页面').not.toBe('');
    let r: { prevented: boolean } | undefined;
    const opened = openedDuring(() => { r = navigate(loadedPage() + suffix); });
    expect(r).toEqual({ prevented: false });
    expect(opened).toEqual([]);
  });

  it.each([
    ['另一个端口', 'http://localhost:5174/'],
    ['端口只是前缀相同', 'http://localhost:51730/'],
    ['同端口换成 https', 'https://localhost:5173/'],
    ['同端口换一个主机名', 'http://127.0.0.1:5173/'],
    ['外站', 'https://example.com/'],
  ])('%s：拦下，交给系统默认程序', (_label, url) => {
    let r: { prevented: boolean } | undefined;
    const opened = openedDuring(() => { r = navigate(url); });
    expect(r).toEqual({ prevented: true });
    expect(opened).toEqual([url]);
  });

  it('打包形态的 index.html（file://）：dev 下不是本应用，拦下，不交出去', () => {
    let r: { prevented: boolean } | undefined;
    const opened = openedDuring(() => { r = navigate(PACKAGED); });
    expect(r).toEqual({ prevented: true });
    expect(opened).toEqual([]);
  });
});

describe('dev 形态：新开窗口一律拒绝', () => {
  it.each(['https://example.com/', 'http://localhost:5173/#/settings', PACKAGED, 'javascript:alert(1)'])('%s：{ action: \'deny\' }', (url) => {
    expect(openWindow(url)).toEqual({ action: 'deny' });
  });
});

describe('dev 形态：权限只放行开发服务器页面的 clipboard-sanitized-write', () => {
  it('加载的页面（及其 #hash）要 clipboard-sanitized-write：请求与检查都放行', () => {
    expect(loadedPage(), '主窗口没有加载页面').not.toBe('');
    for (const u of [loadedPage(), `${loadedPage()}#/settings`]) {
      expect(request('clipboard-sanitized-write', { requestingUrl: u, isMainFrame: true }), u).toBe(true);
      expect(check('clipboard-sanitized-write', DEV, { requestingUrl: u, isMainFrame: true }), u).toBe(true);
    }
  });

  it('别的源、打包形态的 file:// 页面、没有 requestingUrl（跨源子框架）要 clipboard-sanitized-write：一律拒绝', () => {
    for (const from of ['http://localhost:5174/', 'http://localhost:51730/', 'https://localhost:5173/', 'https://example.com/', PACKAGED]) {
      expect(request('clipboard-sanitized-write', { requestingUrl: from, isMainFrame: true }), from).toBe(false);
      expect(check('clipboard-sanitized-write', new URL(from).origin, { requestingUrl: from, isMainFrame: true }), from).toBe(false);
    }
    expect(request('clipboard-sanitized-write', { isMainFrame: false })).toBe(false);
    expect(check('clipboard-sanitized-write', DEV, { isMainFrame: false })).toBe(false);
  });

  it.each(['clipboard-read', 'notifications', 'media', 'geolocation', 'fullscreen', 'openExternal'])(
    '加载的页面要 %s：请求与检查都拒绝',
    (p) => {
      expect(request(p, { requestingUrl: loadedPage(), isMainFrame: true })).toBe(false);
      expect(check(p, DEV, { requestingUrl: loadedPage(), isMainFrame: true })).toBe(false);
    },
  );
});

// W2b-6b：打包版去掉应用菜单（tests/main-window-guard-wiring-packaged.test.ts），开发态不动——
// Electron 的默认菜单留给开发：Ctrl+R 重载、Ctrl+Shift+I 开发者工具。去菜单写成不看 isPackaged 的话，这里红。
describe('dev 形态：应用菜单保持 Electron 的默认菜单', () => {
  it('Menu.setApplicationMenu 一次也没调', () => {
    expect(h.trayCreated, 'whenReady 走完了').toBe(true);
    expect(h.appMenus).toEqual([]);
    expect(h.calls).not.toContain('Menu.setApplicationMenu');
  });
});
