// DeskMinis G3 扩展市场 UI 真机验收驱动（CDP 驱动真实 dev 实例）。
// 用法：node scripts/e2e-g3-acceptance.mjs（dev 实例自启自收；跑前确认 5173/9222 无残留占用）
//
// 覆盖（任务步骤 E 六项）：
//   ① 「扩展」tab 打开，技能列表加载（真 ClawHub / awesome-dsh 真网）；
//   ② 搜索一个词结果刷新；
//   ③ verdict=ok 小技能完整安装：确认卡（文件清单+hash）→ 安装 → toast → 已装态 → 设置页技能列表可见；
//   ④ MCP 子 tab npm 包型条目走到确认卡：完整 npx 命令原样 + env 输入行（isSecret=password），不真装；
//   ⑤ 离线缓存路径：一阶段收口后把 market_cache 全表 aged 到过期（node:sqlite 直改，
//      免 ABI 依赖），二阶段用死端口 fixture（DESKMINIS_MARKET_FIXTURE_URL=http://127.0.0.1:9）
//      模拟断网 → stale 提示出现 + 源 chips 标灰；
//   ⑥ 亮暗双主题截图（徽章对比度、浮岛形态）。
//
// 收尾：taskkill 进程树 + 临时数据根删除；退出码非零即失败。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';

const results = [];
function record(step, pass, detail) {
  results.push({ step, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${step}] ${detail}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'dm-g3-e2e-'));
const SHOTS_DIR = join(process.cwd(), 'scripts', 'e2e-shots-g3');
mkdirSync(SHOTS_DIR, { recursive: true });

// ---------- CDP 客户端（E/D/F 波沉淀） ----------
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this.id = 0; this.pending = new Map(); this.listeners = [];
    this.ws.on('message', d => {
      const m = JSON.parse(d.toString());
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
        return;
      }
      if (m.method) for (const fn of [...this.listeners]) { try { fn(m); } catch { /* 监听器异常不中断 */ } }
    });
  }
  open() { return new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); }); }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const mid = ++this.id;
      this.pending.set(mid, { resolve, reject });
      this.ws.send(JSON.stringify({ id: mid, method, params }));
    });
  }
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch { /* 尽力 */ } }
}

let cdp;
const consoleErrors = [];
async function evaluate(expr) {
  const res = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error('evaluate 异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 300));
  return res.result?.value;
}
async function waitFor(expr, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await evaluate(expr); } catch { v = undefined; }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时(${Math.round(timeoutMs / 1000)}s): ${label}`);
    await sleep(200);
  }
}
const count = sel => evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
async function shot(name) {
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(SHOTS_DIR, name), Buffer.from(s.data, 'base64'));
  console.log('[shot] ' + name);
  return name;
}
async function setTheme(mode) {
  await evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(mode)})`);
  await sleep(450);
}
async function setNativeInput(sel, value) {
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}
async function minisdCall(method, params) {
  const info = await evaluate(`window.deskminis.minisdInfo()`);
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/?token=${encodeURIComponent(info.token)}`);
    const to = setTimeout(() => { ws.close(); reject(new Error('minisdCall 超时: ' + method)); }, 30_000);
    ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })));
    ws.on('message', d => {
      const m = JSON.parse(d.toString());
      if (m.id !== 1) return;
      clearTimeout(to); ws.close();
      if (m.error) reject(new Error(m.error.message ?? JSON.stringify(m.error))); else resolve(m.result);
    });
    ws.on('error', e => { clearTimeout(to); reject(e); });
  });
}
/** 按文本找按钮并点击（工作台标签/段控/chips 都是文本辨识）。 */
async function clickButtonByText(sel, text) {
  const ok = await evaluate(`(() => {
    const bs = [...document.querySelectorAll(${JSON.stringify(sel)})];
    const b = bs.find(x => (x.textContent || '').trim().includes(${JSON.stringify(text)}));
    if (!b) return false; b.click(); return true;
  })()`);
  if (!ok) throw new Error(`找不到按钮 ${sel} 含文本「${text}」`);
}

// ---------- 启动 dev 实例 ----------
const ELECTRON_VITE_BIN = join(process.cwd(), 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
if (!existsSync(ELECTRON_VITE_BIN)) { console.error('找不到 node_modules/electron-vite —— 先 npm install'); process.exit(2); }
function launchDev(extraEnv) {
  const child = spawn(process.execPath, [ELECTRON_VITE_BIN, 'dev', '--', '--remote-debugging-port=9222'], {
    cwd: process.cwd(),
    env: (() => {
      const e = { ...process.env, DESKMINIS_DATA_DIR: DATA_ROOT, DESKMINIS_TEST: '1', ...extraEnv };
      delete e.ELECTRON_RUN_AS_NODE; // 宿主带它是为了 better-sqlite3 ABI；dev 实例必须摘掉
      return e;
    })(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.stderr.write('[dev] ' + d));
  child.stderr.on('data', d => process.stderr.write('[dev] ' + d));
  return child;
}
function killDev(child) {
  if (child?.pid) {
    const r = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'pipe' });
    console.log(r.status === 0 ? 'dev 进程树已回收' : 'taskkill 非零退出（可能已自行退出）');
  }
}
async function connectCdp() {
  let targets;
  const t0 = Date.now();
  for (;;) {
    try { targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json()); break; } catch { /* 未就绪 */ }
    if (Date.now() - t0 > 90_000) throw new Error('9222 不透（90s）');
    await sleep(500);
  }
  let page;
  const t1 = Date.now();
  for (;;) {
    page = targets.find(t => t.type === 'page' && /localhost:517\d/.test(t.url)) ?? targets.find(t => t.type === 'page' && t.url.startsWith('http://localhost:'));
    if (page) break;
    if (Date.now() - t1 > 90_000) throw new Error('找不到渲染 page');
    await sleep(500);
    targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json());
  }
  console.log('渲染 page: ' + page.url);
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  cdp.on(m => {
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push((m.params.args ?? []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      consoleErrors.push((d.text + ' ' + (d.exception?.description ?? '')).slice(0, 200));
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await waitFor(`!!document.querySelector('textarea.field')`, 90_000, '初始挂载');
  await sleep(800);
}
async function openMarketTab() {
  await clickButtonByText('.wtab-main', '扩展');
  await waitFor(`!!document.querySelector('.mkp')`, 10_000, 'MarketPanel 挂载');
}

let child = null;
try {
  // ============================================================
  // 一阶段：真网（ClawHub / MCP Registry / awesome-dsh）
  // ============================================================
  child = launchDev({});
  await connectCdp();
  await setTheme('light');

  // ① 「扩展」tab 打开，技能列表加载
  await openMarketTab();
  await waitFor(`document.querySelectorAll('.mcard').length > 0`, 45_000, '技能卡片流加载（真网）');
  const cards1 = await count('.mcard');
  const chips1 = await evaluate(`[...document.querySelectorAll('.chip')].map(c => c.textContent.trim()).join('|')`);
  const subBtns = await evaluate(`[...document.querySelectorAll('.mkseg button')].map(b => b.textContent.trim()).join('|')`);
  await shot('g3-light-skills.png');
  record('G3-1. 扩展 tab 打开 + 技能列表加载（真网）', cards1 > 0 && chips1.includes('全部') && subBtns === '技能|MCP',
    `卡片=${cards1} chips=[${chips1}] 子tab=[${subBtns}]`);

  // ② 搜索一个词结果刷新
  await setNativeInput('.mksearch', 'pdf');
  await waitFor(`(() => {
    const cards = [...document.querySelectorAll('.mcard')];
    return cards.length > 0 && cards.some(c => (c.textContent || '').includes('ClawHub'));
  })()`, 45_000, '搜索 pdf 后出现 ClawHub 结果（防抖 300ms + 真网搜索）');
  const cards2 = await count('.mcard');
  record('G3-2. 搜索刷新（pdf → ClawHub 结果出现）', cards2 > 0, `搜索后卡片=${cards2}`);

  // ③ verdict=ok 小技能完整安装
  // 先经 RPC 在首页结果里挑一个 detail verdict=ok 的 clawhub 条目（服务端裁定，不猜）
  const sr = await minisdCall('market.search', { kind: 'skill', q: 'pdf' });
  let target = null;
  for (const it of (sr.items ?? []).filter(i => i.id.startsWith('clawhub:')).slice(0, 8)) {
    try {
      const d = await minisdCall('market.detail', { id: it.id });
      if (d.item.verdict === 'ok') { target = { id: it.id, name: d.item.name }; break; }
    } catch { /* 换一个 */ }
  }
  if (!target) throw new Error('真网首页 8 个 clawhub 条目里找不到 verdict=ok——无法走完整安装');
  console.log('安装目标: ' + target.id + '（' + target.name + '）');

  // 详情视图：README 渲染 + license 透出（就地展开）
  await evaluate(`(() => {
    const c = [...document.querySelectorAll('.mcard')].find(x => (x.querySelector('.mc-name')?.textContent || '').trim() === ${JSON.stringify(target.name)});
    if (!c) return false; c.click(); return true;
  })()`);
  await waitFor(`!!document.querySelector('.mkdetail .md')`, 30_000, '详情 README 渲染');
  const detailMeta = await evaluate(`(() => {
    const t = document.querySelector('.mkdmeta')?.textContent || '';
    return { license: t.includes('license'), vb: document.querySelector('.mkdetail .vb')?.textContent || '' };
  })()`);
  await shot('g3-light-detail.png');

  // 返回列表 → Install → 确认卡
  await clickButtonByText('.mkback', '返回列表');
  await waitFor(`!!document.querySelector('.mklist')`, 10_000, '回到列表');
  await evaluate(`(() => {
    const c = [...document.querySelectorAll('.mcard')].find(x => (x.querySelector('.mc-name')?.textContent || '').trim() === ${JSON.stringify(target.name)});
    const b = c?.querySelector('button.mc-install'); if (!b) return false; b.click(); return true;
  })()`);
  await waitFor(`!!document.querySelector('.mask .sheet')`, 30_000, '确认卡打开（installPlan 真网组装）');
  await waitFor(`!document.querySelector('.shbody .mkloading')`, 30_000, 'plan 组装完成');
  const planDom = await evaluate(`(() => {
    const body = document.querySelector('.shbody');
    return {
      text: body?.textContent || '',
      files: !!body?.querySelector('.filelist'),
      hash: !!body?.querySelector('.hashline'),
      okBtnDisabled: document.querySelector('.shok')?.disabled,
    };
  })()`);
  await shot('g3-light-confirm.png');
  const planOk = planDom.files && planDom.hash && planDom.text.includes('SKILL.md')
    && planDom.text.includes('来源') && planDom.text.includes('安全裁定') && !planDom.okBtnDisabled;

  // 确认安装 → toast → 已装态
  await evaluate(`document.querySelector('.shok').click()`);
  await waitFor(`(() => { const t = document.querySelector('.mktoast'); return !!t && t.textContent.includes('已安装'); })()`, 90_000, '安装成功 toast');
  await waitFor(`(() => {
    const c = [...document.querySelectorAll('.mcard')].find(x => (x.querySelector('.mc-name')?.textContent || '').trim() === ${JSON.stringify(target.name)});
    return !!c?.querySelector('.mc-installed');
  })()`, 15_000, '卡片转已装态');
  const installed = await minisdCall('market.installed', { kind: 'skill' });
  const instRow = (installed.items ?? []).find(i => i.id === target.id);

  // 设置页技能列表可见：localRef → skills 列表名 → 设置模态技能页断言
  let settingsSeesSkill = false;
  let skillName = '';
  if (instRow) {
    const skills = await minisdCall('skills.list', {});
    skillName = skills.find(s => s.id === instRow.localRef)?.name ?? '';
    // 开设置模态（侧栏折叠态走图标轨 gear，展开态走 SessionList 底部「设置」）
    const opened = await evaluate(`(() => {
      const b = document.querySelector('.rl[title="设置"]') || [...document.querySelectorAll('.lfbtn')].find(x => x.textContent.includes('设置'));
      if (!b) return false; b.click(); return true;
    })()`);
    if (opened) {
      await waitFor(`!!document.querySelector('.snav')`, 10_000, '设置模态打开');
      await clickButtonByText('.sitem', '技能');
      await waitFor(`!!document.querySelector('.skills')`, 10_000, '技能页挂载');
      settingsSeesSkill = skillName !== '' && await evaluate(`document.querySelector('.skills')?.textContent.includes(${JSON.stringify(skillName)})`);
      await evaluate(`(() => { const x = document.querySelector('.xbtn'); if (x) x.click(); })()`);
      await sleep(400);
    }
  }
  record('G3-3. verdict=ok 技能完整安装链路', planOk && !!instRow && settingsSeesSkill,
    `目标=${target.id} 确认卡(文件清单=${planDom.files} hash=${planDom.hash} SKILL.md=${planDom.text.includes('SKILL.md')} 钮可用=${!planDom.okBtnDisabled}) 已装登记=${!!instRow} 设置页见「${skillName}」=${settingsSeesSkill} 详情(license行=${detailMeta.license} 徽章=${detailMeta.vb})`);

  // ⑥（暗色前半）+ ④ MCP 子 tab
  await setTheme('dark');
  await clickButtonByText('.mkseg button', 'MCP');
  await waitFor(`document.querySelectorAll('.mcard').length > 0`, 45_000, 'MCP 列表加载（真网注册表）');
  await shot('g3-dark-mcp.png');

  // 经 RPC 挑一个 npm stdio + 带 env 声明的条目走到确认卡
  // （首页未必有：多关键词轮询扫描——github/slack 类集成服务通常带 token env）
  let mcpTarget = null;
  let mcpQuery = '';
  outer:
  for (const mq of ['', 'github', 'slack', 'fetch', 'search']) {
    let ml;
    try { ml = await minisdCall('market.search', { kind: 'mcp', q: mq }); } catch { continue; }
    for (const it of (ml.items ?? []).slice(0, 30)) {
      try {
        const p = await minisdCall('market.installPlan', { id: it.id });
        if (p.command && (p.env?.length ?? 0) > 0) { mcpTarget = { id: it.id, name: it.name, plan: p }; mcpQuery = mq; break outer; }
      } catch { /* 换一个 */ }
    }
  }
  if (!mcpTarget) throw new Error('注册表多关键词扫描（150 条）找不到 npm stdio + env 声明条目');
  console.log('MCP 确认卡目标: ' + mcpTarget.id + '（q=' + mcpQuery + '）');
  // UI 列表同步到命中关键词，保证目标卡片可见（防抖 300ms 后刷新）
  if (mcpQuery !== '') {
    await setNativeInput('.mksearch', mcpQuery);
    await waitFor(`(() => {
      const c = [...document.querySelectorAll('.mcard')].find(x => (x.querySelector('.mc-name')?.textContent || '').trim() === ${JSON.stringify(mcpTarget.name)});
      return !!c;
    })()`, 45_000, '目标 MCP 卡片出现在 UI 列表');
  }
  await evaluate(`(() => {
    const c = [...document.querySelectorAll('.mcard')].find(x => (x.querySelector('.mc-name')?.textContent || '').trim() === ${JSON.stringify(mcpTarget.name)});
    const b = c?.querySelector('button.mc-install'); if (!b) return false; b.click(); return true;
  })()`);
  await waitFor(`!!document.querySelector('.mask .sheet .cmdline')`, 30_000, 'MCP 确认卡（完整命令）');
  const cmdText = await evaluate(`document.querySelector('.sheet .cmdline')?.textContent || ''`);
  const expectCmd = `${mcpTarget.plan.command.command} ${mcpTarget.plan.command.args.join(' ')}`;
  const envInputs = await count('.envinput');
  const pwdInputs = await count('.envinput[type="password"]');
  const secretDecls = mcpTarget.plan.env.filter(d => d.isSecret).length;
  await shot('g3-dark-confirm.png');
  await evaluate(`(() => { const b = [...document.querySelectorAll('.shfoot button')].find(x => x.textContent.includes('取消')); if (b) b.click(); })()`);
  await sleep(400);
  record('G3-4. MCP npm 包条目确认卡：完整 npx 命令 + env 输入行',
    cmdText.trim() === expectCmd && envInputs === mcpTarget.plan.env.length && pwdInputs === secretDecls,
    `命令原样=[${cmdText.trim()}] 期望=[${expectCmd}] env输入=${envInputs}/${mcpTarget.plan.env.length} password=${pwdInputs}/${secretDecls}（不真装）`);

  // ⑥ 暗色技能列表补一张
  await clickButtonByText('.mkseg button', '技能');
  await waitFor(`document.querySelectorAll('.mcard').length > 0`, 30_000, '暗色技能列表');
  await shot('g3-dark-skills.png');

  record('G3-6. 亮暗双主题截图', true,
    'g3-light-skills / g3-light-detail / g3-light-confirm / g3-dark-mcp / g3-dark-confirm / g3-dark-skills（+ 离线图）已落 scripts/e2e-shots-g3/');

  // 一阶段收口
  cdp.close(); cdp = null;
  killDev(child); child = null;
  await sleep(1500);

  // ============================================================
  // 二阶段：离线缓存路径（缓存全表 aged + 死端口 fixture = 断网）
  // ============================================================
  {
    const db = new DatabaseSync(join(DATA_ROOT, 'minis.db'));
    const aged = db.prepare('UPDATE market_cache SET fetched_at = 0').run();
    // 探活缓存行删除（不是 aged）：有旧缓存时探活走降级算「可达」——那是正确行为。
    // 要验 chips 标灰得让探活真失败。保留 awesome-dsh:index（兼作技能列表数据源，
    // 删了技能列表就全源失败空手了）。
    const delProbe = db.prepare("DELETE FROM market_cache WHERE key IN ('clawhub:probe', 'mcp-registry:probe')").run();
    db.close();
    console.log(`market_cache aged 行数: ${aged.changes}，探活行删除: ${delProbe.changes}`);
  }
  child = launchDev({ DESKMINIS_MARKET_FIXTURE_URL: 'http://127.0.0.1:9' }); // discard 端口：一切市场请求必败
  await connectCdp();
  await setTheme('light');
  await openMarketTab();
  await waitFor(`document.querySelectorAll('.mcard').length > 0`, 45_000, '离线缓存卡片（降级）');
  await waitFor(`!!document.querySelector('.mkstalebar')`, 15_000, 'stale 离线缓存提示条');
  const staleText = await evaluate(`document.querySelector('.mkstalebar')?.textContent || ''`);
  const offChips = await count('.chip.off');
  await shot('g3-offline-stale.png');
  record('G3-5. 断网走缓存路径：stale 提示 + 不可达源标灰',
    staleText.includes('离线缓存') && offChips > 0,
    `提示=[${staleText.trim()}] 标灰chips=${offChips}`);

  record('Z. 全程 console error 清零', consoleErrors.length === 0,
    consoleErrors.length === 0 ? '零 error' : `共 ${consoleErrors.length} 条 [${consoleErrors.slice(0, 3).join(' | ')}]`);
} catch (e) {
  record('异常', false, e.message);
} finally {
  try { cdp?.close(); } catch { /* 尽力 */ }
  killDev(child);
  try { rmSync(DATA_ROOT, { recursive: true, force: true }); } catch { /* 尽力 */ }
}

const failed = results.filter(r => !r.pass);
console.log(`\n==== G3 验收：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length === 0 ? 0 : 1);
