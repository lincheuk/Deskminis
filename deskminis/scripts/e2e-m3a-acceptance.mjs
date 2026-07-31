// DeskMinis M3a 端到端验收驱动（对应 docs/plans/2026-07-31-m3a-remote-access.md「完成定义」）。
// 用法：先 `npm run build`，再 `npm run e2e:m3a`。
//
// 覆盖（本地完整链路，不联网）：
//   1) 配对：local 调 remote.pair.begin → pairing 模式 complete → 两端 fingerprint 一致
//   2) PASETO：用 authKey 铸 v4.local token（exp/iat/device_fingerprint，毫秒）
//   3) WS 远程连接：?paseto= 连上，authMode=remote
//   4) 业务面：remote 调 chat.sessions.list → 收到结果
//   5) 广播：local 调 chat.prompt（fake provider）→ remote 连接收 chat.event 广播
//   6) 边界：remote 调 remote.pair.begin → 被拒（设计注意点 a：remote.* 仅 local 可调）
//
// 环境隔离：临时数据根（mkdtemp）+ DESKMINIS_TEST=1（InMemoryVault）+ MINISD_HOST=127.0.0.1，结束 rmSync。
//
// authKey 派生策略（红线 4e：remote.status 不返回密钥材料）：
//   e2e 扮演手机端，独立用 ECDH 对称性派生 authKey（phonePriv + desktopPub + code → HKDF），
//   与 minisd 端 completePairing 存的 authKey 一致（ECDH getSharedSecret 对称性保证）。
//   这同时验证了两端密码学实现一致性——若 minisd 端 derivePairingKey 有误，PASETO 会被拒绝。

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const MINISD_ENTRY = join(process.cwd(), 'out', 'main', 'minisd.js');
if (!existsSync(MINISD_ENTRY)) { console.error('找不到 out/main/minisd.js —— 先 npm run build'); process.exit(2); }

// ---- 临时数据根 + 最小 providers.json（__fake__ 为默认，DESKMINIS_FAKE_PROVIDER=1 时 FakeProvider 接管） ----
const DATA_ROOT = mkdtempSync(join(tmpdir(), 'dm-e2e-m3a-'));
writeFileSync(join(DATA_ROOT, 'providers.json'), JSON.stringify({
  providers: [{ id: '__fake__', name: 'fake', kind: 'openai-compat', modelId: 'fake' }],
  defaultProviderId: '__fake__',
}, null, 2), 'utf8');
console.log('临时数据根: ' + DATA_ROOT);

const results = [];
const record = (step, pass, detail) => { results.push({ step, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  [${step}] ${detail}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- PASETO v4.local encode（与 src/minisd/remote/paseto.ts 一致；e2e 独立实现验证两端一致） ----
const PASETO_HEADER = 'v4.local';
const NONCE_LEN = 24;
function encodePaseto(payload, authKey) {
  const nonce = randomBytes(NONCE_LEN);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  // pre-auth: 'v4.local' + 0x00 + nonce
  const aad = Buffer.concat([Buffer.from(PASETO_HEADER, 'ascii'), Buffer.from([0x00]), nonce]);
  const cipher = xchacha20poly1305(authKey, nonce, aad);
  const sealed = cipher.encrypt(plaintext);
  const b64u = bytes => Buffer.from(bytes).toString('base64url');
  return `${PASETO_HEADER}.${b64u(nonce)}.${b64u(sealed)}`;
}

// ---- authKey 派生（与 src/minisd/remote/pairing.ts derivePairingKey 的 authKey 部分一致） ----
const HKDF_INFO_PAIRING = new TextEncoder().encode('DeskMinis/PairingKey/v1');
function deriveAuthKey(myPriv, peerPub, code) {
  const shared = x25519.getSharedSecret(myPriv, peerPub);
  const salt = new TextEncoder().encode(code);
  const derived = hkdf(sha256, shared, salt, HKDF_INFO_PAIRING, 64);
  return derived.slice(0, 32); // authKey（前 32 字节）
}

// ---- 设备指纹（与 StaticIdentity.fingerprint 一致：sha256(pubKey).slice(0,6) → 12 hex） ----
function deviceFingerprint(pubKey) {
  return Buffer.from(sha256(pubKey).slice(0, 6)).toString('hex');
}

// ---- spawn minisd standalone ----
const proc = spawn(electronBin, [MINISD_ENTRY], {
  env: {
    ...process.env,
    DESKMINIS_STANDALONE: '1',
    DESKMINIS_TEST: '1',
    DESKMINIS_FAKE_PROVIDER: '1',
    DESKMINIS_DATA_DIR: DATA_ROOT,
    MINISD_HOST: '127.0.0.1',
    ELECTRON_RUN_AS_NODE: '1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let port = 0, token = '';
proc.stdout.on('data', d => {
  const lines = d.toString().split('\n');
  for (const line of lines) {
    try { const o = JSON.parse(line); if (o.minisdPort && o.authToken) { port = o.minisdPort; token = o.authToken; } } catch { /* 日志行 */ }
  }
});
proc.stderr.on('data', d => process.stderr.write('[minisd] ' + d.toString()));

function wsConnect(query) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?${query}`);
    let idc = 0;
    const pending = new Map();
    const notifications = [];
    ws.on('message', data => {
      const msg = JSON.parse(String(data));
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      else if (msg.method) notifications.push(msg);
    });
    ws.on('open', () => res({
      ws,
      call: (method, params) => new Promise((resolve, reject) => {
        const id = ++idc;
        pending.set(id, m => m.error ? reject(new Error(`${method}: ${m.error.message ?? JSON.stringify(m.error)}`)) : resolve(m.result));
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      }),
      notifications,
    }));
    ws.on('error', rej);
  });
}

await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('minisd 启动超时（15s）')), 15000);
  const check = () => { if (port && token) { clearTimeout(t); res(); } else setTimeout(check, 100); };
  check();
});
console.log(`minisd 起来: port=${port}`);

let local, pairingConn, remote;
try {
  // 1. local 连接 + remote.pair.begin
  local = await wsConnect(`token=${token}`);
  const begin = await local.call('remote.pair.begin', {});
  record('begin', begin.pairingCode.length === 8 && begin.myFingerprint.length === 12,
    `code=${begin.pairingCode} fp=${begin.myFingerprint} pub=${begin.myPublicKeyB64.slice(0, 12)}...`);

  // 2. 手机端生成临时 X25519 keypair + 算指纹（noble/curves 用 keygen()，与 pairing.ts StaticIdentity 一致）
  const phoneKp = x25519.keygen();
  const phonePriv = phoneKp.secretKey;
  const phonePub = phoneKp.publicKey;
  const phonePubB64 = Buffer.from(phonePub).toString('base64');
  const phoneFp = deviceFingerprint(phonePub);

  // 3. pairing 模式 complete（?pairingCode= 连接，只能调 remote.pair.complete）
  pairingConn = await wsConnect(`pairingCode=${begin.pairingCode}`);
  const done = await pairingConn.call('remote.pair.complete', {
    pairingCode: begin.pairingCode,
    peerPublicKey: phonePubB64,
    peerFingerprint: phoneFp,
    peerName: 'e2e-phone',
  });
  record('complete', done.ok === true && done.peerFingerprint === phoneFp,
    `ok=${done.ok} 对端fp=${done.peerFingerprint}（应=${phoneFp}）`);
  pairingConn.ws.close();

  // 4. e2e 独立派生 authKey（ECDH 对称性：phonePriv + desktopPub → 与 minisd 端一致）
  const desktopPub = new Uint8Array(Buffer.from(begin.myPublicKeyB64, 'base64'));
  const authKey = deriveAuthKey(phonePriv, desktopPub, begin.pairingCode);

  // 5. 铸 PASETO v4.local（exp/iat 毫秒，10 分钟时效）
  const now = Date.now();
  const paseto = encodePaseto(
    { iat: now, exp: now + 10 * 60 * 1000, device_fingerprint: phoneFp },
    authKey,
  );
  record('paseto', paseto.startsWith('v4.local.'), `token 前 20=${paseto.slice(0, 20)}...`);

  // 6. remote 连接（?paseto=）→ authMode=remote → 调业务面 chat.sessions.list
  remote = await wsConnect(`paseto=${encodeURIComponent(paseto)}`);
  const list = await remote.call('chat.sessions.list', {});
  record('remote.list', Array.isArray(list), `sessions=${list.length}`);

  // 7. 广播：local 建会话 + chat.prompt（fake provider）→ remote 收 chat.event
  const sess = await local.call('chat.sessions.create', { title: 'm3a-e2e' });
  await local.call('chat.prompt', { sessionId: sess.id, text: '你好' });
  let gotEvent = false;
  for (let i = 0; i < 100; i++) {
    if (remote.notifications.some(n => n.method === 'chat.event' && n.params.sessionId === sess.id)) { gotEvent = true; break; }
    await sleep(50);
  }
  record('broadcast', gotEvent, 'remote 收到 chat.event 广播');

  // 8. 边界：remote 调 remote.pair.begin → 被拒（设计注意点 a：remote.* 仅 local 可调）
  let denied = null;
  try { await remote.call('remote.pair.begin', {}); }
  catch (e) { denied = e; }
  record('denied', !!denied, `remote 调 remote.pair.begin ${denied ? '被拒: ' + denied.message : '未拒绝（红线违反）'}`);
} catch (e) {
  record('error', false, e.message);
} finally {
  try { remote?.ws?.close(); } catch { /* 尽力 */ }
  try { pairingConn?.ws?.close(); } catch { /* 尽力 */ }
  try { local?.ws?.close(); } catch { /* 尽力 */ }
  try { proc.kill(); } catch { /* 尽力 */ }
  await sleep(500);
  try { rmSync(DATA_ROOT, { recursive: true, force: true }); console.log('临时数据根已清理'); }
  catch { console.warn('临时数据根清理失败: ' + DATA_ROOT); }
}

const pass = results.filter(r => r.pass).length;
console.log(`\nM3a e2e: ${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
