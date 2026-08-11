// DeskMinis 点击扫描 端到端验收驱动（docs/plans/2026-07-31-mu2-ui-implementation.md 点击扫描 Task 8 · 决策 8 同基建）。
// 用法：node scripts/e2e-click-audit-acceptance.mjs（dev 实例自启自收，无需先 build；跑前确认 5173/9222 无残留占用）。
//
// 覆盖（CDP 驱动真实 dev 实例 DOM 断言，假 provider 脚本化造场景，零真网）：
//   1) 分栏：MU5 布局 B 反转后改锚**对话列**——默认 336px；工作台标签六枚且默认「进度」；
//      合成拖拽分隔条右移 200 → 536 → clamp 520（localStorage 键同步换成 deskminis.chatW）
//   2) 进度 tab：__tool__ file_write（数据根外）回合 → 步骤列表运行中步骤；权限卡触发 → 进度 tab 橙点 + 「去处理」点击滚动定位
//   3) 产物 tab：file_write（工作区内，自动放行）回合 → 产物卡出现 + 点击切文件 tab 出预览
//   4) 左栏：任务卡徽标 等待批准 → 完成 切换；底部「设置」开 SettingsModal、「设备」开 DevicesModal
//   5) 设置模态：Ctrl+, 开、Esc 关、外观切深色立即生效、Page.reload 后主题保留（localStorage 持久化）
//   6) 空状态：无会话 → 三示例卡 + 点击填入输入框；saveAttachment preload 桥存在性断言（见申报①）
//   7) DevicesModal：remote.pair.begin 出码 XXXX-XXXX + 倒计时读秒；remote-cli 完成配对 → 设备滑入（留配对设备供用例 8 截图）
//   8) 三模式全量截图 15 张（浅/深/跟随系统(深色系统模拟) × 主对话屏/右栏进度/右栏产物/设置模态/DevicesModal
//      → scripts/e2e-shots-click-audit/）+ 全程无 console error + 三模式关键 CSS 变量槽位非空
//
// 环境隔离：DESKMINIS_DATA_DIR=mkdtemp 临时目录 + DESKMINIS_TEST=1（内存 vault）+ DESKMINIS_FAKE_PROVIDER=1
//   + DESKMINIS_FAKE_REPLY（markdown 样本：截图与 markdown 渲染数据源）+ providers.json 预置 __fake__ 默认。
//
// 计划内修正/偏差申报（commit message 同步申报）：
//   ① 用例 6「Composer 粘贴图片」：CDP 无法向渲染进程合成携带真实 File 的 paste 事件（DataTransfer 构造在
//     isolated world 受限，计划 Task 8 Step 1 用例 6 已预留此退路）——按计划在脚本内断言 saveAttachment preload
//     桥存在；行为背书 = tests/main-attachments.test.ts（3 例）+ lib/composer/attach 单测 + 复核方手工验收截图。
//   ② 用例 8 主对话屏五元素（Markdown/工具行/diff/权限卡/EventNote）同框的 staging 依据：pendingPerms 是
//     store 全局态（permission.request 广播不经 activeId 过滤，stores/chat.ts L58），权限卡渲染于任意会话视图。
//     场景 = 会话 A（markdown + file_edit diff 历史 + __fail__ error 条）活动 + 会话 B 发起的权限卡（90s 窗口内）。
//     权限卡在「其所属会话上下文」中的交互正确性由用例 2 单独验证（该用例权限卡与 __tool__ 同会话）。
//   ③ 主对话屏截图为排除右栏干扰，经标题栏「视图 → 切换工作台」收起右栏拍摄，拍后即恢复（应用真实功能路径）。
//   ④ FakeProvider 单会话单次 __tool__（parseScript 取历史首条）与 __fail__ 全史毒化两条 minisd 红线不可碰，
//     故 file_edit（自动放行）与 file_write 权限卡分属会话 A/B 两场景区会话；用例间会话隔离沿用 mu2a 沉淀技法②。
//   ⑤ 用例 4 徽标：计划 Task 4 单测契约 running 优先级压过 waiting（权限卡悬挂时回合未 turnEnd，
//     running=true）——本会话卡验「进行中」，「等待批准」经全局 pendingPerms + 非运行活动会话（新建空会话）
//     路径验证；另 minisd 不自动生成会话标题（updateSessionTitle 无调用方，卡标题恒「新会话」），
//     用例 4/8 会话定位改 :data-sid 精确匹配（SessionList 增量属性，守卫锚不受影响）；
//     产物卡点击时 FilesPanel 可能未挂载（v-show+visited 懒挂载，watch 不触发）——FilesPanel onMounted
//     补消费 chat.pendingFilePreview（纯增量，既有 watch 路径保留）。
//
// 9222 透传（案 A 实证沿用）：electron-vite dev -- --remote-debugging-port=9222，60s 轮询 /json。
// 收尾：taskkill /pid /T /F 杀进程树；临时数据根与数据根外写盘目标删除；退出码非零即失败。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const results = [];
function record(step, pass, detail) {
  results.push({ step, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${step}] ${detail}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 临时数据根 + 预置假 provider ----------
const DATA_ROOT = mkdtempSync(join(tmpdir(), 'dm-e2e-click-audit-'));
writeFileSync(join(DATA_ROOT, 'providers.json'), JSON.stringify({
  providers: [{ id: '__fake__', name: 'Fake', kind: 'ollama', modelId: 'fake' }],
  defaultProviderId: '__fake__',
}, null, 2));
console.log('临时数据根: ' + DATA_ROOT);

// 数据根外写盘目标（触发 file-write 权限卡；用完即删）
const WRITE_OUTSIDE = join(tmpdir(), `dm-click-audit-e2e-write-${process.pid}.txt`);

// markdown 样本（截图主对话屏 + 渲染数据源）
const MD_SAMPLE = [
  '## MU2B 验收标题', '',
  '场景正文段落。', '',
  '- 列表甲', '- 列表乙', '',
  '```js', "console.log('click-audit')", '```',
].join('\n');

// ---------- 启动 dev 实例 ----------
const ELECTRON_VITE_BIN = join(process.cwd(), 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
if (!existsSync(ELECTRON_VITE_BIN)) { console.error('找不到 node_modules/electron-vite —— 先 npm install'); process.exit(2); }

const child = spawn(process.execPath, [ELECTRON_VITE_BIN, 'dev', '--', '--remote-debugging-port=9222'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DESKMINIS_DATA_DIR: DATA_ROOT,
    DESKMINIS_TEST: '1',
    DESKMINIS_FAKE_PROVIDER: '1',
    DESKMINIS_FAKE_REPLY: MD_SAMPLE,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', d => process.stderr.write('[dev] ' + d));
child.stderr.on('data', d => process.stderr.write('[dev] ' + d));

// ---------- CDP 客户端 ----------
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
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
    await sleep(150);
  }
}
async function sendPrompt(text) {
  await evaluate(`(() => {
    const ta = document.querySelector('textarea.field');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitFor(`(() => { const b = document.querySelector('button.send:not(.stop)'); return !!b && !b.disabled; })()`, 10_000, '发送钮可用');
  await evaluate(`document.querySelector('button.send:not(.stop)').click()`);
}
const count = sel => evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
/** FakeProvider.parseScript 取历史首条 __tool__：每个 __tool__ 用例开新会话隔离（mu2a 技法②）。 */
async function newSession() {
  await evaluate(`document.querySelector('.newbtn').click()`);
  await waitFor(`document.querySelectorAll('.ublock').length === 0 && document.querySelectorAll('.msg-a').length === 0 && !document.querySelector('.perm')`, 10_000, '新会话就绪');
}
async function waitTurnSettled(a0, timeoutMs, label) {
  await waitFor(`document.querySelectorAll('.msg-a').length > ${a0}`, timeoutMs, label ?? '回合落地（.msg-a +1）');
}
/** minisd 直联 JSON-RPC（取活动会话 id 等脚本侧数据；与渲染端 WS 并存的第二连接，remote-cli 已实证可行）。 */
async function minisdCall(method, params) {
  const info = await evaluate(`window.deskminis.minisdInfo()`);
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/?token=${encodeURIComponent(info.token)}`);
    const to = setTimeout(() => { ws.close(); reject(new Error('minisdCall 超时: ' + method)); }, 10_000);
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
/** 最新会话 id（newSession 之后即调：updated_at 最新者居首）。 */
async function activeSessionId() {
  const list = await minisdCall('chat.sessions.list', {});
  const id = list?.[0]?.id;
  if (typeof id !== 'string' || !id) throw new Error('chat.sessions.list 无会话: ' + JSON.stringify(list).slice(0, 200));
  return id;
}

const SHOTS_DIR = join(process.cwd(), 'scripts', 'e2e-shots-click-audit');
/** CDP 全窗截图（与 mu2a/mu2b 同一实现）。 */
async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const out = join(SHOTS_DIR, name);
  writeFileSync(out, Buffer.from(r.data, 'base64'));
  return out;
}
const consoleErrors = [];

try {
  // —— CDP 连接（60s 轮询；先等初始挂载再 reload，mu2a 技法①） ——
  console.log('等待 CDP 9222 …');
  let targets;
  {
    const t0 = Date.now();
    for (;;) {
      try { targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json()); break; } catch { /* 未就绪 */ }
      if (Date.now() - t0 > 60_000) throw new Error('9222 不透（60s）。排查 5173/9222 残留进程');
      await sleep(500);
    }
  }
  let page;
  {
    const t0 = Date.now();
    for (;;) {
      page = targets.find(t => t.type === 'page' && /localhost:517\d/.test(t.url))
          ?? targets.find(t => t.type === 'page' && t.url.startsWith('http://localhost:'));
      if (page) break;
      if (Date.now() - t0 > 60_000) throw new Error('找不到渲染 page：' + JSON.stringify(targets.map(t => [t.type, t.url])));
      await sleep(500);
      targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json());
    }
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
  await waitFor(`!!document.querySelector('textarea.field')`, 60_000, '初始挂载');
  // —— 测试隔离：清掉跨次残留的分栏宽度偏好 ——
  // renderer 的 localStorage 落在 Electron userData 下，**不随本脚本的临时数据根隔离**，会跨次残留。
  // 点击扫描 时这看不出来（默认 360 与拖后复位值相同）；MU5 默认 336 而 clamp 上限 520，
  // 上一轮残留的 520 会被例 1 当成「默认宽」读到 —— 用例遂测的是上一轮的尾巴而不是默认值。
  // 显式清掉并重挂载，让例 1 每次都从真正的默认态起测。
  await evaluate(`localStorage.removeItem('deskminis.chatW'); location.reload()`);
  await sleep(600);
  await waitFor(`!!document.querySelector('textarea.field')`, 60_000, '清偏好后重新挂载');
  const cleanW = await evaluate(`localStorage.getItem('deskminis.chatW')`);
  if (cleanW !== null) throw new Error('分栏宽度偏好未清干净：' + cleanW);
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(500);
  await waitFor(`!!document.querySelector('textarea.field')`, 60_000, 'reload 后应用挂载');
  await sleep(1200);



  // ============ 点击扫描 ============
  const audit = [];   // { 面: string, 控件: string, 反应: bool, 说明: string }

  /** DOM 指纹：结构 + 关键状态。够敏感（类名/文本/元素数变化都算），又不至于被时间戳搅动。 */
  const FP = `(() => {
    const b = document.body;
    const cls = [...document.querySelectorAll('[class]')].length;
    // 记**位置**而不只是类名：选中态在 A/B 之间移动时类名串是一样的（都是 "opt on"），
    // 只记类名分辨不出「选中项换了」，会把一堆能用的控件误判成没反应（初版就是这么误报 4 处的）。
    const all = [...document.querySelectorAll('*')];
    const on = [...document.querySelectorAll('.on, .open, [aria-expanded="true"], [data-theme]')]
      .map(e => all.indexOf(e) + ':' + e.className).join('|');
    const theme = document.documentElement.getAttribute('data-theme') || '';
    const modal = document.querySelector('.modal') ? document.querySelector('.modal').getAttribute('aria-label') : '';
    const panels = [...document.querySelectorAll('.wtab-main')].map(t => t.className).join('|');
    return JSON.stringify({ len: b.innerHTML.length, cls, on, modal, panels, theme,
      txt: b.innerText.replace(/\\d+[smh]\\b|\\d{1,2}:\\d{2}/g, '').length });
  })()`;

  /** 扫一个面：sel 选中的每个控件都点一次，点完用 restore 把面恢复原状。 */
  async function sweep(faceName, sel, restore, skipText = []) {
    const n = await evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
    for (let i = 0; i < n; i++) {
      // 每次重新取元素（上一次点击可能已重排 DOM）
      const info = await evaluate(`(() => {
        const list = document.querySelectorAll(${JSON.stringify(sel)});
        const e = list[${i}];
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return JSON.stringify({
          txt: (e.textContent || e.getAttribute('title') || e.getAttribute('aria-label') || e.className).trim().slice(0, 24),
          cls: e.className, dis: e.disabled === true,
          vis: r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden',
        });
      })()`);
      if (!info) continue;
      const it = JSON.parse(info);
      if (!it.vis) continue;
      if (it.dis) { audit.push({ 面: faceName, 控件: it.txt, 反应: null, 说明: 'disabled（有意禁用，不计）' }); continue; }
      if (skipText.some(s => it.txt.includes(s))) { audit.push({ 面: faceName, 控件: it.txt, 反应: null, 说明: '跳过（破坏性/外部副作用）' }); continue; }

      const before = await evaluate(FP);
      await evaluate(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${i}]; if (e) e.click(); })()`);
      await sleep(360);
      const after = await evaluate(FP);
      audit.push({ 面: faceName, 控件: it.txt, 反应: before !== after, 说明: before === after ? '指纹零变化——疑似点了没反应' : '' });
      // **每点一次都把界面完整复位**：不复位的话，一个「关闭对话列」之类的点击会把
      // 后续控件全变成不可见，扫描等于自断前提（初版就是这么把覆盖从 21 降到 12 的）。
      if (restore) await restore();
    }
  }

  // 准备：建一个会话，保证各面有内容
  await newSession();
  const sid = await activeSessionId();
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.title||'').includes('展开会话列表')); if (b) b.click(); })()`);
  await sleep(400);

  /** 完整复位：reload 后重建「侧栏展开 + 已选会话」这个基线。
   *  Escape 关模态是不够的——三个分区开关、工作台折叠、标签关闭都改不回来。 */
  const resetApp = async () => {
    await cdp.send('Page.reload', { ignoreCache: false });
    await waitFor(`!!document.querySelector('textarea.field')`, 20_000, '重挂载');
    await sleep(600);
    await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.title||'').includes('展开会话列表')); if (b) b.click(); })()`);
    await sleep(300);
    await evaluate(`(() => { const c = document.querySelector('.scard'); if (c) c.click(); })()`);
    await sleep(500);
  };
  const openSettingsAt = async (page) => {
    await resetApp();
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))`);
    await waitFor(`!!document.querySelector('.modal[aria-label="设置"]')`, 8_000, '设置模态');
    await evaluate(`(() => { const x = [...document.querySelectorAll('.sitem')].find(e => e.textContent.trim() === ${JSON.stringify(page)}); if (x) x.click(); })()`);
    await sleep(400);
  };

  // ① 主界面（每点一次 reload 复位）
  await resetApp();
  await sweep('主界面', '.titlebar .mi, .titlebar .tb-seg, .titlebar .tb-ico, .lfoot .lfbtn, .wtab-main, .wtab-collapse, .ctools button, .ctools .cpill, .newbtn, .collapse, .scard, .excard, .ritem',
    resetApp, ['设置', '设备']);

  // ② 工作区面板
  const openWs = async () => {
    await resetApp();
    await evaluate(`(() => { const b = document.querySelector('.wsbtn'); if (b && !document.querySelector('.wspanel')) b.click(); })()`);
    await sleep(300);
  };
  await openWs();
  await sweep('工作区面板', '.wspanel button', openWs, ['选择目录', '新建会话并选目录']);

  // ③ 会话行操作区
  const openMenu = async () => {
    await resetApp();
    await evaluate(`(() => { const b = document.querySelector('.scard .smore'); if (b && !document.querySelector('.smenu')) b.click(); })()`);
    await sleep(300);
  };
  await openMenu();
  await sweep('会话操作区', '.smenu button, .smenu select', openMenu, ['删除']);

  // ④ 设置模态五页
  for (const page of ['模型', '技能', '外观', '权限', '设备与同步']) {
    const open = () => openSettingsAt(page);
    await open();
    await sweep('设置·' + page, '.sbody button, .sbody .opt, .sbody .mrow, .rtoggle, .syncbtn, .devbtn, .xbtn',
      open, ['删除', '管理设备', '导入']);
  }
  await resetApp();

  // 汇总
  const dead = audit.filter(a => a.反应 === false);
  const live = audit.filter(a => a.反应 === true);
  const skipped = audit.filter(a => a.反应 === null);
  console.log('\n===== 点击扫描结果 =====');
  console.log(`有反应 ${live.length} / 无反应 ${dead.length} / 跳过 ${skipped.length}（共 ${audit.length}）`);
  console.log('--- 全部条目 ---');
  for (const a of audit) console.log(`  [${a.面}] ${a.控件} => ${a.反应 === null ? '跳过' : (a.反应 ? '有反应' : '无反应')}`);
  if (dead.length) {
    console.log('\n--- 疑似点了没反应（需人工复核）---');
    for (const d of dead) console.log(`  [${d.面}] ${d.控件}`);
  }
  if (skipped.length) {
    console.log('\n--- 跳过 ---');
    for (const d of skipped) console.log(`  [${d.面}] ${d.控件} — ${d.说明}`);
  }
  record('点击扫描完成', true, `有反应 ${live.length} / 疑似无反应 ${dead.length} / 跳过 ${skipped.length}`);

} catch (e) {
  record('异常', false, e.message);
} finally {
  try { cdp?.close(); } catch { /* 尽力 */ }
  if (child.pid) {
    const r = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'pipe' });
    console.log(r.status === 0 ? 'dev 进程树已回收' : 'taskkill 非零退出（可能已自行退出）');
  }
  await sleep(800);
  try { rmSync(DATA_ROOT, { recursive: true, force: true }); console.log('临时数据根已清理'); }
  catch { console.warn('临时数据根清理失败（可手动删除）: ' + DATA_ROOT); }
  try { rmSync(WRITE_OUTSIDE, { force: true }); } catch { /* 尽力 */ }
}

const failed = results.filter(r => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} 步通过 =====`);
process.exit(failed.length ? 1 : 0);
