// W2b-11a 实拍：三处改过的文案页 + 托盘两条通道。
//   copy  终端抽屉（标题行与连接提示）、定时任务页头、设备页页头与同步状态句——改后的原文逐字取回，旧说法不在
//   tray  用 electronApp.evaluate 让主进程对窗口 webContents.send 托盘的两条通道（与 main/index.ts 托盘菜单的 click 同一写法）：
//         menu:toggle-right 收起 / 再展开右栏（会话页）；menu:open-settings 切到设置舞台
// 用法：NODE_PATH=<scratchpad>/driver/node_modules xvfb-run -a node W2b-11a-shell.mjs
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
const { _electron: electron } = createRequire(import.meta.url)('playwright-core');

const APP_DIR = '/home/user/wt-h/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const SHOTS = path.join(S, 'hemo-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log('[w2b11a-shell]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { checks: {} };

const DATA = fs.mkdtempSync(path.join(S, 'W2b-11a-shell-data-'));
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45_000,
  env: { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA, DESKMINIS_FAKE_REPLY: '收到，这是一条假回复。' },
});
const errors = [];
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(250); }
  if (!page) page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e?.message ?? e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.waitForSelector('textarea.field', { timeout: 20_000 });
  await sleep(1200);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  const ss = async (name) => { await page.screenshot({ path: path.join(SHOTS, `W2b-11a-${name}.png`) }); log('shot:', name); };
  const running = () => page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat.running);
  async function waitTurn(maxMs = 20_000) {
    let saw = false;
    for (let t = 0; t < maxMs; t += 50) { const r = await running(); if (r) saw = true; else if (saw) return true; await sleep(50); }
    return saw;
  }
  const nav = (label) => page.evaluate((label) => {
    const b = [...document.querySelectorAll('.navit')].find((x) => x.textContent?.trim().startsWith(label));
    if (!b) return 'NOT_FOUND:' + label; b.click(); return 'OK';
  }, label);
  const shell = () => page.evaluate(() => {
    const ws = document.querySelector('aside.ws');
    return {
      wsVisible: !!ws && getComputedStyle(ws).display !== 'none',
      settingsVisible: !!document.querySelector('.settings'),
      view: document.querySelector('.navit.on')?.textContent?.trim() ?? null,
      asidePressed: [...document.querySelectorAll('.bar .ib')].find((b) => b.getAttribute('title') === '工作台')?.getAttribute('aria-pressed'),
    };
  });

  // 先有一段对话：会话页才有右栏
  await page.evaluate(() => {
    const ta = document.querySelector('textarea.field');
    ta.focus(); ta.value = '你好，这是托盘与文案实拍用的会话'; ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(150);
  await page.keyboard.press('Enter');
  out.turn = await waitTurn();
  await sleep(800);

  // ---------------- tray ----------------
  const sendTray = (ch) => app.evaluate(({ BrowserWindow }, ch) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.show();
    w.webContents.send(ch);
    return BrowserWindow.getAllWindows().length;
  }, ch);
  out.tray0 = await shell();
  await ss('tray-0-before');
  log('send menu:toggle-right →', await sendTray('menu:toggle-right'));
  await sleep(500);
  out.tray1 = await shell();
  await ss('tray-1-right-collapsed');
  log('send menu:toggle-right →', await sendTray('menu:toggle-right'));
  await sleep(500);
  out.tray2 = await shell();
  await ss('tray-2-right-expanded');
  log('send menu:open-settings →', await sendTray('menu:open-settings'));
  await sleep(700);
  out.tray3 = await shell();
  await ss('tray-3-settings');

  // ---------------- copy ----------------
  log('nav 定时 →', await nav('定时'));
  await sleep(700);
  out.cronSub = await page.evaluate(() => document.querySelector('.head .sub')?.textContent?.trim() ?? '');
  await ss('copy-cron');
  log('nav 设备 →', await nav('设备'));
  await sleep(700);
  out.devicesSubs = await page.evaluate(() => [...document.querySelectorAll('.head .sub')].map((p) => p.textContent?.trim()));
  out.devicesSync = await page.evaluate(() => document.querySelector('.syncsub')?.textContent?.trim() ?? '');
  await ss('copy-devices');
  // 终端：回到会话页，开标题栏的终端钮
  const firstRow = await page.evaluate(() => { const r = document.querySelector('.srow'); if (!r) return 'NO_ROW'; r.click(); return 'OK'; });
  log('open session →', firstRow);
  await sleep(700);
  log('toggle term →', await page.evaluate(() => { const b = [...document.querySelectorAll('.bar .ib')].find((x) => x.getAttribute('title') === '终端'); if (!b) return 'NO_BTN'; b.click(); return 'OK'; }));
  await sleep(2500);
  out.termHead = await page.evaluate(() => document.querySelector('.term .thead span')?.textContent?.trim() ?? '');
  out.termBuffer = await page.evaluate(() => [...document.querySelectorAll('.term .xterm-rows > div')].map((d) => d.textContent).join('\n').trim());
  await ss('copy-terminal');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await sleep(400);
  await ss('copy-terminal-dark');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
} finally {
  await Promise.race([app.close().catch(() => {}), sleep(8000)]);
  try { app.process().kill('SIGKILL'); } catch { /* 已退出 */ }
}

out.errors = errors;
out.checks.trayStartExpanded = out.tray0?.wsVisible === true;
out.checks.trayToggleCollapses = out.tray1?.wsVisible === false && out.tray1?.asidePressed === 'false';
out.checks.trayToggleExpandsAgain = out.tray2?.wsVisible === true && out.tray2?.asidePressed === 'true';
out.checks.trayOpensSettings = out.tray3?.settingsVisible === true;
out.checks.cronCopy = /关掉窗口后应用仍在托盘里运行/.test(out.cronSub ?? '') && !/不是后台服务/.test(out.cronSub ?? '');
out.checks.devicesCopy = (out.devicesSubs ?? []).some((t) => /设置、记忆文件和附件不同步/.test(t)) && (out.devicesSubs ?? []).some((t) => /MINISD_HOST=0\.0\.0\.0/.test(t))
  && !(out.devicesSubs ?? []).some((t) => /会话与设置/.test(t)) && /会话在已配对设备之间自动同步/.test(out.devicesSync ?? '');
out.checks.terminalHead = /独立的 PowerShell/.test(out.termHead ?? '') && !/共用/.test(out.termHead ?? '');
out.checks.noPageErrors = errors.filter((e) => /pageerror/.test(e)).length === 0;
const file = path.join(S, 'hemo-logs', `W2b-11a-shell-${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2));
log('result →', file);
log(JSON.stringify(out.checks));
process.exit(Object.values(out.checks).every(Boolean) ? 0 : 1);
