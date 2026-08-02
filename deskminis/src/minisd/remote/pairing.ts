/**
 * 配对密钥管理（设计 §2.1）。
 *
 * 三层分层：
 *   - StaticIdentity：X25519 静态密钥对（长期身份，首次生成后持久化到 vault，后续启动复用）
 *   - PairingStore：PairingKey 持久化 CRUD（vault 存密钥本体，pairing-index.json 存 fingerprint 列表）
 *   - PairingService：配对协议生命周期（begin/complete/hasPending/cleanupExpired），组合上面两者
 *
 * 流程：
 *   1. local 端调 beginPairing → 生成 8 字配对码 + 登记到 pending 表（5min 过期）
 *   2. 对端拿到 code + 本端公钥，调 completePairing(code, peerPubKeyB64, peerFingerprint)
 *   3. completePairing：消费 code（一次性）→ ECDH(本端私钥, 对端公钥) → HKDF 派生 64 字节
 *      - 前 32 字节 = auth_key（PASETO v4.local 对称密钥）
 *      - 后 32 字节 = session_secret（后续会话密钥派生种子，M3b 消费）
 *   4. roomId = base32(HKDF(shared, info='room_id', len=5))，8 字符（中继房间定位，本期 LAN 直连不消费）
 *
 * 存储：
 *   - 静态身份私钥：vault key='pairing.static-identity'，value=base64(privKey)
 *   - PairingKey：vault key='pairing.<fingerprint>'，value=base64(JSON({authKey,sessionSecret,roomId,peerName,createdAt}))
 *   - fingerprint 索引：dataDir/pairing-index.json（非机密，无需进 vault）
 *
 * 红线：密钥材料（authKey/sessionSecret/privateKey）禁止出现在日志/错误信息/RPC 返回里。
 *   list() 返回脱敏视图（只有 peerFingerprint/peerName/createdAt/roomId）。
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { SecretVault } from '../store/provider-store';

/** vault key：静态身份私钥（首次生成后持久化，后续启动复用，永不导出）。 */
const VAULT_STATIC_IDENTITY = 'pairing.static-identity';

/** 配对密钥的完整形态（含密钥材料，仅本端 vault 内持有，绝不外传）。 */
export interface PairingKey {
  /** PASETO v4.local 对称密钥（32 字节） */
  authKey: Uint8Array;
  /** 后续会话密钥派生种子（32 字节，M3b 消费） */
  sessionSecret: Uint8Array;
  /** 中继房间定位（8 字符 base32，本期 LAN 直连不消费） */
  roomId: string;
  /** 对端设备指纹（12 字符 hex，配对时两端比对，安全码的来源） */
  peerFingerprint: string;
  /** 对端设备名（UI 显示用） */
  peerName: string;
  /** 配对建立时间（epoch 秒，非毫秒） */
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

/** 配对码有效期 5 分钟（设计 §1-M3a「5 分钟 code 过期」）。 */
export const PAIRING_CODE_TTL_S = 300;

/** 生成 8 字配对码（去除易混淆字符 0/O/1/I/L）。 */
export function generatePairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LEN);
  let out = '';
  for (let i = 0; i < PAIRING_CODE_LEN; i++) {
    out += PAIRING_CODE_ALPHABET[bytes[i] % PAIRING_CODE_ALPHABET.length];
  }
  return out;
}

/**
 * X25519 静态密钥对（长期身份，设计 §2.1「X25519 静态密钥，本地生成，不导出」）。
 *
 * - 无参构造：随机生成新身份（测试/临时场景）
 * - 传 privateKey：从已有私钥恢复（getPublicKey 派生公钥）
 * - StaticIdentity.loadOrCreate(vault)：生产用法，首次生成并持久化，后续加载复用
 */
export class StaticIdentity {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
  /** 设备指纹 = sha256(publicKey).slice(0,6) 的 12 字符十六进制（48-bit 强度，防离线碰撞研磨） */
  readonly fingerprint: string;

  constructor(privateKey?: Uint8Array) {
    if (privateKey) {
      this.privateKey = privateKey;
      this.publicKey = x25519.getPublicKey(privateKey);
    } else {
      const kp = x25519.keygen();
      this.privateKey = kp.secretKey;
      this.publicKey = kp.publicKey;
    }
    const h = sha256(this.publicKey);
    this.fingerprint = Buffer.from(h.slice(0, 6)).toString('hex'); // 6 字节 = 12 hex 字符
  }

  /** 从 vault 加载已有身份，或首次生成并持久化。 */
  static loadOrCreate(vault: SecretVault): StaticIdentity {
    const existing = vault.get(VAULT_STATIC_IDENTITY);
    if (existing) {
      const priv = new Uint8Array(Buffer.from(existing, 'base64'));
      return new StaticIdentity(priv);
    }
    const id = new StaticIdentity();
    vault.set(VAULT_STATIC_IDENTITY, Buffer.from(id.privateKey).toString('base64'));
    return id;
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
  return out.slice(0, 8);
}

/**
 * 从 ECDH 共享密钥 + 配对码派生 PairingKey（两端相同 code + 互换公钥 → 相同派生结果）。
 * @param myPriv 本端 X25519 私钥
 * @param peerPub 对端 X25519 公钥
 * @param pairingCode 8 字配对码
 * @param peerFingerprint 对端设备指纹（来自 StaticIdentity.fingerprint）
 * @param peerName 对端设备名（UI 显示用）
 */
export function derivePairingKey(
  myPriv: Uint8Array,
  peerPub: Uint8Array,
  pairingCode: string,
  peerFingerprint: string = '',
  peerName: string = '未命名设备',
): PairingKey {
  const shared = x25519.getSharedSecret(myPriv, peerPub);
  const salt = new TextEncoder().encode(pairingCode);
  const derived = hkdf(sha256, shared, salt, HKDF_INFO_PAIRING, 64);
  const roomBytes = hkdf(sha256, shared, salt, HKDF_INFO_ROOM, 5);
  const roomId = base32Encode5(new Uint8Array(roomBytes));
  return {
    authKey: derived.slice(0, 32),
    sessionSecret: derived.slice(32, 64),
    roomId,
    peerFingerprint,
    peerName,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

const INDEX_FILE = 'pairing-index.json';
const ADDRESS_FILE = 'peer-addresses.json';

/** 地址簿条目（对端监听地址，配对时习得，sync.hello 交换刷新）。 */
interface AddressEntry {
  address: string;
  learnedAt: number;
  lastSeenAt?: number;
}

/** PairingKey 持久化存储（vault 存密钥本体，index 文件存 fingerprint 列表以支持 list）。 */
export class PairingStore {
  private indexFile: string;
  private addressFile: string;

  constructor(private dataDir: string, private vault: SecretVault) {
    this.indexFile = join(dataDir, INDEX_FILE);
    this.addressFile = join(dataDir, ADDRESS_FILE);
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
    renameSync(tmp, this.indexFile);
  }

  private readAddressIndex(): Record<string, AddressEntry> {
    if (!existsSync(this.addressFile)) return {};
    try {
      const raw = readFileSync(this.addressFile, 'utf8').replace(/\r\n/g, '\n');
      const obj = JSON.parse(raw);
      return (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) ? obj : {};
    } catch { return {}; }
  }

  private writeAddressIndex(index: Record<string, AddressEntry>): void {
    const tmp = this.addressFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8');
    renameSync(tmp, this.addressFile);
  }

  /** 保存（重复 save 同一 fingerprint 覆盖）。 */
  save(key: PairingKey): void {
    const fp = key.peerFingerprint;
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

  /** 列出所有已配对设备 + 地址簿信息（脱敏视图）。 */
  listWithAddress(): Array<PairingKeyPublicView & { address?: string; lastSeenAt?: number }> {
    const addrIndex = this.readAddressIndex();
    return this.list().map(v => ({
      ...v,
      address: addrIndex[v.peerFingerprint]?.address,
      lastSeenAt: addrIndex[v.peerFingerprint]?.lastSeenAt,
    }));
  }

  /** 设置对端监听地址（配对时习得 / sync.hello 交换刷新）。 */
  setAddress(fp: string, addr: string): void {
    const index = this.readAddressIndex();
    const existing = index[fp];
    index[fp] = { address: addr, learnedAt: Math.floor(Date.now() / 1000), lastSeenAt: existing?.lastSeenAt };
    this.writeAddressIndex(index);
  }

  /** 取对端监听地址。 */
  getAddress(fp: string): string | undefined {
    return this.readAddressIndex()[fp]?.address;
  }

  /** 更新对端最后在线时间。 */
  setLastSeen(fp: string, ts: number): void {
    const index = this.readAddressIndex();
    if (!index[fp]) return; // 未设地址的不记
    index[fp].lastSeenAt = ts;
    this.writeAddressIndex(index);
  }

  /** 删除（vault + index + 地址簿三清，密钥彻底清除）。 */
  delete(fp: string): void {
    this.vault.delete(this.vaultKey(fp));
    const fps = this.readIndex().filter(x => x !== fp);
    this.writeIndex(fps);
    const addrIndex = this.readAddressIndex();
    if (addrIndex[fp]) {
      delete addrIndex[fp];
      this.writeAddressIndex(addrIndex);
    }
  }
}

/** pending 配对码注册表条目（进程内存，重启即失效——配对中断需重新 begin）。 */
interface PendingEntry {
  /** 配对码生效时间（epoch 秒） */
  expiresAt: number;
}

/**
 * 配对协议生命周期管理（组合 StaticIdentity + PairingStore + pending 注册表）。
 *
 * 设计 §2.1：
 *   - 静态身份：首次生成存 vault，后续启动复用（不导出）
 *   - 配对码：8 字，5 分钟过期，一次性（complete 后立即失效）
 *   - completePairing：ECDH + HKDF 派生 PairingKey，存入 vault
 */
export class PairingService {
  private identity: StaticIdentity;
  private pending = new Map<string, PendingEntry>();

  constructor(
    private store: PairingStore,
    vault: SecretVault,
  ) {
    this.identity = StaticIdentity.loadOrCreate(vault);
  }

  /** 本端公钥（配对时通过带外通道交换给对端）。 */
  get myPublicKey(): Uint8Array { return this.identity.publicKey; }

  /** 本端指纹（配对时两端比对，防 MITM）。 */
  get myFingerprint(): string { return this.identity.fingerprint; }

  /**
   * 开始配对：生成 8 字配对码 + 登记到 pending 表（5min 过期）。
   * 仅 local 模式可调（由 remote.pair.begin RPC 守卫）。
   */
  beginPairing(): { code: string; ourPubKeyB64: string; fingerprint: string; expiresAt: number } {
    const code = generatePairingCode();
    const expiresAt = Math.floor(Date.now() / 1000) + PAIRING_CODE_TTL_S;
    this.pending.set(code, { expiresAt });
    return {
      code,
      ourPubKeyB64: Buffer.from(this.identity.publicKey).toString('base64'),
      fingerprint: this.identity.fingerprint,
      expiresAt,
    };
  }

  /**
   * 完成配对：消费 code（一次性）+ ECDH 派生 PairingKey + 存入 vault。
   * 仅 pairing 模式可调（由 remote.pair.complete RPC 守卫）。
   * @param code beginPairing 返回的配对码
   * @param peerPubKeyB64 对端公钥（base64）
   * @param peerFingerprint 对端指纹
   * @param peerName 对端设备名（UI 显示用）
   */
  completePairing(
    code: string,
    peerPubKeyB64: string,
    peerFingerprint: string,
    peerName?: string,
  ): { fingerprint: string; ourPubKeyB64: string } {
    const entry = this.pending.get(code);
    if (!entry) throw new Error(`配对码不存在或已失效: ${code}`);
    const now = Math.floor(Date.now() / 1000);
    if (entry.expiresAt <= now) {
      this.pending.delete(code);
      throw new Error(`配对码已过期: ${code}`);
    }
    const peerPub = new Uint8Array(Buffer.from(peerPubKeyB64, 'base64'));
    const key = derivePairingKey(
      this.identity.privateKey,
      peerPub,
      code,
      peerFingerprint,
      peerName ?? '未命名设备',
    );
    this.store.save(key);
    this.pending.delete(code); // 一次性
    return {
      fingerprint: peerFingerprint,
      ourPubKeyB64: Buffer.from(this.identity.publicKey).toString('base64'),
    };
  }

  /** 配对码是否在 pending 表且未过期（供 additionalVerify 查验 pairing 模式连接）。 */
  hasPending(code: string): boolean {
    const entry = this.pending.get(code);
    if (!entry) return false;
    if (entry.expiresAt <= Math.floor(Date.now() / 1000)) {
      this.pending.delete(code);
      return false;
    }
    return true;
  }

  /** 清理所有过期 pending entry。 */
  cleanupExpired(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [code, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(code);
    }
  }

  // ---- 代理 PairingStore 的方法（供 createRemoteMethods/createAdditionalVerify 单参使用）----

  list(): PairingKeyPublicView[] { return this.store.list(); }
  get(fingerprint: string): PairingKey | undefined { return this.store.get(fingerprint); }
  delete(fingerprint: string): void { this.store.delete(fingerprint); }

  /**
   * 加入配对（决策 3：join 侧封装，私钥不离开 service）。
   * 本端作为 join 方，用对端公钥 + 配对码派生 PairingKey 并持久化 + 记地址簿。
   * @param peerPubKeyB64 对端公钥（base64，来自 complete 响应的 myPublicKeyB64）
   * @param peerFingerprint 对端指纹（join 侧从公钥本地重算，防伪报）
   * @param peerName 对端设备名
   * @param code 配对码
   * @param addr 对端监听地址（host:port）
   */
  joinPairing(peerPubKeyB64: string, peerFingerprint: string, peerName: string, code: string, addr: string): void {
    const peerPub = new Uint8Array(Buffer.from(peerPubKeyB64, 'base64'));
    const key = derivePairingKey(this.identity.privateKey, peerPub, code, peerFingerprint, peerName);
    this.store.save(key);
    this.store.setAddress(peerFingerprint, addr);
  }

  /** 代理地址簿方法（供 OutboundClient / remote.status 使用）。 */
  setAddress(fp: string, addr: string): void { this.store.setAddress(fp, addr); }
  getAddress(fp: string): string | undefined { return this.store.getAddress(fp); }
  listWithAddress(): Array<PairingKeyPublicView & { address?: string; lastSeenAt?: number }> { return this.store.listWithAddress(); }
  setLastSeen(fp: string, ts: number): void { this.store.setLastSeen(fp, ts); }
}
