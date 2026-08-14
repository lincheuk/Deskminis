// DeskMinis A 组修复冒烟验收（体检报告 P0 修复包 + B1 的真机行为验证）。
// 用法：node scripts/e2e-smoke-wavea.mjs（dev 实例自启自收；跑前确认 5173/9222 无残留占用）。
//
// 覆盖（CDP 驱动真实 dev 实例，假 provider 脚本化造场景，零真网）：
//   1) B1  自动命名：普通回合结束后左栏标题离开「新会话」（fire-and-forget 真路径）
//   2) A3  绑定真实项目目录后 file_write 工作区内直接放行（全程无权限卡、文件落盘）
//   3) A3  工作区之外仍弹权限卡；点「拒绝」后文件未写
//   4) A2  权限选择器切「完全访问」后同类界外写入不再询问（档位真实作用于网关）
//   5) A7  长命令执行中点「停止」：数秒内回到空闲（无 A7 时要等满 60s 超时）
//
// 与既有 e2e 的关系：mu2a/mu2b/mu6 是 UI 接线回归；本脚本专验 2026-08 修复波（A2/A3/A7/B1）
// 的行为语义。A1/A4/A5/A6 依赖真模型或大历史，行为由单测背书（agent-loop/compact/prune 等），
// 不在本脚本重复。
//
// 环境隔离：DESKMINIS_DATA_DIR=mkdtemp + DESKMINIS_TEST=1 + DESKMINIS_FAKE_PROVIDER=1 +
//   providers.json 预置 __fake__ 默认（与 mu6 同基建）。

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
const DATA_ROOT = mkdtempSync(join(tmpdir(), 'dm-e2e-smoke-'));
writeFileSync(join(DATA_ROOT, 'providers.json'), JSON.stringify({
  providers: [{ id: '__fake__', name: 'Fake', kind: 'ollama', modelId: 'fake' }],
  defaultProviderId: '__fake__',
}, null, 2));
console.log('临时数据根: ' + DATA_ROOT);

// 「真实项目目录」替身（案 2 绑定为工作区）与两个界外写盘目标（案 3 拒绝 / 案 4 放行）
const WS_DIR = mkdtempSync(join(tmpdir(), 'dm-smoke-project-'));
const OUTSIDE_DENY = join(tmpdir(), `dm-smoke-deny-${process.pid}.txt`);
const OUTSIDE_FULL = join(tmpdir(), `dm-smoke-full-${process.pid}.txt`);

// ---------- 启动 dev 实例 ----------
const ELECTRON_VITE_BIN = join(process.cwd(), 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
if (!existsSync(ELECTRON_VITE_BIN)) { console.error('找不到 node_modules/electron-vite —— 先 npm install'); process.exit(2); }

const child = spawn(process.execPath, [ELECTRON_VITE_BIN, 'dev', '--', '--remote-debugging-port=9222'], {
  cwd: process.cwd(),
  env: { ...process.env, DESKMINIS_DATA_DIR: DATA_ROOT, DESKMINIS_TEST: '1', DESKMINIS_FAKE_PROVIDER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', d => process.stderr.write('[dev] ' + d));
child.stderr.on('data', d => process.stderr.write('[dev] ' + d));

// ---------- CDP 客户端（与 mu6 同实现） ----------
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
/** FakeProvider.parseScript 取历史首条 __tool__：每个 __tool__ 用例开新会话隔离（mu2a 技法②）。 */
async function newSession() {
  await evaluate(`document.querySelector('.newbtn').click()`);
  await waitFor(`document.querySelectorAll('.ublock').length === 0 && document.querySelectorAll('.msg-a').length === 0 && !document.querySelector('.perm')`, 10_000, '新会话就绪');
}
const toolScript = (name, input) => `__tool__ ${name} ${JSON.stringify(input)}`;
/** 等待磁盘条件成立（放行类断言以真实落盘为准，不猜 UI 时序）。 */
async function waitDisk(cond, timeoutMs, label) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时(${Math.round(timeoutMs / 1000)}s): ${label}`);
    await sleep(150);
  }
}

const SHOTS_DIR = join(process.cwd(), 'scripts', 'e2e-shots-smoke');
mkdirSync(SHOTS_DIR, { recursive: true });
async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const out = join(SHOTS_DIR, name);
  writeFileSync(out, Buffer.from(r.data, 'base64'));
  return out;
}
const consoleErrors = [];

try {
  // —— CDP 连接（与 mu6 同技法） ——
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
      consoleErrors.push((m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description ?? '')).slice(0, 200));
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await waitFor(`!!document.querySelector('textarea.field')`, 60_000, '初始挂载');

  // ===== 案 1：B1 自动命名 —— 普通回合后左栏标题离开「新会话」 =====
  {
    await newSession();
    const a0 = 0;
    await sendPrompt('帮我看看这个项目的结构');
    await waitFor(`document.querySelectorAll('.msg-a').length > ${a0}`, 20_000, '回合落地');
    // 自动命名是 fire-and-forget：等广播驱动左栏刷新（假 provider 回复「（假回复）」会成为标题）
    const title = await waitFor(`(() => {
      const t = document.querySelector('.scard.on .stitle')?.textContent?.trim();
      return (t && t !== '新会话') ? t : false;
    })()`, 15_000, '标题离开「新会话」');
    record('1. B1 自动命名', true, `左栏标题=「${title}」（fire-and-forget 真路径 + sessions.changed 广播刷新）`);
    await shot('smoke-1-autotitle.png');
  }

  // ===== 案 2：A3 绑定真实项目目录 → 工作区内 file_write 直接放行 =====
  {
    await newSession();
    // 经真实 UI 设工作区：wsbtn 开面板 → 粘路径 → 应用
    await evaluate(`document.querySelector('.wsbtn').click()`);
    await waitFor(`!!document.querySelector('.wsinput')`, 5_000, '工作区面板');
    await evaluate(`(() => {
      const ip = document.querySelector('.wsinput');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(ip, ${JSON.stringify(WS_DIR)});
      ip.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await evaluate(`document.querySelector('.wsbtn-apply').click()`);
    // 应用成功后 wspanel 自动关闭（applyWs 置 wsOpen=false），.wspath 随之消失——
    // 以「面板关闭 + chip 显示目录名」为设置成功的判据
    await waitFor(`!document.querySelector('.wspanel') && (document.querySelector('.wsbtn')?.textContent ?? '').includes(${JSON.stringify(WS_DIR.split('\\').pop())})`, 8_000, '工作区已设置（面板关闭+chip 换名）');
    const target = join(WS_DIR, 'smoke-inside.txt');
    await sendPrompt(toolScript('file_write', { path: target, content: 'A3 放行', tool_title: '写工作区内文件' }));
    await waitDisk(() => existsSync(target), 15_000, '工作区内文件落盘');
    const permCount = await evaluate(`document.querySelectorAll('.perm').length`);
    record('2. A3 工作区放行', permCount === 0, `绑定 ${WS_DIR} 后写入直接落盘=${existsSync(target)}，权限卡=${permCount}（应 0）`);
  }

  // ===== 案 3：A3 工作区之外仍弹卡；拒绝后不落盘 =====
  {
    await newSession();
    await sendPrompt(toolScript('file_write', { path: OUTSIDE_DENY, content: '不该出现', tool_title: '写界外文件' }));
    await waitFor(`!!document.querySelector('.perm')`, 15_000, '界外写权限卡');
    await shot('smoke-3-perm-card.png');
    await evaluate(`[...document.querySelectorAll('.perm .btn')].find(b => b.textContent.includes('拒绝'))?.click()`);
    await waitFor(`!document.querySelector('.perm')`, 10_000, '权限卡关闭');
    await sleep(600); // 给拒绝结果一个落库广播窗口
    record('3. A3 界外仍询问', !existsSync(OUTSIDE_DENY), `权限卡出现=true，拒绝后文件未写=${!existsSync(OUTSIDE_DENY)}`);
  }

  // ===== 案 4：A2 完全访问 —— 同类界外写入不再询问 =====
  {
    // 经真实 UI 切档：权限胶囊 → 完全访问（第三行）。
    // 注意 .cpill 是通用胶囊类（工作区 chip / 模型胶囊同款），必须按当前档位文案定位权限胶囊
    const PERM_PILL = `[...document.querySelectorAll('.cpill')].find(p => /每次确认|本会话沿用|完全访问/.test(p.textContent))`;
    await evaluate(`${PERM_PILL}.click()`);
    await waitFor(`document.querySelectorAll('.mrow').length >= 3`, 5_000, '权限档菜单');
    await evaluate(`[...document.querySelectorAll('.mrow')].find(r => r.textContent.includes('完全访问'))?.click()`);
    await waitFor(`(${PERM_PILL})?.textContent?.includes('完全访问')`, 8_000, '档位切换生效（RPC 往返）');
    await newSession();
    await sendPrompt(toolScript('file_write', { path: OUTSIDE_FULL, content: 'A2 放行', tool_title: '完全访问写入' }));
    await waitDisk(() => existsSync(OUTSIDE_FULL), 15_000, '完全访问下界外落盘');
    const permCount = await evaluate(`document.querySelectorAll('.perm').length`);
    await shot('smoke-4-full-access.png');
    // 恢复默认档，不给后续用例留状态
    await evaluate(`${PERM_PILL}.click()`);
    await waitFor(`document.querySelectorAll('.mrow').length >= 3`, 5_000, '权限档菜单(还原)');
    await evaluate(`[...document.querySelectorAll('.mrow')].find(r => r.textContent.includes('每次确认'))?.click()`);
    await waitFor(`(${PERM_PILL})?.textContent?.includes('每次确认')`, 8_000, '档位还原');
    record('4. A2 完全访问真实生效', permCount === 0, `切档后界外写入直接落盘=${existsSync(OUTSIDE_FULL)}，权限卡=${permCount}（应 0）；已还原「每次确认」`);
  }

  // ===== 案 5：A7 停止即停 —— 60s 长命令数秒内被掐断 =====
  {
    await newSession();
    await sendPrompt(toolScript('shell_execute', { command: 'Start-Sleep -Seconds 60', tool_title: '长睡眠命令' }));
    await waitFor(`!!document.querySelector('.perm')`, 15_000, 'shell 权限卡');
    await evaluate(`[...document.querySelectorAll('.perm .btn')].find(b => b.textContent.includes('允许') && !b.textContent.includes('本会话'))?.click()`);
    // 等命令真的跑起来（工具行出现旋转圈）
    await waitFor(`!!document.querySelector('.tline .spin')`, 15_000, '工具行执行中');
    await shot('smoke-5-running.png');
    const t0 = Date.now();
    await evaluate(`document.querySelector('button.send.stop').click()`);
    // A7 之前：要等满 60s 超时才回空闲。A7 之后：interrupt 杀驱动，数秒内回合终结。
    await waitFor(`!!document.querySelector('button.send:not(.stop)')`, 12_000, '停止后回到空闲');
    const elapsed = Date.now() - t0;
    record('5. A7 停止即停', elapsed < 10_000, `点停止 → ${elapsed}ms 回到空闲（无 A7 需 60s+ 超时）`);
    await shot('smoke-5-stopped.png');
  }

  const errPass = consoleErrors.length === 0;
  record('6. 全程 console error 清零', errPass, errPass ? '0 条' : `${consoleErrors.length} 条：${consoleErrors.slice(0, 3).join(' | ')}`);
} catch (e) {
  record('中断', false, String(e?.stack ?? e).slice(0, 500));
} finally {
  cdp?.close();
  if (child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(800);
  for (const p of [OUTSIDE_DENY, OUTSIDE_FULL]) { try { rmSync(p, { force: true }); } catch { /* 尽力 */ } }
  try { rmSync(DATA_ROOT, { recursive: true, force: true }); } catch { /* 占用时留给系统临时目录清理 */ }
  try { rmSync(WS_DIR, { recursive: true, force: true }); } catch { /* 同上 */ }
  console.log('dev 进程树已回收');
}

const failed = results.filter(r => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} 步通过 =====`);
process.exit(failed.length === 0 ? 0 : 1);
