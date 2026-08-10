// DeskMinis MU2b 端到端验收驱动（docs/plans/2026-07-31-mu2-ui-implementation.md MU2b Task 8 · 决策 8 同基建）。
// 用法：node scripts/e2e-mu2b-acceptance.mjs（dev 实例自启自收，无需先 build；跑前确认 5173/9222 无残留占用）。
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
//      → scripts/e2e-shots-mu2b/）+ 全程无 console error + 三模式关键 CSS 变量槽位非空
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
const DATA_ROOT = mkdtempSync(join(tmpdir(), 'dm-e2e-mu2b-'));
writeFileSync(join(DATA_ROOT, 'providers.json'), JSON.stringify({
  providers: [{ id: '__fake__', name: 'Fake', kind: 'ollama', modelId: 'fake' }],
  defaultProviderId: '__fake__',
}, null, 2));
console.log('临时数据根: ' + DATA_ROOT);

// 数据根外写盘目标（触发 file-write 权限卡；用完即删）
const WRITE_OUTSIDE = join(tmpdir(), `dm-mu2b-e2e-write-${process.pid}.txt`);

// markdown 样本（截图主对话屏 + 渲染数据源）
const MD_SAMPLE = [
  '## MU2B 验收标题', '',
  '场景正文段落。', '',
  '- 列表甲', '- 列表乙', '',
  '```js', "console.log('mu2b')", '```',
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

const SHOTS_DIR = join(process.cwd(), 'scripts', 'e2e-shots-mu2b');
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
  // MU2b 时这看不出来（默认 360 与拖后复位值相同）；MU5 默认 336 而 clamp 上限 520，
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

  // —— 用例 6（先做：需无会话空态）：空状态三示例卡 + 点击填入 + saveAttachment 桥 ——
  const emptyOk = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.empty .excard')];
    const titles = cards.map(c => c.querySelector('.extitle')?.textContent ?? '');
    return cards.length === 3 && titles.includes('读代码') && titles.includes('写脚本') && titles.includes('跑命令');
  })()`);
  await evaluate(`document.querySelector('.empty .excard').click()`);
  await waitFor(`document.querySelector('textarea.field').value.includes('帮我读懂这个项目')`, 5_000, '示例卡填入输入框');
  const bridgeOk = await evaluate(`typeof window.deskminis?.saveAttachment === 'function'`);
  // 清空输入框，避免干扰后续用例
  await evaluate(`(() => {
    const ta = document.querySelector('textarea.field');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ''); ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  record('6. 空状态三示例卡 + 点击填入 + saveAttachment 桥', emptyOk === true && bridgeOk === true,
    `三示例卡=${emptyOk} 点击填入=OK saveAttachment 桥=${bridgeOk}（申报①：粘贴行为由 main-attachments/attach 单测 + 手工验收背书）`);

  // —— 用例 1（MU5 重锚）：对话列 336 默宽 / 六标签默认进度 / 拖拽 clamp 520 ——
  // 守卫价值不变（分栏宽度受控且可拖、面板默认态正确），换的是它挂在哪一栏：
  // MU2b 是「对话伸展 + 右栏定宽」，布局 B 反转为「对话定宽 + 工作台伸展」。
  const paneW0 = await evaluate(`getComputedStyle(document.querySelector('.pane-chat')).width`);
  const tabsOk = await evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.wtab')];
    const texts = tabs.map(t => t.querySelector('.wtab-main').textContent.trim());
    return tabs.length === 6 && texts.join(',') === '进度,产物,文件,终端,浏览器,屏幕'
        && tabs[0].classList.contains('on') && !tabs[1].classList.contains('on');
  })()`);
  // 合成拖拽：边界在对话列**右**缘，故右移增宽——起点 1000，右移 200 → 336+200=536 → clamp 520
  await evaluate(`(() => {
    const bar = document.querySelector('.cdrag');
    bar.dispatchEvent(new MouseEvent('mousedown', { clientX: 1000, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1200, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 1200, bubbles: true }));
  })()`);
  await sleep(300);
  const paneW1 = await evaluate(`getComputedStyle(document.querySelector('.pane-chat')).width`);
  const savedW = await evaluate(`localStorage.getItem('deskminis.chatW')`);
  // MU5 追加：上限已从绝对 520 改为「可用宽的一半，且工作台不低于 360」。
  // 故此处不再锚魔数，改断言**不变量**——魔数会随窗口尺寸失效，不变量不会。
  const clampInvariant = await evaluate(`(() => {
    const chat = document.querySelector('.pane-chat').getBoundingClientRect().width;
    const wb = document.querySelector('.pane-w').getBoundingClientRect().width;
    const avail = chat + wb;
    return chat <= Math.floor(avail * 0.5) + 1 && wb >= 360;
  })()`);
  // 拖回 336 复位（后续截图版面一致）：从 520 左移 184
  await evaluate(`(() => {
    const bar = document.querySelector('.cdrag');
    bar.dispatchEvent(new MouseEvent('mousedown', { clientX: 1000, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 816, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 816, bubbles: true }));
  })()`);
  await sleep(200);
  record('1. 对话列 336 默宽 / 六标签默认进度 / 右拖到底守住「≤一半 且 工作台≥360」',
    paneW0 === '336px' && tabsOk === true && clampInvariant === true && savedW !== null,
    `默宽=${paneW0} 六标签默认进度=${tabsOk} 拖到底=${paneW1}（localStorage=${savedW}）不变量=${clampInvariant}，已拖回复位`);

  // —— 用例 2：进度 tab（__tool__ 回合步骤 + 权限卡橙点 + 去处理定位） ——
  await newSession();
  const sid2 = await activeSessionId();
  const writeInput2 = JSON.stringify({ path: WRITE_OUTSIDE, content: 'mu2b-e2e 进度验收', tool_title: '进度验收写文件' });
  await sendPrompt(`__tool__ file_write ${writeInput2}`);
  await waitFor(`!!document.querySelector('.perm')`, 20_000, '权限卡出现');
  const progressOk = await evaluate(`(() => {
    const step = document.querySelector('.ppanel .step .sicon.run');
    const dot = document.querySelector('.wtab.dot-warn');
    const pend = document.querySelector('.ppanel .psec.pending .pending-text');
    const go = document.querySelector('.ppanel .gobtn');
    return !!step && !!dot && dot.textContent.includes('进度')
        && !!pend && pend.textContent.includes('等待批准') && !!go && go.textContent.includes('去处理');
  })()`);
  // 上翻解除跟随 → 点「去处理」→ 权限卡被滚动定位回视口
  await evaluate(`(() => { const s = document.querySelector('.stream'); s.scrollTop = 0; s.dispatchEvent(new Event('scroll')); })()`);
  const outOfView0 = await evaluate(`(() => {
    const p = document.querySelector('.perm'); const s = document.querySelector('.stream');
    if (!p || !s) return false;
    const r = p.getBoundingClientRect(); const sr = s.getBoundingClientRect();
    return r.top > sr.bottom || r.bottom < sr.top;
  })()`);
  await evaluate(`document.querySelector('.ppanel .gobtn').click()`);
  const located = await waitFor(`(() => {
    const p = document.querySelector('.perm'); const s = document.querySelector('.stream');
    if (!p || !s) return false;
    const r = p.getBoundingClientRect(); const sr = s.getBoundingClientRect();
    return r.top >= sr.top - 4 && r.bottom <= sr.bottom + 4;
  })()`, 8_000, '去处理 → 权限卡滚动定位回视口').then(() => true).catch(() => false);
  record('2. 进度 tab 步骤列表 + 橙点 + 去处理定位', progressOk === true && located,
    `步骤/橙点/待批卡断言=${progressOk} 定位前出视口=${outOfView0} 去处理定位回视口=${located}`);

  // —— 用例 4a：左栏徽标切换（申报⑤：计划 Task 4 单测契约 running 优先级压过 waiting——权限卡
  //    悬挂时回合未 turnEnd，running=true，故本会话卡为「进行中」；「等待批准」走全局 pendingPerms
  //    广播 + 非运行活动会话路径验证：新建空会话（open 重置 running=false）→ 其活动卡即等待批准） ——
  const badgeRun = await evaluate(`(() => {
    const b = document.querySelector('.scard.on .sdot');
    const row = document.querySelector('.scard.on');
    // MU5：状态由文字徽标改色点，文字搬到行 title（色觉障碍补偿）——语义检查随之改锚 title
    return !!b && b.classList.contains('run') && !!row && row.title.includes('进行中');
  })()`);
  await evaluate(`document.querySelector('.newbtn').click()`);
  const badgeWait = await waitFor(`(() => {
    const b = document.querySelector('.scard.on .sdot');
    const row = document.querySelector('.scard.on');
    // MU5：状态由文字徽标改色点，文字搬到行 title（色觉障碍补偿）——语义检查随之改锚 title
    return !!b && b.classList.contains('wait') && !!row && row.title.includes('等待批准');
  })()`, 8_000, '空会话活动卡「等待批准」').then(() => true).catch(() => false);
  // 切回用例 2 会话答卡（minisd 不自动生成标题，卡标题恒「新会话」——按 data-sid 精确定位）
  await evaluate(`document.querySelector('.scard[data-sid="${sid2}"]').click()`);
  await waitFor(`!!document.querySelector('.perm')`, 5_000, '切回用例 2 会话（权限卡仍在）');
  // 允许 → 回合落地 → 徽标转「完成」
  await evaluate(`document.querySelector('.perm .btn.primary').click()`);
  const a0c2 = 0;
  await waitFor(`!document.querySelector('.perm') && !!document.querySelector('.tline')`, 20_000, '卡消失 + ToolLine 出现');
  await waitTurnSettled(a0c2, 20_000, '用例 2 回合落地');
  const badgeDone = await waitFor(`(() => {
    const b = document.querySelector('.scard.on .sdot');
    const row = document.querySelector('.scard.on');
    // MU5：状态由文字徽标改色点，文字搬到行 title（色觉障碍补偿）——语义检查随之改锚 title
    return !!b && b.classList.contains('done') && !!row && row.title.includes('完成');
  })()`, 10_000, '徽标转完成').then(() => true).catch(() => false);

  // —— 用例 4b：底部「设置」/「设备」入口 ——
  await evaluate(`[...document.querySelectorAll('.lfoot .lfbtn')].find(b => b.textContent.includes('设置')).click()`);
  const settingsOpened = await waitFor(`!!document.querySelector('.modal[aria-label="设置"]')`, 5_000, '设置模态开').then(() => true).catch(() => false);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await waitFor(`!document.querySelector('.modal[aria-label="设置"]')`, 5_000, '设置模态关');
  await evaluate(`[...document.querySelectorAll('.lfoot .lfbtn')].find(b => b.textContent.includes('设备')).click()`);
  const devicesOpened = await waitFor(`!!document.querySelector('.modal[aria-label="设备与同步"]')`, 5_000, '设备模态开').then(() => true).catch(() => false);
  await evaluate(`document.querySelector('.modal[aria-label="设备与同步"] .xbtn').click()`);
  await waitFor(`!document.querySelector('.modal[aria-label="设备与同步"]')`, 5_000, '设备模态关');
  record('4. 左栏徽标切换 + 底部设置/设备入口', badgeRun === true && badgeWait && badgeDone && settingsOpened && devicesOpened,
    `徽标进行中=${badgeRun} 等待批准=${badgeWait} 完成=${badgeDone} 设置入口=${settingsOpened} 设备入口=${devicesOpened}`);

  // —— 用例 3：产物 tab（工作区内 file_write → 产物卡 → 点击切文件 tab 预览） ——
  await newSession();
  const sid3 = await activeSessionId();
  const wsFile3 = join(DATA_ROOT, 'sessions', sid3, 'workspace', 'artifact-demo.txt');
  const writeInput3 = JSON.stringify({ path: wsFile3, content: 'mu2b 产物预览验收内容', tool_title: '产物验收写文件' });
  const a0c3 = await count('.msg-a');
  await sendPrompt(`__tool__ file_write ${writeInput3}`);
  // 工作区内直放行为 M1 语义；若意外弹卡则放行并在明细申报
  const permPopped3 = await sleep(2500).then(() => count('.perm')).then(n => n > 0);
  if (permPopped3) await evaluate(`document.querySelector('.perm .btn.primary').click()`);
  await waitTurnSettled(a0c3, 20_000, '用例 3 回合落地');
  await evaluate(`[...document.querySelectorAll('.wtab-main')].find(t => t.textContent.includes('产物')).click()`);
  await waitFor(`!!document.querySelector('.acard')`, 10_000, '产物卡出现');
  const acardOk = await evaluate(`(() => {
    const c = document.querySelector('.acard .apath');
    return !!c && c.textContent.includes('artifact-demo.txt');
  })()`);
  await evaluate(`document.querySelector('.acard').click()`);
  // MU5 重锚：产物卡点击不再只是「切到文件 tab」，而是**在工作台开一个以该文件命名的可关闭标签**。
  // 两半分开断言——复合断言失败时说不清是标签名变了还是预览真没出来，那正是要避免的诊断黑洞。
  const bodyOk = await waitFor(`(() => {
    const body = document.querySelector('.fprev .pbody');
    return !!body && body.textContent.includes('mu2b 产物预览验收内容');
  })()`, 10_000, '文件预览正文出现').then(() => true).catch(() => false);
  const fileTabOk = await evaluate(`(() => {
    const tabOn = [...document.querySelectorAll('.wtab')].find(t => t.classList.contains('on'));
    return !!tabOn && tabOn.textContent.includes('artifact-demo.txt') && !!tabOn.querySelector('.wtab-x');
  })()`);
  record('3. 产物卡出现 + 点击开出可关闭的文件标签并预览', acardOk === true && bodyOk && fileTabOk === true,
    `产物卡路径断言=${acardOk} 预览正文=${bodyOk} 文件标签(带关闭钮)=${fileTabOk}${permPopped3 ? '（申报：工作区内 file_write 弹卡，已点允许——M1 直放语义需复核）' : '（工作区内直放无弹卡）'}`);

  // —— 用例 5：设置模态（Ctrl+, / Esc / 深色即效 / reload 保留） ——
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))`);
  await waitFor(`!!document.querySelector('.modal[aria-label="设置"]')`, 5_000, 'Ctrl+, 开设置');
  await evaluate(`[...document.querySelectorAll('.sitem')].find(s => s.textContent.includes('外观')).click()`);
  await evaluate(`[...document.querySelectorAll('.modal .opt')].find(o => o.textContent.includes('深色')).click()`);
  const darkNow = await evaluate(`document.documentElement.getAttribute('data-theme')`);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  const escClosed = await waitFor(`!document.querySelector('.modal[aria-label="设置"]')`, 5_000, 'Esc 关设置').then(() => true).catch(() => false);
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(500);
  await waitFor(`!!document.querySelector('textarea.field')`, 60_000, 'reload 后应用挂载');
  const darkKept = await evaluate(`document.documentElement.getAttribute('data-theme')`);
  record('5. 设置模态 Ctrl+,/Esc/深色即效/reload 保留',
    darkNow === 'dark' && escClosed && darkKept === 'dark',
    `切深色即效 data-theme=${darkNow} Esc 关=${escClosed} reload 后=${darkKept}`);

  // —— 用例 7：DevicesModal 出码 + 倒计时；remote-cli 完成配对（留设备供用例 8 截图） ——
  await evaluate(`[...document.querySelectorAll('.lfoot .lfbtn')].find(b => b.textContent.includes('设备')).click()`);
  await waitFor(`!!document.querySelector('.modal[aria-label="设备与同步"]')`, 10_000, 'DevicesModal 出现');
  await evaluate(`[...document.querySelectorAll('.modal .pbtn')].find(b => b.textContent.includes('发起配对')).click()`);
  await waitFor(`!!document.querySelector('.modal .code')`, 10_000, '配对码出现');
  const codeText = await evaluate(`document.querySelector('.modal .code').textContent.trim()`);
  const codeFmtOk = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(codeText);
  const sec1 = Number(/（(\d+)s）/.exec(await evaluate(`document.querySelector('.modal .codestate').textContent`))?.[1] ?? -1);
  await sleep(2200);
  const sec2 = Number(/（(\d+)s）/.exec(await evaluate(`document.querySelector('.modal .codestate').textContent`))?.[1] ?? -1);
  const countdownOk = sec1 > 0 && sec2 > 0 && sec2 < sec1;
  const info7 = await evaluate(`window.deskminis.minisdInfo()`);
  const cli = spawnSync(process.execPath, [
    join(process.cwd(), 'src', 'cli', 'remote-cli.mjs'), 'connect', codeText.replace('-', ''), 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    '--port', String(info7.port), '--token', info7.token,
  ], { encoding: 'utf8', timeout: 15_000 });
  const cliOut = (cli.stdout ?? '') + (cli.stderr ?? '');
  const cliOk = cli.status === 0 && cliOut.includes('fingerprint');
  const slideOk = cliOk
    ? await waitFor(`[...document.querySelectorAll('.modal .devcard')].some(c => c.textContent.includes('remote-cli'))`, 12_000, '设备滑入').then(() => true).catch(() => false)
    : false;
  await evaluate(`document.querySelector('.modal[aria-label="设备与同步"] .xbtn').click()`);
  await waitFor(`!document.querySelector('.modal[aria-label="设备与同步"]')`, 5_000, 'DevicesModal 关');
  record('7. DevicesModal 出码倒计时 + CLI 配对设备滑入', codeFmtOk && countdownOk && cliOk && slideOk,
    `码=${codeText}（格式=${codeFmtOk}）倒计时 ${sec1}s→${sec2}s（递减=${countdownOk}）CLI=${cliOk} 滑入=${slideOk}`);

  // —— 用例 8：三模式全量截图（15 张）+ console error 清零 + CSS 槽位巡检 ——
  mkdirSync(SHOTS_DIR, { recursive: true });
  // staging 会话 A：markdown → file_edit（diff，工作区内自动放行）→ 稍后 __fail__ error 条
  await newSession();
  const sidA = await activeSessionId();
  await sendPrompt('场景 markdown 铺垫');
  await waitFor(`!!document.querySelector('.md h2.md-h2')`, 20_000, '会话 A markdown 渲染');
  const sceneFile = join(DATA_ROOT, 'sessions', sidA, 'workspace', 'scene-note.txt');
  mkdirSync(join(DATA_ROOT, 'sessions', sidA, 'workspace'), { recursive: true });
  writeFileSync(sceneFile, '第一行旧文本\n第二行保留\n第三行也保留\n');
  const editInput = JSON.stringify({
    path: sceneFile, old_string: '第一行旧文本', new_string: '第一行新文本\n新增一行 diff', tool_title: '场景编辑文件',
  });
  const a0sA = await count('.msg-a');
  await sendPrompt(`__tool__ file_edit ${editInput}`);
  {
    const popped = await sleep(2500).then(() => count('.perm')).then(n => n > 0);
    if (popped) await evaluate(`document.querySelector('.perm .btn.primary').click()`); // 工作区内应直放；弹卡则放行兜底
  }
  await waitTurnSettled(a0sA, 20_000, '会话 A file_edit 回合落地');
  // staging 会话 B：markdown 铺垫 → __tool__ file_write 数据根外 → 权限卡 pending（90s 窗口）
  await newSession();
  await sendPrompt('场景 B 铺垫');
  await waitFor(`!!document.querySelector('.md h2.md-h2')`, 20_000, '会话 B markdown 渲染');
  const writeInputB = JSON.stringify({ path: WRITE_OUTSIDE, content: 'mu2b-e2e 截图权限卡', tool_title: '截图验收写文件' });
  await sendPrompt(`__tool__ file_write ${writeInputB}`);
  await waitFor(`!!document.querySelector('.perm')`, 20_000, '会话 B 权限卡 pending');
  // 切回会话 A（minisd 不自动生成标题，卡标题恒「新会话」——按 data-sid 精确定位，申报⑤）→ __fail__ 429 → error 条
  await evaluate(`document.querySelector('.scard[data-sid="${sidA}"]').click()`);
  await waitFor(`!!document.querySelector('.md h2.md-h2') && !!document.querySelector('.tline')`, 10_000, '会话 A 重载（markdown + ToolLine）');
  // ToolLine 默认折叠，diff 在展开区（.tlwrap .diff，非 .tline 子级）——点击展开入 DOM
  await evaluate(`document.querySelector('.tline').click()`);
  await waitFor(`!!document.querySelector('.tlwrap .diff')`, 5_000, 'file_edit diff 视图展开');
  await sendPrompt('__fail__ 429');
  await waitFor(`(() => {
    const n = document.querySelector('.eventnote.tone-err .eshort');
    return !!n && n.textContent.includes('请求过频或额度不足');
  })()`, 20_000, '会话 A error 条');
  // 场景就绪断言：markdown + diff ToolLine + 权限卡（全局 pendingPerms，申报②）+ error 条（逐项诊断）
  const sceneDiag = await evaluate(`(() => ({
    md: !!document.querySelector('.md h2.md-h2'),
    diff: !!document.querySelector('.tlwrap .diff'),
    perm: !!document.querySelector('.perm'),
    err: !!document.querySelector('.eventnote.tone-err'),
  }))()`);
  const sceneOk = sceneDiag.md && sceneDiag.diff && sceneDiag.perm && sceneDiag.err;
  console.log('场景就绪（markdown+diff+权限卡+error条）: ' + sceneOk + ' ' + JSON.stringify(sceneDiag));

  // 标题栏「视图 → 切换工作台」收起右栏拍主对话屏（申报③）
  async function toggleRightPanel() {
    await evaluate(`[...document.querySelectorAll('.mi')].find(x => x.textContent.trim() === '视图').click()`);
    await sleep(200);
    await evaluate(`[...document.querySelectorAll('.mpop .it')].find(x => x.textContent.includes('切换工作台')).click()`);
    await sleep(300);
  }
  async function shot(name) {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const out = join(SHOTS_DIR, name);
    writeFileSync(out, Buffer.from(s.data, 'base64'));
    return out;
  }
  const CSS_SLOTS = ['--surface-1', '--action', '--on-action', '--state-ok', '--state-warn-bg', '--fs-body'];
  async function cssSlotsOk() {
    return await evaluate(`(() => {
      const cs = getComputedStyle(document.body);
      return ${JSON.stringify(CSS_SLOTS)}.every(k => cs.getPropertyValue(k).trim() !== '');
    })()`);
  }
  const shots = [];
  const slotResults = [];
  for (const mode of ['light', 'dark', 'system']) {
    // system = 跟随系统（深色系统）：剥 data-theme + 模拟 prefers-color-scheme: dark
    if (mode === 'system') {
      await evaluate(`document.documentElement.removeAttribute('data-theme')`);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    } else {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
      await evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(mode)})`);
    }
    await sleep(500);
    slotResults.push(await cssSlotsOk());
    // 主对话屏（收起右栏）
    await toggleRightPanel();
    shots.push(await shot(`mu2b-${mode}-chat.png`));
    await toggleRightPanel();
    // 右栏进度
    await evaluate(`[...document.querySelectorAll('.wtab-main')].find(t => t.textContent.includes('进度')).click()`);
    await sleep(250);
    shots.push(await shot(`mu2b-${mode}-progress.png`));
    // 右栏产物
    await evaluate(`[...document.querySelectorAll('.wtab-main')].find(t => t.textContent.includes('产物')).click()`);
    await sleep(250);
    shots.push(await shot(`mu2b-${mode}-artifacts.png`));
    // 设置模态
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))`);
    await waitFor(`!!document.querySelector('.modal[aria-label="设置"]')`, 5_000, `${mode} 设置模态`);
    await sleep(250);
    shots.push(await shot(`mu2b-${mode}-settings.png`));
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(`!document.querySelector('.modal[aria-label="设置"]')`, 5_000, `${mode} 设置模态关`);
    // DevicesModal（设备卡来自用例 7 配对）
    await evaluate(`[...document.querySelectorAll('.lfoot .lfbtn')].find(b => b.textContent.includes('设备')).click()`);
    await waitFor(`!!document.querySelector('.modal[aria-label="设备与同步"]')`, 5_000, `${mode} DevicesModal`);
    await sleep(250);
    shots.push(await shot(`mu2b-${mode}-devices.png`));
    await evaluate(`document.querySelector('.modal[aria-label="设备与同步"] .xbtn').click()`);
    await waitFor(`!document.querySelector('.modal[aria-label="设备与同步"]')`, 5_000, `${mode} DevicesModal 关`);
    // 进度 tab 复位，下一模式版面一致
    await evaluate(`[...document.querySelectorAll('.wtab-main')].find(t => t.textContent.includes('进度')).click()`);
  }
  // 还原：清模拟媒体 + 回存储主题（用例 5 已存 dark）
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`);
  const shotsOk = shots.length === 15 && shots.every(s => existsSync(s));
  const noConsoleErr = consoleErrors.length === 0;
  const slotsOk = slotResults.every(Boolean);
  record('8. 三模式全量截图 15 张 + console error 清零 + CSS 槽位',
    shotsOk && sceneOk === true && noConsoleErr && slotsOk,
    `截图=${shots.length}/15 场景五元素=${sceneOk} console error=${consoleErrors.length} 条 CSS 槽位三模式=${slotResults.join('/')}`
      + (noConsoleErr ? '' : ` [${consoleErrors.slice(0, 3).join(' | ')}]`));
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
