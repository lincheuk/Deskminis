/** W2b-6（侦察 lifecycle.md「W2b-guards」· cross.md S24 · 设计稿 §4 W2b-6）：窗口导航守卫与权限白名单的接线——打包形态。
 *
 *  判定在 src/main/nav-guard.ts（单测在 tests/main-window-guard.test.ts），这里钉「主进程真的按它办」，分两部分：
 *  ① 行为：用 electron 桩把 src/main/index.ts 真跑一遍，从 whenReady 走到建好窗口与托盘，
 *     取出它注册给 webContents 与 session.defaultSession 的处理器直接调——
 *     新开窗口一律 { action: 'deny' }，http / https / mailto 交给 shell.openExternal（打不开时静默）；
 *     不是本应用的页内导航 preventDefault；权限请求与检查只放行本应用页面的 clipboard-sanitized-write；
 *     而且都挂在加载页面之前（晚一步，加载期间的导航与权限请求就没人管）；
 *     窗口实际加载的页面（桩按 Electron 的 loadFile 拼法记下）必须被守卫认作本应用，否则剪贴板写入被拒、复制静默失效。
 *  ② 源码守卫：按调用形态认，读进来先剥注释（注释里写着旧调用喂不饱断言，handoff §2.10）。
 *
 *  本文件是 loadFile 形态（没设 ELECTRON_RENDERER_URL，createWindow 走 loadFile，与打包后加载的是同一个页面；桩的 isPackaged 为假）；
 *  dev 形态（设了 ELECTRON_RENDERER_URL，走 loadURL）在 tests/main-window-guard-wiring-dev.test.ts；
 *  真打包（isPackaged 为真，W2b-6b：不认 ELECTRON_RENDERER_URL、去掉应用菜单）在 tests/main-window-guard-wiring-packaged.test.ts。
 *  三个文件共用 tests/main-window-guard-harness.ts 的
 *  electron 桩与启动器——那里的桩让 whenReady 在测试的 worker 里真跑，数据根用 mkdtemp 临时目录，注意事项写在那个文件头。 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripComments } from './strip-comments';
import { bootMain, check, h, loadedPage, navigate, openWindow, openedDuring, request } from './main-window-guard-harness';

vi.mock('electron', async () => (await import('./main-window-guard-harness')).fakeElectron());
vi.mock('electron-updater', async () => (await import('./main-window-guard-harness')).fakeElectronUpdater());

const repoRoot = join(__dirname, '..');
/** 打包形态下本应用页面的地址：主进程 loadFile 的是 src/main 旁边的 ../renderer/index.html */
const APP = pathToFileURL(join(repoRoot, 'src/renderer/index.html')).href;

let restore = (): void => {};
// 打包形态（loadFile）：没设 ELECTRON_RENDERER_URL。全量并发时起主进程可能慢，钩子时限放宽到 30s
beforeAll(async () => { restore = await bootMain({ rendererUrl: undefined }); }, 30_000);
afterAll(() => { restore(); });

describe('① 接线的行为：注册时机', () => {
  it('两个 session 权限处理器在建窗口之前就注册好', () => {
    const iWin = h.calls.indexOf('new BrowserWindow');
    expect(iWin, '走到了建窗口').toBeGreaterThanOrEqual(0);
    for (const c of ['setPermissionRequestHandler', 'setPermissionCheckHandler']) {
      const i = h.calls.indexOf(c);
      expect(i, `${c} 没有调用`).toBeGreaterThanOrEqual(0);
      expect(i, `${c} 必须在 new BrowserWindow 之前`).toBeLessThan(iWin);
      expect(h.calls.filter((x) => x === c), `${c} 只调一次`).toHaveLength(1);
    }
  });

  it('新窗口与导航两道守卫挂在加载页面之前（打包形态走 loadFile）', () => {
    const iLoad = h.calls.indexOf('loadFile');
    expect(iLoad, '打包形态（没设 ELECTRON_RENDERER_URL）应当 loadFile').toBeGreaterThanOrEqual(0);
    expect(h.calls).not.toContain('loadURL');
    for (const c of ['setWindowOpenHandler', 'webContents.on:will-navigate']) {
      const i = h.calls.indexOf(c);
      expect(i, `${c} 没有注册`).toBeGreaterThanOrEqual(0);
      expect(i, `${c} 必须在 loadFile 之前`).toBeLessThan(iLoad);
      expect(i, `${c} 在建窗口之后`).toBeGreaterThan(h.calls.indexOf('new BrowserWindow'));
    }
  });
});

// 守卫认「本应用」用的基址与窗口实际加载的页面要是同一个：两边一分叉，本应用自己的页面就被当成外站——
// 整页重载被拦，剪贴板写入被拒，代码块「复制」与「复制完整路径」静默失效（MarkdownView / PreviewPane catch 后不提示）。
// 这里不拿 APP 比，拿桩记下的「实际加载的页面」比：加载分支改加载别的文件、基址没跟着改，这里就红。
describe('① 接线的行为：窗口实际加载的页面，守卫认作本应用', () => {
  it('打包形态只加载一次、走 loadFile，加载的正是 APP（其余各例里的「本应用页面」）', () => {
    expect(h.loads.map((l) => l.via)).toEqual(['loadFile']);
    expect(loadedPage()).toBe(APP);
  });

  it.each([
    ['加载的页面', ''],
    ['加载的页面带 #hash', '#/x'],
    ['加载的页面带 ?query（整页重载）', '?r=1'],
  ])('页内导航到%s：放行、不交出去', (_label, suffix) => {
    expect(loadedPage(), '主窗口没有加载页面').not.toBe('');
    let r: { prevented: boolean } | undefined;
    const opened = openedDuring(() => { r = navigate(loadedPage() + suffix); });
    expect(r).toEqual({ prevented: false });
    expect(opened).toEqual([]);
  });

  it('加载的页面要 clipboard-sanitized-write：权限请求与检查都放行', () => {
    expect(loadedPage(), '主窗口没有加载页面').not.toBe('');
    expect(request('clipboard-sanitized-write', { requestingUrl: loadedPage(), isMainFrame: true })).toBe(true);
    expect(check('clipboard-sanitized-write', 'file:///', { requestingUrl: loadedPage(), isMainFrame: true })).toBe(true);
  });
});

describe('① 接线的行为：新开窗口一律拒绝，网页与邮件交给系统默认程序', () => {
  it.each([
    ['https://example.com', 'https://example.com/'],
    ['http://example.com/a?b=1#c', 'http://example.com/a?b=1#c'],
    ['mailto:someone@example.com', 'mailto:someone@example.com'],
    ['HTTPS://Example.COM/a b', 'https://example.com/a%20b'],
  ])('%s：{ action: \'deny\' }，shell.openExternal 收到规范化的 %s', (url, normalized) => {
    let r: { action: string } | undefined;
    const opened = openedDuring(() => { r = openWindow(url); });
    expect(r).toEqual({ action: 'deny' });
    expect(opened).toEqual([normalized]);
  });

  it.each([
    'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<h1>x</h1>', 'about:blank', 'deskminis://x', 'not a url',
  ])('%s：{ action: \'deny\' }，也不交给 shell.openExternal', (url) => {
    let r: { action: string } | undefined;
    const opened = openedDuring(() => { r = openWindow(url); });
    expect(r).toEqual({ action: 'deny' });
    expect(opened).toEqual([]);
  });

  it('本应用自己的页面也不新开窗口（打包后是 file://，不交出去）', () => {
    let r: { action: string } | undefined;
    const opened = openedDuring(() => { r = openWindow(`${APP}#/settings`); });
    expect(r).toEqual({ action: 'deny' });
    expect(opened).toEqual([]);
  });

  it('系统打不开（没有默认邮件客户端）时静默：照样拒绝，不冒出未处理的 rejection，只在 stderr 留一行', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    h.openFails = true;
    try {
      let r: { action: string } | undefined;
      const opened = openedDuring(() => { r = openWindow('mailto:nobody@example.com'); });
      expect(r).toEqual({ action: 'deny' });
      expect(opened).toEqual(['mailto:nobody@example.com']);
      // rejection 的处理要等到下一轮事件循环才算数
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(stderr.mock.calls.map((c) => String(c[0])).join(''), '失败原因写进 stderr（界面上不弹）').toContain('没有与之关联的应用程序');
    } finally {
      h.openFails = false;
      stderr.mockRestore();
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('① 接线的行为：页内导航只放行本应用页面', () => {
  it.each([
    ['本应用页面', APP],
    ['本应用页面带 #hash', `${APP}#/settings`],
    ['本应用页面带 ?query（整页重载）', `${APP}?reload=1`],
  ])('%s：放行（不 preventDefault、不交出去）', (_label, url) => {
    let r: { prevented: boolean } | undefined;
    const opened = openedDuring(() => { r = navigate(url); });
    expect(r).toEqual({ prevented: false });
    expect(opened).toEqual([]);
  });

  it.each([
    ['https://example.com/', 'https://example.com/'],
    ['http://127.0.0.1:9/nav', 'http://127.0.0.1:9/nav'],
    ['mailto:someone@example.com', 'mailto:someone@example.com'],
  ])('%s：拦下，并交给系统默认程序', (url, normalized) => {
    let r: { prevented: boolean } | undefined;
    const opened = openedDuring(() => { r = navigate(url); });
    expect(r).toEqual({ prevented: true });
    expect(opened).toEqual([normalized]);
  });

  it.each([
    ['file:///etc/passwd', 'file:///etc/passwd'],
    ['同目录的别的 html', APP.replace(/index\.html$/, 'other.html')],
    ['同目录下名字以 index.html 打头的别的文件', `${APP}.bak`],
    ['data:', 'data:text/html,<h1>x</h1>'],
    ['javascript:', 'javascript:alert(1)'],
    ['自定义协议', 'deskminis://x'],
  ])('%s：拦下，不交出去（文件拖到输入区以外时的 file:// 导航也走这里）', (_label, url) => {
    let r: { prevented: boolean } | undefined;
    const opened = openedDuring(() => { r = navigate(url); });
    expect(r).toEqual({ prevented: true });
    expect(opened).toEqual([]);
  });
});

describe('① 接线的行为：权限只放行本应用页面的 clipboard-sanitized-write', () => {
  const OTHERS = [
    'clipboard-read', 'notifications', 'media', 'geolocation', 'fullscreen', 'openExternal', 'midi', 'midiSysex',
    'pointerLock', 'keyboardLock', 'display-capture', 'idle-detection', 'window-management', 'storage-access',
    'top-level-storage-access', 'speaker-selection', 'fileSystem', 'mediaKeySystem', 'unknown',
  ];

  it('请求：本应用页面要 clipboard-sanitized-write → callback(true)', () => {
    expect(request('clipboard-sanitized-write', { requestingUrl: `${APP}#/`, isMainFrame: true })).toBe(true);
  });

  it.each(OTHERS)('请求：本应用页面要 %s → callback(false)', (p) => {
    expect(request(p, { requestingUrl: APP, isMainFrame: true })).toBe(false);
  });

  it('请求：外站或别的 file:// 页面要 clipboard-sanitized-write → callback(false)', () => {
    for (const from of ['https://example.com/', 'file:///etc/passwd', APP.replace(/index\.html$/, 'other.html')]) {
      expect(request('clipboard-sanitized-write', { requestingUrl: from, isMainFrame: true }), from).toBe(false);
    }
  });

  it('请求：跨源子框架（没有 requestingUrl）要 clipboard-sanitized-write → callback(false)，不拿基址顶替', () => {
    expect(request('clipboard-sanitized-write', { isMainFrame: false })).toBe(false);
  });

  it('检查：本应用页面的 clipboard-sanitized-write → true；其余权限 false', () => {
    // file:// 页面的 requestingOrigin 只是 file:///，分不出是哪个文件：按 details.requestingUrl 判
    expect(check('clipboard-sanitized-write', 'file:///', { requestingUrl: APP, isMainFrame: true })).toBe(true);
    for (const p of [...OTHERS, 'hid', 'serial', 'usb', 'deprecated-sync-clipboard-read']) {
      expect(check(p, 'file:///', { requestingUrl: APP, isMainFrame: true }), p).toBe(false);
    }
  });

  it('检查：外站页面、跨源子框架（没有 requestingUrl）要 clipboard-sanitized-write → false', () => {
    expect(check('clipboard-sanitized-write', 'https://example.com/', { requestingUrl: 'https://example.com/', isMainFrame: true })).toBe(false);
    expect(check('clipboard-sanitized-write', 'file:///', { isMainFrame: false })).toBe(false);
    // requestingOrigin 冒充不了：看的是 requestingUrl
    expect(check('clipboard-sanitized-write', 'file:///', { requestingUrl: 'https://example.com/', isMainFrame: true })).toBe(false);
  });
});

// ─────────────────────────── ② 源码守卫（认调用形态，先剥注释） ───────────────────────────
const read = (rel: string): string => stripComments(readFileSync(join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n'));
const mainDir = join(repoRoot, 'src/main');
// 递归扫整个 src/main（W2b-6b · W2b-6 第三轮审查 nit）：以前只读顶层，代码挪进子目录后，'allow' 字面量、cb(true)、
// shell.openExternal 计数这几条「不许出现 / 只许一处」的守卫就看不见那里的新文件。文件名记相对 src/main 的路径，分隔符统一成 /
const mainSources = (readdirSync(mainDir, { recursive: true }) as string[])
  .filter((f) => f.endsWith('.ts'))
  .map((f) => [f.split(sep).join('/'), read(`src/main/${f.split(sep).join('/')}`)] as const);
const main = read('src/main/index.ts');
/** src/main（含子目录）每个文件里 re 命中几次就记几个文件名 */
const hitFiles = (re: RegExp): string[] =>
  mainSources.flatMap(([f, src]) => (src.match(new RegExp(re.source, 'g')) ?? []).map(() => f));

/** 从 anchor 命中处之后的第一个 open 起按配对取出内容（不含两端）；找不到返回 ''。 */
function balancedAfter(src: string, anchor: RegExp, open = '(', close = ')'): string {
  const m = anchor.exec(src);
  if (!m) return '';
  const start = src.indexOf(open, m.index + m[0].length - 1);
  if (start < 0) return '';
  let depth = 1; let i = start + 1;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) depth--;
  }
  return src.slice(start + 1, i - 1);
}

describe('② 源码守卫', () => {
  it('src/main/nav-guard.ts 是纯函数模块：不 import electron', () => {
    const guard = read('src/main/nav-guard.ts');
    expect(guard).toMatch(/export function isAppUrl\(/);
    expect(guard).not.toMatch(/from ['"]electron['"]|require\(\s*['"]electron['"]\s*\)/);
  });

  it('setWindowOpenHandler( 全 src/main 只有一处，在 index.ts；处理器只回 action: \'deny\'，src/main 里没有 \'allow\'', () => {
    expect(hitFiles(/\.setWindowOpenHandler\(/)).toEqual(['index.ts']);
    const handler = balancedAfter(main, /\.setWindowOpenHandler\(/);
    expect(handler).toMatch(/action:\s*'deny'/);
    expect(hitFiles(/['"`]allow['"`]/), 'src/main 里任何地方都不许出现 \'allow\' 字面量').toEqual([]);
  });

  it("'will-navigate' 的处理体里有 preventDefault()", () => {
    expect(hitFiles(/\.on\(\s*['"`]will-navigate['"`]/)).toEqual(['index.ts']);
    // 锚点停在 .on( 的括号上（后面用先行断言认事件名），取出的是整个调用的实参
    const args = balancedAfter(main, /\.on\((?=\s*['"`]will-navigate['"`])/);
    expect(args).toMatch(/\.preventDefault\(\)/);
  });

  it('两道窗口守卫都在 createWindow 里、加载页面之前挂上', () => {
    const body = balancedAfter(main, /async function createWindow\(\): Promise<BrowserWindow> \{/, '{', '}');
    const iOpen = body.search(/\.webContents\.setWindowOpenHandler\(/);
    const iNav = body.search(/\.webContents\.on\(\s*['"`]will-navigate['"`]/);
    const iLoad = Math.min(...[/\.loadURL\(/, /\.loadFile\(/].map((re) => body.search(re)).filter((i) => i >= 0));
    expect(iOpen).toBeGreaterThanOrEqual(0);
    expect(iNav).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(iLoad), 'createWindow 里找不到 loadURL / loadFile').toBe(true);
    expect(iOpen).toBeLessThan(iLoad);
    expect(iNav).toBeLessThan(iLoad);
  });

  // 加载目标与守卫基址各算各的时候，只改一边（比如只让加载分支看 isPackaged）另一边不跟，本应用页面就被当成外站。
  // W2b-6 时行为测试里 isPackaged 恒为假，这种分叉照样全绿，所以钉结构：本应用页面的地址只在 rendererBaseUrl() 里算，
  // createWindow 按它加载、按它认导航，whenReady 按它认权限——要改认不认 ELECTRON_RENDERER_URL，只能改那一处，两边一起变。
  // W2b-6b 起打包版在那一处不认它（tests/main-window-guard-wiring-packaged.test.ts 在 isPackaged 为真时从行为上核对），结构钉照留。
  it('本应用页面的地址只在 rendererBaseUrl() 里算：createWindow 按它加载、按它认导航，whenReady 按它认权限', () => {
    const baseFn = balancedAfter(main, /function rendererBaseUrl\(\): string \{/, '{', '}');
    expect(baseFn, 'rendererBaseUrl() 经 appBaseUrl( 读 ELECTRON_RENDERER_URL').toMatch(/\bappBaseUrl\([^)]*\bELECTRON_RENDERER_URL\b/);
    // 别处不另算：ELECTRON_RENDERER_URL 在 src/main 的代码里只出现这一次，appBaseUrl( 在 index.ts 里也只调这一次
    expect(hitFiles(/\bELECTRON_RENDERER_URL\b/), 'ELECTRON_RENDERER_URL 只许在 rendererBaseUrl() 里读').toEqual(['index.ts']);
    expect(main.match(/\bappBaseUrl\(/g) ?? []).toHaveLength(1);
    // createWindow：will-navigate 认本应用用的基址，与 loadURL / loadFile 的实参是同一个名字，它出自 rendererBaseUrl()。
    // 导航地址取事件对象的 e.url 或 Electron 传的位置参数 url 都认（W2b-6b：两种写法在真 Electron 下等价）
    const body = balancedAfter(main, /async function createWindow\(\): Promise<BrowserWindow> \{/, '{', '}');
    const base = /\bisAppUrl\(\s*\w+(?:\.url)?\s*,\s*(\w+)\s*\)/.exec(body)?.[1] ?? '';
    expect(base, 'createWindow 里找不到 isAppUrl(<导航地址>, <基址>)').not.toBe('');
    expect(body).toMatch(new RegExp(`\\bconst ${base} = rendererBaseUrl\\(\\);`));
    const loads = [...body.matchAll(/\.(loadURL|loadFile)\(/g)];
    expect(loads.length, 'createWindow 里找不到 loadURL / loadFile').toBeGreaterThan(0);
    for (const m of loads) {
      const arg = balancedAfter(body.slice(m.index ?? 0), /\.(?:loadURL|loadFile)\(/);
      expect(arg, `.${m[1]}( 的实参要出自 ${base}`).toMatch(new RegExp(`\\b${base}\\b`));
    }
    // whenReady：两个权限处理器认本应用用的基址，也出自 rendererBaseUrl()
    const ready = balancedAfter(main, /app\.whenReady\(\)\.then\(async \(\) => \{/, '{', '}');
    const permBases = [...ready.matchAll(/\bpermissionAllowed\([^()]*,\s*(\w+)\s*\)/g)].map((m) => m[1]);
    expect(permBases, 'whenReady 里两个权限处理器都走 permissionAllowed(…, <基址>)').toHaveLength(2);
    for (const b of new Set(permBases)) expect(ready).toMatch(new RegExp(`\\bconst ${b} = rendererBaseUrl\\(\\);`));
  });

  it('session.defaultSession.setPermissionRequestHandler( 与 setPermissionCheckHandler( 各一处，在 whenReady 的早退之后、createWindow( 之前，处理器走 permissionAllowed(', () => {
    expect(hitFiles(/\.setPermissionRequestHandler\(/)).toEqual(['index.ts']);
    expect(hitFiles(/\.setPermissionCheckHandler\(/)).toEqual(['index.ts']);
    const ready = balancedAfter(main, /app\.whenReady\(\)\.then\(async \(\) => \{/, '{', '}');
    // 单实例早退按形态认（W2b-6b · W2b-6 第三轮审查 nit）：锁变量叫什么，从模块顶层 app.requestSingleInstanceLock() 赋给谁现取，
    // 再在 whenReady 里找 if (!<它>) return。以前按裸串 'if (!gotSingleInstanceLock) return;' 找，锁变量一改名就是 -1，
    // 「在早退之后」恒真——改名后再把两个处理器挪到早退之前，照样全绿。现在找不到早退就红
    const lockVar = /\b(?:const|let|var)\s+(\w+)\s*=\s*app\.requestSingleInstanceLock\(\)/.exec(main)?.[1] ?? '';
    expect(lockVar, '模块顶层找不到 app.requestSingleInstanceLock() 的结果').not.toBe('');
    const iGuard = ready.search(new RegExp(`\\bif\\s*\\(\\s*!\\s*${lockVar}\\s*\\)\\s*\\{?\\s*return\\b`));
    expect(iGuard, `whenReady 里找不到单实例早退 if (!${lockVar}) return`).toBeGreaterThanOrEqual(0);
    const iWindow = ready.search(/\bcreateWindow\(/);
    for (const re of [/session\.defaultSession\.setPermissionRequestHandler\(/, /session\.defaultSession\.setPermissionCheckHandler\(/]) {
      const i = ready.search(re);
      expect(i, `whenReady 里找不到 ${re.source}`).toBeGreaterThan(iGuard);
      expect(i).toBeLessThan(iWindow);
      expect(balancedAfter(ready, re)).toMatch(/\bpermissionAllowed\(/);
    }
  });

  it('src/main 里没有 cb(true) / callback(true)', () => {
    expect(hitFiles(/\b(cb|callback)\(\s*true\s*\)/)).toEqual([]);
  });

  it('shell.openExternal( 全 src/main 只有一处，失败接住（.catch(）', () => {
    expect(hitFiles(/\bshell\.openExternal\(/)).toEqual(['index.ts']);
    const at = main.search(/\bshell\.openExternal\(/);
    const call = balancedAfter(main.slice(at), /\bshell\.openExternal\(/);
    expect(main.slice(at + 'shell.openExternal('.length + call.length + 1)).toMatch(/^\s*\.catch\(/);
  });
});
