/**
 * 认证配对（F11C，配对协议 v2）里本项目自定的部分：帧、身份串、上下文哈希、由 Ke 导出配对密钥、常量。
 * RFC 9382 规定的运算在 spake2.ts；这里的编码都在 RFC 之外，没有公开向量可对，列在规格文档的未审查清单里
 * （docs/specs/2026-10-03-f11c-authenticated-pairing.md）。
 *
 * 传输：ws://<H>/?pair=2，URL 里没有任何秘密。帧是文本 JSON，键集必须恰好等于约定，多一个键、少一个键、
 * 类型或长度不对都算格式错；二进制字段是严格的 base64url。
 *
 *   M1  J→H  dm.pair.hello    v, suite, id(32B), name, listenPort, pA(65B)
 *   M2  H→J  dm.pair.reply    v, id(32B), pB(65B), cB(32B)
 *   M3  J→H  dm.pair.confirm  v, cA(32B)
 *   M4  H→J  dm.pair.done     v
 *       H→J  dm.pair.fail     v        所有失败原因都是这同一串字节
 *
 * J 是 SPAKE2 的 A（用 M），H 是 B（用 N）。
 *   A   = utf8("DeskMinis/Pair/2/joiner") ‖ 0x00 ‖ spkJ        B = utf8("DeskMinis/Pair/2/host") ‖ 0x00 ‖ spkH
 *   ctx = lp(utf8("DeskMinis/Pair/2/ctx")) ‖ lp(utf8(suite)) ‖ lp([0x02]) ‖ lp(utf8(name)) ‖ lp(u16be(listenPort))
 *   AAD = ctxH = SHA-256(ctx)
 *
 * 本文件不依赖 pairing.ts（pairing.ts 反过来从这里取 base32Encode5）。
 */
import { bytesToNumberBE, concatBytes } from '@noble/curves/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { PAIRING_PROTOCOL_V2, PAIRING_SUITE, PairError } from '../../shared/pairing';
import { SPAKE2_ORDER, SPAKE2_SHARE_LEN, lp8 } from './spake2';

/** URL 里标明「走认证配对」的查询参数：?pair=2。 */
export const PAIR_QUERY = 'pair';
/** 握手每一步的时限。 */
export const PAIR_STEP_TIMEOUT_MS = 10_000;
/** 每个配对码最多几次握手。 */
export const PAIR_MAX_ATTEMPTS = 5;
export const PAIR_MAX_FRAME_BYTES = 2048;
export const PAIR_NAME_MAX_BYTES = 64;
/** w = OS2IP(scrypt(code)) mod n。dkLen 40 字节比 n 多 64 位，取模偏差可忽略。 */
export const PAIR_SCRYPT = Object.freeze({ N: 2 ** 14, r: 8, p: 1, dkLen: 40 });
export const PAIR_SCRYPT_SALT = 'DeskMinis/Pair/2/w';
export const PAIR_DONE_FRAME = '{"t":"dm.pair.done","v":2}';
export const PAIR_FAIL_FRAME = '{"t":"dm.pair.fail","v":2}';

const T_HELLO = 'dm.pair.hello';
const T_REPLY = 'dm.pair.reply';
const T_CONFIRM = 'dm.pair.confirm';
const STATIC_KEY_LEN = 32;
const CONFIRM_LEN = 32;

const TE = new TextEncoder();
const ID_JOINER = TE.encode('DeskMinis/Pair/2/joiner');
const ID_HOST = TE.encode('DeskMinis/Pair/2/host');
const CTX_LABEL = TE.encode('DeskMinis/Pair/2/ctx');
const INFO_PAIRING_V2 = TE.encode('DeskMinis/PairingKey/v2');
const INFO_ROOM_V2 = TE.encode('DeskMinis/PairingKey/roomId/v2');

export interface PairHello { id: Uint8Array; name: string; listenPort: number; pA: Uint8Array }
export interface PairReply { id: Uint8Array; pB: Uint8Array; cB: Uint8Array }
export interface PairConfirm { cA: Uint8Array }

/** M1 的 name 规则：UTF-8 不超过 PAIR_NAME_MAX_BYTES 字节、不含控制字符（U+0000–U+001F、U+007F–U+009F），可为空。
 *  parsePairHello 与 J 侧的发送前检查共用这一个函数，所以 J 放行的名字 H 一定接受。 */
export function isValidPairName(name: string): boolean {
  if (typeof name !== 'string') return false;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return false;
  return TE.encode(name).length <= PAIR_NAME_MAX_BYTES;
}

const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');

/** 严格的 base64url：字符集合规、解码后长度精确、再编码等于原串（挡掉填充、尾部多余位、标准 base64 字符）。 */
function strictB64u(v: unknown, len: number): Uint8Array {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]*$/.test(v)) throw new PairError('PAIR_PROTOCOL');
  const buf = Buffer.from(v, 'base64url');
  if (buf.length !== len || buf.toString('base64url') !== v) throw new PairError('PAIR_PROTOCOL');
  return new Uint8Array(buf);
}

/** 解析成对象并要求键集恰好等于 keys。 */
function parseFrame(text: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > PAIR_MAX_FRAME_BYTES) throw new PairError('PAIR_PROTOCOL');
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { throw new PairError('PAIR_PROTOCOL'); }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new PairError('PAIR_PROTOCOL');
  const got = Object.keys(obj);
  if (got.length !== keys.length || !keys.every(k => Object.prototype.hasOwnProperty.call(obj, k))) throw new PairError('PAIR_PROTOCOL');
  return obj as Record<string, unknown>;
}

function sharePoint(v: unknown): Uint8Array {
  const b = strictB64u(v, SPAKE2_SHARE_LEN);
  // 只查编码形状（未压缩点的首字节）；在不在曲线上由 spake2Finish 查
  if (b[0] !== 0x04) throw new PairError('PAIR_PROTOCOL');
  return b;
}

/** 自动带 t、v、suite；name 不合规抛 PairError('PAIR_BAD_NAME')。 */
export function encodePairHello(m: PairHello): string {
  if (!isValidPairName(m.name)) throw new PairError('PAIR_BAD_NAME');
  return JSON.stringify({
    t: T_HELLO, v: PAIRING_PROTOCOL_V2, suite: PAIRING_SUITE,
    id: b64u(m.id), name: m.name, listenPort: m.listenPort, pA: b64u(m.pA),
  });
}
export function encodePairReply(m: PairReply): string {
  return JSON.stringify({ t: T_REPLY, v: PAIRING_PROTOCOL_V2, id: b64u(m.id), pB: b64u(m.pB), cB: b64u(m.cB) });
}
export function encodePairConfirm(m: PairConfirm): string {
  return JSON.stringify({ t: T_CONFIRM, v: PAIRING_PROTOCOL_V2, cA: b64u(m.cA) });
}

/** 严格解析：不合规抛 PairError('PAIR_PROTOCOL')。只查格式，不查点是否在曲线上。 */
export function parsePairHello(text: string): PairHello {
  const o = parseFrame(text, ['t', 'v', 'suite', 'id', 'name', 'listenPort', 'pA']);
  // 版本与套件严格相等：没有带内协商，换协议另开入口
  if (o.t !== T_HELLO || o.v !== PAIRING_PROTOCOL_V2 || o.suite !== PAIRING_SUITE) throw new PairError('PAIR_PROTOCOL');
  if (typeof o.name !== 'string' || !isValidPairName(o.name)) throw new PairError('PAIR_PROTOCOL');
  const port = o.listenPort;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) throw new PairError('PAIR_PROTOCOL');
  return { id: strictB64u(o.id, STATIC_KEY_LEN), name: o.name, listenPort: port, pA: sharePoint(o.pA) };
}
export function parsePairReply(text: string): PairReply {
  const o = parseFrame(text, ['t', 'v', 'id', 'pB', 'cB']);
  if (o.t !== T_REPLY || o.v !== PAIRING_PROTOCOL_V2) throw new PairError('PAIR_PROTOCOL');
  return { id: strictB64u(o.id, STATIC_KEY_LEN), pB: sharePoint(o.pB), cB: strictB64u(o.cB, CONFIRM_LEN) };
}
export function parsePairConfirm(text: string): PairConfirm {
  const o = parseFrame(text, ['t', 'v', 'cA']);
  if (o.t !== T_CONFIRM || o.v !== PAIRING_PROTOCOL_V2) throw new PairError('PAIR_PROTOCOL');
  return { cA: strictB64u(o.cA, CONFIRM_LEN) };
}

/** J 用：'done' / 'fail'；都不是返回 undefined。收尾帧不带认证，只认这两串固定的字节。 */
export function parsePairEnd(text: string): 'done' | 'fail' | undefined {
  if (text === PAIR_DONE_FRAME) return 'done';
  if (text === PAIR_FAIL_FRAME) return 'fail';
  return undefined;
}

/** w = OS2IP(scrypt(utf8(code), salt, N, r, p, dkLen)) mod n；结果为 0 抛 PairError('PAIR_BAD_CODE_FORMAT')。
 *  code 是归一化后的 12 个字符（标记位也在里面）。scryptAsync 会让出事件循环。 */
export async function derivePasswordScalar(code: string): Promise<bigint> {
  const dk = await scryptAsync(TE.encode(code), TE.encode(PAIR_SCRYPT_SALT), { ...PAIR_SCRYPT });
  const w = bytesToNumberBE(dk) % SPAKE2_ORDER;
  dk.fill(0);
  if (w === 0n) throw new PairError('PAIR_BAD_CODE_FORMAT');
  return w;
}

/** SPAKE2 的身份串：角色标签 ‖ 0x00 ‖ 32 字节 X25519 静态公钥。角色进身份串，M 与 N 又不对称，反射过不了确认。 */
export function pairIdentity(role: 'joiner' | 'host', staticPub: Uint8Array): Uint8Array {
  return concatBytes(role === 'joiner' ? ID_JOINER : ID_HOST, new Uint8Array([0]), staticPub);
}

/** 32 字节的 ctxH：协议版本、套件、name、listenPort。作为 RFC 的 AAD 进确认密钥，同时进配对密钥导出的 info。 */
export function pairContextHash(c: { name: string; listenPort: number }): Uint8Array {
  const port = new Uint8Array(2);
  new DataView(port.buffer).setUint16(0, c.listenPort);
  return sha256(concatBytes(
    lp8(CTX_LABEL), lp8(TE.encode(PAIRING_SUITE)), lp8(new Uint8Array([PAIRING_PROTOCOL_V2])),
    lp8(TE.encode(c.name)), lp8(port),
  ));
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 5 字节 → 8 字符标准 base32（RFC 4648，无填充）。从 pairing.ts 原样搬来，v1 与 v2 的 roomId 共用。 */
export function base32Encode5(bytes: Uint8Array): string {
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

/** 握手成功后由 Ke 导出配对密钥（RFC 之外的标准 HKDF 用法；标签与 v1 的 DeskMinis/PairingKey/v1 同形）。
 *  产出与 v1 的 PairingKey 同形（authKey、sessionSecret 各 32 字节），加密通道无感。 */
export function derivePairingMaterial(Ke: Uint8Array, ctxH: Uint8Array): { authKey: Uint8Array; sessionSecret: Uint8Array; roomId: string } {
  const okm = hkdf(sha256, Ke, undefined, concatBytes(INFO_PAIRING_V2, ctxH), 64);
  const room = hkdf(sha256, Ke, undefined, concatBytes(INFO_ROOM_V2, ctxH), 5);
  const out = { authKey: okm.slice(0, 32), sessionSecret: okm.slice(32, 64), roomId: base32Encode5(room) };
  okm.fill(0);
  return out;
}

/** 设备指纹：sha256(静态公钥) 前 6 字节的十六进制。由 M1 / M2 的 id 本地计算，不单独传。 */
export function fingerprintOfPublicKey(pub: Uint8Array): string {
  return Buffer.from(sha256(pub).slice(0, 6)).toString('hex');
}
