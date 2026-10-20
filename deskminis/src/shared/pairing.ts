/**
 * 配对的共享契约（F11C）：协议号、本机策略、配对码格式、错误码、remote.* 的返回形状。
 *
 * minisd 与渲染端共用，所以这里不放任何密码运算、不用 Node 的 API。
 * 版本信号在带外：v1 码 8 位、字母表里没有 0 和 O；v2 码 12 位、首位固定是标记 0。
 * 加入的一端只凭输入就能判断走哪条协议，网络上不做 v1/v2 协商，也没有「v2 失败改走 v1」的路径。
 */

/** 1 = 旧明文配对（?pairingCode= 加 remote.pair.complete）；2 = 认证配对（SPAKE2，?pair=2）。 */
export type PairingProtocol = 1 | 2;
export const PAIRING_PROTOCOL_V2 = 2;
export const PAIRING_SUITE = 'SPAKE2-P256-SHA256-HKDF-HMAC';

/** 本机配对策略：本地设置决定，不在网络上协商。 */
export type PairingPolicy = 'legacy' | 'authenticated';
/** 独立密码学审查通过前保持 'legacy'（tests/pair-policy.test.ts 有守卫）。 */
export const DEFAULT_PAIRING_POLICY: PairingPolicy = 'legacy';

/** 缺失或不认识的值一律回到 DEFAULT_PAIRING_POLICY。 */
export function parsePairingPolicy(raw: string | undefined): PairingPolicy {
  return raw === 'legacy' || raw === 'authenticated' ? raw : DEFAULT_PAIRING_POLICY;
}

/** 配对码字母表：31 个字符，不含易混的 0、1、I、L、O。 */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LEN_V1 = 8;
export const PAIRING_CODE_LEN_V2 = 12;
/** v2 码的首位。不在 PAIRING_CODE_ALPHABET 里，v1 码不可能以它开头。 */
export const PAIRING_CODE_V2_MARKER = '0';

/** 转大写、去掉 [A-Z0-9] 之外的字符；结果的首字符是 O 时换成 0（抄码时最容易混的一对；
 *  v1 码里没有 O，这一步不会改到 v1 码）；不截断。 */
export function normalizePairingCode(raw: string): string {
  const c = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.startsWith('O') ? PAIRING_CODE_V2_MARKER + c.slice(1) : c;
}

export type PairingCodeKind = { kind: 'v2'; code: string } | { kind: 'v1' } | { kind: 'invalid' };

/** 归一化后：
 *  - 首位是标记：恰好 12 位且后 11 位全在字母表内 → v2（带归一化后的 12 位码）；否则 invalid。
 *    没输完的 v2 码一定落在这一支，在本地就被拦下，不会被当成 v1 码明文发出。
 *  - 首位不是标记：长度恰为 8 → v1；否则 invalid。v1 不查字母表，保持原有行为。 */
export function classifyPairingCode(raw: string): PairingCodeKind {
  const c = normalizePairingCode(raw);
  if (c.startsWith(PAIRING_CODE_V2_MARKER)) {
    if (c.length !== PAIRING_CODE_LEN_V2) return { kind: 'invalid' };
    for (let i = 1; i < c.length; i++) {
      if (!PAIRING_CODE_ALPHABET.includes(c[i])) return { kind: 'invalid' };
    }
    return { kind: 'v2', code: c };
  }
  return c.length === PAIRING_CODE_LEN_V1 ? { kind: 'v1' } : { kind: 'invalid' };
}

export type PairErrorCode =
  | 'PAIR_BAD_CODE_FORMAT'      // J 本地：既不是 8 位的旧码，也不是以 0 开头的完整 12 位码；不发任何网络请求
  | 'PAIR_BAD_NAME'             // J 本地：设备名超过 64 字节或含控制字符；不发任何网络请求
  | 'PAIR_LEGACY_DISABLED'      // 策略是 authenticated 却要走 v1；或 v1 要覆盖一条 v2 记录
  | 'PAIR_UNREACHABLE'          // 连不上对方
  | 'PAIR_NO_PENDING'           // 升级请求被 401：对方没有待用的码、码已作废、正忙，或版本不支持
  | 'PAIR_BUSY'                 // 本机已有一个加入在进行
  | 'PAIR_TIMEOUT'
  | 'PAIR_PROTOCOL'             // 对端的帧不合规
  | 'PAIR_SELF'                 // 对端身份等于本机
  | 'PAIR_CONFIRM_FAILED'       // J 验 cB 失败：码不对，或连接被篡改
  | 'PAIR_PEER_REJECTED'        // H 回了 fail 或提前断开
  | 'PAIR_COMMIT_FAILED'        // 本机写配对记录失败
  | 'PAIR_ROLLBACK_INCOMPLETE'  // 配对失败且刚写入的记录没能清掉（本进程内已吊销）
  | 'PAIR_CANCELLED'            // H：配对码被取消或被新的码顶掉；J：握手期间本机对这个指纹做了解绑或另一次配对
  | 'PAIR_EXPIRED' | 'PAIR_ATTEMPTS_EXHAUSTED' | 'PAIR_CODE_EXPOSED';

/** 每个码的中文说明（界面与错误串共用）。每一条都含「配对」二字；不含码、密钥、对端自报的内容。 */
export const PAIR_ERROR_TEXT: Readonly<Record<PairErrorCode, string>> = Object.freeze({
  PAIR_BAD_CODE_FORMAT: '配对码格式不对：旧方式的配对码是 8 位；认证配对码以 0 开头、共 12 位，要完整输入。',
  PAIR_BAD_NAME: '配对用的设备名不合规：不能超过 64 字节，不能含控制字符。',
  PAIR_LEGACY_DISABLED: '这台机器不接受旧的 8 位配对：已打开认证配对，或这台设备已经用认证配对配过（要改回旧方式得先解绑）。',
  PAIR_UNREACHABLE: '连不上对方，配对没有开始。请检查地址、端口和网络。',
  PAIR_NO_PENDING: '对方没有接受这次配对：对方没有待用的认证配对码、配对码已作废、对方正忙，或对方的版本不支持认证配对。',
  PAIR_BUSY: '这台机器已有一个加入配对在进行，等它结束再试。',
  PAIR_TIMEOUT: '配对超时：对方没有在时限内回应。',
  PAIR_PROTOCOL: '配对失败：对方发来的数据不合规。',
  PAIR_SELF: '配对失败：对方的身份就是这台机器自己。',
  PAIR_CONFIRM_FAILED: '配对码不对，或连接被篡改；配对没有完成。',
  PAIR_PEER_REJECTED: '对方拒绝了这次配对或提前断开；配对没有完成。',
  PAIR_COMMIT_FAILED: '配对记录没能写入这台机器，配对没有完成。',
  PAIR_ROLLBACK_INCOMPLETE: '配对失败，而且刚写入的配对记录没能清掉。这条记录在本次运行期间已停用；重启后请到设备页解绑它。',
  PAIR_CANCELLED: '配对已取消：配对码被取消或被新的配对码顶掉，或配对期间这台设备被解绑、重新配对。',
  PAIR_EXPIRED: '配对码已过期，请重新发起。',
  PAIR_ATTEMPTS_EXHAUSTED: '配对码输错的次数到了上限，这个配对码已作废，请重新发起。',
  PAIR_CODE_EXPOSED: '这个配对码被不支持认证配对的版本明文发了出来，已作废。请让对方换成支持认证配对的版本，再重新发起。',
});

/** 旧的 8 位配对被「对端」以 PAIR_LEGACY_DISABLED 拒绝时，加入端给用户看的说明。
 *  对端回来的原文（PAIR_ERROR_TEXT.PAIR_LEGACY_DISABLED）以「这台机器」为主语，指的是对端；原样显示在加入端会把用户引向错的机器。
 *  这不是一个错误码：它不以 PAIR_ 开头，界面取不到码，原样显示。 */
export const PAIR_PEER_LEGACY_DISABLED_TEXT = '对方不接受旧的 8 位配对：对方已打开认证配对，或对方已经用认证配对配过这台设备。要改回旧方式，得先在对方的设备页解绑这台设备。';

/** message 固定为 `${code}: ${PAIR_ERROR_TEXT[code]}`：底层错误、码、密钥都不进错误串。 */
export class PairError extends Error {
  readonly code: PairErrorCode;
  constructor(code: PairErrorCode) {
    super(`${code}: ${PAIR_ERROR_TEXT[code]}`);
    this.name = 'PairError';
    this.code = code;
  }
}

/** 从 RPC 错误串开头取码；不是 PairError 的消息返回 undefined。 */
export function pairErrorCodeOf(message: string): PairErrorCode | undefined {
  const m = /^(PAIR_[A-Z_]+): /.exec(String(message));
  if (!m) return undefined;
  return Object.prototype.hasOwnProperty.call(PAIR_ERROR_TEXT, m[1]) ? (m[1] as PairErrorCode) : undefined;
}

/** remote.pair.begin 的返回：既有字段不变，新增 protocol、attempts。 */
export interface PairBeginResult {
  pairingCode: string; myPublicKey: Uint8Array; myPublicKeyB64: string; myFingerprint: string; expiresIn: number;
  protocol: PairingProtocol; attempts?: number;
}
export interface PairJoinResult { ok: true; peerFingerprint: string; protocol: PairingProtocol }

/** remote.status 顶层的 pairing 字段。 */
export interface PairStatus {
  policy: PairingPolicy;
  defaultPolicy: PairingPolicy;
  /** 本机发起、仍有效的 v2 码的状态（不含码本身）。v1 的 pending 不在这里。expiresAt 是毫秒时间戳。 */
  host?: { protocol: 2; expiresAt: number; attemptsLeft: number; inFlight: boolean };
  /** 最近一次 v2 主机侧结局；begin 时清空。 */
  lastHostOutcome?:
    | { at: number; kind: 'paired'; peerFingerprint: string; replaced: boolean }
    | { at: number; kind: 'failed'; code: PairErrorCode };
}

/** remote.status 的 devices 一行：既有字段不变，新增后两项。 */
export interface PairedDeviceView {
  peerFingerprint: string; peerName: string; roomId: string; createdAt: number;
  address?: string; lastSeenAt: number; online: boolean;
  pairingProtocol: PairingProtocol;
  /** 这是一条 v1 记录，且对端在线并声明了 pairV2：重新配对可以升级。 */
  canUpgradePairing: boolean;
}
