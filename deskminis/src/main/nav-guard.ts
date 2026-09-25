/** W2b-6 窗口导航守卫与权限白名单的判定（设计稿 §4 W2b-6 · 侦察 lifecycle.md「W2b-guards」· cross.md S24）。
 *
 *  为什么：主进程以前对渲染端的新开窗口、页内导航、权限请求一概不管。回复里的 markdown 外链（target=_blank）
 *  与 window.open 会在应用里开出第二个 Electron 窗口加载外站；location.href 改到外站（或把文件拖到输入区以外，
 *  Chromium 按 file:// 导航）会把整个界面换掉，只能重启；通知、剪贴板读取、定位、摄像头等权限一律放行。
 *  现在：新窗口一律拒绝，网页与邮件交给系统默认程序；不是本应用页面的导航拦下；权限只放行剪贴板写入。
 *
 *  W2b-6b 订正：渲染端会新开窗口的地方不止 markdown 外链。侦察（lifecycle.md 的事实清单）与 W2b-6 当初以为
 *  「外链只有 MarkdownInline 的 <a target=_blank>、渲染端没有 window.open」，漏了终端抽屉：xterm 让输出里的 OSC 8
 *  超链接可点，改动前打包产物里唯一的 window.open( 就是 xterm 自带的那段——先 window.open() 开空白窗口、事后才改地址。
 *  新窗口处理器只看得到新窗口一开始要加载的地址，于是只收到 about:blank，拒绝之后什么也没交出去，终端里的链接点了没反应。
 *  W2b-6b 起 TerminalPane 配了 linkHandler，确认后直接 window.open(地址)，地址才到得了这里、交得给系统浏览器。
 *
 *  纯函数、不 import electron：判定都在这里，单测直接穷举（tests/main-window-guard.test.ts）；
 *  主进程（index.ts 的 createWindow 与 whenReady）只接线。 */
import { pathToFileURL } from 'node:url';

/** 交给系统默认程序（shell.openExternal）的协议：网页与邮件。
 *  javascript: / data: / file: / 自定义协议一律不交——交出去等于让页面内容指挥系统去执行或打开本机文件。 */
export const EXTERNAL_PROTOCOLS: readonly string[] = Object.freeze(['http:', 'https:', 'mailto:']);

/** 渲染端能拿到的权限只有这一项：全树只用 navigator.clipboard.writeText
 *  （代码块「复制」、预览区「复制完整路径」）；粘贴走 paste 事件，不经权限。
 *  其余（通知、摄像头麦克风、定位、剪贴板读取、全屏、openExternal……）一律拒绝。 */
export const ALLOWED_PERMISSIONS: readonly string[] = Object.freeze(['clipboard-sanitized-write']);

function parse(url: string): URL | undefined {
  try { return new URL(url); } catch { return undefined; }
}

/** 交给 shell.openExternal 的地址：协议在 EXTERNAL_PROTOCOLS 里才给，给的是解析后的规范形（首尾空白、
 *  大小写、转义都理过）；不给就是 undefined。解析失败也不给。 */
export function externalUrlOf(url: string): string | undefined {
  const u = parse(url);
  return u !== undefined && EXTERNAL_PROTOCOLS.includes(u.protocol) ? u.href : undefined;
}

export function isExternalSafe(url: string): boolean {
  return externalUrlOf(url) !== undefined;
}

/** 本应用页面的地址（按真假判，空串当没设）。主进程的 createWindow 按它加载，导航守卫与权限白名单按它认本应用——
 *  加载的与认的是同一个值，两边不会各判各的、判岔：
 *  dev 是 electron-vite 给的 ELECTRON_RENDERER_URL（http://localhost:<端口>，端口不固定，不能写死），走 loadURL；
 *  打包后是 out/renderer/index.html 的 file URL，还原成路径走 loadFile。 */
export function appBaseUrl(rendererUrl: string | undefined, indexHtmlPath: string): string {
  return rendererUrl ? rendererUrl : pathToFileURL(indexHtmlPath).href;
}

/** 百分号转义解码：只解合法的 %XX 串，解不了（孤立的 %、不成 UTF-8 的字节）原样留着。 */
function decodePath(pathname: string): string {
  return pathname.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try { return decodeURIComponent(run); } catch { return run; }
  });
}

/** file: 地址落到哪个文件的比较键。两边来路不同：基址是 pathToFileURL 给的，导航地址是 Electron 的 loadFile
 *  用 url.format 拼（不转义 %）、再经 Chromium 规范化的，转义集不尽相同，Chromium 还把 Windows 盘符规范成大写。
 *  所以解码后再比，盘符统一大写。 */
function fileKey(u: URL): string {
  const path = decodePath(u.pathname).replace(/^\/([a-z]):/, (_m, drive: string) => `/${drive.toUpperCase()}:`);
  return `${u.host}|${path}`;
}

/** url 是不是本应用自己的页面（appBase 见 appBaseUrl）。解析失败一律不是。
 *  - dev（基址是 http / https）：同源即是——vite 开发服务器只供应本应用；HMR 的整页刷新是 reload，不走导航事件；
 *  - 打包后（基址是 file:）：必须是 index.html 这一个文件，#hash 与 ?query 不看；同目录的别的文件、别处的 file:// 都不是。 */
export function isAppUrl(url: string, appBase: string): boolean {
  const u = parse(url);
  const base = parse(appBase);
  if (u === undefined || base === undefined) return false;
  if (base.protocol === 'http:' || base.protocol === 'https:') return u.origin === base.origin;
  return u.protocol === base.protocol && fileKey(u) === fileKey(base);
}

/** 权限请求与检查是否放行：权限在白名单里、且发起的正是本应用页面。
 *  requestingUrl 取 Electron 给的 details.requestingUrl（发起权限的那个框架最后加载的地址）：
 *  file:// 页面的 requestingOrigin 只是 file:///，分不出是哪个文件；跨源子框架拿不到 requestingUrl，一律拒绝。
 *  xvfb 实测（Electron 38，打包形态）：点代码块「复制」时 writeText 走一次权限请求（clipboard-sanitized-write，
 *  requestingUrl 是 index.html 的地址），请求被拒则复制静默失败；navigator.permissions.query 走的是权限检查，
 *  那边的 requestingOrigin 只是 file:///，requestingUrl 仍是 index.html 的地址。 */
export function permissionAllowed(permission: string, requestingUrl: string | undefined, appBase: string): boolean {
  return ALLOWED_PERMISSIONS.includes(permission) && requestingUrl !== undefined && isAppUrl(requestingUrl, appBase);
}
