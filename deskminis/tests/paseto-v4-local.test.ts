import { describe, it, expect, beforeEach } from 'vitest';
import { encodePaseto, decodePaseto, type PasetoPayload } from '../src/minisd/remote/paseto';

// 32 字节 auth_key（PASETO v4.local 要求）；测试用固定 key，生产由 HKDF 派生
const AUTH_KEY = new Uint8Array(32).fill(7);
const NOW = 1_700_000_000_000; // 固定时间戳，避免测试与系统时钟耦合

const basePayload: PasetoPayload = {
  exp: NOW + 10 * 60 * 1000,
  iat: NOW,
  device_fingerprint: 'sha256:abcdef',
};

describe('encodePaseto / decodePaseto 基础', () => {
  it('encode 后前缀必为 v4.local.', () => {
    const token = encodePaseto(basePayload, AUTH_KEY, { now: NOW });
    expect(token.startsWith('v4.local.')).toBe(true);
  });

  it('encode → decode 往返：payload 字段完全一致', () => {
    const token = encodePaseto(basePayload, AUTH_KEY, { now: NOW });
    const decoded = decodePaseto(token, AUTH_KEY, { now: NOW });
    expect(decoded.exp).toBe(basePayload.exp);
    expect(decoded.iat).toBe(basePayload.iat);
    expect(decoded.device_fingerprint).toBe(basePayload.device_fingerprint);
  });

  it('decode 接受无 footer 的 token', () => {
    const token = encodePaseto(basePayload, AUTH_KEY, { now: NOW });
    const decoded = decodePaseto(token, AUTH_KEY, { now: NOW });
    expect(decoded.exp).toBe(basePayload.exp);
  });
});

describe('时效校验', () => {
  it('未过期 → 正常解码', () => {
    const token = encodePaseto({ ...basePayload, exp: NOW + 60_000 }, AUTH_KEY, { now: NOW });
    expect(() => decodePaseto(token, AUTH_KEY, { now: NOW })).not.toThrow();
  });

  it('已过期 → 抛 PASETO_EXPIRED', () => {
    const token = encodePaseto({ ...basePayload, exp: NOW - 1 }, AUTH_KEY, { now: NOW });
    expect(() => decodePaseto(token, AUTH_KEY, { now: NOW })).toThrow(/expired|过期/i);
  });

  it('10 分钟时效刚好临界：exp = now + 10min → 通过', () => {
    const tenMin = 10 * 60 * 1000;
    const token = encodePaseto({ ...basePayload, exp: NOW + tenMin }, AUTH_KEY, { now: NOW });
    expect(() => decodePaseto(token, AUTH_KEY, { now: NOW })).not.toThrow();
  });
});

describe('认证加密完整性（AEAD）', () => {
  it('auth_key 错误 → 抛 PASETO_INVALID（密文不可解）', () => {
    const token = encodePaseto(basePayload, AUTH_KEY, { now: NOW });
    const wrongKey = new Uint8Array(32).fill(8);
    expect(() => decodePaseto(token, wrongKey, { now: NOW })).toThrow(/invalid|不可解|认证/i);
  });

  it('密文被篡改 1 字节 → 抛认证错误', () => {
    const token = encodePaseto(basePayload, AUTH_KEY, { now: NOW });
    // v4.local.<base64(nonce)>.<base64(ciphertext+tag)>
    const parts = token.split('.');
    const ct = Buffer.from(parts[3], 'base64');
    ct[0] ^= 0x01;
    parts[3] = ct.toString('base64').replace(/=+$/, '');
    const tampered = parts.join('.');
    expect(() => decodePaseto(tampered, AUTH_KEY, { now: NOW })).toThrow();
  });

  it('payload 必含 exp/iat/device_fingerprint', () => {
    // @ts-expect-error 故意缺字段
    expect(() => encodePaseto({ exp: NOW, iat: NOW }, AUTH_KEY, { now: NOW })).toThrow();
  });

  it('auth_key 长度 != 32 → 抛错', () => {
    const shortKey = new Uint8Array(16).fill(7);
    expect(() => encodePaseto(basePayload, shortKey, { now: NOW })).toThrow(/32|长度/);
  });
});

describe('格式校验', () => {
  it('非 v4.local. 前缀 → 拒', () => {
    expect(() => decodePaseto('v4.public.xxx', AUTH_KEY, { now: NOW })).toThrow(/v4\.local|前缀/i);
    expect(() => decodePaseto('v3.local.xxx', AUTH_KEY, { now: NOW })).toThrow(/v4\.local|前缀/i);
  });

  it('随机字符串 → 拒', () => {
    expect(() => decodePaseto('garbage', AUTH_KEY, { now: NOW })).toThrow();
  });
});
