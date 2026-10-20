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
import type { PairingAcceptor } from '../rpc/server';
import {
  DEFAULT_PAIRING_POLICY, PAIRING_CODE_ALPHABET, PAIRING_CODE_LEN_V2, PAIRING_CODE_V2_MARKER, PairError,
  type PairErrorCode, type PairStatus, type PairingPolicy, type PairingProtocol,
} from '../../shared/pairing';
import { PAIR_STEP_TIMEOUT_MS, base32Encode5 } from './pair-proto';
import { PairingHost } from './pair-host';
import { PairingJoiner } from './pair-join';

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
  /** 建立这条配对的协议（F11C）；缺省（旧记录、v1 写入）= 1。 */
  pairingProtocol?: PairingProtocol;
}

/** PairingStore.list() 返回的脱敏视图（不含密钥材料）。 */
export interface PairingKeyPublicView {
  peerFingerprint: string;
  peerName: string;
  roomId: string;
  createdAt: number;
  /** 建立这条配对的协议（F11C）：1 = 旧明文配对，2 = 认证配对。 */
  pairingProtocol: PairingProtocol;
}

// 8 字配对码字符集（去除易混淆字符 0/O/1/I/L，符合设计 §2.1）：31 个字符（23 个字母加 8 个数字），
// 定义在 shared/pairing.ts 的 PAIRING_CODE_ALPHABET，渲染端与引擎共用。
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

/** 认证配对（F11C）的 12 位码：首位是固定标记 PAIRING_CODE_V2_MARKER，后 11 位从字母表里拒绝采样
 *  （字节 >= 248 丢弃；248 = 31 × 8），无取模偏差。标记位不提供熵：在线猜测的空间是 31^11。 */
export function generatePairingCodeV2(): string {
  let out = PAIRING_CODE_V2_MARKER;
  while (out.length < PAIRING_CODE_LEN_V2) {
    for (const b of randomBytes(16)) {
      if (b >= 248) continue;
      out += PAIRING_CODE_ALPHABET[b % PAIRING_CODE_ALPHABET.length];
      if (out.length === PAIRING_CODE_LEN_V2) break;
    }
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
// base32Encode5（5 字节 → 8 字符 base32）搬到了 pair-proto.ts，v1 与 v2 的 roomId 共用同一个实现。

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

/** PairingStore.commit 的结果（F11C）：一次事务式写入的句柄。 */
export interface PairingCommit {
  readonly peerFingerprint: string;
  /** 提交前这个指纹下有一条生效的记录（被吊销的不算）。 */
  readonly replaced: boolean;
  /** 暂存的提交由此转为生效。返回 false 表示这次提交已被别的写入或解绑取代，记录没有生效。
   *  非暂存的提交恒返回 true。重复调用无害。 */
  activate(): boolean;
  /** 撤回这次提交。clean=false 表示确认到本次写入的记录还留在 vault 里；
   *  不论 clean 与否，回滚后该指纹在本进程里要么是提交前的旧记录，要么没有记录。 */
  rollback(): { clean: boolean };
}

/** PairingKey 持久化存储（vault 存密钥本体，index 文件存 fingerprint 列表以支持 list）。 */
export class PairingStore {
  private indexFile: string;
  private addressFile: string;
  /** 被吊销的指纹（F11C；只在进程内，不落盘）：一次失败的握手写进 vault 的记录没能确认删掉时，
   *  本进程里当它不存在——get / list 读不到，握不了通道，也不算已配对。只有这个指纹有了一条新的、生效的记录才解除。 */
  private revoked = new Set<string>();
  /** 暂存中的提交（F11C；只在进程内）：密钥已经写进 vault，但生效视图仍是提交前的原文 prevRaw；
   *  owner 是那次提交自己的标识，别的写入或解绑会把标记摘掉。 */
  private staged = new Map<string, { prevRaw: string | undefined; owner: object }>();

  constructor(private dataDir: string, private vault: SecretVault) {
    this.indexFile = join(dataDir, INDEX_FILE);
    this.addressFile = join(dataDir, ADDRESS_FILE);
  }

  private vaultKey(fp: string): string { return `pairing.${fp}`; }

  /** 生效视图（F11C）：get / list 都经这里读，isPaired、通道候选、出站拨号、remote.status 看到的因此都是它。
   *  被吊销的指纹不存在；暂存中的指纹仍是提交前的样子。两个集合都空时就是 vault.get。 */
  private rawView(fp: string): string | undefined {
    if (this.revoked.has(fp)) return undefined;
    const s = this.staged.get(fp);
    return s ? s.prevRaw : this.vault.get(this.vaultKey(fp));
  }

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
    // F11C：这个指纹有了一条新的、生效的记录——摘掉暂存与吊销标记（两个集合缺省为空，v1 的行为不变）。
    // 不摘的话，吊销之后做的 v1 配对写了记录却在本进程里看不见。
    this.staged.delete(fp);
    this.revoked.delete(fp);
    const fps = this.readIndex();
    if (!fps.includes(fp)) { fps.push(fp); this.writeIndex(fps); }
  }

  /**
   * 事务式写入（F11C，认证配对用）：地址簿 → 索引 → vault.set。vault 写入是唯一的提交点——
   * isPaired 与通道候选都只看 vault，之前任何一步失败留下的只有非机密的索引或地址项，而 list() 会滤掉没有 vault 条目的指纹。
   * 任一步抛错先按相反顺序恢复，再抛 PairError('PAIR_COMMIT_FAILED')（底层错误不向上带，免得 vault 或文件系统的原始错误串进 RPC 返回）。
   *
   * opts.staged 为真时写入后不生效（get / list 仍返回提交前的视图），调 activate() 才生效；缺省即时生效。
   * 加入端先落盘再发确认，收到对端的 done 才生效：在那之前新密钥握不了通道，一个知道码的对端没法先连上来再让握手失败。
   */
  commit(key: PairingKey, address?: string, opts?: { staged?: boolean }): PairingCommit {
    const fp = key.peerFingerprint;
    const k = this.vaultKey(fp);
    // 旧值读的是生效视图，不是裸读 vault：指纹已被吊销时 vault 里残留的那份原文不算旧值，之后的回滚不会把它写回去
    const prevRaw = this.rawView(fp);
    const prevInIndex = this.readIndex().includes(fp);
    const prevAddr = this.readAddressIndex()[fp];
    const writtenRaw = JSON.stringify({
      authKey: Buffer.from(key.authKey).toString('base64'),
      sessionSecret: Buffer.from(key.sessionSecret).toString('base64'),
      roomId: key.roomId,
      peerName: key.peerName,
      createdAt: key.createdAt,
      ...(key.pairingProtocol === 2 ? { proto: 2 } : {}),
    });
    let writtenAddr: AddressEntry | undefined;
    let addedIndex = false;
    const restoreAddress = (): void => {
      const index = this.readAddressIndex();
      if (prevAddr) index[fp] = prevAddr; else delete index[fp];
      this.writeAddressIndex(index);
    };
    const dropFromIndex = (): void => { this.writeIndex(this.readIndex().filter(x => x !== fp)); };
    try {
      if (address !== undefined) {
        const index = this.readAddressIndex();
        const entry: AddressEntry = { address, learnedAt: Math.floor(Date.now() / 1000), lastSeenAt: prevAddr?.lastSeenAt };
        index[fp] = entry;
        this.writeAddressIndex(index);
        writtenAddr = entry;
      }
      if (!prevInIndex) {
        this.writeIndex([...this.readIndex(), fp]);
        addedIndex = true;
      }
      this.vault.set(k, writtenRaw); // 提交点
    } catch {
      if (addedIndex) { try { dropFromIndex(); } catch { /* 尽力恢复 */ } }
      if (writtenAddr) { try { restoreAddress(); } catch { /* 尽力恢复 */ } }
      throw new PairError('PAIR_COMMIT_FAILED');
    }

    const owner = {};
    // active：这次提交已经生效（即时生效的提交一开始就是）。生效之后 rollback 什么都不做
    let active = opts?.staged !== true;
    if (active) {
      this.staged.delete(fp);
      this.revoked.delete(fp);
    } else {
      this.staged.set(fp, { prevRaw, owner });
    }
    return {
      peerFingerprint: fp,
      replaced: prevRaw !== undefined,
      activate: (): boolean => {
        if (active) return true;
        // 暂存标记已经不是自己的：被别的写入或解绑摘掉了（或已经回滚），什么都不改
        if (this.staged.get(fp)?.owner !== owner) return false;
        this.staged.delete(fp);
        this.revoked.delete(fp);
        active = true;
        return true;
      },
      rollback: (): { clean: boolean } => {
        if (active) return { clean: true };
        let clean = true;
        // 先读当前值：只有它仍是本次写入时才往 vault 里写旧值或删除，窗口期里别的操作留下的状态不会被这次回滚覆盖
        let cur: string | undefined;
        try { cur = this.vault.get(k); } catch { cur = undefined; }
        if (cur === writtenRaw) {
          if (prevRaw !== undefined) {
            // 本次写入还在，提交前有生效记录：把旧原文写回去
            try {
              this.vault.set(k, prevRaw);
              if (writtenAddr) { try { restoreAddress(); } catch { /* 尽力恢复 */ } }
              if (addedIndex) { try { dropFromIndex(); } catch { /* 尽力恢复 */ } }
            } catch {
              // 写不回去：vault 里留着的是这次失败握手的密钥，本进程里吊销它
              this.revoked.add(fp);
              clean = false;
            }
          } else {
            // 提交前没有生效记录（包括提交前已被吊销）：目标是「没有记录」，一律先吊销再删，不等删除得到确认
            // （KeyringVault.delete 与 get 都吞错，「删了、复查也说没了」不能当真）
            this.revoked.add(fp);
            try { this.vault.delete(k); } catch { /* 下面复查 */ }
            let still: string | undefined;
            try { still = this.vault.get(k); } catch { still = undefined; }
            if (still === undefined) {
              if (addedIndex) { try { dropFromIndex(); } catch { /* 尽力恢复 */ } }
              if (writtenAddr) { try { restoreAddress(); } catch { /* 尽力恢复 */ } }
            } else {
              // 确认到还在：索引与地址簿保持不动，重启后设备页能看到并解绑
              clean = false;
            }
          }
        } else if (cur === undefined) {
          // 窗口内这个指纹被解绑了（也可能是凭据库这一次读失败）：不写回旧值，按「没有记录」的方向处理
          this.revoked.add(fp);
          try { this.vault.delete(k); } catch { /* 条目已不存在时是空操作 */ }
          if (addedIndex) { try { dropFromIndex(); } catch { /* 尽力恢复 */ } }
          if (writtenAddr) {
            try {
              const index = this.readAddressIndex();
              const now = index[fp];
              // 地址簿里这一项仍是本次写的才删
              if (now && now.address === writtenAddr.address && now.learnedAt === writtenAddr.learnedAt) {
                delete index[fp];
                this.writeAddressIndex(index);
              }
            } catch { /* 尽力恢复 */ }
          }
        }
        // 其它值：窗口内同一指纹有了别的记录（v1 的 save，或另一次即时生效的 commit）——vault、索引、地址簿都不动
        if (this.staged.get(fp)?.owner === owner) this.staged.delete(fp);
        return { clean };
      },
    };
  }

  /** 按 fingerprint 取回完整 PairingKey（含密钥材料）。读的是生效视图（见 rawView）。 */
  get(fp: string): PairingKey | undefined {
    const raw = this.rawView(fp);
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
        pairingProtocol: obj.proto === 2 ? 2 : 1,
      };
    } catch { return undefined; }
  }

  /** 列出所有已配对设备（脱敏视图，不含密钥材料）。读的是生效视图（见 rawView）。 */
  list(): PairingKeyPublicView[] {
    return this.readIndex().map(fp => {
      const raw = this.rawView(fp);
      if (!raw) return null;
      try {
        const obj = JSON.parse(raw);
        const pairingProtocol: PairingProtocol = obj.proto === 2 ? 2 : 1;
        return { peerFingerprint: fp, peerName: obj.peerName, roomId: obj.roomId, createdAt: obj.createdAt, pairingProtocol };
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
    // F11C：解绑摘掉这个指纹的暂存标记——握手窗口内的解绑不会被之后的 activate() 或 rollback() 撤销。
    // 不动吊销：条目真的没了，吊销与否读出来都是「没有」；条目其实还在（删除被吞错），吊销必须留着。
    this.staged.delete(fp);
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

/** 配对生命周期事件（F11C，审计用）。事件里没有码和密钥。 */
export type PairingEvent =
  | { kind: 'begin'; protocol: PairingProtocol }
  | { kind: 'paired'; protocol: 2; role: 'host' | 'join'; peerFingerprint: string; replaced: boolean }
  | { kind: 'failed'; protocol: 2; role: 'host' | 'join'; code: PairErrorCode }
  | { kind: 'cancelled' }
  | { kind: 'policy'; policy: PairingPolicy };

/** v2 配对记录落定或被撤回的通知（setPairedListener）。 */
export type PairedNotice =
  | { kind: 'paired'; role: 'host' | 'join'; peerFingerprint: string; replaced: boolean }
  | { kind: 'rolledBack'; peerFingerprint: string };

export interface PairingServiceOpts {
  /** 缺省：进程内的一个变量，初值 DEFAULT_PAIRING_POLICY。 */
  policy?: { get(): PairingPolicy; set(p: PairingPolicy): void };
  /** 毫秒；测试注入。缺省 Date.now。 */
  now?: () => number;
  /** J 侧每一步的时限；测试注入短值。缺省 PAIR_STEP_TIMEOUT_MS。 */
  joinStepMs?: number;
  /** v2 码的有效期（毫秒）；只给到期定时器的测试注入短值，minisd/index.ts 不传。
   *  缺省 PAIRING_CODE_TTL_S * 1000；大于缺省值的注入值按缺省值算（只能调短）。 */
  codeTtlMs?: number;
  /** 审计用；回调里抛的错被吞掉。事件里没有码和密钥。 */
  onEvent?: (e: PairingEvent) => void;
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
  // ---- F11C：策略、认证配对 v2 的两端、事件 ----
  private readonly policyStore: { get(): PairingPolicy; set(p: PairingPolicy): void };
  private readonly onEvent: ((e: PairingEvent) => void) | undefined;
  private readonly now: () => number;
  private readonly host: PairingHost;
  private readonly joiner: PairingJoiner;
  private pairedListener: ((e: PairedNotice) => void) | undefined;

  constructor(
    private store: PairingStore,
    vault: SecretVault,
    opts: PairingServiceOpts = {},
  ) {
    this.identity = StaticIdentity.loadOrCreate(vault);
    let memPolicy: PairingPolicy = DEFAULT_PAIRING_POLICY;
    this.policyStore = opts.policy ?? { get: () => memPolicy, set: p => { memPolicy = p; } };
    this.onEvent = opts.onEvent;
    this.now = opts.now ?? Date.now;
    const emit = (e: PairingEvent): void => this.emit(e);
    const notify = (e: PairedNotice): void => {
      // 监听者出错不撤销配对，也不让握手状态机看到异常
      try { this.pairedListener?.(e); } catch { /* 见上 */ }
    };
    const defaultTtlMs = PAIRING_CODE_TTL_S * 1000;
    this.host = new PairingHost({
      myPublicKey: this.identity.publicKey,
      now: this.now,
      // 注入值只能把有效期调短，调不长
      codeTtlMs: Math.min(opts.codeTtlMs ?? defaultTtlMs, defaultTtlMs),
      generateCode: generatePairingCodeV2,
      commit: (key, address) => this.store.commit(key, address),
      emit, notify,
    });
    this.joiner = new PairingJoiner({
      myPublicKey: this.identity.publicKey,
      now: this.now,
      stepMs: opts.joinStepMs ?? PAIR_STEP_TIMEOUT_MS,
      commit: (key, address) => this.store.commit(key, address, { staged: true }),
      emit, notify,
    });
  }

  /** 事件回调里抛的错被吞掉：审计写失败不该让配对失败。 */
  private emit(e: PairingEvent): void {
    try { this.onEvent?.(e); } catch { /* 见上 */ }
  }

  /** 本机配对策略。每次现读（来源是 settings 表）；读失败由调用方决定怎么处理。 */
  policy(): PairingPolicy { return this.policyStore.get(); }

  /** 持久化新策略，清空全部待用的码（v1 与 v2），使在途握手失败。写入失败原样向上抛。 */
  setPolicy(p: PairingPolicy): void {
    this.policyStore.set(p);
    this.cancelPairing();
    this.emit({ kind: 'policy', policy: p });
  }

  /** 认证配对 v2 的发起：生成 12 位码（不上线路），安装待用状态。自己不看策略，由 remote.pair.begin 按策略选择。 */
  async beginPairingV2(): Promise<{ code: string; ourPubKeyB64: string; fingerprint: string; expiresAt: number; attempts: number }> {
    const r = await this.host.begin();
    return {
      code: r.code,
      ourPubKeyB64: Buffer.from(this.identity.publicKey).toString('base64'),
      fingerprint: this.identity.fingerprint,
      expiresAt: r.expiresAt,
      attempts: r.attempts,
    };
  }

  /** 认证配对 v2 的加入：code 是归一化后的 12 位码。失败抛 PairError。 */
  joinPairingV2(p: { host: string; port: number; code: string; name?: string; listenPort?: number }): Promise<{ peerFingerprint: string; replaced: boolean }> {
    return this.joiner.join(p);
  }

  /** 作废本机全部待用的码（v1 的 pending 全清，v2 的码作废、在途握手失败）。幂等，不抛错。 */
  cancelPairing(): { cancelled: boolean } {
    try {
      const hadV1 = this.pending.size > 0;
      this.pending.clear();
      const hadV2 = this.host.cancel();
      const cancelled = hadV1 || hadV2;
      if (cancelled) this.emit({ kind: 'cancelled' });
      return { cancelled };
    } catch {
      return { cancelled: false };
    }
  }

  /** remote.status 顶层的 pairing 字段。调用时先做过期检查：v2 码已过期就当场清掉并记结局 PAIR_EXPIRED。 */
  pairingStatus(): PairStatus {
    return { policy: this.policy(), defaultPolicy: DEFAULT_PAIRING_POLICY, ...this.host.status() };
  }

  /** 烧码规则：v1 入口上出现了当前 v2 码（或它的一段），说明它被明文发了出来，当场作废。不抛错。 */
  noteLegacyAttempt(presented: string): void {
    try { this.host.noteLegacyAttempt(presented); } catch { /* 不抛错 */ }
  }

  /** 交给 createAdditionalVerify：RpcServer 的 ?pair=2 入口经它受理握手。 */
  get pairingAcceptor(): PairingAcceptor { return this.host.acceptor; }

  /** v2 配对记录落定或被撤回之后调。只有一个监听者，由 createRemoteMethods 设置；监听者抛的错被吞掉。
   *  paired：H 落盘之后、回 done 之前；J 收到 done 且 activate() 为真之后。
   *  rolledBack：J 在落盘之后失败、rollback() 做完之后（不论 clean 与否，也包括 activate() 返回 false）。 */
  setPairedListener(fn: (e: PairedNotice) => void): void { this.pairedListener = fn; }

  /** 本端公钥（配对时通过带外通道交换给对端）。 */
  get myPublicKey(): Uint8Array { return this.identity.publicKey; }

  /** 本端指纹（配对时两端比对，防 MITM）。 */
  get myFingerprint(): string { return this.identity.fingerprint; }

  /**
   * 开始配对：生成 8 字配对码 + 登记到 pending 表（5min 过期）。
   * 仅 local 模式可调（由 remote.pair.begin RPC 守卫）。
   */
  beginPairing(): { code: string; ourPubKeyB64: string; fingerprint: string; expiresAt: number } {
    // F11C：策略为 authenticated 时 v1 入口整体关闭（服务层也设闸，防止绕过 RPC 直接调用）
    if (this.policy() === 'authenticated') throw new PairError('PAIR_LEGACY_DISABLED');
    const code = generatePairingCode();
    const expiresAt = Math.floor(Date.now() / 1000) + PAIRING_CODE_TTL_S;
    this.pending.set(code, { expiresAt });
    this.emit({ kind: 'begin', protocol: 1 });
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
    if (this.policy() === 'authenticated') throw new PairError('PAIR_LEGACY_DISABLED');
    const entry = this.pending.get(code);
    if (!entry) throw new Error(`配对码不存在或已失效: ${code}`);
    const now = Math.floor(Date.now() / 1000);
    if (entry.expiresAt <= now) {
      this.pending.delete(code);
      throw new Error(`配对码已过期: ${code}`);
    }
    // F11C：v1 不得覆盖已有的 v2 记录（两种策略下都生效）。v1 的对端指纹是自报的，放行等于让知道 v1 码的人
    // 顶替一条经过认证的配对；要改回旧方式得先解绑。
    if (this.store.get(peerFingerprint)?.pairingProtocol === 2) throw new PairError('PAIR_LEGACY_DISABLED');
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
    if (this.policy() === 'authenticated') return false; // F11C：authenticated 下 v1 入口全拒
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
    // F11C 的两道闸，与 completePairing 相同：authenticated 下不执行 v1；v1 不得覆盖已有的 v2 记录
    if (this.policy() === 'authenticated') throw new PairError('PAIR_LEGACY_DISABLED');
    if (this.store.get(peerFingerprint)?.pairingProtocol === 2) throw new PairError('PAIR_LEGACY_DISABLED');
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
