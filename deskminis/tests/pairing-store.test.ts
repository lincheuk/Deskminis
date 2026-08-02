import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import {
  PairingStore,
  PairingService,
  StaticIdentity,
  generatePairingCode,
  derivePairingKey,
  type PairingKey,
} from '../src/minisd/remote/pairing';

let dataDir: string;
let vault: InMemoryVault;
let store: PairingStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'dm-pair-'));
  vault = new InMemoryVault();
  store = new PairingStore(dataDir, vault);
});
afterEach(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 尽力 */ } });

describe('generatePairingCode', () => {
  it('8 字符，全大写字母+数字', () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
  });

  it('两次生成不同（随机性）', () => {
    const a = generatePairingCode();
    const b = generatePairingCode();
    expect(a).not.toBe(b);
  });

  it('去除易混淆字符（0/O/1/I/L）', () => {
    for (let i = 0; i < 100; i++) {
      const code = generatePairingCode();
      expect(code).not.toMatch(/[01OIL]/);
    }
  });
});

describe('derivePairingKey（ECDH + HKDF）', () => {
  it('两端相同 pairingCode + 互换公钥 → 派生出相同 auth_key/session_secret', () => {
    const A = new StaticIdentity();
    const B = new StaticIdentity();
    const code = 'ABCD2345';
    const keyA = derivePairingKey(A.privateKey, B.publicKey, code);
    const keyB = derivePairingKey(B.privateKey, A.publicKey, code);
    expect(keyA.authKey).toEqual(keyB.authKey);
    expect(keyA.sessionSecret).toEqual(keyB.sessionSecret);
    expect(keyA.roomId).toBe(keyB.roomId);
  });

  it('pairingCode 不同 → 派生结果不同', () => {
    const A = new StaticIdentity();
    const B = new StaticIdentity();
    const keyA = derivePairingKey(A.privateKey, B.publicKey, 'CODE1111');
    const keyB = derivePairingKey(A.privateKey, B.publicKey, 'CODE2222');
    expect(keyA.authKey).not.toEqual(keyB.authKey);
  });

  it('公钥不同 → 派生结果不同', () => {
    const A = new StaticIdentity();
    const B1 = new StaticIdentity();
    const B2 = new StaticIdentity();
    const key1 = derivePairingKey(A.privateKey, B1.publicKey, 'CODE1111');
    const key2 = derivePairingKey(A.privateKey, B2.publicKey, 'CODE1111');
    expect(key1.authKey).not.toEqual(key2.authKey);
  });

  it('authKey/sessionSecret 长度均为 32 字节', () => {
    const A = new StaticIdentity();
    const B = new StaticIdentity();
    const key = derivePairingKey(A.privateKey, B.publicKey, 'ABCD2345');
    expect(key.authKey.length).toBe(32);
    expect(key.sessionSecret.length).toBe(32);
  });

  it('roomId 是 8 字符 base32 串（中继房间定位用，本期 LAN 直连不消费）', () => {
    const A = new StaticIdentity();
    const B = new StaticIdentity();
    const key = derivePairingKey(A.privateKey, B.publicKey, 'ABCD2345');
    expect(key.roomId).toMatch(/^[A-Z2-7]{8}$/);
  });

  it('createdAt 是 epoch 秒（不是毫秒）', () => {
    const A = new StaticIdentity();
    const B = new StaticIdentity();
    const before = Math.floor(Date.now() / 1000);
    const key = derivePairingKey(A.privateKey, B.publicKey, 'ABCD2345');
    const after = Math.floor(Date.now() / 1000);
    expect(key.createdAt).toBeGreaterThanOrEqual(before);
    expect(key.createdAt).toBeLessThanOrEqual(after);
    // epoch 秒约 10 位（2026 年约 17 亿），毫秒约 13 位（约 17 万亿）
    expect(key.createdAt).toBeLessThan(10_000_000_000);
  });
});

describe('StaticIdentity（X25519 静态密钥对）', () => {
  it('publicKey 32 字节，privateKey 32 字节', () => {
    const h = new StaticIdentity();
    expect(h.publicKey.length).toBe(32);
    expect(h.privateKey.length).toBe(32);
  });

  it('两次实例化生成不同密钥对（无参构造）', () => {
    const a = new StaticIdentity();
    const b = new StaticIdentity();
    expect(a.privateKey).not.toEqual(b.privateKey);
  });

  it('fingerprint = sha256(publicKey).slice(0,6) 十六进制（12 hex 字符，48-bit 强度防碰撞）', () => {
    const h = new StaticIdentity();
    expect(h.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it('loadOrCreate：首次生成并持久化到 vault，二次加载复用同一密钥', () => {
    const v = new InMemoryVault();
    expect(v.get('pairing.static-identity')).toBeUndefined();
    const a = StaticIdentity.loadOrCreate(v);
    expect(v.get('pairing.static-identity')).toBeTruthy();
    const b = StaticIdentity.loadOrCreate(v);
    expect(Buffer.from(a.privateKey).equals(Buffer.from(b.privateKey))).toBe(true);
    expect(Buffer.from(a.publicKey).equals(Buffer.from(b.publicKey))).toBe(true);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('从已有私钥构造（测试/恢复场景）', () => {
    const orig = new StaticIdentity();
    const restored = new StaticIdentity(orig.privateKey);
    expect(Buffer.from(restored.privateKey).equals(Buffer.from(orig.privateKey))).toBe(true);
    expect(Buffer.from(restored.publicKey).equals(Buffer.from(orig.publicKey))).toBe(true);
    expect(restored.fingerprint).toBe(orig.fingerprint);
  });
});

describe('PairingStore CRUD', () => {
  it('save → list 能看到', () => {
    const key: PairingKey = {
      authKey: new Uint8Array(32).fill(1),
      sessionSecret: new Uint8Array(32).fill(2),
      roomId: 'ABCDEFGH',
      peerFingerprint: 'abcdef012345',
      peerName: '我的手机',
      createdAt: Math.floor(Date.now() / 1000),
    };
    store.save(key);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].peerFingerprint).toBe('abcdef012345');
    expect(list[0].peerName).toBe('我的手机');
  });

  it('save 后 get 按 peerFingerprint 取回完整字段', () => {
    const key: PairingKey = {
      authKey: new Uint8Array(32).fill(7),
      sessionSecret: new Uint8Array(32).fill(8),
      roomId: 'ROOM1234',
      peerFingerprint: 'fff123456789',
      peerName: 'test-device',
      createdAt: 1234567890,
    };
    store.save(key);
    const got = store.get('fff123456789');
    expect(got).toBeDefined();
    expect(Array.from(got!.authKey)).toEqual(Array.from(new Uint8Array(32).fill(7)));
    expect(got!.roomId).toBe('ROOM1234');
    expect(got!.createdAt).toBe(1234567890);
  });

  it('list 不返回密钥材料（脱敏：只返回 fingerprint/peerName/createdAt/roomId）', () => {
    const key: PairingKey = {
      authKey: new Uint8Array(32).fill(1),
      sessionSecret: new Uint8Array(32).fill(2),
      roomId: 'ROOM1234',
      peerFingerprint: 'abc123456789',
      peerName: 'phone',
      createdAt: 1,
    };
    store.save(key);
    const list = store.list();
    const item = list[0] as any;
    expect(item.authKey).toBeUndefined();
    expect(item.sessionSecret).toBeUndefined();
    expect(item.peerFingerprint).toBe('abc123456789');
  });

  it('delete → list 看不到，vault 里也删除（密钥彻底清除）', () => {
    const key: PairingKey = {
      authKey: new Uint8Array(32).fill(1),
      sessionSecret: new Uint8Array(32).fill(2),
      roomId: 'ROOM1234',
      peerFingerprint: 'del123456789',
      peerName: 'del',
      createdAt: 1,
    };
    store.save(key);
    expect(store.list()).toHaveLength(1);
    store.delete('del123456789');
    expect(store.list()).toHaveLength(0);
    expect(store.get('del123456789')).toBeUndefined();
    expect(vault.get('pairing.del123456789')).toBeUndefined();
  });

  it('index 文件持久化：重新打开 store 仍能 list', () => {
    const key: PairingKey = {
      authKey: new Uint8Array(32).fill(1),
      sessionSecret: new Uint8Array(32).fill(2),
      roomId: 'ROOM1234',
      peerFingerprint: 'persist12345',
      peerName: 'persist',
      createdAt: 1,
    };
    store.save(key);
    const store2 = new PairingStore(dataDir, vault);
    const list = store2.list();
    expect(list).toHaveLength(1);
    expect(list[0].peerFingerprint).toBe('persist12345');
  });

  it('save 多个不同 fingerprint 共存', () => {
    for (let i = 0; i < 3; i++) {
      store.save({
        authKey: new Uint8Array(32).fill(i),
        sessionSecret: new Uint8Array(32).fill(i),
        roomId: `ROOM${i}234`,
        peerFingerprint: `fp${i}123456789`,
        peerName: `dev${i}`,
        createdAt: i,
      });
    }
    expect(store.list()).toHaveLength(3);
  });

  it('重复 save 同一 fingerprint 覆盖（更新 peerName 等）', () => {
    const base = {
      authKey: new Uint8Array(32).fill(1),
      sessionSecret: new Uint8Array(32).fill(2),
      roomId: 'ROOM1234',
      peerFingerprint: 'dup123456789',
      peerName: 'old',
      createdAt: 1,
    };
    store.save(base);
    store.save({ ...base, peerName: 'new', createdAt: 2 });
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].peerName).toBe('new');
    expect(list[0].createdAt).toBe(2);
  });
});

describe('密钥材料不出现在日志/错误信息', () => {
  it('list 返回的 JSON 不含 authKey/sessionSecret 字段', () => {
    store.save({
      authKey: new Uint8Array(32).fill(0xAB),
      sessionSecret: new Uint8Array(32).fill(0xCD),
      roomId: 'ROOM1234',
      peerFingerprint: 'log123456789',
      peerName: 'log-test',
      createdAt: 1,
    });
    const json = JSON.stringify(store.list());
    expect(json).not.toContain('authKey');
    expect(json).not.toContain('sessionSecret');
    expect(json).not.toContain('qqrq');
  });
});

describe('PairingService（配对生命周期）', () => {
  it('beginPairing 返回 code + ourPubKeyB64 + fingerprint + expiresAt', () => {
    const svc = new PairingService(store, vault);
    const r = svc.beginPairing();
    expect(r.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(r.ourPubKeyB64).toBeTruthy();
    expect(r.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    // expiresAt 是 epoch 秒，约 5 分钟后
    const now = Math.floor(Date.now() / 1000);
    expect(r.expiresAt).toBeGreaterThanOrEqual(now + 290);
    expect(r.expiresAt).toBeLessThanOrEqual(now + 310);
  });

  it('beginPairing 首次生成静态身份并存 vault；二次复用同一公钥', () => {
    const v = new InMemoryVault();
    const svc1 = new PairingService(store, v);
    const a = svc1.beginPairing();
    expect(v.get('pairing.static-identity')).toBeTruthy();
    const svc2 = new PairingService(store, v);
    const b = svc2.beginPairing();
    expect(b.ourPubKeyB64).toBe(a.ourPubKeyB64);
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  it('hasPending：begin 后 true；complete 后 false（一次性）', () => {
    const svc = new PairingService(store, vault);
    const { code } = svc.beginPairing();
    expect(svc.hasPending(code)).toBe(true);
    // complete 需要 pairing 模式的对端公钥——这里用另一个 StaticIdentity 模拟对端
    const peer = new StaticIdentity();
    svc.completePairing(
      code,
      Buffer.from(peer.publicKey).toString('base64'),
      peer.fingerprint,
      'peer',
    );
    expect(svc.hasPending(code)).toBe(false);
  });

  it('hasPending：不存在的 code → false', () => {
    const svc = new PairingService(store, vault);
    expect(svc.hasPending('NOTEXIST')).toBe(false);
  });

  it('completePairing：存入的 authKey 与对端独立用 derivePairingKey 派生的一致（ECDH 对称性）', () => {
    // 端 A：begin + complete
    const svc = new PairingService(store, vault);
    const begin = svc.beginPairing();
    const peer = new StaticIdentity();
    svc.completePairing(
      begin.code,
      Buffer.from(peer.publicKey).toString('base64'),
      peer.fingerprint,
      'peer',
    );
    const keyA = store.get(peer.fingerprint)!;
    // 端 B：用 derivePairingKey 独立派生（对端不走 completePairing，只用 code + 对端公钥）
    const keyB = derivePairingKey(
      peer.privateKey,
      new Uint8Array(Buffer.from(begin.ourPubKeyB64, 'base64')),
      begin.code,
      begin.fingerprint,
      'desktop',
    );
    expect(Buffer.from(keyA.authKey).equals(Buffer.from(keyB.authKey))).toBe(true);
    expect(Buffer.from(keyA.sessionSecret).equals(Buffer.from(keyB.sessionSecret))).toBe(true);
  });

  it('completePairing：过期 code → 抛错', () => {
    const svc = new PairingService(store, vault);
    const { code } = svc.beginPairing();
    // 直接操纵内部 pending 表模拟过期
    (svc as any).pending.get(code).expiresAt = Math.floor(Date.now() / 1000) - 1;
    const peer = new StaticIdentity();
    expect(() => svc.completePairing(
      code,
      Buffer.from(peer.publicKey).toString('base64'),
      peer.fingerprint,
    )).toThrow(/过期|expired|失效/i);
    // 过期 code 也被清理
    expect(svc.hasPending(code)).toBe(false);
  });

  it('completePairing：未知 code → 抛错', () => {
    const svc = new PairingService(store, vault);
    const peer = new StaticIdentity();
    expect(() => svc.completePairing(
      'NOTEXIST',
      Buffer.from(peer.publicKey).toString('base64'),
      peer.fingerprint,
    )).toThrow(/不存在|失效|unknown/i);
  });

  it('completePairing 后 PairingKey 存入 vault（list 能看到）', () => {
    const svc = new PairingService(store, vault);
    const { code } = svc.beginPairing();
    const peer = new StaticIdentity();
    svc.completePairing(
      code,
      Buffer.from(peer.publicKey).toString('base64'),
      peer.fingerprint,
      '我的手机',
    );
    const list = svc.list();
    expect(list).toHaveLength(1);
    expect(list[0].peerFingerprint).toBe(peer.fingerprint);
    expect(list[0].peerName).toBe('我的手机');
  });

  it('cleanupExpired 移除所有过期 pending entry', () => {
    const svc = new PairingService(store, vault);
    const a = svc.beginPairing();
    const b = svc.beginPairing();
    (svc as any).pending.get(a.code).expiresAt = Math.floor(Date.now() / 1000) - 1;
    svc.cleanupExpired();
    expect(svc.hasPending(a.code)).toBe(false);
    expect(svc.hasPending(b.code)).toBe(true);
  });

  it('代理 store 方法：list/get/delete', () => {
    const svc = new PairingService(store, vault);
    const key: PairingKey = {
      authKey: new Uint8Array(32).fill(1),
      sessionSecret: new Uint8Array(32).fill(2),
      roomId: 'ROOM1234',
      peerFingerprint: 'proxy123456',
      peerName: 'proxy',
      createdAt: 1,
    };
    store.save(key);
    expect(svc.list()).toHaveLength(1);
    expect(svc.get('proxy123456')).toBeDefined();
    svc.delete('proxy123456');
    expect(svc.list()).toHaveLength(0);
  });
});

// ===== M3c Task 2: 地址簿存储（peer-addresses.json + PairingStore 扩展）=====

function makeKey(fp: string): PairingKey {
  return {
    authKey: new Uint8Array(32).fill(1),
    sessionSecret: new Uint8Array(32).fill(2),
    roomId: 'ROOM1234',
    peerFingerprint: fp,
    peerName: `dev-${fp}`,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

describe('PairingStore 地址簿（peer-addresses.json）', () => {
  it('setAddress/getAddress/listWithAddress 读写', () => {
    store.save(makeKey('FP1'));
    store.setAddress('FP1', '192.168.1.10:53182');
    expect(store.getAddress('FP1')).toBe('192.168.1.10:53182');
    const list = store.listWithAddress();
    expect(list[0]).toMatchObject({ peerFingerprint: 'FP1', address: '192.168.1.10:53182' });
  });

  it('delete 同步清地址', () => {
    store.save(makeKey('FP1'));
    store.setAddress('FP1', '1.2.3.4:5');
    store.delete('FP1');
    expect(store.getAddress('FP1')).toBeUndefined();
    expect(store.listWithAddress()).toHaveLength(0);
  });

  it('setLastSeen 更新 lastSeenAt', () => {
    store.save(makeKey('FP1'));
    store.setAddress('FP1', '1.2.3.4:5');
    store.setLastSeen('FP1', 9999);
    const list = store.listWithAddress();
    expect(list[0].lastSeenAt).toBe(9999);
  });

  it('未设地址的设备 listWithAddress 返回 address=undefined', () => {
    store.save(makeKey('FP1'));
    const list = store.listWithAddress();
    expect(list[0].address).toBeUndefined();
  });

  it('地址簿持久化：重新打开 store 仍能读地址', () => {
    store.save(makeKey('FP1'));
    store.setAddress('FP1', '10.0.0.1:8080');
    const store2 = new PairingStore(dataDir, vault);
    expect(store2.getAddress('FP1')).toBe('10.0.0.1:8080');
  });
});

describe('PairingService.joinPairing', () => {
  it('封装 derivePairingKey+save+setAddress（私钥不离开 service）', () => {
    const service = new PairingService(store, vault);
    const peerPub = service.myPublicKey;  // 用自己公钥测试（对称性）
    const peerPubB64 = Buffer.from(peerPub).toString('base64');
    service.joinPairing(peerPubB64, 'PEERFP', 'PeerDev', 'CODE1234', '1.2.3.4:5');
    expect(service.get('PEERFP')).toBeDefined();
    expect(store.getAddress('PEERFP')).toBe('1.2.3.4:5');
  });
});
