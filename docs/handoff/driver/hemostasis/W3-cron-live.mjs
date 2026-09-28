// W3-cron 实拍（Linux + xvfb，真 Electron）：定时任务改了间隔后「创建 / 保存」。
// 用法：NODE_PATH=$S/driver/node_modules xvfb-run -a node W3-cron-live.mjs <应用目录（已 npm run build）> <标签 old|new>
//   old：在修之前的构建上复现真机报告 §3.1——改间隔后点「创建」，表单不关、列表不变、错误行不出现，控制台里是没人接的 TypeError；
//   new：修之后——改间隔能建成、编辑改间隔能保存；间隔填 3 被浏览器自带校验拦下（min 与引擎下限一致）；
//        引擎拒绝的输入（坏的 cron 表达式）落到错误行。
// 未打包形态即可（定时任务页与打包无关）；数据根是 mkdtemp 临时目录，假 provider，不碰网络。
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
const { _electron: electron } = createRequire(import.meta.url)('playwright-core');

const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const APP_DIR = process.argv[2];
const LABEL = process.argv[3] ?? 'run';
const SHOTS = path.join(S, 'hemo-shots');
const DATA = fs.mkdtempSync(path.join(S, `W3-cron-${LABEL}-data-`));
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
const log = (...a) => console.log(`[W3-cron ${LABEL}]`, ...a);
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
  const shot = async (name) => { const p = path.join(SHOTS, `W3-cron-${LABEL}-${name}.png`); await page.screenshot({ path: p }); log('shot', p); };
  const state = () => page.evaluate(() => ({
    formOpen: !!document.querySelector('form.f-card'),
    errline: document.querySelector('.errline')?.textContent?.trim() ?? '',
    jobs: [...document.querySelectorAll('.job')].map(j => ({
      name: j.querySelector('.jname')?.textContent?.trim(),
      sched: j.querySelector('.jtop .f-tag')?.textContent?.trim(),
    })),
  }));
  const clickButtonText = (text) => page.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent?.trim() === t) ?? [...document.querySelectorAll('button')].find(x => x.textContent?.includes(t));
    if (!b) return 'NOT_FOUND'; b.click(); return 'OK';
  }, text);

  // 进定时任务页 → 新建
  log('nav →', await clickButtonText('定时任务'));
  await sleep(600);
  log('new →', await clickButtonText('新建任务'));
  await page.waitForSelector('form.f-card', { timeout: 5_000 });
  await page.fill('form.f-card input.f-input:not([type])', '间隔改成 5 分钟的任务');
  await page.fill('form.f-card textarea.f-area', '看一眼工作区有没有新文件');
  // 关键一步：改间隔（真用户就是这样在框里改）
  await page.fill('form.f-card input[type=number]', '5');
  const modelType = await page.evaluate(() => typeof document.querySelector('form.f-card input[type=number]')?.value);
  log('interval dom value type:', modelType);
  const errsBefore = report.consoleErrors.length;
  log('submit →', await clickButtonText('创建'));
  await sleep(1500);
  const afterCreate = await state();
  report.checks.createAfterIntervalChange = {
    ...afterCreate,
    newConsoleErrors: report.consoleErrors.slice(errsBefore),
    created: afterCreate.jobs.some(j => j.name === '间隔改成 5 分钟的任务'),
  };
  log('after create:', JSON.stringify(report.checks.createAfterIntervalChange));
  await shot('1-create-interval5');

  if (LABEL !== 'old' && report.checks.createAfterIntervalChange.created) {
    // 编辑已有任务并改间隔 → 保存
    const opened = await page.evaluate(() => {
      const b = document.querySelector('.job .jacts button[title="编辑"]'); if (!b) return 'NOT_FOUND'; b.click(); return 'OK';
    });
    log('edit →', opened);
    await page.waitForSelector('form.f-card', { timeout: 5_000 });
    await page.fill('form.f-card input[type=number]', '10');
    log('save →', await clickButtonText('保存'));
    await sleep(1500);
    const afterEdit = await state();
    report.checks.editIntervalSave = { ...afterEdit, saved: afterEdit.jobs.some(j => /10/.test(j.sched ?? '')) };
    log('after edit:', JSON.stringify(report.checks.editIntervalSave));
    await shot('2-edit-interval10');

    // 间隔 3：浏览器自带校验先拦（min=5），表单不提交
    log('new →', await clickButtonText('新建任务'));
    await page.waitForSelector('form.f-card', { timeout: 5_000 });
    await page.fill('form.f-card input.f-input:not([type])', '间隔 3 分钟');
    await page.fill('form.f-card textarea.f-area', 'x');
    await page.fill('form.f-card input[type=number]', '3');
    const validity = await page.evaluate(() => {
      const i = document.querySelector('form.f-card input[type=number]');
      const f = document.querySelector('form.f-card');
      return { min: i?.getAttribute('min'), formValid: f?.checkValidity(), message: i?.validationMessage };
    });
    log('submit →', await clickButtonText('创建'));
    await sleep(800);
    const after3 = await state();
    report.checks.interval3 = { ...validity, formStillOpen: after3.formOpen, created: after3.jobs.some(j => j.name === '间隔 3 分钟') };
    log('interval 3:', JSON.stringify(report.checks.interval3));
    await shot('3-interval3-blocked');

    // 引擎拒绝的输入落到错误行：改成 cron，填坏表达式
    await page.selectOption('form.f-card select.f-select', 'cron');
    await sleep(200);
    await page.fill('form.f-card input[placeholder="0 9 * * *"]', 'bad');
    log('submit →', await clickButtonText('创建'));
    await sleep(1200);
    const afterBad = await state();
    report.checks.badCron = { errline: afterBad.errline, formStillOpen: afterBad.formOpen };
    log('bad cron:', JSON.stringify(report.checks.badCron));
    await shot('4-bad-cron-errline');
  }
} finally {
  await app.close().catch(() => {});
  fs.writeFileSync(path.join(S, `W3-cron-${LABEL}-report.json`), JSON.stringify(report, null, 2));
  log('report written; console errors total:', report.consoleErrors.length);
}
