/**
 * 配对密钥管理（设计 §2.1）。
 *
 * 流程：
 *   1. 用户输入 8 字配对码（generatePairingCode 生成，去除易混淆字符）
 *   2. 两端各自生成 X25519 静态密钥对（EphemeralPairHandshake）
 *   3. 通过带外交换公钥（CLI/二维码；e2e 用代码模拟）
 *   4. derivePairingKey：ECDH(本端私钥, 对端公钥) → 共享密钥 → HKDF-SHA256 派生 64 字节
 *      - 前 32 字节 = auth_key（PASETO v4.local 对称密钥）
 *      - 后 32 字节 = session_secret（后续会话密钥派生种子，M3b 消费）
 *   5. roomId = base32(HKDF(shared, info='room_id', len=5))，8 字符（中继房间定位，本期 LAN 直连不消费）
 *
 * 存储：PairingKey 存 Windows 凭据库（沿用 M1 vault/keyring 路径，见 provider-store.ts L12-36）。
 *   - SecretVault 接口只有 set/get/delete 无 list（M1 现状，计划已显式标注）
 *   - 因此 PairingStore.list() 自管 `pairing-index.json` 索引文件，存 fingerprint 列表
 *   - vault key 命名：`pairing.<fingerprint>`
 *   - vault value：base64(JSON({authKey, sessionSecret, roomId, peerName, createdAt}))
 *
 * 红线：密钥材料（authKey/sessionSecret）禁止出现在日志/错误信息/RPC 返回里。
 *   list() 返回脱敏视图（只有 fingerprint/peerName/createdAt/roomId）。
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { SecretVault } from '../store/provider-store';

/** 配对密钥的完整形态（含密钥材料，仅本端 vault 内持有，绝不外传）。 */
export interface PairingKey {
  /** PASETO v4.local 对称密钥（32 字节） */
  authKey: Uint8Array;
  /** 后续会话密钥派生种子（32 字节，M3b 消费） */
  sessionSecret: Uint8Array;
  /** 中继房间定位（8 字符 base32，本期 LAN 直连不消费） */
  roomId: string;
  /** 对端设备指纹（12 字符 hex，配对时两端比对，6 位安全码的来源） */
  peerFingerprint: string;
  /** 对端设备名（UI 显示用） */
  peerName: string;
  /** 配对建立时间（ms since epoch） */
  createdAt: number;
}

/** PairingStore.list() 返回的脱敏视图（不含密钥材料）。 */
export interface PairingKeyPublicView {
  peerFingerprint: string;
  peerName: string;
  roomId: string;
  createdAt: number;
}

/** 8 字配对码字符集（去除易混淆字符 0/O/1/I/L，符合设计 §2.1）。 */
const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 30 字符
const PAIRING_CODE_LEN = 8;

/** 生成 8 字配对码（去除易混淆字符 0/O/1/I/L）。 */
export function generatePairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LEN);
  let out = '';
  for (let i = 0; i < PAIRING_CODE_LEN; i++) {
    out += PAIRING_CODE_ALPHABET[bytes[i] % PAIRING_CODE_ALPHABET.length];
  }
  return out;
}

/** X25519 静态密钥对包装类（设计 §2.1「X25519 静态密钥，本地生成，不导出」）。 */
export class EphemeralPairHandshake {
  /** X25519 私钥（32 字节，永不离开本机） */
  readonly privateKey: Uint8Array;
  /** X25519 公钥（32 字节，配对时通过带外通道交换给对端） */
  readonly publicKey: Uint8Array;
  /** 设备指纹 = sha256(publicKey).slice(0,6) 的 12 字符十六进制（设计 §2.1 的 6 位安全码） */
  readonly fingerprint: string;

  constructor(seed?: Uint8Array) {
    const kp = seed ? x25519.keygen(seed) : x25519.keygen();
    this.privateKey = kp.secretKey;
    this.publicKey = kp.publicKey;
    const h = sha256(this.publicKey);
    this.fingerprint = Buffer.from(h.slice(0, 6)).toString('hex'); // 6 字节 = 12 hex 字符
  }
}

const HKDF_INFO_PAIRING = new TextEncoder().encode('DeskMinis/PairingKey/v1');
const HKDF_INFO_ROOM = new TextEncoder().encode('DeskMinis/PairingKey/roomId/v1');
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 5 字节 → 8 字符标准 base32（RFC 4648，无填充）。 */
function base32Encode5(bytes: Uint8Array): string {
  if (bytes.length !== 5) throw new Error(`base32Encode5 需要 5 字节，收到 ${bytes.length}`);
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1F];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1F];
  return out.slice(0, 8); // 5 字节 = 40 bit = 8 个 5-bit 字符
}

/**
 * 从 ECDH 共享密钥 + 配对码派生 PairingKey（两端相同 code + 互换公钥 → 相同派生结果）。
 * @param myPriv 本端 X25519 私钥
 * @param peerPub 对端 X25519 公钥
 * @param pairingCode 8 字配对码
 * @param peerFingerprint 对端设备指纹（来自 EphemeralPairHandshake.fingerprint）
 * @param peerName 对端设备名（UI 显示用）
 */
export function derivePairingKey(
  myPriv: Uint8Array,
  peerPub: Uint8Array,
  pairingCode: string,
  peerFingerprint: string = '',
  peerName: string = '未命名设备',
): PairingKey {
  // ECDH：本端私钥 + 对端公钥 → 共享密钥（两端互换算出同一个值）
  const shared = x25519.getSharedSecret(myPriv, peerPub);
  const salt = new TextEncoder().encode(pairingCode);
  // 派生 64 字节：前 32 = auth_key，后 32 = session_secret
  const derived = hkdf(sha256, shared, salt, HKDF_INFO_PAIRING, 64);
  // roomId 单独派生（避免与 auth/session 材料混用同一 HKDF 输出）
  const roomBytes = hkdf(sha256, shared, salt, HKDF_INFO_ROOM, 5);
  const roomId = base32Encode5(new Uint8Array(roomBytes));
  return {
    authKey: derived.slice(0, 32),
    sessionSecret: derived.slice(32, 64),
    roomId,
    peerFingerprint,
    peerName,
    createdAt: Date.now(),
  };
}

const INDEX_FILE = 'pairing-index.json';

/** PairingKey 持久化存储（vault 存密钥本体，index 文件存 fingerprint 列表以支持 list）。 */
export class PairingStore {
  private indexFile: string;

  constructor(private dataDir: string, private vault: SecretVault) {
    this.indexFile = join(dataDir, INDEX_FILE);
  }

  private vaultKey(fp: string): string { return `pairing.${fp}`; }

  private readIndex(): string[] {
    if (!existsSync(this.indexFile)) return [];
    try {
      const raw = readFileSync(this.indexFile, 'utf8').replace(/\r\n/g, '\n');
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : [];
    } catch { return []; }
  }

  private writeIndex(fps: string[]): void {
    const tmp = this.indexFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(fps, null, 2), 'utf8');
    renameSync(tmp, this.indexFile); // 原子替换
  }

  /** 保存（重复 save 同一 fingerprint 覆盖）。 */
  save(key: PairingKey): void {
    const fp = key.peerFingerprint;
    // vault value：base64 编码 Uint8Array，避免 JSON 序列化成 `{"0":1,...}`
    const payload = {
      authKey: Buffer.from(key.authKey).toString('base64'),
      sessionSecret: Buffer.from(key.sessionSecret).toString('base64'),
      roomId: key.roomId,
      peerName: key.peerName,
      createdAt: key.createdAt,
    };
    this.vault.set(this.vaultKey(fp), JSON.stringify(payload));
    const fps = this.readIndex();
    if (!fps.includes(fp)) { fps.push(fp); this.writeIndex(fps); }
  }

  /** 按 fingerprint 取回完整 PairingKey（含密钥材料）。 */
  get(fp: string): PairingKey | undefined {
    const raw = this.vault.get(this.vaultKey(fp));
    if (!raw) return undefined;
    try {
      const obj = JSON.parse(raw);
      return {
        authKey: new Uint8Array(Buffer.from(obj.authKey, 'base64')),
        sessionSecret: new Uint8Array(Buffer.from(obj.sessionSecret, 'base64')),
        roomId: obj.roomId,
        peerFingerprint: fp,
        peerName: obj.peerName,
        createdAt: obj.createdAt,
      };
    } catch { return undefined; }
  }

  /** 列出所有已配对设备（脱敏视图，不含密钥材料）。 */
  list(): PairingKeyPublicView[] {
    return this.readIndex().map(fp => {
      const raw = this.vault.get(this.vaultKey(fp));
      if (!raw) return null;
      try {
        const obj = JSON.parse(raw);
        return { peerFingerprint: fp, peerName: obj.peerName, roomId: obj.roomId, createdAt: obj.createdAt };
      } catch { return null; }
    }).filter((x): x is PairingKeyPublicView => x !== null);
  }

  /** 删除（vault + index 双清，密钥彻底清除）。 */
  delete(fp: string): void {
    this.vault.delete(this.vaultKey(fp));
    const fps = this.readIndex().filter(x => x !== fp);
    this.writeIndex(fps);
  }
}
