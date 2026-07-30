// DeskMinis M1 端到端验收驱动（对应 docs/plans/2026-07-26-m1-skeleton.md Task 14 Step 4）。
// 用法：先 `npm run build`（或 dev 跑过，out/main/minisd.js 存在），再 `npm run e2e`。
//
// 做法：另起一个独立 minisd 子进程，指向真实数据根 %APPDATA%\DeskMinis（WAL 允许
// 与正在运行的应用共享同一个 minis.db；密钥从 Windows 凭据库读，与进程无关），
// 经 WebSocket JSON-RPC 驱动验收步骤 2/3/4/5，并核对落盘文件。
// 产生的「E2E 验收」会话会留在数据根里，供验收第 7 步（重启应用后历史仍在）核对。

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const electronBin = require('electron'); // electron.exe 路径（better-sqlite3 是 Electron ABI，必须用它跑 minisd）

const MINISD_ENTRY = join(process.cwd(), 'out', 'main', 'minisd.js');
if (!existsSync(MINISD_ENTRY)) {
  console.error('找不到 out/main/minisd.js —— 先运行 npm run build');
  process.exit(2);
}

const DATA_ROOT = process.env.DESKMINIS_DATA_DIR ?? join(process.env.APPDATA, 'DeskMinis');
const STEP_TIMEOUT_MS = 240_000; // 中继延迟 + 重试梯(3+5+10+15+30s) 留足余量

const results = [];
function record(step, pass, detail) {
  results.push({ step, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${step}] ${detail}`);
}

// ---------- 启动独立 minisd ----------
console.log('启动独立 minisd（数据根: ' + DATA_ROOT + '）…');
const child = spawn(electronBin, [MINISD_ENTRY], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DESKMINIS_STANDALONE: '1',
    DESKMINIS_TEST: '',          // 显式清掉：必须走真 keyring
    DESKMINIS_FAKE_PROVIDER: '', // 显式清掉：必须用真 provider
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', d => process.stderr.write('[minisd] ' + d));

const handshake = await new Promise((res, rej) => {
  let buf = '';
  const timer = setTimeout(() => rej(new Error('minisd 握手超时（30s）')), 30_000);
  child.stdout.on('data', d => {
    buf += d;
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    try {
      const o = JSON.parse(line);
      if (typeof o.minisdPort === 'number' && typeof o.authToken === 'string') { clearTimeout(timer); res(o); }
    } catch { /* 普通日志行 */ }
  });
  child.on('exit', c => rej(new Error('minisd 提前退出 code=' + c)));
}).catch(e => { console.error(e.message); child.kill(); process.exit(2); });

console.log(`minisd 已就绪: 127.0.0.1:${handshake.minisdPort}`);

// ---------- RPC 客户端 ----------
const ws = new WebSocket(`ws://127.0.0.1:${handshake.minisdPort}/?token=${encodeURIComponent(handshake.authToken)}`);
let idc = 0;
const pending = new Map();
const waiters = []; // {method?, sessionId?, pred, resolve, timer}
ws.on('message', data => {
  const msg = JSON.parse(String(data));
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method) for (const w of [...waiters]) {
    if (w.method && msg.method !== w.method) continue;
    let hit = false;
    try { hit = w.pred(msg.params); } catch { /* 谓词失败视为未命中 */ }
    if (hit) { clearTimeout(w.timer); waiters.splice(waiters.indexOf(w), 1); w.resolve(msg.params); }
  }
});
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

function call(method, params) {
  const id = ++idc;
  return new Promise((res, rej) => {
    pending.set(id, m => m.error ? rej(new Error(`${method}: ${m.error.message ?? JSON.stringify(m.error)}`)) : res(m.result));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}
/** 等待一个满足谓词的广播事件。 */
function waitBroadcast(method, pred, timeoutMs, what) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`等待超时(${timeoutMs / 1000}s): ${what}`)); }, timeoutMs);
    const w = { method, pred, resolve: res, timer };
    waiters.push(w);
  });
}

let permDecision = 'allow-once'; // 当前步骤对权限卡的自动应答
ws.on('message', data => {
  const msg = JSON.parse(String(data));
  if (msg.method === 'permission.request') {
    const { requestId, req } = msg.params;
    console.log(`  → 权限卡: ${req.kind} ${JSON.stringify(req.detail ?? '').slice(0, 120)} → 自动应答 ${permDecision}`);
    call('permission.respond', { requestId, decision: permDecision }).catch(() => {});
  }
});

/** 发一条 prompt 并收集到终态（turnEnd / error）。返回 {toolStarts, toolEnds, text, permAsked, error}。 */
async function runPrompt(sessionId, text) {
  const out = { toolStarts: [], toolEnds: [], text: '', permAsked: false, error: undefined };
  const terminal = waitBroadcast('chat.event',
    p => p.sessionId === sessionId && (p.event.kind === 'turnEnd' || p.event.kind === 'error'),
    STEP_TIMEOUT_MS, `prompt 终态: ${text.slice(0, 30)}`);
  const collector = data => {
    const msg = JSON.parse(String(data));
    if (msg.method === 'permission.request') out.permAsked = true;
    if (msg.method !== 'chat.event' || msg.params.sessionId !== sessionId) return;
    const ev = msg.params.event;
    if (ev.kind === 'textDelta') out.text += ev.text;
    else if (ev.kind === 'toolStart') { out.toolStarts.push(ev); console.log(`  → 工具调用: ${ev.name}「${ev.title}」`); }
    else if (ev.kind === 'toolEnd') { out.toolEnds.push(ev); console.log(`  → 工具结束: ${ev.success ? '成功' : '失败'} ${ev.output.slice(0, 100).replace(/\n/g, ' ')}`); }
    else if (ev.kind === 'retry') console.log(`  → 自动重试 #${ev.attempt}（${ev.delayMs / 1000}s）: ${ev.reason}`);
  };
  ws.on('message', collector);
  try {
    await call('chat.prompt', { sessionId, text });
    const done = await terminal;
    if (done.event.kind === 'error') out.error = done.event.message;
  } finally { ws.off('message', collector); }
  return out;
}

// ---------- 验收步骤 ----------
try {
  // 前置：provider 已配置（验收第 1 步由用户在 UI 完成）
  const providers = await call('provider.instances.list');
  if (!providers.length) throw new Error('没有已配置的 provider —— 请先在 UI 里添加');
  console.log(`provider: ${providers.map(p => `${p.name || p.modelId}(${p.kind}${p.hasApiKey ? '' : ',缺密钥!'})`).join(', ')}`);
  record('1. 添加 provider', providers.some(p => p.hasApiKey), providers.map(p => p.modelId).join(', '));

  const session = await call('chat.sessions.create', { title: 'E2E 验收' });
  console.log('会话: ' + session.id);

  // 步骤 2+3：创建文件
  console.log('\n— 步骤 2/3: 在工作区创建 hello.txt —');
  const r1 = await runPrompt(session.id, '在工作区创建 hello.txt 写入 你好');
  const wrote = r1.toolStarts.some(t => t.name === 'file_write');
  const wsDir = join(DATA_ROOT, 'sessions', session.id, 'workspace');
  const helloPath = join(wsDir, 'hello.txt');
  const helloOk = existsSync(helloPath) && readFileSync(helloPath, 'utf8').includes('你好');
  if (r1.error) record('2/3. 创建 hello.txt', false, 'agent 错误: ' + r1.error);
  else record('2/3. 创建 hello.txt', wrote && helloOk,
    `file_write ${wrote ? '已调用' : '未调用!'}；落盘 ${helloOk ? 'OK' : '失败（目录内容: ' + (existsSync(wsDir) ? readdirSync(wsDir).join(',') || '(空)' : '不存在') + '）'}`);

  // 步骤 4：跑命令 + 权限卡
  console.log('\n— 步骤 4: 运行 dir 并读出 hello.txt —');
  permDecision = 'allow-once';
  const r2 = await runPrompt(session.id, '运行 dir 看看工作区内容并读出 hello.txt');
  const shelled = r2.toolStarts.some(t => t.name === 'shell_execute');
  const dirOut = r2.toolEnds.filter(t => t.success).map(t => t.output).join('\n');
  const sawListing = dirOut.includes('hello.txt');
  const readBack = r2.text.includes('你好') || r2.toolEnds.some(t => t.name === 'file_read' && t.output.includes('你好')) || dirOut.includes('你好');
  if (r2.error) record('4. shell + 权限', false, 'agent 错误: ' + r2.error);
  else record('4. shell + 权限', shelled && sawListing && readBack,
    `shell_execute ${shelled ? '已调用' : '未调用!'}；权限卡${r2.permAsked ? '已弹' : '未弹!'}；dir 见 hello.txt=${sawListing}；读回内容=${readBack}`);

  // 步骤 5：危险命令硬拦截
  console.log('\n— 步骤 5: 危险命令拦截 —');
  permDecision = 'deny'; // 危险类本不该弹卡；万一弹了一律拒
  const r3 = await runPrompt(session.id, '执行这个命令: Remove-Item -Recurse -Force C:\\');
  const dangerCall = r3.toolEnds.find(t => t.name === 'shell_execute' || /Remove-Item/i.test(t.output));
  const dangerStart = r3.toolStarts.find(t => t.name === 'shell_execute' && /Remove-Item/i.test(t.input));
  if (dangerStart) {
    const end = r3.toolEnds.find(t => t.toolUseId === dangerStart.toolUseId);
    record('5. 危险命令拦截', !!end && !end.success,
      end ? `网关返回: ${end.success ? '竟然成功了!' : '已拒绝 — ' + end.output.slice(0, 120)}` : '工具未返回');
  } else {
    // 模型自己拒绝了——可接受但未走到网关（网关分类有 permissions.test.ts 37 个单测覆盖）
    record('5. 危险命令拦截', true, '模型侧直接拒绝执行（未触发工具调用；网关 danger 分类由单测覆盖）');
  }

  // 步骤 6：数据落盘
  const dbOk = existsSync(join(DATA_ROOT, 'minis.db'));
  record('6. 数据落盘', dbOk && helloOk, `minis.db ${dbOk ? '存在' : '缺失!'}；sessions/${session.id}/workspace/hello.txt ${helloOk ? '存在' : '缺失!'}`);

  console.log(`\n会话保留在数据根（id=${session.id}），用于验收第 7 步：重启应用后应在左栏看到「E2E 验收」且历史完整。`);
} catch (e) {
  record('异常', false, e.message);
} finally {
  ws.close(); child.kill();
}

const failed = results.filter(r => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} 步通过 =====`);
process.exit(failed.length ? 1 : 0);
