// W2b-6b xvfb 实拍①：终端抽屉里的 OSC 8 超链接交给系统浏览器（照 W2b-6 第三轮审查的剧本 W2b-6-review3-osc8.mjs 改写）。
// 跑的是工作区 /home/user/wt-q/deskminis 的 npm run build 产物（未打包形态；链接的处理与是否打包无关）。
// 做法：PATH 前面放一个假 powershell.exe，启动就打印一条 OSC 8 超链接——显示文字是「官方文档 CLICK-OSC8-LINK」，
// 实际指向本地「外站」；主进程里桩掉 shell.openExternal 只记地址，挂 web-contents-created 数新建的 webContents。
// 点三次：① 确认框点取消 ② 确认框立即点确定 ③ 确认框等 6 秒再点确定（用户看地址看久了，点击的瞬时激活已过期）。
// 断言：确认框是中文、带真实地址，不再有 xterm 的英文确认框；取消不交出；确定后 openExternal 收到那个地址；
// 窗口始终 1 个、没有新 webContents；外站零请求（地址只交给系统浏览器，应用自己不去加载）。
// 确认框弹着时用 X11 截一张整屏（原生对话框不在网页里，page.screenshot 截不到）。
// 两种点法（第一个参数）：
//   cdp    —— 确认框交给 playwright 经 CDP 点（page.on('dialog') 里 accept / dismiss）；实测 Electron 的原生框这时不会跟着关，
//             整屏截图上会留着一个，这是驱动方式的副作用，不是应用的行为；
//   native —— 不经 CDP，像用户一样用 X11 点原生框上的按钮（Ok / Cancel），看点完框关没关、结果对不对。
// 用法：NODE_PATH=<scratchpad>/driver/node_modules xvfb-run -a node W2b-6b-osc8.mjs <cdp|native>
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
const MODE = process.argv[2] === 'native' ? 'native' : 'cdp';
const log = (...a) => console.error(`[W2b-6b osc8 ${MODE}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { mode: MODE, checks: {} };
const x11 = (...args) => { try { return JSON.parse(execFileSync('python3', [X11, ...args], { encoding: 'utf8' })); } catch (e) { return { error: String(e?.message ?? e) }; } };

const extHits = [];
const ext = http.createServer((req, res) => { extHits.push(req.url); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1 id="ext">EXT</h1>'); });
await new Promise((r) => ext.listen(0, '127.0.0.1', r));
const LINK = `http://127.0.0.1:${ext.address().port}/osc8?from=terminal`;

const BIN = fs.mkdtempSync(path.join(S, 'W2b-6b-osc8-bin-'));
fs.writeFileSync(path.join(BIN, 'powershell.exe'),
  `#!/bin/sh\nprintf 'osc8: \\033]8;;${LINK}\\033\\\\官方文档 CLICK-OSC8-LINK\\033]8;;\\033\\\\ end\\r\\n'\nexec cat > /dev/null\n`, { mode: 0o755 });
const DATA = fs.mkdtempSync(path.join(S, `W2b-6b-osc8-${MODE}-data-`));
const XDG = fs.mkdtempSync(path.join(S, `W2b-6b-osc8-${MODE}-xdg-`));
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
const env = { ...process.env, PATH: `${BIN}:${process.env.PATH}`, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA, XDG_CONFIG_HOME: XDG, DESKMINIS_FAKE_REPLY: '好的。' };
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;

const app = await electron.launch({ executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 60_000, env });
await app.evaluate(({ app: a, shell }) => {
  globalThis.__opened = []; globalThis.__created = [];
  shell.openExternal = async (u) => { globalThis.__opened.push(u); };
  a.on('web-contents-created', (_e, wc) => { globalThis.__created.push(wc.id); });
});
const mainState = () => app.evaluate(({ BrowserWindow }) => ({
  windows: BrowserWindow.getAllWindows().length,
  urls: BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()),
  opened: globalThis.__opened.slice(), created: globalThis.__created.slice(),
}));

// 确认框的处理队列：每弹一次取一个动作
const plan = [];
const dialogs = [];
let dialogSeq = 0;
try {
  let page = null;
  for (let i = 0; i < 120 && !page; i++) { page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(250); }
  const consoleMsgs = [];
  page.on('console', (m) => consoleMsgs.push(`${m.type()}: ${m.text()}`));
  page.on('dialog', async (d) => {
    const n = ++dialogSeq;
    const step = plan.shift() ?? { accept: false, waitMs: 0 };
    const rec = { n, type: d.type(), message: d.message(), action: step.accept ? 'accept' : 'dismiss', waitMs: step.waitMs };
    dialogs.push(rec);
    // 原生对话框弹着的时候截整屏、列顶层窗口（它不在网页里）
    await sleep(700);
    rec.x11Windows = x11('list');
    if (step.shot) rec.x11Shot = x11('shot', path.join(SHOTS, step.shot));
    if (step.waitMs) await sleep(step.waitMs);
    if (MODE === 'cdp') {
      if (step.accept) await d.accept(); else await d.dismiss();
    } else {
      // 原生框：没有窗口管理器，框落在 (0,0) 附近、没有标题栏；按钮一左一右占满底边（左 Ok、右 Cancel）
      const box = (rec.x11Windows ?? []).find((w) => w.name !== 'DeskMinis' && w.w < 800 && w.h < 400);
      rec.box = box ?? null;
      if (box) {
        const bx = box.x + Math.round(box.w * (step.accept ? 0.25 : 0.75));
        const by = box.y + box.h - 16;
        rec.clickAt = [bx, by];
        x11('click', String(bx), String(by));
        await sleep(800);
        rec.x11WindowsAfterClick = x11('list');
      }
    }
    rec.handledAt = Date.now();
  });
  await page.waitForSelector('textarea.field', { timeout: 30_000 });
  await sleep(1500);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  // 先发一条建出会话（终端按 activeId attach）
  await page.evaluate(() => { const ta = document.querySelector('textarea.field'); ta.focus(); ta.value = '你好'; ta.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(150);
  await page.keyboard.press('Enter');
  await sleep(3000);
  await page.click('button.ib[title="终端"]');
  let rowText = '';
  for (let t = 0; t < 20_000; t += 250) {
    rowText = await page.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')].map((e) => e.textContent).join('\n'));
    if (rowText.includes('CLICK-OSC8-LINK')) break;
    await sleep(250);
  }
  report.terminalHasLink = rowText.includes('CLICK-OSC8-LINK');
  const rect = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.xterm-rows > div')].find((r) => r.textContent.includes('CLICK-OSC8-LINK'));
    if (!row) return null;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent.indexOf('CLICK-OSC8-LINK');
      if (i >= 0) { const rg = document.createRange(); rg.setStart(n, i + 2); rg.setEnd(n, i + 8); const b = rg.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }
    }
    const span = [...row.querySelectorAll('span')].find((s) => s.textContent.includes('C'));
    const b = (span ?? row).getBoundingClientRect();
    return { x: b.x + 20, y: b.y + b.height / 2 };
  });
  report.rect = rect;
  report.before = await mainState();
  await page.screenshot({ path: path.join(SHOTS, `W2b-6b-osc8-${MODE}-terminal.png`) });

  async function clickLink(label) {
    await page.mouse.move(rect.x - 40, rect.y);
    await sleep(200);
    await page.mouse.move(rect.x, rect.y);
    await sleep(600);
    const hover = await page.evaluate(() => !!document.querySelector('.xterm-rows .xterm-underline-1, .xterm-rows [style*="underline"]'));
    const before = dialogs.length;
    await page.mouse.down(); await sleep(60); await page.mouse.up();
    // 等确认框被处理完（最长 15 秒）
    for (let t = 0; t < 15_000 && !(dialogs.length > before && dialogs[dialogs.length - 1].handledAt); t += 100) await sleep(100);
    await sleep(1500);
    const st = await mainState();
    log(label, JSON.stringify({ hover, dialogs: dialogs.length - before, opened: st.opened, windows: st.windows }));
    return { hover, dialogsShown: dialogs.length - before, state: st };
  }

  if (rect) {
    plan.push({ accept: false, waitMs: 0, shot: `W2b-6b-osc8-${MODE}-confirm-x11.png` });
    report.cancel = await clickLink('① 取消');
    plan.push({ accept: true, waitMs: 0 });
    report.accept = await clickLink('② 立即确定');
    plan.push({ accept: true, waitMs: 6000 });
    report.acceptLate = await clickLink('③ 6 秒后确定');
  }
  report.after = await mainState();
  report.dialogs = dialogs;
  report.extHits = extHits.slice();
  report.consoleWarn = consoleMsgs.filter((m) => /Opening link|navigate|blocked/i.test(m));
  report.pageHref = await page.evaluate(() => location.href);
  await page.screenshot({ path: path.join(SHOTS, `W2b-6b-osc8-${MODE}-after.png`) });
  report.x11After = x11('shot', path.join(SHOTS, `W2b-6b-osc8-${MODE}-after-x11.png`));
  report.x11WindowsAfter = x11('list');

  // 判定
  const c = report.checks;
  c.terminalHasLink = report.terminalHasLink === true;
  c.threeDialogs = dialogs.length === 3;
  c.dialogsChinese = dialogs.every((d) => d.type === 'confirm' && /[\u4e00-\u9fff]/.test(d.message) && !/Do you want to navigate|WARNING/.test(d.message));
  c.dialogsShowRealUrl = dialogs.every((d) => d.message.includes(LINK));
  c.cancelOpensNothing = report.cancel?.state.opened.length === 0;
  c.acceptOpensExternal = JSON.stringify(report.accept?.state.opened) === JSON.stringify([LINK]);
  c.lateAcceptOpensExternal = JSON.stringify(report.acceptLate?.state.opened) === JSON.stringify([LINK, LINK]);
  c.oneWindowAlways = [report.before, report.cancel?.state, report.accept?.state, report.acceptLate?.state, report.after].every((s) => s?.windows === 1);
  c.noNewWebContents = JSON.stringify(report.after.created) === JSON.stringify(report.before.created);
  c.extZeroRequests = extHits.length === 0;
  c.noXtermWarning = report.consoleWarn.length === 0;
  c.pageStayed = report.pageHref.startsWith('file://') && report.pageHref.endsWith('/out/renderer/index.html');
  // 原生点法：点完按钮框就关了，最后只剩主窗口一个顶层窗口
  if (MODE === 'native') {
    c.nativeBoxFound = dialogs.every((d) => d.box);
    c.nativeBoxClosed = dialogs.every((d) => Array.isArray(d.x11WindowsAfterClick) && d.x11WindowsAfterClick.every((w) => w.name === 'DeskMinis'));
    c.noLeftoverBox = Array.isArray(report.x11WindowsAfter) && report.x11WindowsAfter.every((w) => w.name === 'DeskMinis');
  }
  report.pass = Object.values(c).every(Boolean);
} catch (e) {
  report.error = String(e?.stack ?? e);
} finally {
  await app.close().catch(() => {});
  ext.close();
  console.log(JSON.stringify(report, null, 2));
}
