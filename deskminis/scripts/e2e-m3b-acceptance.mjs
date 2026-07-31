// DeskMinis M3b 端到端验收驱动（对应 docs/plans/2026-07-31-m3b-sync-engine.md「完成定义」）。
// 用法：先 `npm run build`，再 `npm run e2e:m3b`。
//
// 覆盖（本地完整链路，不联网）：
//   1) 双实例：A/B 两个 standalone minisd（各自临时数据根 + 不同 port）
//   2) M3a 配对互连：A 调 remote.pair.begin → B 调 remote.pair.complete → 两端 fingerprint + authKey 一致
//   3) A 端写入：chat.sessions.create + chat.prompt 4 轮（fake provider）
//   4) openDb 直落 marker：e2e 主进程用 better-sqlite3 直接 open A 的 minis.db 落 compact marker（评审命门 5b）
//   5) 单向同步：A 端 sync.pull 拿 wire payload → B 端 local token 连自己调 sync.push 入库
//   6) PASETO 远程调 sync.pull：B 端用 PASETO 连 A 调 sync.pull，断言与 local 一致（评审命门 5a）
//   7) 红线断言 1：两端 chat.contextInfo.usedTokens 差值 = 0
//   8) 红线断言 2：两端 sync.pull 拿到的消息 id 序列逐位完全一致
//   9) marker 同步成功：openDb 落的 marker 经 sync.pull 拉到 B 端
//
// 环境隔离：临时数据根（mkdtemp × 2）+ DESKMINIS_TEST=1（InMemoryVault）+ MINISD_HOST=127.0.0.1，结束 rmSync。
// authKey 派生：与 e2e-m3a 一致——独立用 ECDH 对称性派生（phonePriv + desktopPub + code → HKDF）。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

const require = createRequire(import.meta.url);
const electronBin = require('electron');
const Database = require('better-sqlite3');  // 评审命门 5b：openDb 直落 marker
const MINISD_ENTRY = join(process.cwd(), 'out', 'main', 'minisd.js');
if (!existsSync(MINISD_ENTRY)) { console.error('找不到 out/main/minisd.js —— 先 npm run build'); process.exit(2); }

const results = [];
const record = (step, pass, detail) => { results.push({ step, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  [${step}] ${detail}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- PASETO v4.local encode + authKey 派生（与 e2e-m3a 一致） ----
const PASETO_HEADER = 'v4.local';
const NONCE_LEN = 24;
function encodePaseto(payload, authKey) {
  const nonce = randomBytes(NONCE_LEN);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const aad = Buffer.concat([Buffer.from(PASETO_HEADER, 'ascii'), Buffer.from([0x00]), nonce]);
  const cipher = xchacha20poly1305(authKey, nonce, aad);
  const sealed = cipher.encrypt(plaintext);
  const b64u = bytes => Buffer.from(bytes).toString('base64url');
  return `${PASETO_HEADER}.${b64u(nonce)}.${b64u(sealed)}`;
}
const HKDF_INFO_PAIRING = new TextEncoder().encode('DeskMinis/PairingKey/v1');
function deriveAuthKey(myPriv, peerPub, code) {
  const shared = x25519.getSharedSecret(myPriv, peerPub);
  const salt = new TextEncoder().encode(code);
  return hkdf(sha256, shared, salt, HKDF_INFO_PAIRING, 64).slice(0, 32);
}
function deviceFingerprint(pubKey) {
  return Buffer.from(sha256(pubKey).slice(0, 6)).toString('hex');
}

// ---- spawn 单个 minisd 实例 ----
function spawnMinisd(label, dataRoot) {
  writeFileSync(join(dataRoot, 'providers.json'), JSON.stringify({
    providers: [{ id: '__fake__', name: 'fake', kind: 'openai-compat', modelId: 'fake' }],
    defaultProviderId: '__fake__',
  }), 'utf8');
  const proc = spawn(electronBin, [MINISD_ENTRY], {
    env: { ...process.env, DESKMINIS_STANDALONE: '1', DESKMINIS_TEST: '1', DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: dataRoot, MINISD_HOST: '127.0.0.1', ELECTRON_RUN_AS_NODE: '1' },
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
    setTimeout(() => reject(new Error(`${label} 启动超时`)), 10000);
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
    return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
  return { ready, call, notifications, close: () => ws.close() };
}

async function waitFor(what, cond, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await sleep(20);
  }
}

async function promptTurn(c, sessionId, text) {
  await c.call('chat.prompt', { sessionId, text, providerId: '__fake__' });
  await waitFor(`turnEnd for "${text.slice(0, 20)}"`, () =>
    c.notifications.some(n => n.method === 'chat.event' && n.params.sessionId === sessionId && n.params.event.kind === 'turnEnd'));
  c.notifications.length = 0;
}

async function main() {
  const dataRootA = mkdtempSync(join(tmpdir(), 'dm-m3b-A-'));
  const dataRootB = mkdtempSync(join(tmpdir(), 'dm-m3b-B-'));
  console.log('临时数据根 A: ' + dataRootA);
  console.log('临时数据根 B: ' + dataRootB);

  let A, B;
  try {
    A = await spawnMinisd('A', dataRootA);
    B = await spawnMinisd('B', dataRootB);
    console.log(`A port=${A.port} B port=${B.port}`);

    // 1) M3a 配对：A local 调 remote.pair.begin → B 用 pairingCode 连 A 调 remote.pair.complete
    const localA = rpcClient(`ws://127.0.0.1:${A.port}/?token=${A.token}`); await localA.ready;
    const begin = (await localA.call('remote.pair.begin', {})).result;
    record('1. beginPairing', !!begin.pairingCode, `code=${begin.pairingCode} fp=${begin.myFingerprint}`);

    // B 端扮演手机：生成临时 X25519 keypair → 用 pairingCode 连 A 调 remote.pair.complete
    const phoneKp = x25519.keygen();
    const phoneFp = deviceFingerprint(phoneKp.publicKey);
    const pairingUrl = `ws://127.0.0.1:${A.port}/?pairingCode=${begin.pairingCode}`;
    const pairConn = rpcClient(pairingUrl); await pairConn.ready;
    const complete = (await pairConn.call('remote.pair.complete', {
      pairingCode: begin.pairingCode,
      peerPublicKey: Buffer.from(phoneKp.publicKey).toString('base64'),
      peerFingerprint: phoneFp,
      peerName: 'B-phone',
    })).result;
    record('2. completePairing', complete.ok && complete.peerFingerprint === phoneFp, `peerFp=${complete.peerFingerprint}`);
    pairConn.close();

    // 派生 authKey（B 端作为手机，用 phonePriv + A 的公钥 + code）
    const authKey = deriveAuthKey(phoneKp.secretKey, Buffer.from(begin.myPublicKeyB64, 'base64'), begin.pairingCode);
    const paseto = encodePaseto({ exp: Date.now() + 60000, iat: Date.now(), device_fingerprint: phoneFp }, authKey);

    // 2) A 端写入：创建会话 + 4 轮对话
    const s = (await localA.call('chat.sessions.create', {})).result;
    await promptTurn(localA, s.id, '回合 1：测试同步前写入');
    await promptTurn(localA, s.id, '回合 2：继续追加');
    await promptTurn(localA, s.id, '回合 3：再追加');
    await promptTurn(localA, s.id, '回合 4：最后一轮');
    record('3. A 写入 4 轮对话', !!s.id, `sid=${s.id}`);

    // 3) A 端 sync.pull 拿 wire payload（消息列表，用于后续 marker 锚点）
    const payload = (await localA.call('sync.pull', { sessionId: s.id, afterTs: 0 })).result;
    record('4. A sync.pull', payload.messages.length > 0, `拿到 ${payload.messages.length} 条消息`);

    // 4) openDb 直落 compact marker（评审命门 5b）：e2e 主进程用 better-sqlite3 直接 open A 的
    //    minis.db（WAL 模式支持多进程共存——M2c 已实证），INSERT INTO compact_markers 落测试 marker。
    //    last_compacted_message_id 取 payload 最后一条消息 id（确保锚点存在，不产 orphan）。
    const lastMsgId = payload.messages[payload.messages.length - 1].id;
    const MARKER_ID = 'MK_E2E';
    try {
      const dbA = new Database(join(dataRootA, 'minis.db'));
      dbA.pragma('journal_mode = WAL');
      dbA.prepare(`INSERT INTO compact_markers (id, session_id, summary, last_compacted_message_id, created_at) VALUES (?,?,?,?,?)`)
        .run(MARKER_ID, s.id, 'e2e 摘要：前 4 轮已压缩', lastMsgId, Date.now() / 1000);
      dbA.close();
      record('5. openDb 直落 marker', true, `markerId=${MARKER_ID} lastCompactedMsgId=${lastMsgId}`);
    } catch (e) {
      // Step 2 实测为准：若真报 disk I/O（WAL 多进程冲突），回退现方案并在 commit 申报
      record('5. openDb 直落 marker', false, `disk I/O? ${e.message}——回退方案：marker 同步仅靠单测覆盖`);
    }

    // 5) A 端重新 sync.pull（含 marker）→ B 端 local token 连自己调 sync.push 入库
    const payloadWithMarker = (await localA.call('sync.pull', { sessionId: s.id, afterTs: 0 })).result;
    const localB = rpcClient(`ws://127.0.0.1:${B.port}/?token=${B.token}`); await localB.ready;
    const pushResult = (await localB.call('sync.push', { sessionId: s.id, payload: payloadWithMarker })).result;
    record('6. B sync.push', pushResult.mergedCount > 0, `mergedCount=${pushResult.mergedCount}`);

    // 6) PASETO 远程调 sync.pull（评审命门 5a）：B 端用派生的 PASETO 连 A 的 ?paseto= 端点调
    //    sync.pull，断言与 local token 拉取结果一致——sync.* 的 remote 面是本里程碑唯一新权限面。
    const remoteClient = rpcClient(`ws://127.0.0.1:${A.port}/?paseto=${paseto}`); await remoteClient.ready;
    const remotePull = (await remoteClient.call('sync.pull', { sessionId: s.id, afterTs: 0 })).result;
    const remoteIds = remotePull.messages.map(m => m.id);
    const localIds = payloadWithMarker.messages.map(m => m.id);
    record('7. PASETO 远程 sync.pull 与 local 一致', JSON.stringify(remoteIds) === JSON.stringify(localIds), `remote=[${remoteIds.join(',')}] local=[${localIds.join(',')}]`);
    remoteClient.close();

    // 7) 红线断言 1：两端 chat.contextInfo.usedTokens 差值 = 0
    //   （contextInfo 内部走 buildEffectiveHistory + estimateTokens，effectiveHistory 一致则 token 数必相等）
    const ctxA = (await localA.call('chat.contextInfo', { sessionId: s.id })).result;
    const ctxB = (await localB.call('chat.contextInfo', { sessionId: s.id })).result;
    record('8. usedTokens 差值=0', ctxA.usedTokens === ctxB.usedTokens, `A=${ctxA.usedTokens} B=${ctxB.usedTokens} diff=${Math.abs(ctxA.usedTokens - ctxB.usedTokens)}`);

    // 8) 红线断言 2：两端 sync.pull 拿到的消息 id 序列逐位完全一致（设计 §6）
    const pullA = (await localA.call('sync.pull', { sessionId: s.id, afterTs: 0 })).result;
    const pullB = (await localB.call('sync.pull', { sessionId: s.id, afterTs: 0 })).result;
    const idsA = pullA.messages.map(m => m.id);
    const idsB = pullB.messages.map(m => m.id);
    record('9. 消息 id 序列逐位一致', JSON.stringify(idsA) === JSON.stringify(idsB), `A=[${idsA.join(',')}] B=[${idsB.join(',')}]`);

    // 9) marker 同步成功：openDb 落的 marker 经 sync.pull 拉到 B 端
    const hasMarkerB = pullB.markers.some(m => m.id === MARKER_ID);
    record('10. marker 同步成功', hasMarkerB, `B markers=${JSON.stringify(pullB.markers.map(m => m.id))}`);

    localA.close(); localB.close();
  } finally {
    if (A) { try { A.proc.kill(); } catch {} }
    if (B) { try { B.proc.kill(); } catch {} }
    await sleep(200);
    try { rmSync(dataRootA, { recursive: true, force: true }); } catch {}
    try { rmSync(dataRootB, { recursive: true, force: true }); } catch {}
  }

  console.log(`\nM3b e2e: ${results.filter(r => r.pass).length}/${results.length} passed`);
  process.exit(results.every(r => r.pass) ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
