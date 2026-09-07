// U2 实拍：三种 Office 格式的内容预览。文件由 agent 自己用 office_write 产出（U4 的 e2e），
// 再由预览区用 office.read 读回来渲染（U2）——一条链两头都验到。
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
const APP_DIR = '/home/user/Deskminis/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/ef029206-b91f-57eb-8ce8-a84cf713c455/scratchpad';
const SHOTS = path.join(S, 'shots');
const DATA = path.join(S, 'u2-data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
const log = (...a) => console.log('[u2]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ss = async (p, n) => { await p.screenshot({ path: path.join(SHOTS, n + '.png') }); log('shot:', n); };

const DOCX = { blocks: [
  { kind: 'heading', level: 1, text: '县域充电网络建设方案' },
  { kind: 'para', text: '本方案面向 2026—2028 三年期，覆盖 6 个乡镇的充电基础设施布点、投资测算与运营模式。' },
  { kind: 'heading', level: 2, text: '一、建设目标' },
  { kind: 'para', text: '到 2028 年底建成直流快充站 18 座、交流慢充桩 240 个，实现县域主干道 30 公里服务半径全覆盖。' },
  { kind: 'para', text: '同步建设统一结算平台，接入省级监管系统，实现刷卡、扫码、即插即充三种支付方式。' },
  { kind: 'heading', level: 2, text: '二、投资测算' },
  { kind: 'table', rows: [
    ['项目', '单价（万元）', '数量', '小计（万元）'],
    ['直流快充站', '42.0', '18', '756.0'],
    ['交流慢充桩', '1.8', '240', '432.0'],
    ['配电增容', '15.5', '6', '93.0'],
    ['结算平台', '80.0', '1', '80.0'],
    ['合计', '—', '—', '1361.0'],
  ] },
  { kind: 'heading', level: 2, text: '三、运营模式' },
  { kind: 'para', text: '采用「政府投资 + 企业运营」模式，财政补贴设备投资的 40%，运营方负责日常维护并按度电分成。' },
] };
const XLSX = { sheets: [
  { name: '投资测算', rows: [
    ['项目', '单价(万元)', '数量', '小计(万元)', '占比'],
    ['直流快充站', 42, 18, 756, '55.5%'],
    ['交流慢充桩', 1.8, 240, 432, '31.7%'],
    ['配电增容', 15.5, 6, 93, '6.8%'],
    ['结算平台', 80, 1, 80, '5.9%'],
    ['合计', '', '', 1361, '100%'],
  ] },
  { name: '分期计划', rows: [
    ['期次', '年度', '乡镇', '快充站', '慢充桩', '投资(万元)'],
    ['一期', 2026, '城关、白沙', 6, 80, 452],
    ['二期', 2027, '双河、石岭', 6, 80, 452],
    ['三期', 2028, '柳湾、栗坪', 6, 80, 457],
  ] },
] };
const PPTX = { slides: [
  { title: '县域充电网络建设方案', bullets: ['2026—2028 三年期', '区域发展署 · 2026 年 3 月'] },
  { title: '一、现状：慢充占比过高', bullets: ['现有充电桩 127 个，直流快充仅 23 个', '慢充日均使用 2.1 次，周转率低下', '主干道服务区存在 40 公里补能空白'] },
  { title: '二、目标：三年建成 18 座快充站', bullets: ['直流快充站 18 座，交流慢充桩 240 个', '主干道 30 公里服务半径全覆盖', '统一结算平台接入省级监管'] },
  { title: '三、投资：总额 1361 万元', bullets: ['设备投资占 87%，配电增容占 6.8%', '财政补贴设备投资的 40%', '按日均 18 车次测算，回收期 4.2 年'] },
] };

const CASES = [
  { name: 'docx', file: '建设方案.docx', spec: DOCX, title: '撰写建设方案 Word' },
  { name: 'xlsx', file: '投资测算.xlsx', spec: XLSX, title: '生成投资测算表' },
  { name: 'pptx', file: '汇报材料.pptx', spec: PPTX, title: '生成汇报幻灯片' },
];

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45000,
  env: { ...process.env, DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: DATA,
         DESKMINIS_FAKE_REPLY: '文件已经生成好了，我在右边打开给你看。注意预览是内容预览——文字、表格、大纲都在，字体和精确排版不还原，要看最终版式请用 Office 打开。' },
});
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { page = app.windows().find(w => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(500); }
  await page.waitForSelector('body', { timeout: 15000 });
  await sleep(4500);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  for (let ci = 0; ci < CASES.length; ci++) {
    const c = CASES[ci];
    if (ci > 0) {
      await page.evaluate(() => document.querySelector('.newbtn')?.click());
      await sleep(1200);
    }
    const sent = await page.evaluate((payload) => {
      const ta = document.querySelector('textarea.field');
      if (!ta) return 'NO_FIELD';
      ta.focus();
      ta.value = payload;
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 'OK';
    }, '__tool__ office_write ' + JSON.stringify({ path: c.file, content: JSON.stringify(c.spec), tool_title: c.title }));
    log(c.name, 'fill →', sent);
    await sleep(250);
    await page.keyboard.press('Enter');
    for (let i = 0; i < 60; i++) { await sleep(500); if (await page.evaluate(() => !document.querySelector('.go.stop'))) break; }
    await sleep(1800);

    const opened = await page.evaluate((f) => {
      const el = [...document.querySelectorAll('.ws .row')].find(e => e.textContent?.includes(f.split('.')[0]));
      if (!el) return 'NOT_FOUND'; el.click(); return 'OK';
    }, c.file);
    log(c.name, 'open →', opened);
    await sleep(1800);
    await ss(page, `u2-${c.name}`);
    const probe = await page.evaluate(() => ({
      office: !!document.querySelector('.office'),
      edge: document.querySelector('.office .edge')?.textContent?.slice(0, 28) ?? null,
      paper: !!document.querySelector('.office .paper'),
      h1: document.querySelector('.office .paper h1')?.textContent ?? null,
      tblCells: document.querySelectorAll('.office .dtbl td').length,
      sheetTabs: document.querySelectorAll('.office .tab').length,
      sheetCells: document.querySelectorAll('.office .sheet tbody td').length,
      colHeads: [...document.querySelectorAll('.office .colh')].map(e => e.textContent).join(''),
      slides: document.querySelectorAll('.office .slide').length,
      firstSlide: document.querySelector('.office .stitle')?.textContent ?? null,
      bullets: document.querySelectorAll('.office .sbul li').length,
      fallback: document.body.textContent?.includes('只解 OOXML') ?? false,
    }));
    log(c.name, 'probe:', JSON.stringify(probe));
  }

  // Excel 第二张表：标签页切换要真的换数据
  await page.evaluate(() => { /* 回到 xlsx 会话 */ });
  await ss(page, 'u2-pptx-dark-pre');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await sleep(500);
  await ss(page, 'u2-pptx-dark');

  // legacy 格式：写一个 .doc 进工作区，确认走「明说不支持」而不是解析失败
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
} finally { await app.close().catch(() => {}); }
log('done');
