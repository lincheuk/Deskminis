// DeskMinis M2b 端到端验收驱动（对应 docs/plans/2026-07-28-m2b-providers-modelfallback.md「M2b 完成定义」）。
// 用法：先 `npm run build`，再 `npm run e2e:m2b`。
//
// 核心：构造「真实降级链场景」——脚本自己造一个坏 key 主模型，与用户已配置的有效 provider
// 组成模型组 [主(坏key), 备(有效)]，绑定会话后发 prompt，验证：
//   - 主模型失败触发 fallback 事件，备选真实接管并产出文本
//   - turnEnd 后会话绑定被改写为 provider:<备选id>（修复 62ac690 后的时机）
//   - 杀掉 minisd 重启后绑定与历史仍持久
// 只需 1 个有效 provider 即可运行（坏 key 实例是脚本自己造的）。
// 验收会话保留在数据根作证据，模型组与坏 key 实例在 finally 清理。

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
// 坏 key 若退化为网络错误会先走满重试梯（3+5+10+15+30≈63s）再降级，终态等待保持 240s 余量。
const STEP_TIMEOUT_MS = 240_000;

const results = [];
function record(step, pass, detail) {
  results.push({ step, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${step}] ${detail}`);
}

// ---------- 启动独立 minisd（真实数据根 + 真实凭据库） ----------
function spawnMinisd() {
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
  return child;
}

/** 等待 minisd stdout 的首行握手 JSON。 */
function awaitHandshake(child) {
  return new Promise((res, rej) => {
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
  });
}

async function startMinisd() {
  console.log('启动独立 minisd（数据根: ' + DATA_ROOT + '）…');
  const child = spawnMinisd();
  const hs = await awaitHandshake(child).catch(e => { console.error(e.message); child.kill(); throw e; });
  console.log(`minisd 已就绪: 127.0.0.1:${hs.minisdPort}`);
  return { child, port: hs.minisdPort, token: hs.authToken };
}

// ---------- RPC 客户端 ----------
function createRpcClient(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  let idc = 0;
  const pending = new Map();
  const waiters = [];
  let permDecision = 'allow-once'; // 当前对权限卡的自动应答

  ws.on('message', data => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    // 权限卡自动应答（健康检查步骤的 file_write / shell_execute 需要）
    if (msg.method === 'permission.request') {
      const { requestId, req } = msg.params;
      console.log(`  → 权限卡: ${req.kind} ${JSON.stringify(req.detail ?? '').slice(0, 80)} → 自动应答 ${permDecision}`);
      const id = ++idc;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'permission.respond', params: { requestId, decision: permDecision } }));
      return;
    }
    if (msg.method) for (const w of [...waiters]) {
      if (w.method && msg.method !== w.method) continue;
      let hit = false;
      try { hit = w.pred(msg.params); } catch { /* 谓词失败视为未命中 */ }
      if (hit) { clearTimeout(w.timer); waiters.splice(waiters.indexOf(w), 1); w.resolve(msg.params); }
    }
  });

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

  return new Promise((res, rej) => {
    ws.on('open', () => res({ ws, call, waitBroadcast, setPermDecision: (d) => { permDecision = d; }, close: () => ws.close() }));
    ws.on('error', rej);
  });
}

/** 发一条 prompt 并收集到终态（turnEnd / error）。返回 {text, toolStarts, toolEnds, fallbacks, error}。 */
async function runPrompt(client, sessionId, text, opts = {}) {
  const out = { text: '', toolStarts: [], toolEnds: [], fallbacks: [], error: undefined };
  const terminal = client.waitBroadcast('chat.event',
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
  client.ws.on('message', collector);
  try {
    await client.call('chat.prompt', { sessionId, text, ...opts });
    const done = await terminal;
    if (done.event.kind === 'error') out.error = done.event.message;
  } finally { client.ws.off('message', collector); }
  return out;
}

// ---------- 验收步骤 ----------
let currentChild = undefined;
let currentClient = undefined;
let groupId = undefined;     // finally 清理用
let badMainId = undefined;   // finally 清理用
let sessionId = undefined;   // 验收会话保留作证据，不删除

try {
  const started = await startMinisd();
  currentChild = started.child;
  currentClient = await createRpcClient(started.port, started.token);

  // 步骤 1：找一个 hasApiKey=true 的真实实例作【备选】
  const providers = await currentClient.call('provider.instances.list');
  const backup = providers.find(p => p.hasApiKey);
  if (!backup) throw new Error('未找到 hasApiKey=true 的 provider —— 至少需要 1 个有效 provider 才能跑降级链');
  console.log(`备选 provider: ${backup.name}(${backup.kind}:${backup.modelId}) id=${backup.id}`);
  record('1. 备选 provider 就绪', true, `${backup.name} ${backup.kind}:${backup.modelId}`);

  sessionId = (await currentClient.call('chat.sessions.create', { title: 'M2b E2E 验收' })).id;
  console.log('会话: ' + sessionId);

  // 步骤 2：前置健康检查（基本对话 + 工具调用，验证备选 provider 基本可用）
  console.log('\n— 步骤 2: 前置健康检查（基本对话+工具） —');
  currentClient.setPermDecision('allow-once');
  const r1 = await runPrompt(currentClient, sessionId, '在工作区创建 m2b-test.txt 写入 M2b验证通过');
  const wrote = r1.toolStarts.some(t => t.name === 'file_write');
  const filePath = join(DATA_ROOT, 'sessions', sessionId, 'workspace', 'm2b-test.txt');
  const fileOk = existsSync(filePath);
  if (r1.error) record('2. 前置健康检查', false, 'agent 错误: ' + r1.error);
  else record('2. 前置健康检查', wrote && fileOk,
    `file_write ${wrote ? '已调用' : '未调用'}；落盘 ${fileOk ? 'OK' : '失败'}`);

  // 步骤 3：降级链触发（核心）
  // 组装：坏 key 主模型 + 模型组 [主, 备] + 会话绑定 group:<gid>
  console.log('\n— 步骤 3: 降级链触发（坏 key 主模型 → 备选接管） —');
  const badMain = await currentClient.call('provider.instances.create', {
    name: 'E2E坏key主模型',
    kind: backup.kind,
    modelId: backup.modelId,
    baseUrl: backup.baseUrl,        // 与备选同端点，仅 key 不同
    apiKey: 'sk-invalid-e2e-m2b',   // 无效 key → 401 fallbackable，直接降级
  });
  badMainId = badMain.id;
  console.log(`坏 key 主模型: id=${badMainId}`);

  const group = await currentClient.call('modelgroup.create', {
    name: 'E2E降级链',
    memberIds: [badMain.id, backup.id], // [主(坏key), 备(有效)]
  });
  groupId = group.id;
  console.log(`模型组: ${groupId}（成员: 坏key主 → ${backup.name}）`);

  await currentClient.call('chat.sessions.setModelBinding', { sessionId, binding: `group:${groupId}` });
  console.log(`会话绑定: group:${groupId}`);

  // 发 prompt（不带 providerId，走会话绑定解析）
  const r3 = await runPrompt(currentClient, sessionId, '请只回复两个字：验收');

  // 断言 a) fallback 事件且 to 含备选 modelId
  const fallbackOk = r3.fallbacks.some(f => f.to.includes(backup.modelId));
  // 断言 b) 终态是 turnEnd 且累计 textDelta 非空（备选真实接管）
  const turnEndOk = !r3.error && r3.text.trim().length > 0;
  // 断言 c) 历史里没有「系统提醒」文本（首轮 401 应直接降级，不走 reminder 重试）
  const msgs = await currentClient.call('chat.messages.list', { sessionId });
  const hasReminder = msgs.some(m => Array.isArray(m.parts) && m.parts.some(p => p.type === 'text' && typeof p.value === 'string' && p.value.includes('系统提醒')));

  if (r3.error) {
    record('3. 降级链触发', false, `agent 错误: ${r3.error}；fallback=${r3.fallbacks.length}条`);
  } else {
    record('3. 降级链触发', fallbackOk && turnEndOk && !hasReminder,
      `fallback=${fallbackOk ? 'OK' : '缺失'}(${r3.fallbacks.map(f => `${f.from}→${f.to}`).join(', ')})；` +
      `终态文本=${turnEndOk ? 'OK' : '空'}「${r3.text.trim().slice(0, 30)}」；` +
      `系统提醒=${hasReminder ? '出现(异常)' : '无'}`);
  }

  // 步骤 6a：终态后绑定改写为 provider:<备选id>
  // 注意：修复 62ac690 后改写发生在 turnEnd 时刻，此时已终态，可安全读取。
  console.log('\n— 步骤 6a: 绑定改写（turnEnd 后） —');
  const sessions6a = await currentClient.call('chat.sessions.list');
  const session6a = sessions6a.find(s => s.id === sessionId);
  const expectedBinding = `provider:${backup.id}`;
  const rebindOk = session6a?.modelBinding === expectedBinding;
  record('6a. 绑定改写', rebindOk,
    `期望=${expectedBinding}；实际=${session6a?.modelBinding ?? '(空)'}`);

  // 步骤 6b：杀掉 minisd、重新拉起、重连，验证绑定持久 + 历史完整
  console.log('\n— 步骤 6b: 重启持久化 —');
  currentClient.close();
  currentChild.kill();
  currentClient = undefined;
  currentChild = undefined;
  // 等端口释放
  await new Promise(r => setTimeout(r, 1500));

  const restarted = await startMinisd();
  currentChild = restarted.child;
  currentClient = await createRpcClient(restarted.port, restarted.token);

  const sessions6b = await currentClient.call('chat.sessions.list');
  const session6b = sessions6b.find(s => s.id === sessionId);
  const bindingPersisted = session6b?.modelBinding === expectedBinding;
  const msgs6b = await currentClient.call('chat.messages.list', { sessionId });
  const historyOk = Array.isArray(msgs6b) && msgs6b.length >= 2;
  record('6b. 重启持久化', bindingPersisted && historyOk,
    `绑定=${session6b?.modelBinding ?? '(空)'} ${bindingPersisted ? 'OK' : '丢失!'}；` +
    `历史=${msgs6b.length}条 ${historyOk ? 'OK' : '不足!'}`);

  console.log(`\n验收会话「M2b E2E 验收」保留在数据根（id=${sessionId}）作证据。`);
} catch (e) {
  record('异常', false, e.message);
} finally {
  // 清理测试资源：模型组 + 坏 key 实例（验收会话保留作证据）
  if (currentClient) {
    try {
      if (groupId) await currentClient.call('modelgroup.delete', { id: groupId, confirm: true });
      if (badMainId) await currentClient.call('provider.instances.delete', { id: badMainId, confirm: true });
      console.log('清理完成：模型组与坏 key 实例已删除（验收会话保留）');
    } catch (e) {
      console.warn('清理失败（可手动删除模型组/坏key实例）: ' + e.message);
    }
  }
  currentClient?.close();
  currentChild?.kill();
}

const failed = results.filter(r => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} 步通过 =====`);
process.exit(failed.length ? 1 : 0);
