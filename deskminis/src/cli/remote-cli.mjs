#!/usr/bin/env node
/**
 * DeskMinis 远程接入 CLI（M3a）：pair / connect / status / unpair。
 *
 * 连接 minisd 走 WS（?token=，local 模式）；port+token 经 env MINISD_PORT/MINISD_TOKEN 或 --port/--token。
 * connect 子命令用 @noble/curves 临时生成 X25519 keypair（模拟手机端；真机由 OpenMinis 实现）。
 *
 * 退出码：0 成功 / 1 一般错误 / 3 参数错误 / 4 minisd 不可达
 */
import WebSocket from 'ws';
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

const EXIT = { OK: 0, ERROR: 1, ARGS: 3, UNAVAILABLE: 4 };
const RPC_TIMEOUT_MS = 5000;

/** 计算 X25519 公钥的指纹（sha256 前 6 字节 → 12 hex 字符，与 pairing.ts StaticIdentity 一致）。 */
function fingerprintOf(publicKey) {
  return Buffer.from(sha256(publicKey).slice(0, 6)).toString('hex');
}

/** WS JSON-RPC 单次调用（local 模式，?token=）。 */
function rpc(port, token, method, params) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`);
    const timer = setTimeout(() => { ws.terminate(); rej(new Error('连接 minisd 超时')); }, RPC_TIMEOUT_MS);
    ws.on('error', e => { clearTimeout(timer); rej(e); });
    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
      ws.on('message', d => {
        clearTimeout(timer);
        ws.close();
        res(JSON.parse(String(d)));
      });
    });
  });
}

function parseGlobalArgs(argv) {
  const out = {
    port: process.env.MINISD_PORT,
    token: process.env.MINISD_TOKEN,
    rest: [],
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') { out.port = argv[++i]; continue; }
    if (argv[i] === '--token') { out.token = argv[++i]; continue; }
    if (argv[i] === '--help' || argv[i] === '-h') { out.help = true; continue; }
    out.rest.push(argv[i]);
  }
  return out;
}

const HELP = `DeskMinis 远程接入 CLI（M3a）

用法: node remote-cli.mjs <子命令> [参数] [--port <n>] [--token <t>]
环境: MINISD_PORT / MINISD_TOKEN（或 --port / --token）

子命令:
  pair                          生成 8 字配对码 + 桌面端公钥 + 指纹（桌面端用）
  connect <code> <peerPubKeyB64>  扮演手机端：用配对码 + 对端公钥完成握手，返回手机端指纹
  status                        列出所有已配对节点
  unpair <fingerprint>          取消配对

退出码: 0 成功 / 1 一般错误 / 3 参数错误 / 4 minisd 不可达
`;

async function main() {
  const args = parseGlobalArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); process.exit(EXIT.OK); return; }
  if (args.rest.length === 0) { process.stderr.write('缺少子命令\n\n' + HELP); process.exit(EXIT.ARGS); return; }
  const cmd = args.rest[0];
  if (!['pair', 'connect', 'status', 'unpair'].includes(cmd)) {
    process.stderr.write(`未知子命令: ${cmd}\n\n${HELP}`); process.exit(EXIT.ARGS); return;
  }
  if (!args.port || !args.token) {
    process.stderr.write('缺少 MINISD_PORT/MINISD_TOKEN（用 --port/--token 或 env 传入）\n');
    process.exit(EXIT.UNAVAILABLE); return;
  }

  try {
    if (cmd === 'pair') {
      const r = await rpc(args.port, args.token, 'remote.pair.begin', {});
      if (r.error) throw new Error(r.error.message);
      process.stdout.write(JSON.stringify(r.result, null, 2) + '\n');
      process.exit(EXIT.OK);
    } else if (cmd === 'connect') {
      const code = args.rest[1];
      const peerPubKeyB64 = args.rest[2];
      if (!code || !peerPubKeyB64) {
        process.stderr.write('connect 需要 <code> <peerPubKeyB64>\n'); process.exit(EXIT.ARGS); return;
      }
      // 临时 X25519 keypair（模拟手机端；真机由 OpenMinis 持久化）
      const kp = x25519.keygen();
      const ourPubKeyB64 = Buffer.from(kp.publicKey).toString('base64');
      const ourFingerprint = fingerprintOf(kp.publicKey);
      // 连 pairing 模式 WS（不带 token，用 pairingCode 鉴权）
      const r = await new Promise((res, rej) => {
        const ws = new WebSocket(`ws://127.0.0.1:${args.port}?pairingCode=${code}`);
        const timer = setTimeout(() => { ws.terminate(); rej(new Error('连接 minisd 超时')); }, RPC_TIMEOUT_MS);
        ws.on('error', e => { clearTimeout(timer); rej(e); });
        ws.on('open', () => {
          ws.send(JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'remote.pair.complete',
            params: {
              pairingCode: code,
              peerPublicKey: ourPubKeyB64,
              peerFingerprint: ourFingerprint,
              peerName: 'remote-cli',
            },
          }));
          ws.on('message', d => { clearTimeout(timer); ws.close(); res(JSON.parse(String(d))); });
        });
      });
      if (r.error) throw new Error(r.error.message);
      // 返回手机端的 fingerprint + 公钥（供两端比对）
      process.stdout.write(JSON.stringify({ fingerprint: ourFingerprint, ourPubKeyB64 }, null, 2) + '\n');
      process.exit(EXIT.OK);
    } else if (cmd === 'status') {
      const r = await rpc(args.port, args.token, 'remote.status', {});
      if (r.error) throw new Error(r.error.message);
      const devices = r.result.devices;
      if (devices.length === 0) {
        process.stdout.write('（无已配对节点）\n');
      } else {
        for (const d of devices) {
          process.stdout.write(`${d.peerFingerprint}  room=${d.roomId}  peer=${d.peerName}  createdAt=${new Date(d.createdAt * 1000).toISOString()}\n`);
        }
      }
      process.exit(EXIT.OK);
    } else if (cmd === 'unpair') {
      const fp = args.rest[1];
      if (!fp) { process.stderr.write('unpair 需要 <fingerprint>\n'); process.exit(EXIT.ARGS); return; }
      const r = await rpc(args.port, args.token, 'remote.unpair', { peerFingerprint: fp });
      if (r.error) throw new Error(r.error.message);
      process.stdout.write('ok\n');
      process.exit(EXIT.OK);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 连接错误 → 退出 4（minisd 不可达）
    if (/ECONNREFUSED|connect|超时|timeout/i.test(msg)) {
      process.stderr.write(`minisd 不可达: ${msg}\n`);
      process.exit(EXIT.UNAVAILABLE);
    }
    process.stderr.write(`错误: ${msg}\n`);
    process.exit(EXIT.ERROR);
  }
}

main();
