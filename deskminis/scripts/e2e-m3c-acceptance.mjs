// DeskMinis M3c 端到端验收驱动（对应 docs/plans/2026-08-01-m3c-handoff.md「完成定义」）。
// 用法：先 `npm run build`，再 `npm run e2e:m3c`。
//
// 覆盖（本地完整链路，不联网）：
//   1) 双实例：A/B 两个 standalone minisd（各自临时数据根 + minisd-port.json 端口持久化）
//   2) A begin 出码 → B 经 remote.pair.join 真出站完成配对（含地址簿落地断言）
//   3) OutboundClient 主从裁决拨号 + sync.hello 互认成功（remote.status online=true 双向，B 侧重取 status）
//   4) A 写一轮 → 秒级自动收敛 → B 端 sync.pull 拿到的消息 id 序列与 A 逐位一致
//   5) 双向各写一轮 → 两端 id 序列逐位一致 + usedTokens 零差（设计 §6 双断言）
//   6) 断开 A 重启（端口持久化复用）→ 自动重连 + 增量收敛（B 在 A 断线期间写的消息同步到 A）
//   7) 静默期 sync.dirty 通知 + synced 事件计数不增长（防 ping-pong 实证）
//   8) remote.status 在线点翻转（A 断开 → B 端 A.online=false；A 重连 → true）
//   9) UI CDP：DevicesModal 加入配对两输入 + TitleBar 状态点三态色（小项 7d 并入）
//
// 环境隔离：临时数据根（mkdtemp × 2）+ DESKMINIS_TEST=1（内存 vault 单测路径）+ DESKMINIS_E2E=1
//   （FileVault 跨进程持久化 StaticIdentity，用例 6 重启 A 后身份不丢）+ MINISD_HOST=127.0.0.1，结束 rmSync。
// e2e:m3c 用 cross-env ELECTRON_RUN_AS_NODE=1 electron 跑（better-sqlite3 是 Electron ABI，M3b 教训）。
// UI CDP 段：electron-vite dev --remote-debugging-port=9222（复用 e2e-mu2a 案 A 透传技法）。
//
// 计划内修正/偏差申报（commit message 同步申报）：
//   ① 新增 FileVault（DESKMINIS_E2E=1）：e2e 是 standalone 跨进程，InMemoryVault 不持久化 StaticIdentity，
//     用例 6 重启 A 后身份丢失配对失效；KeyringVault 污染真实凭据库。FileVault 明文存 dataRoot/vault.json，
//     隔离于临时数据根，仅 e2e 模式启用。计划未提及，属 e2e 基础设施补齐。
//   ② InMemoryVault.forDataRoot 单例（前序修复 commit）：单测内同进程 startMinisd 复用 vault，断线重连
//     单测身份持久化。e2e 跨进程不生效，故另需 FileVault。

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const electronBin = require('electron');
const MINISD_ENTRY = join(process.cwd(), 'out', 'main', 'minisd.js');
if (!existsSync(MINISD_ENTRY)) { console.error('找不到 out/main/minisd.js —— 先 npm run build'); process.exit(2); }

const results = [];
const record = (step, pass, detail) => { results.push({ step, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  [${step}] ${detail}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- spawn 单个 minisd 实例（standalone，DESKMINIS_E2E=1 启用 FileVault） ----
function spawnMinisd(label, dataRoot) {
  writeFileSync(join(dataRoot, 'providers.json'), JSON.stringify({
    providers: [{ id: '__fake__', name: 'fake', kind: 'openai-compat', modelId: 'fake' }],
    defaultProviderId: '__fake__',
  }), 'utf8');
  const proc = spawn(electronBin, [MINISD_ENTRY], {
    env: {
      ...process.env,
      DESKMINIS_STANDALONE: '1',
      DESKMINIS_TEST: '1',
      DESKMINIS_E2E: '1',
      DESKMINIS_FAKE_PROVIDER: '1',
      DESKMINIS_DATA_DIR: dataRoot,
      MINISD_HOST: '127.0.0.1',
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    proc.stdout.once('data', d => {
      try {
        const { minisdPort, authToken } = JSON.parse(String(d).trim());
        resolve({ label, proc, port: minisdPort, token: authToken, dataRoot });
      } catch (e) { reject(e); }
    });
    proc.stderr.on('data', d => process.stderr.write(`[${label}] ${d}`));
    setTimeout(() => reject(new Error(`${label} 启动超时`)), 15000);
  });
}

// ---- WS RPC 客户端 ----
function rpcClient(url) {
  const ws = new WebSocket(url);
  let idc = 0;
  const pending = new Map();
  const notifications = [];
  ws.on('message', data => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) notifications.push({ method: msg.method, params: msg.params });
  });
  const ready = new Promise((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  function call(method, params) {
    const id = ++idc;
    return new Promise((resolve, reject) => {
      pending.set(id, m => {
        if (m.error) reject(new Error(`${method}: ${m.error.message ?? JSON.stringify(m.error)}`));
        else resolve(m.result);
      });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }
  return { ready, call, notifications, close: () => { try { ws.close(); } catch { /* */ } } };
}

async function waitFor(what, cond, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { if (await cond()) break; } catch { /* cond 抛错视为未就绪 */ }
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await sleep(100);
  }
}

async function promptTurn(c, sessionId, text) {
  await c.call('chat.prompt', { sessionId, text, providerId: '__fake__' });
  // 同时监听 turnEnd 和 error：error 时立即抛出详情帮助诊断
  const label = text.slice(0, 20);
  const deadline = Date.now() + 20000;
  for (;;) {
    const errEvt = c.notifications.find(n => n.method === 'chat.event' && n.params.sessionId === sessionId && n.params.event?.kind === 'error');
    if (errEvt) throw new Error(`agent loop error (${label}): ${errEvt.params.event.message}`);
    if (c.notifications.some(n => n.method === 'chat.event' && n.params.sessionId === sessionId && n.params.event?.kind === 'turnEnd')) break;
    if (Date.now() > deadline) throw new Error(`等待超时: turnEnd for "${label}"`);
    await sleep(100);
  }
  // 不清空 notifications，用例 7 需要累计 sync.dirty / synced 计数
}

// ---- CDP 客户端（UI 段，复用 e2e-mu2a 基建） ----
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
      if (m.method) for (const fn of [...this.listeners]) { try { fn(m); } catch { /* */ } }
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
  close() { try { this.ws.close(); } catch { /* */ } }
}
async function evaluate(cdp, expr) {
  const res = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error('evaluate 异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 300));
  return res.result?.value;
}
async function waitForDom(cdp, expr, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await evaluate(cdp, expr); } catch { v = undefined; }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时(${Math.round(timeoutMs / 1000)}s): ${label}`);
    await sleep(150);
  }
}

// ============ 主流程 ============
let A, B;
let dataRootA, dataRootB;
try {
  dataRootA = mkdtempSync(join(tmpdir(), 'dm-m3c-A-'));
  dataRootB = mkdtempSync(join(tmpdir(), 'dm-m3c-B-'));
  console.log('临时数据根 A: ' + dataRootA);
  console.log('临时数据根 B: ' + dataRootB);

  A = await spawnMinisd('A', dataRootA);
  B = await spawnMinisd('B', dataRootB);
  console.log(`A port=${A.port} B port=${B.port}`);
  record('1. 双实例启动（minisd-port.json 持久化）',
    existsSync(join(dataRootA, 'minisd-port.json')) && existsSync(join(dataRootB, 'minisd-port.json')),
    `A.port=${A.port} B.port=${B.port}`);

  const localA = rpcClient(`ws://127.0.0.1:${A.port}/?token=${A.token}`); await localA.ready;
  const localB = rpcClient(`ws://127.0.0.1:${B.port}/?token=${B.token}`); await localB.ready;

  // 2. A begin 出码 → B join 真出站配对（免手抄公钥）
  const begin = await localA.call('remote.pair.begin', {});
  record('2a. beginPairing', !!begin.pairingCode, `code=${begin.pairingCode} fp=${begin.myFingerprint}`);
  const joinRes = await localB.call('remote.pair.join', {
    host: '127.0.0.1', port: A.port,
    pairingCode: begin.pairingCode,
    peerName: 'A-设备',
    listenPort: B.port,
  });
  record('2b. B join 真出站配对（免手抄公钥）', joinRes.ok === true, `join=${JSON.stringify(joinRes)}`);
  record('2c. join 返回重算指纹与 begin 一致', joinRes.peerFingerprint === begin.myFingerprint,
    `join=${joinRes.peerFingerprint} begin=${begin.myFingerprint}`);

  // 地址簿落地断言（B 端记 A 地址）
  const bStatus0 = await localB.call('remote.status', {});
  const bHasA = bStatus0.devices.some(d => d.peerFingerprint === begin.myFingerprint && d.address);
  record('2d. 地址簿落地（B 记 A 地址）', bHasA, `devices=${bStatus0.devices.length}`);

  // 3. OutboundClient 主从裁决拨号 + sync.hello 互认 + online 双向（B 侧重取 status，小项 7c）
  //   joinRes.peerFingerprint 是 A 的指纹（B join A，peer=A）；A 的 devices 列表里是 B 的指纹（非 A 自己），
  //   故 A 侧用 .some(d => d.online)（A 只有一个 peer=B），B 侧用 begin.myFingerprint 精确匹配 A。
  await waitFor('A/B 互认 online 双向', async () => {
    const aSt = await localA.call('remote.status', {});
    const bSt = await localB.call('remote.status', {});
    const aOnlineB = aSt.devices.length > 0 && aSt.devices.every(d => d.online === true);
    const bOnlineA = bSt.devices.find(d => d.peerFingerprint === begin.myFingerprint)?.online;
    return aOnlineB === true && bOnlineA === true;
  }, 10000);
  const aStatus = await localA.call('remote.status', {});
  const bStatus = await localB.call('remote.status', {});
  const aOnlineB = aStatus.devices.length > 0 && aStatus.devices.every(d => d.online === true);
  const bOnlineA = bStatus.devices.find(d => d.peerFingerprint === begin.myFingerprint)?.online;
  const bFp = aStatus.devices[0]?.peerFingerprint; // B 的指纹（A 视角）供后续步骤用
  record('3. 在线点双向翻转（出站∪入站，B 侧重取）', aOnlineB === true && bOnlineA === true,
    `A看B=${aOnlineB}(B.fp=${bFp}) B看A=${bOnlineA}`);

  // 4. A 写一轮 → 秒级自动收敛
  const s = await localA.call('chat.sessions.create', {});
  await promptTurn(localA, s.id, '回合 1：A 写');
  await waitFor('B 收到 A 的消息', async () => {
    const bMsgs = (await localB.call('sync.pull', { sessionId: s.id })).messages;
    return bMsgs.length > 0;
  }, 10000);
  const aMsgs1 = (await localA.call('sync.pull', { sessionId: s.id })).messages.map(m => m.id);
  const bMsgs1 = (await localB.call('sync.pull', { sessionId: s.id })).messages.map(m => m.id);
  record('4. A 写→自动收敛 id 序列逐位一致', JSON.stringify(aMsgs1) === JSON.stringify(bMsgs1),
    `A=[${aMsgs1.join(',')}] B=[${bMsgs1.join(',')}]`);

  // 5. 双向各写一轮 + usedTokens 零差
  await promptTurn(localB, s.id, '回合 2：B 写');
  await waitFor('A 收到 B 的消息', async () => {
    const aMsgs = (await localA.call('sync.pull', { sessionId: s.id })).messages;
    return aMsgs.length >= aMsgs1.length + 2;
  }, 10000);
  const aMsgs2 = (await localA.call('sync.pull', { sessionId: s.id })).messages.map(m => m.id);
  const bMsgs2 = (await localB.call('sync.pull', { sessionId: s.id })).messages.map(m => m.id);
  const ctxA = await localA.call('chat.contextInfo', { sessionId: s.id });
  const ctxB = await localB.call('chat.contextInfo', { sessionId: s.id });
  record('5. 双向收敛 id 序列逐位一致 + usedTokens 零差',
    JSON.stringify(aMsgs2) === JSON.stringify(bMsgs2) && ctxA.usedTokens === ctxB.usedTokens,
    `ids一致=${JSON.stringify(aMsgs2) === JSON.stringify(bMsgs2)} A.tokens=${ctxA.usedTokens} B.tokens=${ctxB.usedTokens} diff=${Math.abs(ctxA.usedTokens - ctxB.usedTokens)}`);

  // 6. 断开 A 重启（端口持久化复用 minisd-port.json）→ 自动重连 + 增量收敛
  //   B 在 A 断线期间写一条 → A 重启后双向对账 pull 拿到
  const portFileA = join(dataRootA, 'minisd-port.json');
  const persistedPortBefore = JSON.parse(readFileSync(portFileA, 'utf8').replace(/\r\n/g, '\n')).port;
  // 关停 A
  localA.close();
  try { A.proc.kill(); } catch { /* */ }
  await sleep(800);

  // 8a. 在线点翻转：A 断开 → B 端 A.online=false
  await waitFor('B 看 A offline', async () => {
    const st = await localB.call('remote.status', {});
    const aOnline = st.devices.find(d => d.peerFingerprint === begin.myFingerprint)?.online;
    return aOnline === false;
  }, 8000);
  const bStatusOffline = await localB.call('remote.status', {});
  const bOnlineAOff = bStatusOffline.devices.find(d => d.peerFingerprint === begin.myFingerprint)?.online;
  record('8a. 在线点翻转：A 断开 → B 看 A offline', bOnlineAOff === false, `B看A=${bOnlineAOff}`);

  // B 在 A 断线期间写一条（A 重启后双向对账 pull 拿到）
  await promptTurn(localB, s.id, '回合 3：B 宕机期写');
  const bMsgsBeforeReconnect = (await localB.call('sync.pull', { sessionId: s.id })).messages.map(m => m.id);

  // 重启 A（同数据根，端口持久化复用 minisd-port.json）
  A = await spawnMinisd('A', dataRootA);
  record('6a. A 重启端口持久化复用', A.port === persistedPortBefore,
    `重启前=${persistedPortBefore} 重启后=${A.port} 文件=${JSON.parse(readFileSync(portFileA, 'utf8').replace(/\r\n/g, '\n')).port}`);
  const localA2 = rpcClient(`ws://127.0.0.1:${A.port}/?token=${A.token}`); await localA2.ready;

  // 等自动重连 + 增量收敛（A pull B 拿到宕机期消息）
  await waitFor('A 重连对账拿到 B 宕机期消息', async () => {
    const aMsgs = (await localA2.call('sync.pull', { sessionId: s.id })).messages;
    return aMsgs.length >= bMsgsBeforeReconnect.length;
  }, 15000);
  const aMsgsAfter = (await localA2.call('sync.pull', { sessionId: s.id })).messages.map(m => m.id);
  const bMsgsAfter = (await localB.call('sync.pull', { sessionId: s.id })).messages.map(m => m.id);
  record('6b. 断线重连增量收敛（端口持久化 + 双向对账）',
    JSON.stringify(aMsgsAfter) === JSON.stringify(bMsgsAfter),
    `A=[${aMsgsAfter.join(',')}] B=[${bMsgsAfter.join(',')}]`);

  // 8b. 在线点翻转：A 重连 → B 端 A.online=true
  await waitFor('B 看 A online（重连后）', async () => {
    const st = await localB.call('remote.status', {});
    const aOnline = st.devices.find(d => d.peerFingerprint === begin.myFingerprint)?.online;
    return aOnline === true;
  }, 10000);
  const bStatusOnline = await localB.call('remote.status', {});
  const bOnlineAOn = bStatusOnline.devices.find(d => d.peerFingerprint === begin.myFingerprint)?.online;
  record('8b. 在线点翻转：A 重连 → B 看 A online', bOnlineAOn === true, `B看A=${bOnlineAOn}`);

  // 7. 静默期 sync.dirty 通知 + synced 事件计数不增长（防 ping-pong 实证）
  const dirtyBefore = localB.notifications.filter(n => n.method === 'sync.dirty').length;
  const syncedBefore = localB.notifications.filter(n => n.method === 'chat.event' && n.params?.kind === 'synced').length;
  await sleep(3000); // 静默 3s
  const dirtyAfter = localB.notifications.filter(n => n.method === 'sync.dirty').length;
  const syncedAfter = localB.notifications.filter(n => n.method === 'chat.event' && n.params?.kind === 'synced').length;
  record('7. 静默期 sync.dirty + synced 不增长（ping-pong 终止性）',
    dirtyAfter === dirtyBefore && syncedAfter === syncedBefore,
    `sync.dirty: ${dirtyBefore}→${dirtyAfter} synced: ${syncedBefore}→${syncedAfter}`);

  localA2.close();
  localB.close();
} catch (e) {
  record('异常', false, e.message + '\n' + (e.stack ?? ''));
} finally {
  // 后端进程清理
  if (A) { try { A.proc.kill(); } catch { /* */ } }
  if (B) { try { B.proc.kill(); } catch { /* */ } }
  await sleep(300);
}

// ============ UI CDP 段（用例 9） ============
let uiChild;
let uiDataRoot;
try {
  uiDataRoot = mkdtempSync(join(tmpdir(), 'dm-m3c-ui-'));
  writeFileSync(join(uiDataRoot, 'providers.json'), JSON.stringify({
    providers: [{ id: '__fake__', name: 'fake', kind: 'openai-compat', modelId: 'fake' }],
    defaultProviderId: '__fake__',
  }), 'utf8');
  console.log('\nUI CDP 段临时数据根: ' + uiDataRoot);

  const ELECTRON_VITE_BIN = join(process.cwd(), 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
  uiChild = spawn(process.execPath, [ELECTRON_VITE_BIN, 'dev', '--', '--remote-debugging-port=9222'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DESKMINIS_DATA_DIR: uiDataRoot,
      DESKMINIS_TEST: '1',
      DESKMINIS_E2E: '1',
      DESKMINIS_FAKE_PROVIDER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  uiChild.stdout.on('data', d => process.stderr.write('[dev] ' + d));
  uiChild.stderr.on('data', d => process.stderr.write('[dev] ' + d));

  // 等 9222 透传
  let targets;
  {
    const t0 = Date.now();
    for (;;) {
      try { targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json()); break; } catch { /* */ }
      if (Date.now() - t0 > 60_000) throw new Error('9222 不透（60s）');
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
      if (Date.now() - t0 > 60_000) throw new Error('找不到渲染 page');
      await sleep(500);
      targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json());
    }
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  // 先等初始挂载再 reload（e2e-mu2a 技法①）
  await waitForDom(cdp, `!!document.querySelector('textarea.field')`, 60_000, '初始挂载');
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(500);
  await waitForDom(cdp, `!!document.querySelector('textarea.field')`, 60_000, 'reload 后挂载');

  // 9a. TitleBar 状态点三态 CSS 规则存在（offline/idle/syncing + pulse 动画）
  const syncdotCssOk = await evaluate(cdp, `(() => {
    const sheets = [...document.styleSheets];
    for (const s of sheets) {
      try {
        const rules = [...s.cssRules];
        for (const r of rules) {
          if (r.selectorText && r.selectorText.includes('.syncdot')) return true;
        }
      } catch { /* cross-origin */ }
    }
    return false;
  })()`);
  // 初始态 .syncdot.offline（无在线设备）
  const syncdotOfflineOk = await evaluate(cdp, `!!document.querySelector('.syncdot.offline')`);
  record('9a. TitleBar 状态点三态 CSS + 初始 offline', syncdotCssOk === true && syncdotOfflineOk === true,
    `css=${syncdotCssOk} offline=${syncdotOfflineOk}`);

  // 9b. 设备与同步按钮开模态验两输入（host:port + 配对码，免手抄公钥）
  await evaluate(cdp, `[...document.querySelectorAll('.lfbtn')].find(b => b.textContent.includes('设备'))?.click()`);
  await waitForDom(cdp, `!!document.querySelector('.joinrow')`, 10_000, 'DevicesModal 加入配对两输入');
  const joinInputsOk = await evaluate(cdp, `(() => {
    const joinAddr = document.querySelector('.joinrow .joinaddr');
    const codeInput = document.querySelector('.joinrow .codeinput');
    // 验免手抄公钥：无 joinPubKey 输入
    const noPubKey = !document.querySelector('.joinrow input[name="pubKey"]') &&
                     !document.querySelector('.joinrow .pubkeyinput');
    return !!joinAddr && !!codeInput && noPubKey;
  })()`);
  record('9b. DevicesModal 加入配对两输入（host:port + 配对码，免手抄公钥）', joinInputsOk === true,
    `两输入存在+无公钥输入=${joinInputsOk}`);

  cdp.close();
} catch (e) {
  record('9. UI CDP 异常', false, e.message);
} finally {
  if (uiChild?.pid) {
    try { spawnSync('taskkill', ['/pid', String(uiChild.pid), '/T', '/F'], { stdio: 'pipe' }); } catch { /* */ }
  }
  await sleep(500);
  if (uiDataRoot) { try { rmSync(uiDataRoot, { recursive: true, force: true }); } catch { /* */ } }
}

// ============ 收尾 ============
if (dataRootA) { try { rmSync(dataRootA, { recursive: true, force: true }); } catch { /* */ } }
if (dataRootB) { try { rmSync(dataRootB, { recursive: true, force: true }); } catch { /* */ } }

console.log(`\n===== M3c e2e: ${results.filter(r => r.pass).length}/${results.length} 步通过 =====`);
process.exit(results.every(r => r.pass) ? 0 : 1);
