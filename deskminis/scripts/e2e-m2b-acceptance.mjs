// DeskMinis M2b 端到端验收驱动（对应 docs/plans/2026-07-28-m2b-providers-modelfallback.md「M2b 完成定义」）。
// 用法：先 `npm run build`，再 `npm run e2e:m2b`。
//
// 做法：另起一个独立 minisd 子进程，指向真实数据根 %APPDATA%\DeskMinis，
// 经 WebSocket JSON-RPC 驱动 M2b 验收步骤。需要用户已通过 UI 配置好 provider。
//
// 前置条件：
//   - 至少一个 provider 已配置且密钥有效（Gemini 或 Anthropic 均可）
//   - 如测模型组降级，需至少两个 provider

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const electronBin = require('electron');

const MINISD_ENTRY = join(process.cwd(), 'out', 'main', 'minisd.js');
if (!existsSync(MINISD_ENTRY)) {
  console.error('找不到 out/main/minisd.js —— 先运行 npm run build');
  process.exit(2);
}

const DATA_ROOT = process.env.DESKMINIS_DATA_DIR ?? join(process.env.APPDATA, 'DeskMinis');
const STEP_TIMEOUT_MS = 240_000;

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
    DESKMINIS_TEST: '',
    DESKMINIS_FAKE_PROVIDER: '',
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
const waiters = [];
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
function waitBroadcast(method, pred, timeoutMs, what) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`等待超时(${timeoutMs / 1000}s): ${what}`)); }, timeoutMs);
    const w = { method, pred, resolve: res, timer };
    waiters.push(w);
  });
}

/** 发一条 prompt 并收集到终态（turnEnd / error）。返回 {text, toolStarts, toolEnds, fallbacks, error}。 */
async function runPrompt(sessionId, text, opts = {}) {
  const out = { text: '', toolStarts: [], toolEnds: [], fallbacks: [], error: undefined };
  const terminal = waitBroadcast('chat.event',
    p => p.sessionId === sessionId && (p.event.kind === 'turnEnd' || p.event.kind === 'error'),
    STEP_TIMEOUT_MS, `prompt 终态: ${text.slice(0, 30)}`);
  const collector = data => {
    const msg = JSON.parse(String(data));
    if (msg.method !== 'chat.event' || msg.params.sessionId !== sessionId) return;
    const ev = msg.params.event;
    if (ev.kind === 'textDelta') out.text += ev.text;
    else if (ev.kind === 'toolStart') { out.toolStarts.push(ev); console.log(`  → 工具调用: ${ev.name}「${ev.title}」`); }
    else if (ev.kind === 'toolEnd') { out.toolEnds.push(ev); console.log(`  → 工具结束: ${ev.success ? '成功' : '失败'} ${ev.output.slice(0, 100).replace(/\n/g, ' ')}`); }
    else if (ev.kind === 'fallback') { out.fallbacks.push(ev); console.log(`  → 降级: ${ev.from} → ${ev.to}（${ev.reason}）`); }
  };
  ws.on('message', collector);
  try {
    await call('chat.prompt', { sessionId, text, ...opts });
    const done = await terminal;
    if (done.event.kind === 'error') out.error = done.event.message;
  } finally { ws.off('message', collector); }
  return out;
}

// ---------- 验收步骤 ----------
try {
  // 步骤 1：provider 已配置
  const providers = await call('provider.instances.list');
  if (!providers.length) throw new Error('没有已配置的 provider —— 请先在 UI 里添加');
  console.log(`provider: ${providers.map(p => `${p.name}(${p.kind}${p.hasApiKey ? '' : ',缺密钥!'})`).join(', ')}`);
  const kinds = new Set(providers.map(p => p.kind));
  record('1. provider 已配置', providers.some(p => p.hasApiKey), providers.map(p => `${p.kind}:${p.modelId}`).join(', '));

  const session = await call('chat.sessions.create', { title: 'M2b E2E 验收' });
  console.log('会话: ' + session.id);

  // 步骤 2/3：基本对话 + 工具调用（验证 provider 基本可用）
  console.log('\n— 步骤 2/3: 基本对话 + 工具调用 —');
  const r1 = await runPrompt(session.id, '在工作区创建 m2b-test.txt 写入 M2b验证通过');
  const wrote = r1.toolStarts.some(t => t.name === 'file_write');
  const filePath = join(DATA_ROOT, 'sessions', session.id, 'workspace', 'm2b-test.txt');
  const fileOk = existsSync(filePath);
  if (r1.error) record('2/3. 基本对话+工具', false, 'agent 错误: ' + r1.error);
  else record('2/3. 基本对话+工具', wrote && fileOk,
    `file_write ${wrote ? '已调用' : '未调用'}；落盘 ${fileOk ? 'OK' : '失败'}`);

  // 步骤 4：模型组创建 + 绑定
  console.log('\n— 步骤 4: 模型组创建 + 绑定 —');
  const groups = await call('modelgroup.list');
  let groupId;
  if (providers.length >= 2) {
    const g = await call('modelgroup.create', { name: 'M2b验收链', memberIds: providers.slice(0, 2).map(p => p.id) });
    groupId = g.id;
    console.log(`模型组: ${g.id}（成员: ${providers.slice(0, 2).map(p => p.name).join(' → ')}）`);
    await call('chat.sessions.setModelBinding', { sessionId: session.id, binding: `group:${groupId}` });
    const sessions = await call('chat.sessions.list');
    const updated = sessions.find(s => s.id === session.id);
    record('4. 模型组+绑定', updated?.modelBinding === `group:${groupId}`,
      `绑定=${updated?.modelBinding ?? '(空)'}`);
  } else {
    record('4. 模型组+绑定', false, '需要至少 2 个 provider 才能测试模型组');
  }

  // 步骤 5：模型组绑定下对话（验证链式解析）
  console.log('\n— 步骤 5: 模型组绑定下对话 —');
  if (groupId) {
    const r2 = await runPrompt(session.id, '你好，请简单介绍一下自己');
    if (r2.error) record('5. 模型组对话', false, 'agent 错误: ' + r2.error);
    else record('5. 模型组对话', r2.text.length > 0,
      `回复长度=${r2.text.length}；降级事件=${r2.fallbacks.length > 0 ? r2.fallbacks.map(f => `${f.from}→${f.to}`).join(', ') : '无'}`);
  } else {
    record('5. 模型组对话', false, '跳过（无模型组）');
  }

  // 步骤 6：数据落盘 + 绑定持久化
  console.log('\n— 步骤 6: 数据落盘 + 绑定持久化 —');
  const dbOk = existsSync(join(DATA_ROOT, 'minis.db'));
  const sessions = await call('chat.sessions.list');
  const finalSession = sessions.find(s => s.id === session.id);
  const bindingOk = groupId ? finalSession?.modelBinding === `group:${groupId}` : true;
  record('6. 数据落盘+绑定持久化', dbOk && bindingOk && fileOk,
    `minis.db ${dbOk ? '存在' : '缺失'}；model_binding=${finalSession?.modelBinding ?? '(空)'}；m2b-test.txt ${fileOk ? '存在' : '缺失'}`);

  console.log(`\n会话保留在数据根（id=${session.id}），用于验收第 7 步：重启应用后应在左栏看到「M2b E2E 验收」且历史完整。`);
} catch (e) {
  record('异常', false, e.message);
} finally {
  ws.close(); child.kill();
}

const failed = results.filter(r => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} 步通过 =====`);
process.exit(failed.length ? 1 : 0);
