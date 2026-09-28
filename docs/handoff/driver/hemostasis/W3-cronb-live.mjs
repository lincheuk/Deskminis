// W3-cronb 实拍（Linux + xvfb，真 Electron）：编辑定时任务时清空助手与工作目录再保存，真的清掉；间隔上限与引擎一致。
// 用法：NODE_PATH=$S/driver/node_modules xvfb-run -a node W3-cronb-live.mjs <应用目录（已 npm run build）> <标签>
// 状态从界面读：保存后重新点「编辑」，表单按引擎交回的任务回填（cron.list），读下拉框与输入框的值。
// 未打包形态；数据根是 mkdtemp 临时目录，假 provider，不碰网络。首启会种三个内置助手。
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
const { _electron: electron } = createRequire(import.meta.url)('playwright-core');

const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const APP_DIR = process.argv[2];
const LABEL = process.argv[3] ?? 'run';
const SHOTS = path.join(S, 'hemo-shots');
const DATA = fs.mkdtempSync(path.join(S, `W3-cronb-${LABEL}-data-`));
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
const log = (...a) => console.log(`[W3-cronb ${LABEL}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { label: LABEL, appDir: APP_DIR, checks: {}, consoleErrors: [] };

const env = { ...process.env, DESKMINIS_DATA_DIR: DATA, DESKMINIS_FAKE_PROVIDER: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'], cwd: APP_DIR, env, timeout: 60_000,
});
try {
  const page = await app.firstWindow();
  page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => report.consoleErrors.push('pageerror: ' + String(e?.message ?? e)));
  await page.waitForSelector('.navit', { timeout: 30_000 });
  await sleep(1500);
  const shot = async (name) => { const p = path.join(SHOTS, `W3-cronb-${LABEL}-${name}.png`); await page.screenshot({ path: p }); log('shot', p); };
  const clickButtonText = (text) => page.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent?.trim() === t) ?? [...document.querySelectorAll('button')].find(x => x.textContent?.includes(t));
    if (!b) return 'NOT_FOUND'; b.click(); return 'OK';
  }, text);
  const jobs = () => page.evaluate(() => [...document.querySelectorAll('.job')].map(j => ({
    name: j.querySelector('.jname')?.textContent?.trim(), sched: j.querySelector('.jtop .f-tag')?.textContent?.trim(),
  })));
  const NAME = 'input[placeholder^="如「"]';
  const WS = 'input[placeholder="留空用会话默认沙箱目录"]';
  const assistantSelect = () => page.locator('form.f-card select').nth(1);
  const editFirst = async () => {
    const r = await page.evaluate(() => { const b = document.querySelector('.job .jacts button[title="编辑"]'); if (!b) return 'NOT_FOUND'; b.click(); return 'OK'; });
    await page.waitForSelector('form.f-card', { timeout: 5_000 });
    await sleep(300);
    return r;
  };
  const formValues = () => page.evaluate(() => {
    const sels = document.querySelectorAll('form.f-card select');
    const a = sels[1];
    return { assistant: a?.value ?? null, assistantText: a?.selectedOptions?.[0]?.textContent?.trim() ?? null,
      workspace: document.querySelector('input[placeholder="留空用会话默认沙箱目录"]')?.value ?? null };
  });

  log('nav →', await clickButtonText('定时任务'));
  await sleep(600);
  log('new →', await clickButtonText('新建任务'));
  await page.waitForSelector('form.f-card', { timeout: 5_000 });
  const options = await page.evaluate(() => [...document.querySelectorAll('form.f-card select')[1].options].map(o => ({ v: o.value, t: o.textContent?.trim() })));
  report.checks.assistantOptions = options;
  const pick = options.find(o => o.v !== '');
  if (!pick) throw new Error('没有可选的助手（首启种子没出现）');
  await page.fill(NAME, '清空助手与目录');
  await page.fill('form.f-card textarea.f-area', '到点看一眼工作区');
  await assistantSelect().selectOption(pick.v);
  await page.fill(WS, '/tmp/ws-cronb');
  log('create →', await clickButtonText('创建'));
  await sleep(1500);
  report.checks.created = (await jobs()).some(j => j.name === '清空助手与目录');

  // 编辑：回填应是刚才的助手与目录
  log('edit →', await editFirst());
  report.checks.prefilled = await formValues();
  await shot('1-prefilled');
  // 清空两样再保存
  await assistantSelect().selectOption('');
  await page.fill(WS, '');
  log('save →', await clickButtonText('保存'));
  await sleep(1500);
  report.checks.formClosedAfterSave = !(await page.$('form.f-card'));
  // 再编辑：引擎交回的任务里两样都应是空的
  log('edit again →', await editFirst());
  report.checks.afterClear = await formValues();
  await shot('2-after-clear');
  log('cancel →', await clickButtonText('取消'));
  await sleep(300);

  // 间隔上限：600000 被浏览器拦下；525600 能建
  log('new →', await clickButtonText('新建任务'));
  await page.waitForSelector('form.f-card', { timeout: 5_000 });
  await page.fill(NAME, '间隔太长');
  await page.fill('form.f-card textarea.f-area', 'x');
  await page.fill('form.f-card input[type=number]', '600000');
  const over = await page.evaluate(() => {
    const i = document.querySelector('form.f-card input[type=number]');
    return { max: i?.getAttribute('max'), rangeOverflow: i?.validity?.rangeOverflow, message: i?.validationMessage,
      hint: i?.parentElement?.querySelector('.f-hint')?.textContent?.trim() };
  });
  log('create →', await clickButtonText('创建'));
  await sleep(800);
  report.checks.interval600000 = { ...over, formStillOpen: !!(await page.$('form.f-card')), created: (await jobs()).some(j => j.name === '间隔太长') };
  await shot('3-interval-too-long');
  await page.fill('form.f-card input[type=number]', '525600');
  log('create →', await clickButtonText('创建'));
  await sleep(1500);
  const js = await jobs();
  report.checks.interval525600 = { created: js.some(j => j.name === '间隔太长'), sched: js.find(j => j.name === '间隔太长')?.sched };
  await shot('4-interval-max');
} finally {
  await app.close().catch(() => {});
  fs.writeFileSync(path.join(S, `W3-cronb-${LABEL}-report.json`), JSON.stringify(report, null, 2));
  log('report written; console errors total:', report.consoleErrors.length);
}
