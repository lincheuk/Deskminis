// DeskMinis D 波收官：MCP e2e 冒烟（真 stdio fixture 全链路）。
// 用法：先 `npm run build`，再 `npm run e2e:mcp`（或 `node scripts/e2e-mcp-acceptance.mjs`）。
//
// 串一条中间态配置层的真相链路：配置(servers.json) → 启动(ensureForRun 连 stdio fixture) →
// mcp__ 工具调用 → 权限卡 → 结果回流 → askOnce → deny → 会话禁用 → 试连。
// fixture 用 tests/mcp-stdio-server.mjs（真子进程、零依赖、stdin/stdout 行协议），
// 不是 mock——「环境变量/子进程/行分帧」这些真实路径都真跑一遍。
//
// 为什么能全离线：provider 用 FakeProvider（DESKMINIS_FAKE_PROVIDER=1 + chat.prompt 显式选
// providerId='__fake__'，所以 providers.json 一条都不需要）。FakeProvider 扫会话历史里
// 【首条】形如 `__tool__ <工具名> <inputJSON>` 的用户文本发起一次工具调用；每次 chat.prompt
// 都 new 一个新 FakeProvider（toolCallSpent 归零），所以同一会话每一轮都会重放这【首条】。
// 这是既有红线机制，问法 3 / 案 5 的断言照此设计——别试图让第二条 __tool__ 生效。

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
// 与 minisd 同一 electron 二进制：既是启动 minisd 的可执行，也是 servers.json 里派生 fixture 子进程的 command
// （fixture 子进程必须带 ELECTRON_RUN_AS_NODE=1，否则拉起 GUI 而非 Node 模式——见 tests/mcp-stdio.test.ts 同约定）。
const electronBin = require('electron');

const MINISD_ENTRY = join(process.cwd(), 'out', 'main', 'minisd.js');
if (!existsSync(MINISD_ENTRY)) { console.error('找不到 out/main/minisd.js —— 先运行 npm run build'); process.exit(2); }

// fixture 绝对路径：按脚本自身位置解析，与 cwd 无关
const FIXTURE = fileURLToPath(new URL('../tests/mcp-stdio-server.mjs', import.meta.url));

// 权限超时默认 90s：万一某案意外弹卡但不应答，最坏要等一次 timeout-deny 才收尾，
// 所以回合超时必须 > 90s，否则「无权限卡」断言还没跑完就误报超时。
const TURN_TIMEOUT_MS = 150_000;

const results = [];
function record(step, pass, detail) {
  results.push({ step, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${step}] ${detail}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 临时数据根 + 预写 servers.json（须在 boot 前，minisd 启动即读） ----------
const DATA_ROOT = mkdtempSync(join(tmpdir(), 'dm-e2e-mcp-'));
mkdirSync(join(DATA_ROOT, 'mcp-servers'), { recursive: true });
writeFileSync(join(DATA_ROOT, 'mcp-servers', 'servers.json'), JSON.stringify({
  mcpServers: {
    e2e: {
      // stdio 条目：command=electron 二进制、args=[fixture]、env 强制 Node 模式（D6 试连与 run 连接同工厂）
      command: electronBin,
      args: [FIXTURE],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
  },
}, null, 2), 'utf8');
console.log('临时数据根: ' + DATA_ROOT);

// ---------- minisd + RPC（沿用 m2a e2e 纯 RPC 面模式；本任务不是 mu6 的 CDP 驱 GUI） ----------
function startMinisd() {
  const child = spawn(electronBin, [MINISD_ENTRY], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1', // 以 Node 模式跑 minisd，不拉 GUI
      DESKMINIS_STANDALONE: '1', // 走 standalone 引导分支，stdout 发握手行
      DESKMINIS_DATA_DIR: DATA_ROOT, // 隔离数据根
      DESKMINIS_TEST: '1', // 内存 vault，免真实凭据库
      DESKMINIS_FAKE_PROVIDER: '1', // 打开 FakeProvider
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
    let msg; try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
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
    const timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); rej(new Error(`等待超时(${timeoutMs / 1000}s): ${what}`)); }, timeoutMs);
    const w = { method, pred, resolve: res, timer };
    waiters.push(w);
  });
  return new Promise((res, rej) => {
    ws.on('open', () => res({ ws, call, waitBroadcast, close: () => ws.close() }));
    ws.on('error', rej);
  });
}

// 会话级并发闸竞态退避：上一轮 turnEnd 广播后才 inFlight.delete，紧接着发下一轮可能撞
// 「该会话正在运行中」。对这条已知竞态做短退避重试，比拍脑袋固定 sleep 更稳。
async function promptWithRetry(client, params) {
  let lastErr;
  for (let i = 0; i < 10; i++) {
    try { return await client.call('chat.prompt', params); }
    catch (e) {
      lastErr = e;
      if (String(e.message).includes('正在运行')) { await sleep(300); continue; }
      throw e;
    }
  }
  throw lastErr;
}

// 发一条 prompt 并收集到终态（turnEnd/error）。返回 { text, error, toolStarts, toolEnds, perms }。
// chat.prompt 是 fire-and-forget（返回 {ok:true} 即回，agent 循环后台跑），结果全靠 chat.event 广播回流。
// decision 非空时，对 kind='mcp' 的 permission.request 自动 permission.respond（allow-session / deny）。
async function runTurn(client, sessionId, text, decision) {
  const state = { text: '', error: undefined, toolStarts: [], toolEnds: [], perms: [] };
  const nameById = new Map();
  const terminal = client.waitBroadcast('chat.event',
    p => p.sessionId === sessionId && (p.event.kind === 'turnEnd' || p.event.kind === 'error'),
    TURN_TIMEOUT_MS, `prompt 终态「${text.slice(0, 24)}」`);

  const collector = data => {
    let msg; try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.method === 'chat.event' && msg.params.sessionId === sessionId) {
      const ev = msg.params.event;
      if (ev.kind === 'textDelta') state.text += ev.text;
      else if (ev.kind === 'toolStart') { nameById.set(ev.toolUseId, ev.name); state.toolStarts.push(ev); }
      else if (ev.kind === 'toolEnd') state.toolEnds.push({ ...ev, name: nameById.get(ev.toolUseId) });
    } else if (msg.method === 'permission.request') {
      state.perms.push(msg.params);
      if (decision && msg.params.req?.kind === 'mcp') {
        void client.call('permission.respond', { requestId: msg.params.requestId, decision }).catch(() => {});
      }
    }
  };
  client.ws.on('message', collector);
  try {
    await promptWithRetry(client, { sessionId, text, providerId: '__fake__' });
    const done = await terminal;
    if (done.event.kind === 'error') state.error = done.event.message;
  } finally {
    client.ws.off('message', collector);
  }
  return state;
}

// ---------- 六案 ----------
let inst; let client;
let sessionA; let sessionB;
try {
  inst = await startMinisd();
  client = await createRpcClient(inst.port, inst.token);
  console.log(`minisd 就绪: port=${inst.port}`);

  // —— 案 1：种子与就绪 ——
  try {
    sessionA = (await client.call('chat.sessions.create', { title: 'e2e-mcp-A' })).id;
    const l1 = await client.call('mcp.servers.list', {});
    const hasE2e = Array.isArray(l1?.servers) && l1.servers.some(s => s.name === 'e2e');
    record('1. 种子与就绪', hasE2e, `servers 可见 e2e=${hasE2e}`);
  } catch (e) { record('1. 种子与就绪', false, '异常: ' + e.message); }

  // —— 案 2：端到端调用 + 权限卡（allow-session） ——
  try {
    const t2 = await runTurn(client, sessionA, '__tool__ mcp__e2e__echo {"tool_title":"e2e 冒烟","probe":"e2e-roundtrip"}', 'allow-session');
    const permSeen = t2.perms.some(p => p.req?.kind === 'mcp' && p.req?.detail === 'e2e');
    const echo = t2.toolEnds.find(t => t.name === 'mcp__e2e__echo');
    record('2. 端到端调用 + 权限卡', permSeen && !!echo && echo.success === true && String(echo.output).includes('e2e-roundtrip'),
      `权限卡(mcp/e2e)=${permSeen}；toolEnd success=${echo?.success} output=${JSON.stringify(echo?.output ?? '')}`);
  } catch (e) { record('2. 端到端调用 + 权限卡', false, '异常: ' + e.message); }

  // —— 案 3：askOnce（会话级授权已记，重放首条 __tool__ 不再弹卡） ——
  try {
    const t3 = await runTurn(client, sessionA, '再调一次', undefined);
    const noPerm = t3.perms.filter(p => p.req?.kind === 'mcp').length === 0;
    const echo3 = t3.toolEnds.find(t => t.name === 'mcp__e2e__echo');
    record('3. askOnce', noPerm && !!echo3 && echo3.success === true && String(echo3.output).includes('e2e-roundtrip'),
      `无新权限卡=${noPerm}；重放 toolEnd success=${echo3?.success} output=${JSON.stringify(echo3?.output ?? '')}（内容仍是首条 probe，重放机制使然）`);
  } catch (e) { record('3. askOnce', false, '异常: ' + e.message); }

  // —— 案 4：deny（fixture 未收到调用） ——
  try {
    sessionB = (await client.call('chat.sessions.create', { title: 'e2e-mcp-B' })).id;
    const t4 = await runTurn(client, sessionB, '__tool__ mcp__e2e__echo {"tool_title":"e2e 拒绝案","probe":"denied"}', 'deny');
    const permSeen = t4.perms.some(p => p.req?.kind === 'mcp' && p.req?.detail === 'e2e');
    const echo4 = t4.toolEnds.find(t => t.name === 'mcp__e2e__echo');
    const deniedOut = !!echo4 && echo4.success === false && String(echo4.output).includes('拒绝');
    const noEchoLeak = t4.toolEnds.every(t => !String(t.output).includes('denied'));
    record('4. deny', permSeen && deniedOut && noEchoLeak,
      `权限卡(mcp/e2e)=${permSeen}；toolEnd success=${echo4?.success} output=${JSON.stringify(echo4?.output ?? '')}；无 denied 回显=${noEchoLeak}`);
  } catch (e) { record('4. deny', false, '异常: ' + e.message); }

  // —— 案 5：会话禁用硬执行（禁用检查在权限闸之前，不弹卡） ——
  try {
    await client.call('chat.sessions.setMcpDisabled', { sessionId: sessionB, servers: ['e2e'] });
    const t5 = await runTurn(client, sessionB, '再调一次', undefined);
    const noPerm = t5.perms.filter(p => p.req?.kind === 'mcp').length === 0;
    const echo5 = t5.toolEnds.find(t => t.name === 'mcp__e2e__echo');
    const disabledOut = !!echo5 && String(echo5.output).includes('已在本会话禁用');
    record('5. 会话禁用硬执行', noPerm && disabledOut,
      `无权限卡=${noPerm}；toolEnd success=${echo5?.success} output=${JSON.stringify(echo5?.output ?? '')}`);
  } catch (e) { record('5. 会话禁用硬执行', false, '异常: ' + e.message); }

  // —— 案 6：试连与状态 ——
  try {
    const t6 = await client.call('mcp.servers.test', { name: 'e2e' });
    const l6 = await client.call('mcp.servers.list', {});
    const st = Array.isArray(l6?.statuses) ? l6.statuses.find(s => s.name === 'e2e') : undefined;
    record('6. 试连与状态', t6?.ok === true && t6?.toolCount >= 1 && st?.status === 'connected',
      `test.ok=${t6?.ok} toolCount=${t6?.toolCount} elapsedMs=${t6?.elapsedMs}；run 态 status=${st?.status}`);
  } catch (e) { record('6. 试连与状态', false, '异常: ' + e.message); }
} catch (e) {
  record('引导', false, e.message);
} finally {
  try { client?.close(); } catch { /* 尽力 */ }
  try { inst?.child?.kill(); } catch { /* 尽力 */ }
  await sleep(800); // 让 minisd 释放 minis.db 后再删数据根（SQLite 单进程持有）
  try { rmSync(DATA_ROOT, { recursive: true, force: true }); console.log('临时数据根已清理'); }
  catch { console.warn('临时数据根清理失败（可手动删除）: ' + DATA_ROOT); }
}

const failed = results.filter(r => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} 步通过 =====`);
process.exit(failed.length ? 1 : 0);