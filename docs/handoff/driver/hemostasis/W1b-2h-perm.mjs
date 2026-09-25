// W1b-2g 实拍：设置页「权限」一节——「完全访问」副标题改成如实的说法之后，三张档位卡的排版与选中完全访问时的样子。
// 用法：NODE_PATH=<装了 playwright-core 的 node_modules> xvfb-run -a node W1b-2g-perm.mjs
// 数据根与 Electron 的 cwd 都是 mkdtemp 临时目录：Linux 上桥的命名管道 \\.\pipe\… 与工具写的 C:\… 路径都会按相对路径
// 落进 cwd，cwd 设成应用目录就会在仓库里留文件（C:\Users\me\Documents\notes.txt 就是这么进的仓库）。
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// ESM 的 import 不认 NODE_PATH，CJS 的 require 认：playwright-core 不入库，经 NODE_PATH 指向 scratchpad/driver/node_modules
const { _electron: electron } = createRequire(import.meta.url)('playwright-core');

const APP_DIR = '/home/user/wt-p/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const SHOTS = path.join(S, 'hemo-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const DATA = fs.mkdtempSync(path.join(S, 'W1b-2g-data-'));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'W1b-2g-cwd-'));
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
const log = (...a) => console.log('[W1b-2g]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', APP_DIR], cwd: CWD, timeout: 45_000,
  env: { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA },
});
const errors = [];
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null;
    if (!page) await sleep(250);
  }
  if (!page) page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e?.message ?? e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.waitForSelector('textarea.field', { timeout: 20_000 });
  await sleep(1500);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  const ss = async (name) => { await page.screenshot({ path: path.join(SHOTS, `W1b-2h-${name}.png`) }); log('shot:', name); };
  const clickText = (sel, text) => page.evaluate(({ sel, text }) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent?.trim() === text)
      ?? [...document.querySelectorAll(sel)].find((e) => e.textContent?.includes(text));
    if (!el) return 'NOT_FOUND:' + text;
    el.click(); return 'OK';
  }, { sel, text });
  const probe = () => page.evaluate(() => {
    const tiers = [...document.querySelectorAll('.tiers .tier')].map((b) => {
      const sub = b.querySelector('.sub');
      const r = b.getBoundingClientRect();
      return {
        title: b.querySelector('.ttl')?.textContent?.trim(), sub: sub?.textContent?.trim(), on: b.classList.contains('on'),
        w: Math.round(r.width), h: Math.round(r.height),
        subOverflowX: sub ? sub.scrollWidth > sub.clientWidth : null,
        cardOverflowX: b.scrollWidth > b.clientWidth,
      };
    });
    const warn = document.querySelector('.warnbox')?.textContent?.trim() ?? null;
    const c = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat;
    return { tiers, warn, permTier: c.permTier, win: { w: innerWidth, h: innerHeight } };
  });

  log('nav settings →', await clickText('.navit', '设置'));
  await sleep(500);
  log('sec perm →', await clickText('.secit', '权限'));
  await sleep(500);
  log('probe default:', JSON.stringify(await probe()));
  await ss('perm-default-light');

  log('pick full →', await page.evaluate(() => {
    const b = [...document.querySelectorAll('.tiers .tier')].find((e) => e.querySelector('.ttl')?.textContent?.trim() === '完全访问');
    if (!b) return 'NOT_FOUND'; b.click(); return 'OK';
  }));
  await sleep(700);
  log('probe full:', JSON.stringify(await probe()));
  await ss('perm-full-light');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await sleep(400);
  await ss('perm-full-dark');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  // 窄窗口：760px 以下三张卡改成一列，副标题整句换行
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(740, 820); });
  await sleep(800);
  log('probe narrow:', JSON.stringify(await probe()));
  await ss('perm-full-narrow');

  // 切回每次确认，数据根是临时目录，只为让截图之外的状态也干净
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.tiers .tier')].find((e) => e.querySelector('.ttl')?.textContent?.trim() === '每次确认');
    b?.click();
  });
  await sleep(300);
  log('errors:', JSON.stringify(errors));
} finally {
  await app.close().catch(() => {});
  const strays = fs.readdirSync(APP_DIR).filter((n) => /^[A-Za-z]:|\\/.test(n));
  log('app dir strays:', JSON.stringify(strays), 'cwd entries:', JSON.stringify(fs.readdirSync(CWD)));
  fs.rmSync(CWD, { recursive: true, force: true });
}
