import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import { PairingStore, generatePairingCode, derivePairingKey, EphemeralPairHandshake, type PairingKey } from '../src/minisd/remote/pairing';

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
    // 端 A：生成静态密钥对
    const A = new EphemeralPairHandshake();
    // 端 B：生成静态密钥对
    const B = new EphemeralPairHandshake();
    const code = 'ABCD2345';
    // A 用 B 的公钥 + code 派生
    const keyA = derivePairingKey(A.privateKey, B.publicKey, code);
    // B 用 A 的公钥 + code 派生
    const keyB = derivePairingKey(B.privateKey, A.publicKey, code);
    expect(keyA.authKey).toEqual(keyB.authKey);
    expect(keyA.sessionSecret).toEqual(keyB.sessionSecret);
    expect(keyA.roomId).toBe(keyB.roomId);
  });

  it('pairingCode 不同 → 派生结果不同', () => {
    const A = new EphemeralPairHandshake();
    const B = new EphemeralPairHandshake();
    const keyA = derivePairingKey(A.privateKey, B.publicKey, 'CODE1111');
    const keyB = derivePairingKey(A.privateKey, B.publicKey, 'CODE2222');
    expect(keyA.authKey).not.toEqual(keyB.authKey);
  });

  it('公钥不同 → 派生结果不同', () => {
    const A = new EphemeralPairHandshake();
    const B1 = new EphemeralPairHandshake();
    const B2 = new EphemeralPairHandshake();
    const key1 = derivePairingKey(A.privateKey, B1.publicKey, 'CODE1111');
    const key2 = derivePairingKey(A.privateKey, B2.publicKey, 'CODE1111');
    expect(key1.authKey).not.toEqual(key2.authKey);
  });

  it('authKey/sessionSecret 长度均为 32 字节', () => {
    const A = new EphemeralPairHandshake();
    const B = new EphemeralPairHandshake();
    const key = derivePairingKey(A.privateKey, B.publicKey, 'ABCD2345');
    expect(key.authKey.length).toBe(32);
    expect(key.sessionSecret.length).toBe(32);
  });

  it('roomId 是 8 字符 base32 串（中继房间定位用，本期 LAN 直连不消费）', () => {
    const A = new EphemeralPairHandshake();
    const B = new EphemeralPairHandshake();
    const key = derivePairingKey(A.privateKey, B.publicKey, 'ABCD2345');
    expect(key.roomId).toMatch(/^[A-Z2-7]{8}$/);
  });
});

describe('EphemeralPairHandshake（X25519 静态密钥对）', () => {
  it('publicKey 32 字节，privateKey 32 字节', () => {
    const h = new EphemeralPairHandshake();
    expect(h.publicKey.length).toBe(32);
    expect(h.privateKey.length).toBe(32);
  });

  it('两次实例化生成不同密钥对', () => {
    const a = new EphemeralPairHandshake();
    const b = new EphemeralPairHandshake();
    expect(a.privateKey).not.toEqual(b.privateKey);
  });

  it('fingerprint = sha256(publicKey).slice(0,6) 十六进制（设计 §2.1 的 6 位安全码）', () => {
    const h = new EphemeralPairHandshake();
    expect(h.fingerprint).toMatch(/^[0-9a-f]{12}$/); // 6 字节 = 12 hex 字符
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
      createdAt: Date.now(),
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
    // 返回的「脱敏视图」不应包含 authKey/sessionSecret
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
    // vault 里的条目也清掉
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
    // 重新打开
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
    // 0xAB/0xCD 重复 32 次的 base64 表示不应出现在 JSON 里
    expect(json).not.toContain('authKey');
    expect(json).not.toContain('sessionSecret');
    expect(json).not.toContain('qqrq'); // 0xAB*32 的 base64 片段
  });
});
