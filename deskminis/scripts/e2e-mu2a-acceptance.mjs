// DeskMinis MU2a 端到端验收驱动（docs/plans/2026-07-31-mu2-ui-implementation.md Task 11 · 决策 8）。
// 用法：node scripts/e2e-mu2a-acceptance.mjs（dev 实例自启自收，无需先 build；跑前确认 5173/9222 无残留占用）。
//
// 覆盖（CDP 驱动真实 dev 实例 DOM 断言，假 provider 脚本化造场景，零真网）：
//   1) 渲染进程就绪，无 console error（Runtime 域事件采集：consoleAPICalled(type=error) + exceptionThrown）
//   2) 假 provider 回合：助手 Markdown 渲染——DOM 存在 h2 / code 围栏语言槽 / 列表元素
//   3) __tool__ file_write（数据根外路径）→ 权限卡出现 + 倒计时文本；DOM 点「允许」→ 卡消失、ToolLine 出现（文件真落盘）
//   4) 桥命令卡（__tool__ shell_execute 带 windows-notify show）→ 双段告知块文本；「本会话允许」→ 二次同命令不再弹卡
//   5) __fail__ 429 → EventNote error 条含「请求过频或额度不足」与重试钮；点重试 → 用户消息重发、回合重跑再到终态
//   6) 上翻解除跟随 → 新 delta 后 scrollTop 未被拽回底部；点「回到底部」→ 恢复贴底
//   7) 三模式截图各一（data-theme 切换 + Page.captureScreenshot → scripts/e2e-shots-mu2a/）
//
// 9222 透传（实现期第一验证点 · 案 A 落地）：electron-vite dev -- --remote-debugging-port=9222，
//   cli.js options['--'] → ELECTRON_CLI_ARGS → startElectron 追加 electron 启动参数（dist 源码已实证）。
//   60s 轮询 http://127.0.0.1:9222/json 不通即失败并打印排查指引。
//   （计划回退方案：electron-vite build + spawn electron out/main/index.js --remote-debugging-port=9222——案 A 实证可用，未启用）
//
// 环境隔离：DESKMINIS_DATA_DIR=mkdtemp 临时目录（管道名含数据根哈希，不撞运行中的应用）
//   + DESKMINIS_TEST=1（内存 vault）+ DESKMINIS_FAKE_PROVIDER=1（__tool__/__fail__ 脚本化）
//   + DESKMINIS_FAKE_REPLY（Task 11 计划内红线例外 env 钩子：用例 2 的 markdown DOM 断言数据源）
//   + providers.json 预置 __fake__ 实例并设为默认（chat.prompt 默认 provider 路径命中 FakeProvider，零真网）。
// 收尾：taskkill /pid /T /F 杀进程树，临时数据根与写盘目标文件删除；脚本退出码非零即失败。
//
// 计划内修正/偏差申报（两条，commit message 同步申报）：
//   ① 用例 5「点重试 → 回合成功」机械上不可成立：FakeProvider.parseFail 扫描全量历史，__fail__ 消息
//     落库后该会话每次请求都抛 429（每次 prompt 新建 FakeProvider 实例，一次性标志无法跨实例携带；
//     修 FakeProvider 属 minisd 白名单外改动，决策 4d 红线禁止）。改为断言重试全链路机械可达：
//     点击重试 → 用户消息重发（.ublock +1）→ 回合重跑 → 再次到达 error 终态。错误条文案与重试钮断言不变。
//   ② 用例 6 顺序与触发方式微调：滚动用例先于 __fail__ 用例执行（毒化会话无法再产出新 delta）；
//     假 provider 流式窗口 ~30ms，「流式期间上翻」无法稳定复现，等价化为「先上翻解除跟随 → 再发新消息
//     产生新 delta → 断言不拽回」——shouldFollow 解除态 + 新内容到达两条语义均覆盖。

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

// ---------- 临时数据根 + 预置假 provider（默认即 __fake__，chat.prompt 默认路径命中 FakeProvider） ----------
const DATA_ROOT = mkdtempSync(join(tmpdir(), 'dm-e2e-mu2a-'));
writeFileSync(join(DATA_ROOT, 'providers.json'), JSON.stringify({
  providers: [{ id: '__fake__', name: 'Fake', kind: 'ollama', modelId: 'fake' }],
  defaultProviderId: '__fake__',
}, null, 2));
console.log('临时数据根: ' + DATA_ROOT);

// 用例 3 的写盘目标（数据根外 → 触发 file-write 权限卡；用完即删）
const WRITE_TARGET = join(tmpdir(), `dm-mu2a-e2e-write-${process.pid}.txt`);

// 用例 2 的 markdown 样本（<200 字，含 h2/围栏语言槽/列表；经 env 钩子注入假回复）
const MD_SAMPLE = [
  '## MU2A 验收标题', '',
  '第一段正文。', '',
  '- 列表甲', '- 列表乙', '',
  '```js', "console.log('mu2a')", '```',
].join('\n');

// 用例 4 的桥命令（detectBridgeTriggers 命中 windows-notify|show → bridge-notify；classifyShellCommand → gated）
const BRIDGE_CMD = '& "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" windows-notify show --title "MU2A" --body "e2e 验收"';

// ---------- 启动 dev 实例（案 A：-- 透传 9222） ----------
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

// ---------- CDP 客户端（cdp-eval.mjs / cdp-shot.mjs 模式内联化） ----------
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

let cdp; // 连接后赋值
/** 渲染进程求值（瞬态异常按未命中处理，由 waitFor 重试）。 */
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
/** 填充输入框并点击发送（Vue v-model 需原生 setter + input 事件）。 */
async function sendPrompt(text) {
  await evaluate(`(() => {
    const ta = document.querySelector('textarea.field');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitFor(`(() => { const b = document.querySelector('button.send:not(.stop)'); return !!b && !b.disabled; })()`, 10000, '发送钮可用');
  await evaluate(`document.querySelector('button.send:not(.stop)').click()`);
}
const count = sel => evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
/** FakeProvider.parseScript 取历史中首条 __tool__ 消息：每个 __tool__ 用例必须开新会话隔离，否则重放上一用例的工具。 */
async function newSession() {
  await evaluate(`document.querySelector('.newbtn').click()`);
  await waitFor(`document.querySelectorAll('.ublock').length === 0 && document.querySelectorAll('.msg-a').length === 0 && !document.querySelector('.perm')`, 10_000, '新会话就绪');
}
/** 等一个回合落地：历史重载后助手消息数 +1（turnEnd → open() 重取消息的确定信号）。 */
async function waitTurnSettled(a0, timeoutMs, label) {
  await waitFor(`document.querySelectorAll('.msg-a').length > ${a0}`, timeoutMs, label ?? '回合落地（.msg-a +1）');
}

// ---------- 主流程 ----------
const SHOTS_DIR = join(process.cwd(), 'scripts', 'e2e-shots-mu2a');
try {
  // —— 9222 透传验证点（60s 轮询；不通打印排查指引） ——
  console.log('等待 CDP 9222（electron-vite -- 透传验证点，60s 超时）…');
  let targets;
  {
    const t0 = Date.now();
    for (;;) {
      try { targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json()); break; } catch { /* 未就绪 */ }
      if (Date.now() - t0 > 60_000) {
        throw new Error('9222 不透（60s）。排查：① netstat -ano | findstr :9222 / :5173 有残留进程则 taskkill；'
          + '② electron-vite 4 -- 透传失效则回退方案 = electron-vite build + spawn electron out/main/index.js --remote-debugging-port=9222（计划决策 8 案 B）');
      }
      await sleep(500);
    }
  }
  console.log('CDP 9222 已通（案 A：dev + -- 透传实证可用）');

  // 等渲染 page 出现并连接
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

  // console 错误采集（先于 reload 挂监听，保证从页面诞生起全覆盖）
  const consoleErrors = [];
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
  // 先等初始挂载再 reload：loadURL 在飞时 reload 会把首个导航打成 ERR_ABORTED，主进程按启动失败退出（实证）
  await waitFor(`!!document.querySelector('textarea.field')`, 60_000, '初始挂载（textarea.field 出现）');
  await cdp.send('Page.reload', { ignoreCache: true }); // reload 后采集从干净页面重新开始
  consoleErrors.length = 0;
  await sleep(500); // 让旧文档先 teardown，避免下一条 waitFor 命中将死的旧上下文

  // —— 用例 1：渲染进程就绪，无 console error ——
  await waitFor(`!!document.querySelector('textarea.field')`, 60_000, 'reload 后应用挂载（textarea.field 出现）');
  await sleep(1500); // 给迟到的异步错误一个冒泡窗口
  record('1. 渲染进程就绪无 console error', consoleErrors.length === 0,
    consoleErrors.length === 0 ? '应用挂载完成，0 条 console error/异常' : `采到 ${consoleErrors.length} 条: ${consoleErrors.join(' | ')}`);

  // —— 用例 2：假 provider 回合 → 助手 Markdown 渲染 ——
  await sendPrompt('markdown 验收');
  await waitFor(`!!document.querySelector('.md h2.md-h2')`, 20_000, 'h2 渲染');
  const mdOk = await evaluate(`(() => {
    const h2 = document.querySelector('.md h2.md-h2');
    const lang = document.querySelector('.md-code .md-codebar .md-lang');
    const lis = document.querySelectorAll('.md .md-li');
    return !!h2 && h2.textContent.includes('MU2A 验收标题')
        && !!lang && lang.textContent.trim() === 'js'
        && lis.length >= 2;
  })()`);
  record('2. 助手 Markdown 渲染（h2/围栏语言槽/列表）', mdOk === true,
    mdOk === true ? 'h2「MU2A 验收标题」+ 语言槽 js + 列表项 ≥2 全部命中' : 'DOM 断言未命中（见上方 evaluate 细节）');

  // —— 用例 3：__tool__ file_write（数据根外）→ 权限卡 + 倒计时；点「允许」→ 卡消失 + ToolLine ——
  const writeInput = JSON.stringify({ path: WRITE_TARGET, content: 'mu2a-e2e 写入验收', tool_title: '写入验收文件' });
  await sendPrompt(`__tool__ file_write ${writeInput}`);
  await waitFor(`!!document.querySelector('.perm')`, 20_000, '权限卡出现');
  const cardOk = await evaluate(`(() => {
    const cd = document.querySelector('.perm .countdown');
    const title = document.querySelector('.perm .title');
    return !!cd && /^\\d{1,2}s$/.test(cd.textContent.trim()) && !!title && title.textContent.includes('请求写入文件');
  })()`);
  await evaluate(`document.querySelector('.perm .btn.primary').click()`); // 允许
  await waitFor(`!document.querySelector('.perm') && !!document.querySelector('.tline')`, 20_000, '卡消失 + ToolLine 出现');
  const fileLanded = existsSync(WRITE_TARGET);
  record('3. file_write 权限卡（倒计时）→ 允许 → ToolLine', cardOk === true && fileLanded,
    `倒计时/标题断言=${cardOk} 文件落盘=${fileLanded}（${WRITE_TARGET}）`);

  // —— 用例 4：桥命令卡（双段告知）→ 本会话允许 → 二次同命令不再弹卡 ——
  await newSession(); // 隔离用例 3 的 __tool__ 历史（parseScript 首条命中语义）
  const bridgeInput = JSON.stringify({ command: BRIDGE_CMD, tool_title: '桥通知验收', timeout_seconds: 60 });
  const t0lines = await count('.tline');
  await sendPrompt(`__tool__ shell_execute ${bridgeInput}`);
  await waitFor(`!!document.querySelector('.perm .triggers')`, 20_000, '桥命令卡双段告知块');
  const trigOk = await evaluate(`(() => {
    const tk = document.querySelector('.perm .triggers .tk');
    const tvs = [...document.querySelectorAll('.perm .triggers .tv')].map(x => x.textContent);
    return !!tk && tk.textContent.includes('此命令将触发') && tvs.some(t => t.includes('通知权限'));
  })()`);
  await evaluate(`[...document.querySelectorAll('.perm .btn')].find(b => b.textContent.includes('本会话允许')).click()`);
  // 首次桥命令执行完（长驻 PowerShell 冷启动 + node stub 可能耗时，给 60s）
  await waitFor(`document.querySelectorAll('.tline').length > ${t0lines} && !document.querySelector('.tline .spin') && !document.querySelector('.perm')`, 60_000, '首次桥命令落地');
  // 二次同命令（字节一致 → shell 精确授权命中；桥 kind 会话级授权 → 双侧都不弹卡）
  let sawPerm2 = false;
  {
    const t1lines = await count('.tline');
    await sendPrompt(`__tool__ shell_execute ${bridgeInput}`);
    const t0 = Date.now();
    for (;;) {
      if (await count('.perm') > 0) sawPerm2 = true;
      const done = await evaluate(`document.querySelectorAll('.tline').length > ${t1lines} && !document.querySelector('.tline .spin')`).catch(() => false);
      if (done) break;
      if (Date.now() - t0 > 60_000) throw new Error('等待超时(60s): 二次桥命令落地');
      await sleep(150);
    }
    sawPerm2 = sawPerm2 || (await count('.perm')) > 0;
  }
  record('4. 桥双段告知 + 本会话允许后二次不弹卡', trigOk === true && !sawPerm2,
    `双段告知断言=${trigOk} 二次弹卡=${sawPerm2}（应 false）`);

  // —— 用例 6（先于用例 5 执行：__fail__ 会毒化会话，见文首申报②）：上翻解除跟随 → 新 delta 不拽回 → 回到底部恢复 ——
  // 先确保内容可滚（不足则发填充消息；假回复 markdown 每条 ~10 行）
  for (let i = 0; i < 4; i++) {
    const scrollable = await evaluate(`(() => { const s = document.querySelector('.stream'); return s.scrollHeight > s.clientHeight + 120; })()`);
    if (scrollable) break;
    const a0 = await count('.msg-a');
    await sendPrompt(`滚动填充 ${i + 1}`);
    await waitTurnSettled(a0, 20_000, '填充回合落地');
  }
  const canScroll = await evaluate(`(() => { const s = document.querySelector('.stream'); return s.scrollHeight > s.clientHeight + 120; })()`);
  let scrollOk = false;
  let scrollDetail = '内容不足不可滚';
  if (canScroll) {
    await evaluate(`(() => { const s = document.querySelector('.stream'); s.scrollTop = 0; s.dispatchEvent(new Event('scroll')); })()`);
    await waitFor(`!!document.querySelector('.back-bottom')`, 10_000, '解除跟随 → 回到底部浮钮出现');
    const a0 = await count('.msg-a');
    await sendPrompt('滚动验收：新 delta 不应拽回底部');
    await waitTurnSettled(a0, 20_000, '滚动验收回合落地');
    const notDragged = await evaluate(`(() => { const s = document.querySelector('.stream'); return (s.scrollHeight - s.scrollTop - s.clientHeight) > 40 && !!document.querySelector('.back-bottom'); })()`);
    await evaluate(`document.querySelector('.back-bottom').click()`);
    await waitFor(`(() => { const s = document.querySelector('.stream'); return (s.scrollHeight - s.scrollTop - s.clientHeight) <= 2; })()`, 10_000, '回到底部恢复贴底');
    scrollOk = notDragged === true;
    scrollDetail = `新 delta 后未拽回=${notDragged}，点浮钮已恢复贴底`;
  }
  record('6. 上翻解除跟随 + 新 delta 不拽回 + 回到底部恢复', canScroll === true && scrollOk, scrollDetail);

  // —— 用例 5：__fail__ 429 → EventNote error + 重试钮；点重试 → 回合重跑再到终态（申报①） ——
  await sendPrompt('__fail__ 429');
  await waitFor(`(() => {
    const n = document.querySelector('.eventnote.tone-err .eshort');
    return !!n && n.textContent.includes('请求过频或额度不足') && !!document.querySelector('.eventnote .eretry');
  })()`, 20_000, 'error 条（请求过频或额度不足 + 重试钮）');
  const u0 = await count('.ublock');
  await evaluate(`document.querySelector('.eventnote .eretry').click()`);
  await waitFor(`document.querySelectorAll('.ublock').length > ${u0} && !!document.querySelector('.eventnote.tone-err')`, 20_000, '重试重发 + 回合重跑再到终态');
  record('5. 429 error 条 + 重试钮 + 点重试回合重跑', true,
    'error 条含「请求过频或额度不足」与重试钮；点重试 → 用户消息重发（.ublock +1）→ 回合重跑再到 error 终态（申报①：__fail__ 毒化会话，「回合成功」机械不可达，改为断言重试全链路）');

  // —— 用例 7：三模式截图各一 ——
  mkdirSync(SHOTS_DIR, { recursive: true });
  const origTheme = await evaluate(`document.documentElement.getAttribute('data-theme')`);
  const shots = [];
  for (const mode of ['system', 'light', 'dark']) {
    await evaluate(`(() => {
      const el = document.documentElement;
      if (${JSON.stringify(mode)} === 'system') el.removeAttribute('data-theme'); else el.setAttribute('data-theme', ${JSON.stringify(mode)});
    })()`);
    await sleep(500); // 等令牌层与材质重算
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const out = join(SHOTS_DIR, `mu2a-${mode}.png`);
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    shots.push(out);
  }
  await evaluate(`(() => {
    const el = document.documentElement;
    const orig = ${JSON.stringify(origTheme)};
    if (orig === null) el.removeAttribute('data-theme'); else el.setAttribute('data-theme', orig);
  })()`);
  record('7. 三模式截图', shots.every(s => existsSync(s)), shots.map(s => s.replace(/^.*[\\/]/, '')).join(' / '));
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
  try { rmSync(WRITE_TARGET, { force: true }); } catch { /* 尽力 */ }
}

const failed = results.filter(r => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} 步通过 =====`);
process.exit(failed.length ? 1 : 0);
