import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RpcMethods } from '../src/minisd/rpc/server';
import type { MinisdHandle } from '../src/minisd/index';
import type { PairBeginResult } from '../src/shared/pairing';
import { EventLog } from '../src/minisd/rpc/event-log';
import { StaticIdentity } from '../src/minisd/remote/pairing';
import { probeConnection } from './engine-assembly';
import baseline from './fixtures/rpc-access-baseline.json';

const capture = vi.hoisted(() => ({ methods: undefined as RpcMethods | undefined, events: undefined as unknown }));
vi.mock('../src/minisd/rpc/server', async importOriginal => {
  const original = await importOriginal<typeof import('../src/minisd/rpc/server')>();
  return { ...original, RpcServer: class extends original.RpcServer {
    constructor(...args: ConstructorParameters<typeof original.RpcServer>) {
      super(...args);
      capture.methods = args[0]; capture.events = args[3]?.events;
    }
  } };
});

const root = mkdtempSync(join(tmpdir(), 'dm-q06-assembly-'));
let engine: MinisdHandle | undefined;
const testEnv = process.env.DESKMINIS_TEST;
const peer = new StaticIdentity();
const methods = (): RpcMethods => { if (!capture.methods) throw Error('Real engine did not assemble RPC'); return capture.methods; };
beforeAll(async () => {
  process.env.DESKMINIS_TEST = '1';
  const { startMinisd } = await import('../src/minisd/index');
  engine = await startMinisd({ dataDir: root, host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  try { await engine?.close(); }
  finally {
    if (testEnv === undefined) delete process.env.DESKMINIS_TEST; else process.env.DESKMINIS_TEST = testEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Q06 完整真实引擎装配', () => {
  it('真实 RpcServer 收到完整方法全集及事件日志', () => {
    expect(Object.keys(methods()).sort()).toEqual(Object.keys(baseline.matrix).sort());
    expect(Object.isFrozen(methods())).toBe(true);
    expect(capture.events).toBeInstanceOf(EventLog);
  }, 60000);

  it('真实引擎所有业务组均在读参数/依赖之前拒绝 pairing', async () => {
    const params = new Proxy({}, { get: () => { throw Error('业务参数不应被读取'); } });
    for (const name of Object.keys(methods()).filter(n => !n.startsWith('remote.'))) {
      await expect(Promise.resolve().then(() => methods()[name](params, probeConnection('pairing'))), name).rejects.toThrow(`${name} 在 pairing 模式下不可用`);
    }
  }, 60000);

  it('走真实配对后，已配对远端仍可调用原有业务；本机同步返回值保留', async () => {
    const begin = await methods()['remote.pair.begin']({}, probeConnection('local')) as PairBeginResult;
    const paired = await methods()['remote.pair.complete']({ pairingCode: begin.pairingCode,
      peerPublicKey: Buffer.from(peer.publicKey).toString('base64'), peerFingerprint: peer.fingerprint }, probeConnection('pairing'));
    expect(paired).toMatchObject({ ok: true });
    const remote = { ...probeConnection('remote'), peerFingerprint: peer.fingerprint };
    expect(methods()['chat.sessions.list']({}, remote)).toEqual([]);
    expect(methods()['chat.sessions.list']({}, probeConnection('local'))).toEqual([]);
  }, 60000);

  it('真实配对记录撤销后，所有业务组都拒旧远端并请求关闭', async () => {
    await methods()['remote.unpair']({ peerFingerprint: peer.fingerprint }, probeConnection('local'));
    const params = new Proxy({}, { get: () => { throw Error('业务参数不应被读取'); } });
    for (const name of Object.keys(methods()).filter(n => !n.startsWith('remote.'))) {
      let closes = 0;
      const remote = { ...probeConnection('remote', () => { closes++; }), peerFingerprint: peer.fingerprint };
      await expect(Promise.resolve().then(() => methods()[name](params, remote)), name).rejects.toThrow(`${name} 被拒：这台设备已取消配对`);
      expect(closes, name).toBe(1);
    }
  }, 60000);
});
