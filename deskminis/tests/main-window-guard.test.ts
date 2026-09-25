/** W2b-6（侦察 lifecycle.md「W2b-guards」· cross.md S24 · 设计稿 §4 W2b-6）：窗口导航守卫与权限白名单的判定。
 *
 *  为什么：主进程以前对渲染端的新开窗口、页内导航、权限请求一概不管。改动前的构建在 xvfb 下实测：
 *  - 回复里的 markdown 外链（target=_blank）与 window.open 各开出一个 Electron 窗口，外站页面在应用里加载；
 *  - location.href 改到外站，整个界面被换成外站页面，只能重启应用；
 *  - 通知、剪贴板读取、定位、摄像头的权限查询全都是 granted。
 *
 *  判定全放在 src/main/nav-guard.ts（纯函数，不 import electron），这里直接穷举；
 *  主进程只接线，接线的行为与源码守卫在 tests/main-window-guard-wiring.test.ts。
 *  - 交给系统默认程序的只有 http / https / mailto；
 *  - 本应用页面：dev 是 ELECTRON_RENDERER_URL 的源；打包后是 out/renderer/index.html 这一个文件（带 #hash、?query 算同页）；
 *  - 权限只放行本应用页面发起的 clipboard-sanitized-write（全树只用 navigator.clipboard.writeText；粘贴走 paste 事件，不经权限）。 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ALLOWED_PERMISSIONS, EXTERNAL_PROTOCOLS, appBaseUrl, externalUrlOf, isAppUrl, isExternalSafe, permissionAllowed,
} from '../src/main/nav-guard';

/** 打包形态的基址夹具，按指定的规则生成、与测试跑在哪个平台无关：isAppUrl / permissionAllowed 是纯 URL 比较，
 *  拿来比的地址都写死了，基址也得写死。pathToFileURL 不给 windows 选项就随运行平台走——Windows 上 /opt/… 会先被补成
 *  当前盘符（file:///C:/opt/…），正例因此变红，反例因盘符不同白白变绿。{ windows: true } 与 Windows 上默认走的是
 *  同一条路径（带盘符的绝对路径不看当前目录），Windows 形态的基址在 Linux 上也生成得出来。 */
const posixFileUrl = (p: string): string => pathToFileURL(p, { windows: false }).href;
const winFileUrl = (p: string): string => pathToFileURL(p, { windows: true }).href;

describe('常量', () => {
  it('EXTERNAL_PROTOCOLS 只有 http: / https: / mailto:，且冻结', () => {
    expect(EXTERNAL_PROTOCOLS).toEqual(['http:', 'https:', 'mailto:']);
    expect(Object.isFrozen(EXTERNAL_PROTOCOLS)).toBe(true);
  });

  it('ALLOWED_PERMISSIONS 深等 [\'clipboard-sanitized-write\']，且冻结', () => {
    expect(ALLOWED_PERMISSIONS).toEqual(['clipboard-sanitized-write']);
    expect(Object.isFrozen(ALLOWED_PERMISSIONS)).toBe(true);
  });
});

describe('isExternalSafe / externalUrlOf：交给 shell.openExternal 的只有 http / https / mailto', () => {
  it.each([
    'https://a.b',
    'http://example.com/x?y=1#z',
    'mailto:x@y',
    'mailto:someone@example.com?subject=hi',
    'HTTPS://EXAMPLE.COM/',
    'MailTo:x@y',
  ])('%s → 交出去', (url) => {
    expect(isExternalSafe(url)).toBe(true);
    expect(externalUrlOf(url)).toBeTypeOf('string');
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'java\tscript:alert(1)',
    'file:///C:/x',
    'file:///etc/passwd',
    'data:text/html,x',
    'deskminis://x',
    'about:blank',
    'blob:https://a.b/7d1c0f0e-0000-4000-8000-000000000000',
    'vbscript:msgbox(1)',
    'ms-settings:privacy',
    'ftp://a.b/x',
    'ws://a.b/',
    'chrome://settings',
    'devtools://devtools/bundled/inspector.html',
    'not a url',
    '',
    '//a.b/x',
    '/relative/path',
    'https://',
  ])('%s → 不交出去（解析失败也算）', (url) => {
    expect(isExternalSafe(url)).toBe(false);
    expect(externalUrlOf(url)).toBeUndefined();
  });

  it('交出去的是解析后的规范形：协议与主机小写、空格转义、首尾空白去掉', () => {
    expect(externalUrlOf('HTTPS://Example.COM/a b')).toBe('https://example.com/a%20b');
    expect(externalUrlOf('  https://a.b/x  ')).toBe('https://a.b/x');
    expect(externalUrlOf('mailto:someone@example.com?subject=hi')).toBe('mailto:someone@example.com?subject=hi');
  });
});

describe('appBaseUrl：本应用页面的地址（createWindow 按它加载，守卫按它认本应用）', () => {
  const index = '/opt/DeskMinis/resources/app.asar/out/renderer/index.html';

  it('设了 ELECTRON_RENDERER_URL（dev）就是它', () => {
    expect(appBaseUrl('http://localhost:5173/', index)).toBe('http://localhost:5173/');
  });

  it('没设或是空串（按真假判，空串当没设）：out/renderer/index.html 的 file URL', () => {
    expect(appBaseUrl(undefined, index)).toBe(pathToFileURL(index).href);
    expect(appBaseUrl('', index)).toBe(pathToFileURL(index).href);
  });

  // 打包后 createWindow 把基址还原成路径交给 loadFile：还原出来必须还是 index.html 那个文件，
  // 否则加载的与守卫认的又分了叉。路径里带空格、%、#、?、非 ASCII 也要原样还原。
  // appBaseUrl 里的 pathToFileURL 与这里的 fileURLToPath 都随运行平台走，夹具就得是本机形态的绝对路径
  // （主进程拿 __dirname 拼出来的就是这种）：posix 形态的 /opt/… 在 Windows 上会先被补成当前盘符，还原出 C:\opt\…，
  // 与原串不等。Windows 文件名里不许有 ?，那一组不带；非 ASCII 放在用户名上（按用户安装在 AppData\Local\Programs 下）。
  const nativeIndexPaths = process.platform === 'win32'
    ? [
      'C:\\Program Files\\DeskMinis\\resources\\app.asar\\out\\renderer\\index.html',
      'C:\\Users\\张三\\AppData\\Local\\Programs\\Desk Minis\\100%\\C#\\{x}\\out\\renderer\\index.html',
      'D:\\%41%25\\out\\renderer\\index.html',
    ]
    : [
      index,
      '/opt/Desk Minis/100%/C#/a?b/张三/out/renderer/index.html',
      '/opt/%41%25/out/renderer/index.html',
    ];
  it.each(nativeIndexPaths)('打包后按基址 loadFile：fileURLToPath 还原出的正是 %s', (p) => {
    expect(fileURLToPath(appBaseUrl(undefined, p))).toBe(p);
  });
});

describe('isAppUrl：dev——ELECTRON_RENDERER_URL 的源', () => {
  const base = 'http://localhost:5173/';

  it.each([
    'http://localhost:5173/',
    'http://localhost:5173',
    'http://localhost:5173/#/settings',
    'http://localhost:5173/index.html?t=1',
    'http://LOCALHOST:5173/',
  ])('%s 是本应用', (url) => {
    expect(isAppUrl(url, base)).toBe(true);
    // 基址不带尾斜杠也一样（端口不能写死，取的是实际的 ELECTRON_RENDERER_URL）
    expect(isAppUrl(url, 'http://localhost:5173')).toBe(true);
  });

  it.each([
    'http://localhost:5174/',
    'http://127.0.0.1:5173/',
    'https://localhost:5173/',
    'http://localhost/',
    'https://example.com/',
    'file:///opt/DeskMinis/resources/app.asar/out/renderer/index.html',
    'javascript:alert(1)',
    'data:text/html,x',
    'not a url',
    '',
  ])('%s 不是本应用', (url) => {
    expect(isAppUrl(url, base)).toBe(false);
  });

  it('基址本身解析不了：什么都不算本应用', () => {
    expect(isAppUrl('http://localhost:5173/', 'not a url')).toBe(false);
    expect(isAppUrl('http://localhost:5173/', '')).toBe(false);
  });
});

describe('isAppUrl：打包后——out/renderer/index.html 这一个文件', () => {
  const base = posixFileUrl('/opt/DeskMinis/resources/app.asar/out/renderer/index.html');

  it.each(['', '#/settings', '?x=1', '?x=1#y', '#'])('同一个文件加「%s」是本应用', (suffix) => {
    expect(isAppUrl(base + suffix, base)).toBe(true);
  });

  it.each([
    'file:///opt/DeskMinis/resources/app.asar/out/renderer/other.html',
    'file:///opt/DeskMinis/resources/app.asar/out/renderer/',
    'file:///opt/DeskMinis/resources/app.asar/out/renderer/index.html.bak',
    'file:///opt/DeskMinis/resources/app.asar/out/index.html',
    'file:///etc/passwd',
    'file://evil.example/opt/DeskMinis/resources/app.asar/out/renderer/index.html',
    'https://example.com/',
    'http://localhost:5173/',
    'javascript:alert(1)',
    'data:text/html,x',
    'not a url',
  ])('%s 不是本应用（同目录的别的文件、别处的 file:// 一律不算）', (url) => {
    expect(isAppUrl(url, base)).toBe(false);
  });

  it('Windows 形态：Chromium 把盘符规范成大写、转义集与 pathToFileURL 不尽相同，同一个文件照样认得出', () => {
    // pathToFileURL 在 Windows 上给出的形态
    const win = 'file:///C:/Program%20Files/DeskMinis/resources/app.asar/out/renderer/index.html';
    expect(winFileUrl('C:\\Program Files\\DeskMinis\\resources\\app.asar\\out\\renderer\\index.html')).toBe(win);
    expect(isAppUrl(`${win}#/settings`, win)).toBe(true);
    expect(isAppUrl('file:///c:/Program%20Files/DeskMinis/resources/app.asar/out/renderer/index.html', win)).toBe(true);
    expect(isAppUrl(win, 'file:///c:/Program%20Files/DeskMinis/resources/app.asar/out/renderer/index.html')).toBe(true);
    expect(isAppUrl('file:///C:/Program Files/DeskMinis/resources/app.asar/out/renderer/index.html', win)).toBe(true);
    expect(isAppUrl('file:///D:/Program%20Files/DeskMinis/resources/app.asar/out/renderer/index.html', win)).toBe(false);
    expect(isAppUrl('file:///C:/Windows/System32/drivers/etc/hosts', win)).toBe(false);
  });

  it('路径里有非 ASCII、花括号、#、孤立的 %：按解码后的路径比较', () => {
    // Electron 的 loadFile 用 url.format 拼地址（不转义 %，# 转成 %23），Chromium 再规范化；
    // 基址是 pathToFileURL 给的（% → %25，非 ASCII 与 {} 百分号转义）。两边解码后是同一个路径就算同页。
    const zh = posixFileUrl('/home/张三/Desk{Minis}/out/renderer/index.html');
    expect(isAppUrl('file:///home/%E5%BC%A0%E4%B8%89/Desk{Minis}/out/renderer/index.html', zh)).toBe(true);
    expect(isAppUrl('file:///home/张三/Desk%7BMinis%7D/out/renderer/index.html#/x', zh)).toBe(true);
    const pct = posixFileUrl('/opt/100%/out/renderer/index.html');
    expect(pct).toContain('100%25');
    expect(isAppUrl('file:///opt/100%/out/renderer/index.html', pct)).toBe(true);
    const hash = posixFileUrl('/opt/C#/out/renderer/index.html');
    expect(isAppUrl('file:///opt/C%23/out/renderer/index.html#/x', hash)).toBe(true);
    expect(isAppUrl('file:///opt/C/out/renderer/index.html', hash)).toBe(false);
  });

  it('Windows 形态同样：用户名非 ASCII、花括号、#、孤立的 %，按解码后的路径比较（盘符不分大小写）', () => {
    // 按用户安装时装在 C:\Users\<用户名>\AppData\Local\Programs 下（electron-builder.yml 的 nsis.perMachine: false），
    // 中文用户名就落进了路径；%、#、{} 在 Windows 文件名里都合法。基址按 Windows 规则生成，Linux 上照样跑。
    const zh = winFileUrl('C:\\Users\\张三\\AppData\\Local\\Programs\\Desk{Minis}\\out\\renderer\\index.html');
    expect(zh).toBe('file:///C:/Users/%E5%BC%A0%E4%B8%89/AppData/Local/Programs/Desk%7BMinis%7D/out/renderer/index.html');
    expect(isAppUrl('file:///C:/Users/张三/AppData/Local/Programs/Desk{Minis}/out/renderer/index.html#/x', zh)).toBe(true);
    expect(isAppUrl('file:///c:/Users/%E5%BC%A0%E4%B8%89/AppData/Local/Programs/Desk{Minis}/out/renderer/index.html', zh)).toBe(true);
    expect(isAppUrl('file:///C:/Users/李四/AppData/Local/Programs/Desk{Minis}/out/renderer/index.html', zh)).toBe(false);
    const pct = winFileUrl('C:\\Program Files\\100%\\out\\renderer\\index.html');
    expect(pct).toContain('100%25');
    expect(isAppUrl('file:///C:/Program%20Files/100%/out/renderer/index.html', pct)).toBe(true);
    const hash = winFileUrl('D:\\C#\\out\\renderer\\index.html');
    expect(isAppUrl('file:///D:/C%23/out/renderer/index.html#/x', hash)).toBe(true);
    expect(isAppUrl('file:///D:/C/out/renderer/index.html', hash)).toBe(false);
  });
});

describe('permissionAllowed：只放行本应用页面的 clipboard-sanitized-write', () => {
  const prod = posixFileUrl('/opt/DeskMinis/resources/app.asar/out/renderer/index.html');
  const dev = 'http://localhost:5173/';

  it('本应用页面（打包后、dev）要剪贴板写入：放行', () => {
    expect(permissionAllowed('clipboard-sanitized-write', `${prod}#/`, prod)).toBe(true);
    expect(permissionAllowed('clipboard-sanitized-write', 'http://localhost:5173/', dev)).toBe(true);
  });

  // Electron 38 的 setPermissionRequestHandler / setPermissionCheckHandler 类型里列出的其余全部权限
  it.each([
    'clipboard-read', 'deprecated-sync-clipboard-read', 'notifications', 'media', 'mediaKeySystem', 'geolocation',
    'fullscreen', 'openExternal', 'midi', 'midiSysex', 'pointerLock', 'keyboardLock', 'display-capture',
    'idle-detection', 'window-management', 'storage-access', 'top-level-storage-access', 'speaker-selection',
    'fileSystem', 'hid', 'serial', 'usb', 'unknown', 'Clipboard-Sanitized-Write', '',
  ])('本应用页面要 %s：拒绝', (permission) => {
    expect(permissionAllowed(permission, prod, prod)).toBe(false);
    expect(permissionAllowed(permission, 'http://localhost:5173/', dev)).toBe(false);
  });

  it('不是本应用页面（外站、别的 file://、跨源子框架没有 requestingUrl）要剪贴板写入：拒绝', () => {
    for (const from of ['https://example.com/', 'file:///etc/passwd', 'http://localhost:5174/', undefined, '']) {
      expect(permissionAllowed('clipboard-sanitized-write', from, prod), String(from)).toBe(false);
      expect(permissionAllowed('clipboard-sanitized-write', from, dev), String(from)).toBe(false);
    }
  });
});
