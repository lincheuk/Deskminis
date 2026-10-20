/**
 * F06 K 组：RpcServer.broadcast 是唯一的入序点（src/minisd/rpc/server.ts + rpc/event-log.ts）。
 *
 * 裸 RpcServer、真实 WebSocket：
 *  - 配了 events：每条广播帧顶层带 ev，params 与以前深相等；不入序的方法帧不变；
 *  - 不配 events：帧与以前逐字相同（现有直接构造 RpcServer 的调用方不受影响）；
 *  - pairing 连接收不到广播，但序号照常分配（别的连接上不出现空洞之外的异常）；
 *  - 加密通道上的帧解开后带 ev（戳随整帧加密，链路上看不到）；
 *  - 没有任何连接时照常入序、留进窗口。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import { PairingStore, PairingService, derivePairingKey } from '../src/minisd/remote/pairing';
import { createAdditionalVerify } from '../src/minisd/remote';
import * as channelModule from '../src/minisd/remote/channel';
import { RpcServer, type AdditionalVerify } from '../src/minisd/rpc/server';
import { EventLog } from '../src/minisd/rpc/event-log';
import { waitFor } from './run-ledger-fixture';

type Cipher = { seal(text: string): Uint8Array; open(frame: Uint8Array): string };
const ch = channelModule as unknown as {
  beginClientHandshake(keys: { authKey: Uint8Array; sessionSecret: Uint8Array }, myFp: string, peerFp: string): { hello: string; finish(reply: string): Cipher };
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) { try { await cleanups.pop()!(); } catch { /* 收尾尽力 */ } } });

interface Raw { ws: WebSocket; texts: string[]; bins: Buffer[] }
function rawConnect(url: string): Promise<Raw> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const r: Raw = { ws, texts: [], bins: [] };
    ws.on('message', (d, isBinary) => { if (isBinary) r.bins.push(Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer)); else r.texts.push(String(d)); });
    ws.on('open', () => res(r));
    ws.on('error', rej);
  });
  }
async function boot(opts: { events?: EventLog } = {}, verify?: AdditionalVerify): Promise<{ rpc: RpcServer; port: number }> {
  const rpc = new RpcServer({ ping: () => 'pong' }, 'LOCAL-TOKEN', verify, opts);
  const port = await rpc.listen('127.0.0.1', 0);
  cleanups.push(() => rpc.close());
  return { rpc, port };
}
async function local(port: number): Promise<Raw> {
  const r = await rawConnect(`ws://127.0.0.1:${port}/?token=LOCAL-TOKEN`);
  cleanups.push(() => r.ws.terminate());
  return r;
}

describe('F06 K 组：RpcServer 的广播入序', () => {
  it('配了 events：帧顶层带 ev，同一条连接上 seq 连续；params 与以前深相等；terminal.output 没有 ev、不占号', async () => {
    const events = new EventLog({ epoch: 5 });
    const { rpc, port } = await boot({ events });
    const c = await local(port);
    rpc.broadcast('chat.event', { sessionId: 's', event: { kind: 'textDelta', text: '你好' }, run: { id: 'r', generation: 1, epoch: 5 } });
    rpc.broadcast('terminal.output', { sessionId: 's', data: 'ls\r\n' });
    rpc.broadcast('chat.sessions.changed', {});
    rpc.broadcast('permission.request', { requestId: 'R', req: { sessionId: 's' }, meta: { timeoutMs: 1 } });
    await waitFor('四帧', () => c.texts.length === 4);
    expect(c.texts.map(t => JSON.parse(t))).toEqual([
      { jsonrpc: '2.0', method: 'chat.event', params: { sessionId: 's', event: { kind: 'textDelta', text: '你好' }, run: { id: 'r', generation: 1, epoch: 5 } }, ev: { epoch: 5, seq: 1 } },
      { jsonrpc: '2.0', method: 'terminal.output', params: { sessionId: 's', data: 'ls\r\n' } },
      { jsonrpc: '2.0', method: 'chat.sessions.changed', params: {}, ev: { epoch: 5, seq: 2 } },
      { jsonrpc: '2.0', method: 'permission.request', params: { requestId: 'R', req: { sessionId: 's' }, meta: { timeoutMs: 1 } }, ev: { epoch: 5, seq: 3 } },
    ]);
    // 戳不在 params 里
    for (const t of c.texts) expect(JSON.parse(t).params.ev).toBeUndefined();
    expect(events.lastSeq).toBe(3);
  });

  it('不配 events：广播帧与以前逐字相同（没有 ev）', async () => {
    const { rpc, port } = await boot();
    const c = await local(port);
    rpc.broadcast('chat.event', { text: 'x' });
    rpc.broadcast('chat.sessions.changed', {});
    await waitFor('两帧', () => c.texts.length === 2);
    expect(c.texts).toEqual([
      JSON.stringify({ jsonrpc: '2.0', method: 'chat.event', params: { text: 'x' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'chat.sessions.changed', params: {} }),
    ]);
  });

  it('两条连接收到同一份帧（同一个 seq）；没有任何连接时照常入序并留进窗口', async () => {
    const events = new EventLog({ epoch: 1 });
    const { rpc, port } = await boot({ events });
    // 还没有连接
    rpc.broadcast('a.changed', { n: 1 });
    rpc.broadcast('a.changed', { n: 2 });
    expect(events.lastSeq).toBe(2);
    const a = await local(port);
    const b = await local(port);
    rpc.broadcast('a.changed', { n: 3 });
    await waitFor('两边各一帧', () => a.texts.length === 1 && b.texts.length === 1);
    expect(a.texts[0]).toBe(b.texts[0]);
    expect(JSON.parse(a.texts[0]).ev).toEqual({ epoch: 1, seq: 3 });
    // 断线期间的两帧靠窗口补
    const kept = events.since(0);
    expect(Array.isArray(kept) && kept.map(f => [f.ev.seq, (f.params as { n: number }).n])).toEqual([[1, 1], [2, 2], [3, 3]]);
  });

  it('pairing 连接收不到任何广播（带不带 ev 都没有）；序号照常分配，local 连接上仍然连续', async () => {
    const events = new EventLog({ epoch: 1 });
    const verify: AdditionalVerify = ({ url }) => (url.searchParams.has('pairingCode') ? { ok: true, authMode: 'pairing' } : { ok: false });
    const { rpc, port } = await boot({ events }, verify);
    const p = await rawConnect(`ws://127.0.0.1:${port}/?pairingCode=WHATEVER`);
    cleanups.push(() => p.ws.terminate());
    const c = await local(port);
    for (let i = 0; i < 3; i++) rpc.broadcast('chat.sessions.changed', {});
    await waitFor('local 收到三帧', () => c.texts.length === 3);
    expect(c.texts.map(t => JSON.parse(t).ev.seq)).toEqual([1, 2, 3]);
    // pairing 连接上发一个请求，等它的应答回来：在那之前排队的广播（若有）一定先到
    p.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    await waitFor('pairing 连接收到应答', () => p.texts.length >= 1);
    expect(p.texts.map(t => JSON.parse(t))).toEqual([{ jsonrpc: '2.0', id: 1, result: 'pong' }]);
    expect(p.bins).toEqual([]);
  });

  it('加密通道：链路上是密文，解开后的广播帧带 ev，与 local 连接收到的是同一帧', async () => {
    // 两端互存对方的配对密钥（remote-channel.test.ts 的做法）
    const dirA = mkdtempSync(join(tmpdir(), 'dm-f06-k-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'dm-f06-k-b-'));
    cleanups.push(() => { rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true }); });
    const vaultA = new InMemoryVault(); const vaultB = new InMemoryVault();
    const storeA = new PairingStore(dirA, vaultA); const storeB = new PairingStore(dirB, vaultB);
    const serviceA = new PairingService(storeA, vaultA); const serviceB = new PairingService(storeB, vaultB);
    const keyAtA = derivePairingKey((serviceA as any).identity.privateKey, serviceB.myPublicKey, 'F06CODE1', serviceB.myFingerprint, 'B');
    storeA.save(keyAtA);
    storeB.save(derivePairingKey((serviceB as any).identity.privateKey, serviceA.myPublicKey, 'F06CODE1', serviceA.myFingerprint, 'A'));

    const events = new EventLog({ epoch: 9 });
    const { rpc, port } = await boot({ events }, createAdditionalVerify(serviceB));
    const plain = await local(port);
    const r = await rawConnect(`ws://127.0.0.1:${port}/?ch=1`);
    cleanups.push(() => r.ws.terminate());
    const hs = ch.beginClientHandshake(keyAtA, serviceA.myFingerprint, serviceB.myFingerprint);
    r.ws.send(hs.hello);
    await waitFor('握手应答', () => r.texts.length === 1);
    const cipher = hs.finish(r.texts[0]);
    await waitFor('通道接上', () => rpc.isInboundOnline(serviceA.myFingerprint));

    rpc.broadcast('chat.event', { sessionId: 's', event: { kind: 'textDelta', text: 'SECRET-TEXT' }, run: { id: 'r', generation: 1, epoch: 9 } });
    await waitFor('两边各一帧', () => r.bins.length === 1 && plain.texts.length === 1);
    expect(r.bins[0].includes(Buffer.from('SECRET'))).toBe(false);
    expect(r.bins[0].includes(Buffer.from('"ev"'))).toBe(false);
    const opened = cipher.open(new Uint8Array(r.bins[0]));
    expect(opened).toBe(plain.texts[0]);
    expect(JSON.parse(opened).ev).toEqual({ epoch: 9, seq: 1 });
  });
});
