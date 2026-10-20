/**
 * SPAKE2（RFC 9382），套件 SPAKE2-P256-SHA256-HKDF-HMAC（RFC §6）。纯函数，无 I/O，直接对 RFC 附录 B 的向量
 * （tests/spake2-rfc9382.test.ts）。
 *
 * 这里只有 RFC 规定的部分：份额、共享点 K、transcript TT、Ke / Ka、确认密钥与确认值。
 * 身份串、AAD 的取值、帧格式、由 Ke 导出配对密钥——这些是本项目自定的，在 pair-proto.ts。
 *
 * 记号（RFC §3、§4）：
 *   pA = w·M + x·P（A 发出）        pB = w·N + y·P（B 发出）
 *   K  = h·x·(pB − w·N)（A 算）  =  h·y·(pA − w·M)（B 算）；P-256 的余因子 h = 1
 *   TT = len(A)‖A‖len(B)‖B‖len(pA)‖pA‖len(pB)‖pB‖len(K)‖K‖len(w)‖w      len 是 8 字节小端
 *   Ke‖Ka = Hash(TT)（各一半）     KcA‖KcB = KDF(Ka, nil, "ConfirmationKeys"‖AAD)
 *   cA = MAC(KcA, TT)               cB = MAC(KcB, TT)
 *
 * RFC §7 的要求在这里的落点：
 *   - 收到的点必须在群内，否则中止：checkShare 卡长度与首字节（noble 的 fromBytes 也接受 33 字节压缩点，所以要自己卡），
 *     再 fromBytes（不在曲线上抛错）与 assertValidity；相减得到无穷远点也中止。
 *   - x、y 均匀随机且不得复用：缺省每次调用取新的 randomSecretKey；注入标量只给向量测试用。
 *   - 确认值的比较由调用方用常数时间比较做（pair-host.ts / pair-join.ts）。
 * 已知局限（写在规格文档的未审查清单里）：noble 的 P-256 跑在 JS BigInt 上，不是恒定时间；bigint 标量无法清零。
 */
import { p256 } from '@noble/curves/nist.js';
import { bytesToNumberBE, concatBytes, numberToBytesBE } from '@noble/curves/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

/** RFC 9382 §6 给 P-256 的 M、N（压缩编码）。 */
export const SPAKE2_M_HEX = '02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f';
export const SPAKE2_N_HEX = '03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49';
/** 份额与 K 的线上编码：SEC1 未压缩点，0x04 加两个 32 字节坐标。 */
export const SPAKE2_SHARE_LEN = 65;

export class Spake2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Spake2Error';
  }
}

const Point = p256.Point;
type P256Point = ReturnType<typeof p256.Point.fromHex>;
/** 群的阶 n。 */
export const SPAKE2_ORDER: bigint = Point.Fn.ORDER;
const M: P256Point = Point.fromHex(SPAKE2_M_HEX);
const N: P256Point = Point.fromHex(SPAKE2_N_HEX);
const CONFIRMATION_KEYS = new TextEncoder().encode('ConfirmationKeys');

/** u64le(len(x)) ‖ x */
export function lp8(x: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + x.length);
  new DataView(out.buffer).setBigUint64(0, BigInt(x.length), true);
  out.set(x, 8);
  return out;
}

function assertScalar(k: bigint, what: string): void {
  if (typeof k !== 'bigint' || k < 1n || k >= SPAKE2_ORDER) throw new Spake2Error(`${what} 不在 [1, n-1] 内`);
}

/** 由口令导出的标量 w 以及预先算好的 w·M、w·N。 */
export interface Spake2Password { readonly w: bigint; readonly wM: P256Point; readonly wN: P256Point }

/** w 必须在 [1, n-1]，否则抛 Spake2Error。 */
export function spake2Password(w: bigint): Spake2Password {
  assertScalar(w, 'w');
  return { w, wM: M.multiply(w), wN: N.multiply(w) };
}

/** 本端的份额。role A 用 M，B 用 N。scalar 只给向量测试注入；缺省每次取新的随机标量。 */
export function spake2Share(role: 'A' | 'B', pw: Spake2Password, scalar?: bigint): { scalar: bigint; share: Uint8Array } {
  const k = scalar ?? bytesToNumberBE(p256.utils.randomSecretKey());
  assertScalar(k, '临时标量');
  const blind = role === 'A' ? pw.wM : pw.wN;
  return { scalar: k, share: blind.add(Point.BASE.multiply(k)).toBytes(false) };
}

/** 对端发来的份额：恰好 65 字节、首字节 0x04、在曲线上。 */
function checkShare(share: Uint8Array): P256Point {
  if (!(share instanceof Uint8Array) || share.length !== SPAKE2_SHARE_LEN || share[0] !== 0x04) {
    throw new Spake2Error('对端份额的编码不对');
  }
  try {
    const pt = Point.fromBytes(share);
    pt.assertValidity();
    return pt;
  } catch {
    throw new Spake2Error('对端份额不在曲线上');
  }
}

export interface Spake2Output {
  /** K 与 TT 只供向量测试比对；状态机不得外传、不得记日志。 */
  K: Uint8Array; TT: Uint8Array;
  /** 各 16 字节。 */
  Ke: Uint8Array; Ka: Uint8Array; KcA: Uint8Array; KcB: Uint8Array;
  /** 各 32 字节。 */
  cA: Uint8Array; cB: Uint8Array;
}

/** 校验对端份额（65 字节、0x04、在曲线上、相减结果不是无穷远点），算出全部输出；任何一项不对抛 Spake2Error。
 *  role 是本端的角色：A 的对端份额是 pB，B 的对端份额是 pA。本端自己的份额原样进 TT。 */
export function spake2Finish(i: {
  role: 'A' | 'B'; pw: Spake2Password; scalar: bigint;
  pA: Uint8Array; pB: Uint8Array; idA: Uint8Array; idB: Uint8Array; aad: Uint8Array;
}): Spake2Output {
  assertScalar(i.scalar, '临时标量');
  if (i.pA.length !== SPAKE2_SHARE_LEN || i.pB.length !== SPAKE2_SHARE_LEN) throw new Spake2Error('份额长度不对');
  const peer = checkShare(i.role === 'A' ? i.pB : i.pA);
  const unblinded = peer.subtract(i.role === 'A' ? i.pw.wN : i.pw.wM);
  // 对端份额恰好等于 w·N（或 w·M）：K 会是无穷远点，与口令无关，必须中止
  if (unblinded.is0()) throw new Spake2Error('对端份额无效');
  const shared = unblinded.multiply(i.scalar);
  if (shared.is0()) throw new Spake2Error('对端份额无效');
  const K = shared.toBytes(false);
  const w = numberToBytesBE(i.pw.w, 32);
  const TT = concatBytes(lp8(i.idA), lp8(i.idB), lp8(i.pA), lp8(i.pB), lp8(K), lp8(w));
  w.fill(0);
  const h = sha256(TT);
  const Ke = h.slice(0, 16);
  const Ka = h.slice(16, 32);
  h.fill(0);
  const kc = hkdf(sha256, Ka, undefined, concatBytes(CONFIRMATION_KEYS, i.aad), 32);
  const KcA = kc.slice(0, 16);
  const KcB = kc.slice(16, 32);
  kc.fill(0);
  return { K, TT, Ke, Ka, KcA, KcB, cA: hmac(sha256, KcA, TT), cB: hmac(sha256, KcB, TT) };
}
