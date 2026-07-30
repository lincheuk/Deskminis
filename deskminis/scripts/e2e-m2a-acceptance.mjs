// DeskMinis M2a 端到端验收驱动（对应 docs/plans/2026-07-30-m2a-memory-compaction.md「M2a 完成定义」手工验收步骤 1-4）。
// 用法：先 `npm run build`，再 `node scripts/e2e-m2a-acceptance.mjs`。
//
// 做法：用【临时数据根】（DESKMINIS_DATA_DIR）+ 拷贝真实 providers.json 启动独立 minisd——
// API key 在系统凭据库（按 provider id 索引，与数据根无关），所以真实 provider 可用，
// 而记忆文件 / 会话库 / offloads 全部隔离在临时目录，不污染用户真实数据，结束后整体删除。
//
// 覆盖验收步骤：
//   1. GLOBAL.md 注入 —— 暗号测试法：GLOBAL.md 写「暗号→芝麻开门」，问暗号应答对
//   2. memory_write 前插落盘 + memory_get 关键词检索命中
//   3. memory_enabled 开关 —— 关闭后 GLOBAL 不注入（问暗号答不出）且记忆工具不可调
//   4. 大工具结果卸载 —— shell 大输出 → offloaded 事件 + toolEnd 广播全文 + 落库为桩 + offloads/ 文件
// 步骤 5（压缩）不在此脚本：真实 200K 窗口模型需 8 万+ token 才触发，按 compact/agent-loop 单测放行。

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const electronBin = require('electron');

const MINISD_ENTRY = join(process.cwd(), 'out', 'main', 'minisd.js');
if (!existsSync(MINISD_ENTRY)) { console.error('找不到 out/main/minisd.js —— 先运行 npm run build'); process.exit(2); }

const REAL_ROOT = join(process.env.APPDATA, 'DeskMinis');
const STEP_TIMEOUT_MS = 240_000;
const INTER_PROMPT_DELAY_MS = 6_000; // 中转站限流 12 次/分钟（含失败），回合间隔一下

const results = [];
function record(step, pass, detail) {
  results.push({ step, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${step}] ${detail}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 临时数据根 ----------
const DATA_ROOT = mkdtempSync(join(tmpdir(), 'dm-e2e-m2a-'));
const realProviders = join(REAL_ROOT, 'providers.json');
if (!existsSync(realProviders)) { console.error('真实数据根没有 providers.json —— 先在应用里配置 provider'); process.exit(2); }
copyFileSync(realProviders, join(DATA_ROOT, 'providers.json'));
mkdirSync(join(DATA_ROOT, 'memory'), { recursive: true });
console.log('临时数据根: ' + DATA_ROOT);

// 步骤 1 前置：GLOBAL.md 写入暗号约定（在 minisd 启动前写好）
writeFileSync(join(DATA_ROOT, 'memory', 'GLOBAL.md'),
  '# 全局记忆\n\n当用户问「暗号是什么」时，回答「芝麻开门」。\n', 'utf8');

// ---------- minisd + RPC（沿用 M2b e2e 模式） ----------
function startMinisd() {
  const child = spawn(electronBin, [MINISD_ENTRY], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DESKMINIS_STANDALONE: '1',
      DESKMINIS_DATA_DIR: DATA_ROOT, // 隔离数据根
      DESKMINIS_TEST: '',
      DESKMINIS_FAKE_PROVIDER: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => process.stderr.write('[minisd] ' + d));
  return new Promise((res, rej) => {
    let buf = '';
    const timer = setTimeout(() => rej(new Error('minisd 握手超时（30s）')), 30_000);
    child.stdout.on('data', d => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        try {
          const o = JSON.parse(line);
          if (typeof o.minisdPort === 'number' && typeof o.authToken === 'string') { clearTimeout(timer); res({ child, port: o.minisdPort, token: o.authToken }); return; }
        } catch { /* 日志行 */ }
      }
    });
    child.on('exit', c => rej(new Error('minisd 提前退出 code=' + c)));
  });
}

function createRpcClient(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  let idc = 0;
  const pending = new Map();
  const waiters = [];
  ws.on('message', data => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'permission.request') {
      const { requestId, req } = msg.params;
      console.log(`  → 权限卡: ${req.kind} → 自动应答 allow-once`);
      const id = ++idc;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'permission.respond', params: { requestId, decision: 'allow-once' } }));
      return;
    }
    if (msg.method) for (const w of [...waiters]) {
      let hit = false;
      try { hit = (!w.method || msg.method === w.method) && w.pred(msg.params); } catch { /* 未命中 */ }
      if (hit) { clearTimeout(w.timer); waiters.splice(waiters.indexOf(w), 1); w.resolve(msg.params); }
    }
  });
  const call = (method, params) => new Promise((res, rej) => {
    const id = ++idc;
    pending.set(id, m => m.error ? rej(new Error(`${method}: ${m.error.message ?? JSON.stringify(m.error)}`)) : res(m.result));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  const waitBroadcast = (method, pred, timeoutMs, what) => new Promise((res, rej) => {
    const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`等待超时(${timeoutMs / 1000}s): ${what}`)); }, timeoutMs);
    const w = { method, pred, resolve: res, timer };
    waiters.push(w);
  });
  return new Promise((res, rej) => {
    ws.on('open', () => res({ ws, call, waitBroadcast, close: () => ws.close() }));
    ws.on('error', rej);
  });
}

/** 发一条 prompt 并收集到终态。返回 {text, toolStarts, toolEnds, offloads, error}；toolEnds 附带工具名。 */
async function runPrompt(client, sessionId, text) {
  const out = { text: '', toolStarts: [], toolEnds: [], offloads: [], error: undefined };
  const nameById = new Map();
  const terminal = client.waitBroadcast('chat.event',
    p => p.sessionId === sessionId && (p.event.kind === 'turnEnd' || p.event.kind === 'error'),
    STEP_TIMEOUT_MS, `prompt 终态: ${text.slice(0, 30)}`);
  const collector = data => {
    const msg = JSON.parse(String(data));
    if (msg.method !== 'chat.event' || msg.params.sessionId !== sessionId) return;
    const ev = msg.params.event;
    if (ev.kind === 'textDelta') out.text += ev.text;
    else if (ev.kind === 'toolStart') { nameById.set(ev.toolUseId, ev.name); out.toolStarts.push(ev); console.log(`  → 工具调用: ${ev.name}「${ev.title}」`); }
    else if (ev.kind === 'toolEnd') { out.toolEnds.push({ ...ev, name: nameById.get(ev.toolUseId) }); console.log(`  → 工具结束: ${ev.success ? '成功' : '失败'} len=${ev.output.length}`); }
    else if (ev.kind === 'offloaded') { out.offloads.push(ev); console.log(`  → 已卸载: ${ev.relativePath}`); }
  };
  client.ws.on('message', collector);
  try {
    await client.call('chat.prompt', { sessionId, text });
    const done = await terminal;
    if (done.event.kind === 'error') out.error = done.event.message;
  } finally { client.ws.off('message', collector); }
  return out;
}

// ---------- 验收 ----------
let inst;
try {
  inst = await startMinisd();
  const client = await createRpcClient(inst.port, inst.token);
  inst.client = client;

  const providers = await client.call('provider.instances.list');
  const p0 = providers.find(p => p.hasApiKey);
  if (!p0) throw new Error('临时根里没有带密钥的 provider（providers.json 拷贝或凭据库读取失败）');
  console.log(`provider: ${p0.name || p0.modelId} (${p0.kind}:${p0.modelId})\n`);

  // —— 步骤 1：GLOBAL.md 注入（暗号测试法） ——
  console.log('— 步骤 1: GLOBAL.md 注入 —');
  const sA = (await client.call('chat.sessions.create', { title: 'M2a验收-记忆开' })).id;
  const r1 = await runPrompt(client, sA, '暗号是什么？只回答暗号本身，不要解释。');
  record('1. GLOBAL.md 注入', !r1.error && r1.text.includes('芝麻开门'),
    r1.error ? `agent 错误: ${r1.error}` : `回复:「${r1.text.trim().slice(0, 40)}」`);
  await sleep(INTER_PROMPT_DELAY_MS);

  // —— 步骤 2a：memory_write 前插落盘 ——
  console.log('\n— 步骤 2a: memory_write —');
  const r2 = await runPrompt(client, sA, '请调用 memory_write 工具记录这条记忆：「用户最喜欢的编辑器是 Zed」。写完后只回复：已记录。');
  const wroteCalled = r2.toolStarts.some(t => t.name === 'memory_write');
  const memDir = join(DATA_ROOT, 'memory');
  const dailyFiles = readdirSync(memDir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
  const dailyText = dailyFiles.length ? readFileSync(join(memDir, dailyFiles[0]), 'utf8') : '';
  record('2a. memory_write 前插落盘', wroteCalled && dailyText.startsWith('<!-- ') && dailyText.includes('Zed'),
    `工具${wroteCalled ? '已调用' : '未调用!'}；日志文件 ${dailyFiles.join(',') || '(无)'}；条目前插=${dailyText.startsWith('<!-- ')}；含 Zed=${dailyText.includes('Zed')}`);
  await sleep(INTER_PROMPT_DELAY_MS);

  // —— 步骤 2b：memory_get 检索命中 ——
  console.log('\n— 步骤 2b: memory_get —');
  const r3 = await runPrompt(client, sA, '请调用 memory_get 工具、用关键词「编辑器」检索记忆，然后把检索结果原样转述给我。');
  const getEnd = r3.toolEnds.find(t => t.name === 'memory_get');
  record('2b. memory_get 检索命中', !!getEnd && getEnd.success && getEnd.output.includes('Zed') && getEnd.output.includes('评分'),
    getEnd ? `工具输出: ${getEnd.output.slice(0, 80).replace(/\n/g, ' ')}` : 'memory_get 未被调用!');
  await sleep(INTER_PROMPT_DELAY_MS);

  // —— 步骤 3：memory_enabled 开关 ——
  console.log('\n— 步骤 3: memory_enabled 开关 —');
  const sB = (await client.call('chat.sessions.create', { title: 'M2a验收-记忆关' })).id;
  await client.call('chat.sessions.setMemoryEnabled', { sessionId: sB, enabled: false });
  const listed = (await client.call('chat.sessions.list')).find(s => s.id === sB);
  const r4 = await runPrompt(client, sB, '暗号是什么？只回答暗号本身，不要解释。如果你不知道任何暗号，回答：不知道。');
  const noLeak = !r4.text.includes('芝麻开门');
  const noMemTool = !r4.toolStarts.some(t => t.name === 'memory_write' || t.name === 'memory_get');
  record('3. memory_enabled 开关', listed?.memoryEnabled === false && !r4.error && noLeak && noMemTool,
    `list.memoryEnabled=${listed?.memoryEnabled}；暗号未泄露=${noLeak}（回复「${r4.text.trim().slice(0, 30)}」）；记忆工具未调用=${noMemTool}`);
  await sleep(INTER_PROMPT_DELAY_MS);

  // —— 步骤 4：大工具结果卸载 ——
  console.log('\n— 步骤 4: 大结果卸载 —');
  const r5 = await runPrompt(client, sB,
    '请调用 shell_execute 工具运行这条 PowerShell 命令（原样运行，不要改动）：1..2000 | ForEach-Object { "OFFLOAD-PAD-LINE-$_-XXXXXXXXXXXXXXXXXXXX" }。运行完只回复：完成。');
  const shellEnd = r5.toolEnds.find(t => t.name === 'shell_execute');
  const fullBroadcast = !!shellEnd && shellEnd.output.length > 20_000;
  const offEv = r5.offloads[0];
  const offFile = offEv ? join(DATA_ROOT, 'sessions', sB, 'offloads') : undefined;
  const offFileOk = offFile && existsSync(offFile) && readdirSync(offFile).length > 0;
  const msgs = await client.call('chat.messages.list', { sessionId: sB });
  const trPart = msgs.flatMap(m => m.parts).find(p => p.type === 'toolResult' && String(p.value?.output ?? '').includes('[CONTEXT OFFLOADED'));
  record('4. 大结果卸载', fullBroadcast && !!offEv && !!offFileOk && !!trPart,
    `toolEnd 全文广播=${fullBroadcast}(len=${shellEnd?.output.length ?? 0})；offloaded 事件=${!!offEv}；offloads/ 文件=${!!offFileOk}；落库为桩=${!!trPart}`);

  console.log('\n步骤 5（压缩）按自动化用例放行：真实 200K 窗口需 8 万+ token 才触发，compact/agent-loop 单测已覆盖全部路径。');
} catch (e) {
  record('异常', false, e.message);
} finally {
  try { inst?.client?.close(); } catch { /* 尽力 */ }
  try { inst?.child?.kill(); } catch { /* 尽力 */ }
  await sleep(800);
  try { rmSync(DATA_ROOT, { recursive: true, force: true }); console.log('临时数据根已清理'); }
  catch { console.warn('临时数据根清理失败（可手动删除）: ' + DATA_ROOT); }
}

const failed = results.filter(r => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} 步通过 =====`);
process.exit(failed.length ? 1 : 0);
