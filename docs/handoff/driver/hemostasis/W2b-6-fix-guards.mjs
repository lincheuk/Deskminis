// W2b-6 审查修正后的实拍：createWindow 改成按守卫认的同一个 appBase 加载之后，两种形态重拍一遍。
// 由 W2b-6-guards.mjs 改来：截图与数据根加 fix 前缀；dev 的 ELECTRON_RENDERER_URL 改用 electron-vite 的真实形状
// （`http://host:port`，不带尾斜杠——createWindow 现在原样 loadURL(appBase)）；多记一项「窗口实际加载的页面」。
//
// 用法：NODE_PATH=<scratchpad>/driver/node_modules xvfb-run -a node W2b-6-fix-guards.mjs <after|dev>
//   after   打包形态（loadFile → file://…/out/renderer/index.html）。
//   dev     同一份 out/，但把 out/renderer 用本地 http 服务器供出来并设 ELECTRON_RENDERER_URL，
//           模拟 npm run dev 的 http 源（本应用 = 这个源）。
//
// 判定不靠界面：
//   - 「外站」是剧本另起的本地 http 服务器，记下每一次请求——窗口真被导航走、真开了新窗口，这里就有请求；
//   - 主进程里桩掉 shell.openExternal（只记地址，不真的起浏览器），并挂 web-contents-created 数新建的 webContents；
//   - 剪贴板用主进程的 clipboard.readText() 读回来比对。
// 数据根、Chromium 配置目录都用 mkdtemp 临时目录（DESKMINIS_DATA_DIR、XDG_CONFIG_HOME）。
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
// ESM 的 import 不认 NODE_PATH，CJS 的 require 认：playwright-core 不入库，经 NODE_PATH 指向 scratchpad/driver/node_modules
const { _electron: electron } = createRequire(import.meta.url)('playwright-core');

const APP_DIR = '/home/user/wt-f2/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const SHOTS = path.join(S, 'hemo-shots');
const mode = process.argv[2] ?? 'after';
if (!['after', 'dev'].includes(mode)) throw new Error('mode 只能是 after / dev');
fs.mkdirSync(SHOTS, { recursive: true });

const log = (...a) => console.error(`[W2b-6-fix ${mode}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r));
const report = { mode, steps: [] };
const step = (name, data) => { report.steps.push({ step: name, ...data }); log(name, JSON.stringify(data)); };

// ---- 本地「外站」：记下每次请求 ----
const extHits = [];
const ext = http.createServer((req, res) => {
  extHits.push(req.url);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>EXT</title><h1 id="ext" style="font:32px sans-serif;margin:40px">这是外站页面 ${req.url}</h1>`);
});
await listen(ext);
const EXT = `http://127.0.0.1:${ext.address().port}`;

// ---- dev：本地供出 out/renderer ----
let dev = null;
let DEV_URL = null;
if (mode === 'dev') {
  const root = path.join(APP_DIR, 'out/renderer');
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const devHits = [];
  dev = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    devHits.push(u.pathname + u.search);
    const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1));
    const f = path.join(root, rel);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await listen(dev);
  DEV_URL = `http://127.0.0.1:${dev.address().port}`;
  report.devHits = devHits;
}

const DATA = fs.mkdtempSync(path.join(S, `W2b-6-fix-${mode}-data-`));
const XDG = fs.mkdtempSync(path.join(S, `W2b-6-fix-${mode}-xdg-`));
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
report.dataRoot = DATA;

const CODE = "console.log('W2b-6 复制探针');";
const REPLY = [
  `回复里带两条外链：[打开外站](${EXT}/from-md)，以及 [example 网站](https://example.com/from-md)。`,
  '',
  '```js',
  CODE,
  '```',
].join('\n');

const env = { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA, XDG_CONFIG_HOME: XDG, DESKMINIS_FAKE_REPLY: REPLY };
delete env.ELECTRON_RUN_AS_NODE;
if (mode === 'dev') env.ELECTRON_RENDERER_URL = DEV_URL; else delete env.ELECTRON_RENDERER_URL;

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 60_000, env,
});
// 主进程：桩掉 shell.openExternal、数新建的 webContents
report.hook = await app.evaluate(({ app: a, shell }) => {
  globalThis.__opened = [];
  globalThis.__created = [];
  shell.openExternal = async (u) => { globalThis.__opened.push(u); };
  a.on('web-contents-created', (_e, wc) => { globalThis.__created.push(wc.id); });
  return 'hooked';
});
const pageErrors = [];
try {
  let page = null;
  for (let i = 0; i < 120 && !page; i++) { page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(250); }
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)));
  await page.waitForSelector('textarea.field', { timeout: 30_000 });
  await sleep(1500);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.bringToFront();

  const appUrl = page.url();
  report.appUrl = appUrl;
  // 窗口实际加载的页面：打包形态是 out/renderer/index.html 的 file URL，dev 是开发服务器的根
  report.loadedUrl = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getURL());
  report.expectedLoadedUrl = mode === 'dev' ? `${DEV_URL}/` : pathToFileURL(path.join(APP_DIR, 'out/renderer/index.html')).href;
  const mainState = () => app.evaluate(({ BrowserWindow }) => ({
    windows: BrowserWindow.getAllWindows().length,
    urls: BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()),
    opened: globalThis.__opened.slice(),
    created: globalThis.__created.slice(),
  }));
  const pageState = () => page.evaluate(() => ({
    href: location.href,
    appUi: !!document.querySelector('textarea.field') && !!document.querySelector('.rail'),
    ext: !!document.querySelector('#ext'),
  })).catch((e) => ({ error: String(e?.message ?? e) }));
  const shot = async (name, p = page) => {
    const f = path.join(SHOTS, `W2b-6-fix-${mode}-${name}.png`);
    await p.screenshot({ path: f });
    log('shot', f);
    return f;
  };
  report.initial = { ...(await mainState()), ...(await pageState()) };

  // ---- ① 权限：渲染端各种权限的实际结果 ----
  const perms = await page.evaluate(async () => {
    const q = async (name) => { try { return (await navigator.permissions.query({ name })).state; } catch (e) { return 'ERR:' + e.name; } };
    const out = {};
    out.queryClipboardWrite = await q('clipboard-write');
    out.queryClipboardRead = await q('clipboard-read');
    out.queryNotifications = await q('notifications');
    out.queryGeolocation = await q('geolocation');
    out.queryCamera = await q('camera');
    out.notificationRequest = await Notification.requestPermission().catch((e) => 'ERR:' + e.name);
    out.clipboardReadText = await navigator.clipboard.readText().then(() => 'ok', (e) => 'ERR:' + e.name);
    out.geolocation = await new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('ok'), (e) => r('ERR:code' + e.code), { timeout: 3000 }));
    out.getUserMedia = await navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'ok', (e) => 'ERR:' + e.name);
    return out;
  });
  step('permissions', perms);

  // ---- ② 发一条消息：file_write 产出一个文件，回复里带外链与代码块 ----
  await page.evaluate(() => {
    const ta = document.querySelector('textarea.field');
    ta.focus();
    ta.value = '__tool__ file_write ' + JSON.stringify({ path: 'w2b6.md', content: '# W2b-6\n\n剪贴板探针文件。\n', tool_title: '写一个说明文件' });
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(150);
  await page.keyboard.press('Enter');
  const running = () => page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat.running);
  let saw = false;
  for (let t = 0; t < 30_000; t += 100) { const r = await running(); if (r) saw = true; else if (saw) break; await sleep(100); }
  await page.waitForSelector('.md-copy', { timeout: 15_000 });
  await sleep(800);

  // ②a 代码块「复制」
  await app.evaluate(({ clipboard }) => clipboard.writeText('W2B6-SENTINEL'));
  await page.bringToFront();
  await page.click('.md-copy');
  await sleep(500);
  const codeCopy = {
    clipboard: await app.evaluate(({ clipboard }) => clipboard.readText()),
    button: await page.evaluate(() => document.querySelector('.md-copy')?.textContent?.trim()),
  };
  codeCopy.ok = codeCopy.clipboard === "console.log('W2b-6 复制探针');";
  step('code-copy', codeCopy);
  await shot('copy');

  // ②b 预览区「复制完整路径」
  const openRow = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.ws .row')].find((e) => e.textContent?.includes('w2b6'));
    if (!el) return 'NOT_FOUND:' + [...document.querySelectorAll('.ws .row')].map((e) => e.textContent.trim()).join('|');
    el.click(); return 'OK';
  });
  await sleep(1200);
  await app.evaluate(({ clipboard }) => clipboard.writeText('W2B6-SENTINEL'));
  const hasCopyPath = await page.evaluate(() => !!document.querySelector('.pane button[title="复制完整路径"]'));
  if (hasCopyPath) await page.click('.pane button[title="复制完整路径"]');
  await sleep(400);
  const pathCopy = {
    openRow, hasCopyPath,
    clipboard: await app.evaluate(({ clipboard }) => clipboard.readText()),
    title: await page.evaluate(() => document.querySelector('.pane button.ib')?.getAttribute('title')),
  };
  pathCopy.ok = pathCopy.clipboard.endsWith('/w2b6.md');
  step('path-copy', pathCopy);
  await shot('path-copy');

  // ②c 点回复里的外链（target=_blank → 新开窗口的请求）
  const beforeLink = await mainState();
  await page.click('a.md-link:has-text("打开外站")');
  await sleep(1500);
  const afterLink = await mainState();
  const linkRes = { ...afterLink, extHits: extHits.slice(), windowsBefore: beforeLink.windows };
  if (mode === 'before') {
    // 旧行为：开出第二个 Electron 窗口。看看它里面有没有预加载的 window.deskminis（端口 + token 的入口）
    const child = app.windows().find((w) => w !== page && !w.url().startsWith('devtools://'));
    if (child) {
      await child.waitForLoadState('domcontentloaded').catch(() => {});
      linkRes.childUrl = child.url();
      linkRes.childHasBridge = await child.evaluate(() => typeof window.deskminis).catch((e) => 'ERR:' + e.message);
      linkRes.childHasMinisdInfo = await child.evaluate(() => typeof window.deskminis?.minisdInfo).catch((e) => 'ERR:' + e.message);
      await shot('link-child', child);
    }
  } else {
    await page.click('a.md-link:has-text("example 网站")');
    await sleep(800);
    linkRes.afterExample = await mainState();
  }
  step('md-link', linkRes);
  await page.bringToFront();

  // ---- ③ window.open：外站、https、以及不该交出去的协议 ----
  const opens = {};
  const targets = mode === 'before'
    ? [`${EXT}/open`]
    : ['https://example.com', `${EXT}/open`, 'mailto:someone@example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<h1>x</h1>', 'about:blank'];
  for (const t of targets) {
    opens[t] = await page.evaluate((u) => { try { const w = window.open(u); return w === null ? 'null' : 'WindowProxy'; } catch (e) { return 'ERR:' + e.message; } }, t);
    await sleep(700);
  }
  step('window-open', { returned: opens, ...(await mainState()), extHits: extHits.slice(), page: await pageState() });
  if (mode === 'before') {
    const child = app.windows().filter((w) => w !== page && !w.url().startsWith('devtools://'));
    if (child.length) await shot('open-child', child[child.length - 1]);
  }
  await page.bringToFront();

  // ---- ④ 页内导航：不该放行的 file: / data: ----
  if (mode !== 'before') {
    for (const t of ['file:///etc/passwd', 'data:text/html,<h1>x</h1>']) {
      await page.evaluate((u) => { location.href = u; }, t).catch(() => {});
      await sleep(1000);
    }
    step('navigate-local', { ...(await mainState()), page: await pageState() });
  }

  // ---- ⑤ 页内导航：location.href 改到外站 ----
  const navTargets = mode === 'before' ? [`${EXT}/nav`] : ['https://example.com/', `${EXT}/nav`];
  for (const t of navTargets) {
    await page.evaluate((u) => { location.href = u; }, t).catch(() => {});
    await sleep(1500);
  }
  step('navigate-external', { ...(await mainState()), extHits: extHits.slice(), page: await pageState() });
  await shot('after-navigate');

  // ---- ⑥ 本应用自己的地址照常放行（带 query 的整页重载） ----
  if (mode !== 'before') {
    const self = appUrl.split('#')[0].split('?')[0] + '?w2b6=reload';
    await page.evaluate((u) => { location.href = u; }, self).catch(() => {});
    await page.waitForSelector('textarea.field', { timeout: 30_000 }).catch(() => {});
    await sleep(1500);
    step('navigate-self', { target: self, ...(await mainState()), page: await pageState() });
    await shot('reloaded');
  }
} catch (e) {
  report.error = String(e?.stack ?? e);
} finally {
  report.extHits = extHits;
  report.pageErrors = pageErrors;
  await app.close().catch(() => {});
  ext.close();
  dev?.close();
  // 判定（before 只记录现状，不判）
  if (mode !== 'before') {
    const S_ = Object.fromEntries(report.steps.map((s) => [s.step, s]));
    const lastOpened = S_['navigate-external']?.opened ?? [];
    const dangerous = ['javascript:', 'file:', 'data:', 'about:'];
    const p = S_.permissions ?? {};
    report.checks = {
      加载的正是预期的页面: report.loadedUrl === report.expectedLoadedUrl && report.appUrl === report.expectedLoadedUrl,
      剪贴板写入照常_代码块复制: S_['code-copy']?.ok === true,
      剪贴板写入照常_复制完整路径: S_['path-copy']?.ok === true,
      window_open_全部返回null: Object.values(S_['window-open']?.returned ?? { x: 'missing' }).every((v) => v === 'null'),
      始终只有一个窗口: ['md-link', 'window-open', 'navigate-local', 'navigate-external', 'navigate-self'].every((k) => S_[k]?.windows === 1),
      没有新建webContents: ['md-link', 'window-open', 'navigate-external', 'navigate-self'].every((k) => (S_[k]?.created ?? [0, 0]).length === (report.initial?.created ?? []).length),
      外站服务器零请求: extHits.length === 0,
      页内导航到外站后仍是本应用: S_['navigate-external']?.page?.href === report.appUrl && S_['navigate-external']?.page?.appUi === true,
      file与data导航被拦: S_['navigate-local']?.page?.href === report.appUrl,
      交给系统的正是网页与邮件: ['https://example.com/', `${EXT}/open`, 'mailto:someone@example.com', `${EXT}/nav`, `${EXT}/from-md`, 'https://example.com/from-md'].every((u) => lastOpened.includes(u)),
      危险协议一个没交出去: lastOpened.every((u) => !dangerous.some((d) => u.startsWith(d))),
      本应用地址照常放行: (S_['navigate-self']?.page?.href ?? '').includes('w2b6=reload') && S_['navigate-self']?.page?.appUi === true,
      其余权限全拒: p.queryClipboardRead === 'denied' && p.queryNotifications === 'denied' && p.queryGeolocation === 'denied'
        && p.queryCamera === 'denied' && p.notificationRequest === 'denied' && p.clipboardReadText === 'ERR:NotAllowedError' && p.geolocation === 'ERR:code1',
      剪贴板写入权限查询为granted: p.queryClipboardWrite === 'granted',
      没有页面错误: pageErrors.length === 0 && !report.error,
    };
    report.verdict = Object.values(report.checks).every(Boolean) ? 'PASS' : 'FAIL';
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.verdict === 'FAIL') process.exitCode = 1;
}
