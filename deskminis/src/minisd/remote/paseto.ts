/**
 * PASETO v4.local 对称认证加密（XChaCha20-Poly1305 AEAD）。
 *
 * 用于 M3a 远程客户端的短期会话 token（设计 §2.1）：
 *   - payload：{ exp, iat, device_fingerprint }
 *   - 时效：10 分钟（exp - iat）
 *   - 密钥：PairingKey.auth_key（32 字节，由 HKDF 从 ECDH 共享密钥派生，见 pairing.ts）
 *
 * 不引 paseto 专用库的选型理由（计划「架构决策 1」）：
 *   - noble 套件（@noble/ciphers + @noble/hashes + @noble/curves）已为 Task 3 的 ECDH/HKDF 必需；
 *     PASETO v4.local 在 noble 之上只需 ~40 行胶水，无需再引 paseto-js/paseto.js 等专用库。
 *   - noble 全部纯 JS、零原生依赖、审计过，与 M2 系列 ABI 风险隔离原则一致。
 *   - 专用库多数依赖 Node crypto 或 WebCrypto，跨 utilityProcess/standalone 分支行为不稳。
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

/** PASETO v4.local 的 payload 契约（设计 §2.1）。 */
export interface PasetoPayload {
  /** 过期时间（ms since epoch） */
  exp: number;
  /** 签发时间（ms since epoch） */
  iat: number;
  /** 设备指纹（PairingKey 的 sha256 前 N 位十六进制，配对时两端比对） */
  device_fingerprint: string;
}

const HEADER = 'v4.local';
const NONCE_LEN = 24; // XChaCha20-Poly1305 nonce
const KEY_LEN = 32;   // XChaCha20-Poly1305 key
const TAG_LEN = 16;   // Poly1305 tag

/** URL-safe base64 编码（无填充），PASETO 规范要求。 */
function b64uEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
function b64uDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

/** 派生 PASETO v4.local 的预认证加密材料（nonce）。XChaCha20 内部用 HKDF，但 noble 的 xchacha20poly1305 接受 (key, nonce)。 */
function buildAad(nonce: Uint8Array): Uint8Array {
  // PASETO v4.local pre-auth: b'v4.local' + b'\x00' + nonce
  // 实际规范：preAuth = p_header || 0x00 || nonce（p_header = 'v4.local'，不含分隔点）
  const aad = new Uint8Array(HEADER.length + 1 + NONCE_LEN);
  aad.set(Buffer.from(HEADER, 'ascii'), 0);
  aad[HEADER.length] = 0x00;
  aad.set(nonce, HEADER.length + 1);
  return aad;
}

export interface EncodeOpts { now?: number }
export interface DecodeOpts { now?: number }

/**
 * 编码 PASETO v4.local。
 * @param payload 必含 exp/iat/device_fingerprint
 * @param authKey 32 字节对称密钥
 * @returns 形如 `v4.local.<base64u(nonce)>.<base64u(ciphertext+tag)>` 的字符串
 */
export function encodePaseto(payload: PasetoPayload, authKey: Uint8Array, opts: EncodeOpts = {}): string {
  if (authKey.length !== KEY_LEN) throw new Error(`auth_key 长度必须为 32 字节，收到 ${authKey.length}`);
  if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number' || typeof payload.device_fingerprint !== 'string') {
    throw new Error('payload 必含 exp/iat/device_fingerprint');
  }
  // nonce 用 crypto.randomBytes 生成；这里走 noble 之外的 Node 内置随机源（utilityProcess 可用）
  const nonce = new Uint8Array(NONCE_LEN);
  crypto.getRandomValues(nonce);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const aad = buildAad(nonce);
  // noble xchacha20poly1305: encrypt(plaintext, aad) → ciphertext + tag（tag 在末尾 16 字节）
  const cipher = xchacha20poly1305(authKey, nonce, aad);
  const sealed = cipher.encrypt(plaintext);
  return `${HEADER}.${b64uEncode(nonce)}.${b64uEncode(sealed)}`;
}

/**
 * 解码并校验 PASETO v4.local。
 * @throws 若前缀错误 / 密钥错误 / 密文篡改 / 已过期
 */
export function decodePaseto(token: string, authKey: Uint8Array, opts: DecodeOpts = {}): PasetoPayload {
  if (authKey.length !== KEY_LEN) throw new Error(`auth_key 长度必须为 32 字节，收到 ${authKey.length}`);
  const now = opts.now ?? Date.now();
  if (!token.startsWith(HEADER + '.')) throw new Error(`PASETO 前缀必须为 v4.local.，收到 ${token.slice(0, 12)}`);
  const parts = token.split('.');
  // [v4, local, nonce, ciphertext+tag]
  if (parts.length < 4) throw new Error('PASETO 格式不合法：段数不足');
  const nonce = b64uDecode(parts[2]);
  if (nonce.length !== NONCE_LEN) throw new Error(`nonce 长度必须为 ${NONCE_LEN} 字节`);
  const sealed = b64uDecode(parts[3]);
  if (sealed.length < TAG_LEN) throw new Error('密文+tag 长度不足');
  const aad = buildAad(nonce);
  let plaintext: Uint8Array;
  try {
    const cipher = xchacha20poly1305(authKey, nonce, aad);
    plaintext = cipher.decrypt(sealed);
  } catch {
    throw new Error('PASETO_INVALID: 认证失败或密钥不匹配（密文不可解）');
  }
  let payload: PasetoPayload;
  try {
    payload = JSON.parse(Buffer.from(plaintext).toString('utf8'));
  } catch {
    throw new Error('PASETO_INVALID: 解密后 payload 不是合法 JSON');
  }
  if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number' || typeof payload.device_fingerprint !== 'string') {
    throw new Error('PASETO_INVALID: payload 缺少必填字段 exp/iat/device_fingerprint');
  }
  if (payload.exp <= now) throw new Error(`PASETO_EXPIRED: token 已过期（exp=${payload.exp}, now=${now}）`);
  return payload;
}
