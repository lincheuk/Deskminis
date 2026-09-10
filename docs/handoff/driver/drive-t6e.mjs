// T6e-2 实拍：工具步骤展开区必须看得见「调了什么」。
// 两个会话：① file_write 造出文件（FakeProvider 每回合重放首条消息，换工具必须换会话）
//           ② file_edit 改它 —— 展开后应出现差分视图（相对化路径 + 增删计数），不是一段裸 JSON。
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
const APP_DIR = '/home/user/Deskminis/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/ef029206-b91f-57eb-8ce8-a84cf713c455/scratchpad';
const SHOTS = path.join(S, 'shots');
const DATA = path.join(S, 't6e-data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
const log = (...a) => console.log('[t6e]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const OLD = `def charge_rate(kw, hours):
    return kw * hours

TAX = 0.06
`;
const NEW = `def charge_rate(kw, hours, loss=0.08):
    """按损耗折算实际计费电量。"""
    return kw * hours * (1 - loss)

TAX = 0.13
`;

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45000,
  env: { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA,
         DESKMINIS_FAKE_REPLY: '改好了，计费按 8% 损耗折算，税率也从 6% 调到 13%。' },
});
let bad = 0;
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { page = app.windows().find(w => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(500); }
  await page.waitForSelector('body', { timeout: 15000 });
  await sleep(4500);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  const send = async (payload) => {
    const r = await page.evaluate((p) => {
      const ta = document.querySelector('textarea.field');
      if (!ta) return 'NO_FIELD';
      ta.focus(); ta.value = p;
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 'OK';
    }, payload);
    if (r !== 'OK') throw new Error('填不进输入框: ' + r);
    await sleep(250);
    await page.keyboard.press('Enter');
    for (let i = 0; i < 60; i++) { await sleep(500); if (await page.evaluate(() => !document.querySelector('.go.stop'))) break; }
    await sleep(1500);
  };

  // ① 造文件
  await send('__tool__ file_write ' + JSON.stringify({ path: 'billing.py', content: OLD, tool_title: '写计费脚本' }));
  log('① file_write 完成');

  // ② 新会话 → file_edit。
  // ⚠️ 工作区是**每会话**的：①造的文件不在②的沙箱里，直接发编辑会 ENOENT，
  //    截图上留一条刺眼的「1 步失败」。所以先把种子文件铺进②自己的工作区再发。
  await page.evaluate(() => document.querySelector('.newbtn')?.click());
  await sleep(1500);
  const seed = () => {
    const root = path.join(DATA, 'sessions');
    const dirs = fs.readdirSync(root).map(d => ({ d, t: fs.statSync(path.join(root, d)).mtimeMs }));
    dirs.sort((a, b) => b.t - a.t);
    const ws = path.join(root, dirs[0].d, 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'billing.py'), OLD);
    return dirs[0].d;
  };
  log('② 种子文件铺进会话', seed());
  await send('__tool__ file_edit ' + JSON.stringify({
    path: 'billing.py', old_string: OLD, new_string: NEW, tool_title: '按损耗折算计费并上调税率',
  }));
  log('② file_edit 完成');

  // 展开工具步骤
  const opened = await page.evaluate(() => {
    const h = document.querySelector('.grp .head');
    if (!h) return 'NO_GROUP';
    h.click(); return 'OK';
  });
  log('展开 →', opened);
  if (opened !== 'OK') bad++;
  await sleep(600);
  await page.screenshot({ path: path.join(SHOTS, 't6e-file-edit-diff.png') });

  const probe = await page.evaluate(() => {
    const g = document.querySelector('.grp .body');
    const d = g?.querySelector('.diff');
    return {
      hasDiff: !!d,
      pathText: d?.querySelector('.dpath')?.textContent?.trim() ?? '',
      add: d?.querySelector('.add')?.textContent?.trim() ?? '',
      del: d?.querySelector('.del')?.textContent?.trim() ?? '',
      addLines: g ? g.querySelectorAll('.dline.add').length : -1,
      delLines: g ? g.querySelectorAll('.dline.del').length : -1,
      rawJson: (g?.textContent ?? '').includes('old_string'),
      hasOutput: (g?.textContent ?? '').includes('输出'),
      stepFailed: !!document.querySelector('.grp .bad'),
      stepTitle: g?.querySelector('.stitle')?.textContent?.trim() ?? '',
    };
  });
  log('探针:', JSON.stringify(probe));

  const check = (ok, msg) => { if (!ok) { bad++; log('✗', msg); } else log('✓', msg); };
  check(probe.hasDiff, '差分视图渲出来了（不是一段裸 JSON）');
  check(probe.pathText === 'billing.py', `路径已相对化，显示 "${probe.pathText}"（期望 billing.py）`);
  check(probe.addLines > 0 && probe.delLines > 0, `增删各有行：+${probe.addLines} / -${probe.delLines}`);
  check(/^\+\d+$/.test(probe.add) && /^-\d+$/.test(probe.del), `计数显示 ${probe.add} ${probe.del}`);
  check(!probe.rawJson, '没有把 old_string 原始 JSON 摊给用户');
  check(!probe.stepFailed, '编辑真的执行成功了（差分不是从一次失败调用里渲出来的）');
  check(probe.stepTitle === '按损耗折算计费并上调税率',
    `历史回放的标题是人话而非裸工具名，实为 "${probe.stepTitle}"`);

  // ③ 非 file_edit 的工具回落参数区
  await page.evaluate(() => document.querySelector('.newbtn')?.click());
  await sleep(1500);
  log('③ 种子文件铺进会话', seed());
  await send('__tool__ file_read ' + JSON.stringify({ path: 'billing.py', tool_title: '读回计费脚本' }));
  await page.evaluate(() => document.querySelector('.grp .head')?.click());
  await sleep(600);
  await page.screenshot({ path: path.join(SHOTS, 't6e-params-fallback.png') });
  const p2 = await page.evaluate(() => {
    const t = document.querySelector('.grp .body')?.textContent ?? '';
    return { params: t.includes('参数'), pathShown: t.includes('billing.py') };
  });
  log('回落探针:', JSON.stringify(p2));
  check(p2.params, '非 file_edit 工具回落到参数区');
  check(p2.pathShown, '参数区里看得见调用路径');
} catch (e) {
  bad++; log('异常:', e.message);
} finally {
  await app.close();
}
log(bad === 0 ? '=== 全部通过 ===' : `=== ${bad} 项未通过 ===`);
process.exit(bad === 0 ? 0 : 1);
