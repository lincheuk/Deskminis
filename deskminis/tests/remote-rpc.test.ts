import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import { PairingStore, PairingService, StaticIdentity, derivePairingKey, type PairingKey } from '../src/minisd/remote/pairing';
import { createRemoteMethods, createAdditionalVerify, guardBusinessMethod, PAIRING_CODE_TTL_S } from '../src/minisd/remote';
import { encodePaseto } from '../src/minisd/remote/paseto';
import type { AuthMode, RpcConnection, RpcMethods } from '../src/minisd/rpc/server';

let dataDir: string;
let vault: InMemoryVault;
let store: PairingStore;
let service: PairingService;
let methods: RpcMethods;
let additionalVerify: ReturnType<typeof createAdditionalVerify>;

function makeConn(mode: AuthMode): RpcConnection {
  return { authMode: mode, notify: () => {} };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'dm-rpc-'));
  vault = new InMemoryVault();
  store = new PairingStore(dataDir, vault);
  service = new PairingService(store, vault);
  methods = createRemoteMethods(service);
  additionalVerify = createAdditionalVerify(service);
});
afterEach(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 尽力 */ } });

describe('remote.pair.begin（仅 local）', () => {
  it('local 模式调 → 返回 {pairingCode, myPublicKey, myFingerprint, expiresIn}', async () => {
    const r = await methods['remote.pair.begin']!({}, makeConn('local')) as any;
    expect(typeof r.pairingCode).toBe('string');
    expect(r.pairingCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(r.myPublicKey).toBeInstanceOf(Uint8Array);
    expect(r.myPublicKey.length).toBe(32);
    expect(typeof r.myFingerprint).toBe('string');
    expect(r.myFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(r.expiresIn).toBe(PAIRING_CODE_TTL_S);
  });

  it('每次调用生成新配对码与新握手（随机性）', async () => {
    const a = await methods['remote.pair.begin']!({}, makeConn('local')) as any;
    const b = await methods['remote.pair.begin']!({}, makeConn('local')) as any;
    expect(a.pairingCode).not.toBe(b.pairingCode);
  });

  it('pairing 模式调 → 拒（配对期不能再开新配对）', async () => {
    await expect(methods['remote.pair.begin']!({}, makeConn('pairing'))).rejects.toThrow(/local|权限|authMode/i);
  });

  it('remote 模式调 → 拒（远程端不能自己给自己续配对，红线 4c）', async () => {
    await expect(methods['remote.pair.begin']!({}, makeConn('remote'))).rejects.toThrow(/local|权限|authMode/i);
  });
});

describe('remote.pair.complete（仅 pairing）', () => {
  it('pairing 模式 + 合法 code + 对端公钥 → 完成配对，存入 vault', async () => {
    const begin = await methods['remote.pair.begin']!({}, makeConn('local')) as any;
    const peer = new StaticIdentity();
    const r = await methods['remote.pair.complete']!({
      pairingCode: begin.pairingCode,
      peerPublicKey: peer.publicKey,
      peerFingerprint: peer.fingerprint,
      peerName: '我的手机',
    }, makeConn('pairing')) as any;
    expect(r.ok).toBe(true);
    expect(r.peerFingerprint).toBe(peer.fingerprint);
    expect(store.get(peer.fingerprint)).toBeDefined();
  });

  it('完成配对后，pairingCode 立即失效（一次性）', async () => {
    const begin = await methods['remote.pair.begin']!({}, makeConn('local')) as any;
    const peer = new StaticIdentity();
    await methods['remote.pair.complete']!({
      pairingCode: begin.pairingCode,
      peerPublicKey: peer.publicKey,
      peerFingerprint: peer.fingerprint,
    }, makeConn('pairing'));
    await expect(methods['remote.pair.complete']!({
      pairingCode: begin.pairingCode,
      peerPublicKey: peer.publicKey,
      peerFingerprint: peer.fingerprint,
    }, makeConn('pairing'))).rejects.toThrow(/code|配对码|失效|过期/i);
  });

  it('local 模式调 pair.complete → 拒（必须走 pairing 握手期）', async () => {
    await expect(methods['remote.pair.complete']!({}, makeConn('local'))).rejects.toThrow(/pairing|authMode/i);
  });

  it('remote 模式调 pair.complete → 拒', async () => {
    await expect(methods['remote.pair.complete']!({}, makeConn('remote'))).rejects.toThrow(/pairing|authMode/i);
  });

  it('过期 code（>5min）→ 拒', async () => {
    const begin = await methods['remote.pair.begin']!({}, makeConn('local')) as any;
    (service as any).pending.get(begin.pairingCode).expiresAt = Math.floor(Date.now() / 1000) - 1;
    const peer = new StaticIdentity();
    await expect(methods['remote.pair.complete']!({
      pairingCode: begin.pairingCode,
      peerPublicKey: peer.publicKey,
      peerFingerprint: peer.fingerprint,
    }, makeConn('pairing'))).rejects.toThrow(/过期|expired|失效/i);
  });
});

describe('remote.status（仅 local）', () => {
  it('local 模式 → 返回脱敏列表', async () => {
    const peer = new StaticIdentity();
    const me = new StaticIdentity();
    const key = derivePairingKey(me.privateKey, peer.publicKey, 'CODE1234', peer.fingerprint, 'phone');
    store.save(key);
    const r = await methods['remote.status']!({}, makeConn('local')) as any;
    expect(Array.isArray(r.devices)).toBe(true);
    expect(r.devices).toHaveLength(1);
    const item = r.devices[0];
    expect(item.peerFingerprint).toBe(peer.fingerprint);
    expect(item.peerName).toBe('phone');
    expect(item.authKey).toBeUndefined();
    expect(item.sessionSecret).toBeUndefined();
  });

  it('pairing/remote 模式 → 拒', async () => {
    await expect(methods['remote.status']!({}, makeConn('pairing'))).rejects.toThrow(/local|authMode/i);
    await expect(methods['remote.status']!({}, makeConn('remote'))).rejects.toThrow(/local|authMode/i);
  });
});

describe('remote.unpair（仅 local）', () => {
  it('local 模式 → 删除指定 fingerprint', async () => {
    const peer = new StaticIdentity();
    const me = new StaticIdentity();
    const key = derivePairingKey(me.privateKey, peer.publicKey, 'CODE1234', peer.fingerprint, 'phone');
    store.save(key);
    expect(store.list()).toHaveLength(1);
    const r = await methods['remote.unpair']!({ peerFingerprint: peer.fingerprint }, makeConn('local')) as any;
    expect(r.ok).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it('pairing/remote 模式 → 拒', async () => {
    await expect(methods['remote.unpair']!({ peerFingerprint: 'x' }, makeConn('pairing'))).rejects.toThrow(/local|authMode/i);
    await expect(methods['remote.unpair']!({ peerFingerprint: 'x' }, makeConn('remote'))).rejects.toThrow(/local|authMode/i);
  });
});

describe('createAdditionalVerify', () => {
  it('?paseto=合法 → {ok:true, authMode:remote}', async () => {
    const peer = new StaticIdentity();
    const me = new StaticIdentity();
    const key = derivePairingKey(me.privateKey, peer.publicKey, 'CODE1234', peer.fingerprint);
    store.save(key);
    const token = encodePaseto({
      exp: Date.now() + 60_000,
      iat: Date.now(),
      device_fingerprint: peer.fingerprint,
    }, key.authKey);
    const url = new URL(`ws://x/?paseto=${encodeURIComponent(token)}`);
    const r = await additionalVerify({ req: {} as any, url });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.authMode).toBe('remote');
  });

  it('?paseto=错密钥 → {ok:false}', async () => {
    const token = encodePaseto({
      exp: Date.now() + 60_000, iat: Date.now(), device_fingerprint: 'x',
    }, new Uint8Array(32).fill(1));
    const url = new URL(`ws://x/?paseto=${encodeURIComponent(token)}`);
    const r = await additionalVerify({ req: {} as any, url });
    expect(r.ok).toBe(false);
  });

  it('?pairingCode=合法（begin 后未过期）→ {ok:true, authMode:pairing}', async () => {
    const begin = await methods['remote.pair.begin']!({}, makeConn('local')) as any;
    const url = new URL(`ws://x/?pairingCode=${begin.pairingCode}`);
    const r = await additionalVerify({ req: {} as any, url });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.authMode).toBe('pairing');
  });

  it('?pairingCode=不存在的 code → {ok:false}', async () => {
    const url = new URL('ws://x/?pairingCode=NOTEXIST');
    const r = await additionalVerify({ req: {} as any, url });
    expect(r.ok).toBe(false);
  });

  it('?pairingCode=已过期的 code → {ok:false}', async () => {
    const begin = await methods['remote.pair.begin']!({}, makeConn('local')) as any;
    (service as any).pending.get(begin.pairingCode).expiresAt = Math.floor(Date.now() / 1000) - 1;
    const url = new URL(`ws://x/?pairingCode=${begin.pairingCode}`);
    const r = await additionalVerify({ req: {} as any, url });
    expect(r.ok).toBe(false);
  });

  it('无 paseto 也无 pairingCode → {ok:false}', async () => {
    const url = new URL('ws://x/');
    const r = await additionalVerify({ req: {} as any, url });
    expect(r.ok).toBe(false);
  });

  it('complete 后 pairingCode 立即失效（additionalVerify 也拒）', async () => {
    const begin = await methods['remote.pair.begin']!({}, makeConn('local')) as any;
    const peer = new StaticIdentity();
    await methods['remote.pair.complete']!({
      pairingCode: begin.pairingCode,
      peerPublicKey: peer.publicKey,
      peerFingerprint: peer.fingerprint,
    }, makeConn('pairing'));
    const url = new URL(`ws://x/?pairingCode=${begin.pairingCode}`);
    const r = await additionalVerify({ req: {} as any, url });
    expect(r.ok).toBe(false);
  });
});

describe('业务面拒 pairing（红线 4c）', () => {
  it('createRemoteMethods 返回的方法集只含 remote.* 四个', () => {
    expect(Object.keys(methods).filter(k => k.startsWith('remote.'))).toEqual([
      'remote.pair.begin', 'remote.pair.complete', 'remote.status', 'remote.unpair',
    ]);
  });
});

describe('guardBusinessMethod（业务面 pairing 模式守卫）', () => {
  it('pairing 模式调业务面 → 拒（同步抛错）', () => {
    const fake = guardBusinessMethod((_p: any, _c: any) => 'ok', 'chat.sessions.list');
    expect(() => fake({}, makeConn('pairing'))).toThrow(/pairing|chat\.sessions\.list/i);
  });
  it('local 模式调业务面 → 通过', () => {
    const fake = guardBusinessMethod((_p: any, _c: any) => 'ok', 'chat.sessions.list');
    expect(fake({}, makeConn('local'))).toBe('ok');
  });
  it('remote 模式调业务面 → 通过（remote 全开）', () => {
    const fake = guardBusinessMethod((_p: any, _c: any) => 'ok', 'chat.sessions.list');
    expect(fake({}, makeConn('remote'))).toBe('ok');
  });
});

describe('PairingService 过期清理', () => {
  it('begin 后等 TTL 过期，code 不再可用', async () => {
    const begin = await methods['remote.pair.begin']!({}, makeConn('local')) as any;
    (service as any).pending.get(begin.pairingCode).expiresAt = Math.floor(Date.now() / 1000) - 1;
    const url = new URL(`ws://x/?pairingCode=${begin.pairingCode}`);
    const r = await additionalVerify({ req: {} as any, url });
    expect(r.ok).toBe(false);
  });

  it('cleanupExpired() 移除所有过期 entry', async () => {
    const a = await methods['remote.pair.begin']!({}, makeConn('local')) as any;
    const b = await methods['remote.pair.begin']!({}, makeConn('local')) as any;
    (service as any).pending.get(a.pairingCode).expiresAt = Math.floor(Date.now() / 1000) - 1;
    service.cleanupExpired();
    expect((service as any).pending.size).toBe(1);
    expect((service as any).pending.has(b.pairingCode)).toBe(true);
  });
});
