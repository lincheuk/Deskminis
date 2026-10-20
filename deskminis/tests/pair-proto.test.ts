/** F11C：src/minisd/remote/pair-proto.ts——帧的严格解析、身份串、上下文哈希、w 的派生、配对密钥导出。
 *
 *  这些是 RFC 9382 之外、本项目自定的编码：没有公开向量可对，只能自测，列在规格文档的未审查清单里。
 *  测的是「每个被绑定的字段都真的进了哈希」「解析器不放过任何不合规的帧」，不是密码学强度。 */
import { describe, it, expect } from 'vitest';
import { createHash, hkdfSync, scryptSync } from 'node:crypto';
import { p256 } from '@noble/curves/nist.js';
import {
  PAIR_DONE_FRAME, PAIR_FAIL_FRAME, PAIR_MAX_ATTEMPTS, PAIR_MAX_FRAME_BYTES, PAIR_NAME_MAX_BYTES, PAIR_QUERY,
  PAIR_SCRYPT, PAIR_SCRYPT_SALT, PAIR_STEP_TIMEOUT_MS,
  base32Encode5, derivePairingMaterial, derivePasswordScalar, encodePairConfirm, encodePairHello, encodePairReply,
  fingerprintOfPublicKey, isValidPairName, pairContextHash, pairIdentity,
  parsePairConfirm, parsePairEnd, parsePairHello, parsePairReply,
} from '../src/minisd/remote/pair-proto';
import { PAIR_FRAME_MAX_BYTES, PAIR_STEP_MS } from '../src/minisd/rpc/server';
import { spake2Password, spake2Share } from '../src/minisd/remote/spake2';
import { StaticIdentity } from '../src/minisd/remote/pairing';
import { PAIRING_SUITE, PairError } from '../src/shared/pairing';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const codeOf = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return e instanceof PairError ? e.code : `非 PairError: ${String(e)}`; }
  return undefined;
};

const id = new Uint8Array(32).map((_, i) => i + 1);
const pw = spake2Password(123456789n);
const pA = spake2Share('A', pw).share;
const pB = spake2Share('B', pw).share;
const mac = new Uint8Array(32).fill(0xab);
const helloObj = (): Record<string, unknown> => ({
  t: 'dm.pair.hello', v: 2, suite: PAIRING_SUITE, id: b64u(id), name: '书房的电脑', listenPort: 7820, pA: b64u(pA),
});
const replyObj = (): Record<string, unknown> => ({ t: 'dm.pair.reply', v: 2, id: b64u(id), pB: b64u(pB), cB: b64u(mac) });
const confirmObj = (): Record<string, unknown> => ({ t: 'dm.pair.confirm', v: 2, cA: b64u(mac) });

describe('常量', () => {
  it('入口参数、时限、次数、scrypt 参数', () => {
    expect(PAIR_QUERY).toBe('pair');
    expect(PAIR_STEP_TIMEOUT_MS).toBe(10_000);
    expect(PAIR_MAX_ATTEMPTS).toBe(5);
    expect(PAIR_MAX_FRAME_BYTES).toBe(2048);
    expect(PAIR_NAME_MAX_BYTES).toBe(64);
    expect(PAIR_SCRYPT).toEqual({ N: 16384, r: 8, p: 1, dkLen: 40 });
    expect(Object.isFrozen(PAIR_SCRYPT)).toBe(true);
    expect(PAIR_SCRYPT_SALT).toBe('DeskMinis/Pair/2/w');
  });
  it('收尾帧是两串固定的字节；失败帧不带任何原因', () => {
    expect(PAIR_DONE_FRAME).toBe('{"t":"dm.pair.done","v":2}');
    expect(PAIR_FAIL_FRAME).toBe('{"t":"dm.pair.fail","v":2}');
    expect(parsePairEnd(PAIR_DONE_FRAME)).toBe('done');
    expect(parsePairEnd(PAIR_FAIL_FRAME)).toBe('fail');
    expect(parsePairEnd('{"t":"dm.pair.done","v":2,"x":1}')).toBeUndefined();
    expect(parsePairEnd('{"v":2,"t":"dm.pair.done"}')).toBeUndefined();
    expect(parsePairEnd('')).toBeUndefined();
  });
  it('rpc/server.ts 里写死的数值与这里相等（rpc 层不依赖 remote 层，只能各写一份）', () => {
    expect(PAIR_STEP_MS).toBe(PAIR_STEP_TIMEOUT_MS);
    expect(PAIR_FRAME_MAX_BYTES).toBe(PAIR_MAX_FRAME_BYTES);
  });
});

describe('isValidPairName', () => {
  it('空串、普通名字、恰好 64 字节通过；65 字节拒；多字节字符按字节计', () => {
    expect(isValidPairName('')).toBe(true);
    expect(isValidPairName('My Laptop')).toBe(true);
    expect(isValidPairName('a'.repeat(64))).toBe(true);
    expect(isValidPairName('a'.repeat(65))).toBe(false);
    expect(isValidPairName('中'.repeat(21))).toBe(true);        // 63 字节
    expect(isValidPairName('中'.repeat(21) + 'a')).toBe(true);  // 64 字节
    expect(isValidPairName('中'.repeat(22))).toBe(false);       // 66 字节，只有 22 个字符
  });
  it('控制字符（U+0000–U+001F、U+007F–U+009F）拒', () => {
    for (const ch of ['\u0000', '\n', '\t', '\u001f', '\u007f', '\u0085', '\u009f']) expect(isValidPairName(`a${ch}b`), JSON.stringify(ch)).toBe(false);
    expect(isValidPairName('a b')).toBe(true);
  });
  it('encodePairHello 对不合规的名字抛 PAIR_BAD_NAME；它放行的名字 parsePairHello 都接受', () => {
    expect(codeOf(() => encodePairHello({ id, name: 'a'.repeat(65), listenPort: 0, pA }))).toBe('PAIR_BAD_NAME');
    expect(codeOf(() => encodePairHello({ id, name: 'a\nb', listenPort: 0, pA }))).toBe('PAIR_BAD_NAME');
    for (const name of ['', 'x', 'a'.repeat(64), '中'.repeat(21) + 'a', '"引号"\\反斜杠', '😀 emoji', 'a b']) {
      expect(parsePairHello(encodePairHello({ id, name, listenPort: 1, pA })).name).toBe(name);
    }
  });
});

describe('帧的编码与严格解析', () => {
  it('三种帧编码后能原样解析回来', () => {
    const h = parsePairHello(encodePairHello({ id, name: '书房', listenPort: 65535, pA }));
    expect(hex(h.id)).toBe(hex(id));
    expect(h.name).toBe('书房');
    expect(h.listenPort).toBe(65535);
    expect(hex(h.pA)).toBe(hex(pA));
    const r = parsePairReply(encodePairReply({ id, pB, cB: mac }));
    expect(hex(r.id)).toBe(hex(id));
    expect(hex(r.pB)).toBe(hex(pB));
    expect(hex(r.cB)).toBe(hex(mac));
    expect(hex(parsePairConfirm(encodePairConfirm({ cA: mac })).cA)).toBe(hex(mac));
    expect(parsePairHello(JSON.stringify(helloObj())).listenPort).toBe(7820);
  });
  it('帧里没有配对码，也没有 pairingCode 这个键', () => {
    const all = encodePairHello({ id, name: 'n', listenPort: 0, pA }) + encodePairReply({ id, pB, cB: mac }) + encodePairConfirm({ cA: mac });
    expect(all).not.toContain('pairingCode');
    expect(Object.keys(JSON.parse(encodePairHello({ id, name: 'n', listenPort: 0, pA })))).toEqual(['t', 'v', 'suite', 'id', 'name', 'listenPort', 'pA']);
  });

  const bad = (parse: (t: string) => unknown, base: () => Record<string, unknown>, mutate: (o: Record<string, unknown>) => void): string | undefined => {
    const o = base();
    mutate(o);
    return codeOf(() => parse(JSON.stringify(o)));
  };

  it('hello：多键、少键、t / v / suite 不符都拒', () => {
    expect(bad(parsePairHello, helloObj, o => { o.extra = 1; })).toBe('PAIR_PROTOCOL');
    for (const k of ['t', 'v', 'suite', 'id', 'name', 'listenPort', 'pA']) {
      expect(bad(parsePairHello, helloObj, o => { delete o[k]; }), `少 ${k}`).toBe('PAIR_PROTOCOL');
    }
    expect(bad(parsePairHello, helloObj, o => { o.t = 'dm.pair.reply'; })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairHello, helloObj, o => { o.v = 1; })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairHello, helloObj, o => { o.v = 3; })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairHello, helloObj, o => { o.v = '2'; })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairHello, helloObj, o => { o.suite = 'SPAKE2-P256-SHA512-HKDF-HMAC'; })).toBe('PAIR_PROTOCOL');
    // 少一个键、同时多一个键（键数相同）
    expect(bad(parsePairHello, helloObj, o => { delete o.name; o.nick = 'x'; })).toBe('PAIR_PROTOCOL');
  });
  it('hello：name、listenPort 不合规拒', () => {
    expect(bad(parsePairHello, helloObj, o => { o.name = 'a'.repeat(65); })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairHello, helloObj, o => { o.name = 'a\u0007b'; })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairHello, helloObj, o => { o.name = 7; })).toBe('PAIR_PROTOCOL');
    for (const p of [-1, 65536, 1.5, '7820', null, 1e9]) {
      expect(bad(parsePairHello, helloObj, o => { o.listenPort = p; }), String(p)).toBe('PAIR_PROTOCOL');
    }
    expect(parsePairHello(JSON.stringify({ ...helloObj(), listenPort: 0 })).listenPort).toBe(0);
  });
  it('二进制字段：非严格 base64url、错长度、压缩点首字节都拒', () => {
    const std = Buffer.from(id).toString('base64');             // 带 = 填充
    expect(bad(parsePairHello, helloObj, o => { o.id = std; })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairHello, helloObj, o => { o.id = b64u(id) + '='; })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairHello, helloObj, o => { o.id = b64u(id).slice(0, -1) + '+'; })).toBe('PAIR_PROTOCOL');
    // 43 个字符解出 32 字节，但最后一个字符的低位不是 0：再编码不等于原串
    const s = b64u(id);
    const loose = s.slice(0, -1) + (s.endsWith('A') ? 'B' : String.fromCharCode(s.charCodeAt(s.length - 1) + 1));
    if (Buffer.from(loose, 'base64url').toString('base64url') !== loose) {
      expect(bad(parsePairHello, helloObj, o => { o.id = loose; })).toBe('PAIR_PROTOCOL');
    }
    expect(bad(parsePairHello, helloObj, o => { o.id = b64u(id.slice(0, 31)); })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairHello, helloObj, o => { o.id = b64u(new Uint8Array(33)); })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairHello, helloObj, o => { o.id = [1, 2, 3]; })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairHello, helloObj, o => { o.pA = b64u(pA.slice(0, 64)); })).toBe('PAIR_PROTOCOL');
    // 33 字节的压缩点（合法的点）与 65 字节但首字节是压缩前缀的都拒
    expect(bad(parsePairHello, helloObj, o => { o.pA = b64u(p256.Point.fromBytes(pA).toBytes(true)); })).toBe('PAIR_PROTOCOL');
    const fake = new Uint8Array(pA);
    fake[0] = 0x02;
    expect(bad(parsePairHello, helloObj, o => { o.pA = b64u(fake); })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairReply, replyObj, o => { o.pB = b64u(fake); })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairReply, replyObj, o => { o.cB = b64u(mac.slice(0, 31)); })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairConfirm, confirmObj, o => { o.cA = b64u(new Uint8Array(33)); })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairConfirm, confirmObj, o => { o.cA = ''; })).toBe('PAIR_PROTOCOL');
  });
  it('解析器只查格式：65 字节、首字节 0x04、但不在曲线上的点照样解析出来（由 spake2Finish 拒）', () => {
    const off = new Uint8Array(pA);
    off[64] ^= 1;
    expect(hex(parsePairHello(JSON.stringify({ ...helloObj(), pA: b64u(off) })).pA)).toBe(hex(off));
  });
  it('reply / confirm：多键、少键、t 或 v 不符拒', () => {
    expect(bad(parsePairReply, replyObj, o => { o.name = 'x'; })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairReply, replyObj, o => { delete o.cB; })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairReply, replyObj, o => { o.v = 1; })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairReply, replyObj, o => { o.t = 'dm.pair.hello'; })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairConfirm, confirmObj, o => { o.pairingCode = 'x'; })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairConfirm, confirmObj, o => { delete o.v; })).toBe('PAIR_PROTOCOL');
    expect(bad(parsePairConfirm, confirmObj, o => { o.t = 'dm.pair.done'; })).toBe('PAIR_PROTOCOL');
  });
  it('一种帧不能当另一种解析；不是 JSON 对象的文本、超长的帧拒', () => {
    expect(codeOf(() => parsePairHello(JSON.stringify(replyObj())))).toBe('PAIR_PROTOCOL');
    expect(codeOf(() => parsePairReply(JSON.stringify(helloObj())))).toBe('PAIR_PROTOCOL');
    expect(codeOf(() => parsePairConfirm(PAIR_DONE_FRAME))).toBe('PAIR_PROTOCOL');
    for (const t of ['', 'null', '[]', '"x"', '42', '{', '{"jsonrpc":"2.0","id":1,"method":"remote.status"}']) {
      expect(codeOf(() => parsePairHello(t)), t).toBe('PAIR_PROTOCOL');
      expect(codeOf(() => parsePairConfirm(t)), t).toBe('PAIR_PROTOCOL');
    }
    const padded = JSON.stringify(helloObj()) + ' '.repeat(PAIR_MAX_FRAME_BYTES);
    expect(codeOf(() => parsePairHello(padded))).toBe('PAIR_PROTOCOL');
  });
});

describe('身份串与上下文哈希（被绑定的每一项都要进哈希）', () => {
  it('身份串 = 角色标签 ‖ 0x00 ‖ 公钥；joiner 与 host 互换则不同', () => {
    const j = pairIdentity('joiner', id);
    const h = pairIdentity('host', id);
    expect(Buffer.from(j).toString('latin1')).toBe('DeskMinis/Pair/2/joiner\u0000' + Buffer.from(id).toString('latin1'));
    expect(Buffer.from(h).subarray(0, 22).toString('latin1')).toBe('DeskMinis/Pair/2/host\u0000');
    expect(hex(j)).not.toBe(hex(h));
    const other = new Uint8Array(id);
    other[31] ^= 1;
    expect(hex(pairIdentity('joiner', other))).not.toBe(hex(j));
  });
  it('pairContextHash：32 字节、确定，对 name 与 listenPort 都敏感', () => {
    const ref = pairContextHash({ name: 'pc', listenPort: 7820 });
    expect(ref).toHaveLength(32);
    expect(hex(pairContextHash({ name: 'pc', listenPort: 7820 }))).toBe(hex(ref));
    expect(hex(pairContextHash({ name: 'pd', listenPort: 7820 }))).not.toBe(hex(ref));
    expect(hex(pairContextHash({ name: '', listenPort: 7820 }))).not.toBe(hex(ref));
    expect(hex(pairContextHash({ name: 'pc', listenPort: 7821 }))).not.toBe(hex(ref));
    expect(hex(pairContextHash({ name: 'pc', listenPort: 0 }))).not.toBe(hex(ref));
    // 端口的高字节也进哈希：7820 与 7820 + 256 不同
    expect(hex(pairContextHash({ name: 'pc', listenPort: 7820 + 256 }))).not.toBe(hex(ref));
  });
});

describe('derivePasswordScalar（w 的派生；scrypt 是遵循 RFC 的 MHF，不是安全性来源）', () => {
  it('确定、在 [1, n−1] 内、码不同则 w 不同；标记位也参与', async () => {
    const n = p256.Point.Fn.ORDER;
    const a1 = await derivePasswordScalar('0ABCDEFGH234');
    const a2 = await derivePasswordScalar('0ABCDEFGH234');
    const b = await derivePasswordScalar('0ABCDEFGH235');
    const noMarker = await derivePasswordScalar('ABCDEFGH234');
    expect(a1).toBe(a2);
    expect(a1 > 0n && a1 < n).toBe(true);
    expect(b).not.toBe(a1);
    expect(noMarker).not.toBe(a1);
  });
});

describe('derivePairingMaterial（由 Ke 导出配对密钥）', () => {
  const Ke = new Uint8Array(16).fill(9);
  const ctxH = pairContextHash({ name: 'pc', listenPort: 1 });
  it('两端同样的输入得到同样的结果；authKey 与 sessionSecret 各 32 字节且不同；roomId 是 8 个 base32 字符', () => {
    const a = derivePairingMaterial(Ke, ctxH);
    const b = derivePairingMaterial(new Uint8Array(Ke), new Uint8Array(ctxH));
    expect(hex(a.authKey)).toBe(hex(b.authKey));
    expect(hex(a.sessionSecret)).toBe(hex(b.sessionSecret));
    expect(a.roomId).toBe(b.roomId);
    expect(a.authKey).toHaveLength(32);
    expect(a.sessionSecret).toHaveLength(32);
    expect(hex(a.authKey)).not.toBe(hex(a.sessionSecret));
    expect(a.roomId).toMatch(/^[A-Z2-7]{8}$/);
  });
  it('改 ctxH 或 Ke，三样全变', () => {
    const ref = derivePairingMaterial(Ke, ctxH);
    for (const other of [
      derivePairingMaterial(Ke, pairContextHash({ name: 'pc', listenPort: 2 })),
      derivePairingMaterial(new Uint8Array(16).fill(8), ctxH),
    ]) {
      expect(hex(other.authKey)).not.toBe(hex(ref.authKey));
      expect(hex(other.sessionSecret)).not.toBe(hex(ref.sessionSecret));
      expect(other.roomId).not.toBe(ref.roomId);
    }
  });
});

describe('指纹与 base32', () => {
  it('fingerprintOfPublicKey 与 StaticIdentity.fingerprint 是同一个算法', () => {
    const me = new StaticIdentity();
    expect(fingerprintOfPublicKey(me.publicKey)).toBe(me.fingerprint);
    expect(fingerprintOfPublicKey(me.publicKey)).toMatch(/^[0-9a-f]{12}$/);
  });
  it('base32Encode5：5 字节 → 8 字符（RFC 4648 的例子），长度不对抛错', () => {
    expect(base32Encode5(new Uint8Array(Buffer.from('fooba')))).toBe('MZXW6YTB');
    expect(base32Encode5(new Uint8Array(5))).toBe('AAAAAAAA');
    expect(() => base32Encode5(new Uint8Array(4))).toThrow();
  });
});

// 上面几组测的是「对每个字段敏感」「两端算出来一样」。握手的两端跑的是同一份实现，所以实现整体偏离约定时
// （ctx 里少绑了版本号或套件、导出换了标签、scrypt 的参数被调弱）它们照样全绿——变异核对里这三种都活了下来。
// 这里按规格文档的 transcript（docs/specs/2026-10-03-f11c-authenticated-pairing.md）用 node:crypto 另算一遍来对：
// 期望值不出自被测函数，也不经 @noble。常量写成字面量，不从被测模块取。
describe('与规格文档的 transcript 逐字节一致（node:crypto 独立复算）', () => {
  const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8');
  /** lp(x) = u64le(len(x)) ‖ x */
  const lp = (x: Buffer): Buffer => {
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(x.length));
    return Buffer.concat([len, x]);
  };
  /** ctxH = SHA-256(lp(标签) ‖ lp(套件) ‖ lp([0x02]) ‖ lp(name) ‖ lp(u16be(listenPort))) */
  const ctxRef = (name: string, listenPort: number): Buffer => {
    const port = Buffer.alloc(2);
    port.writeUInt16BE(listenPort);
    return createHash('sha256').update(Buffer.concat([
      lp(utf8('DeskMinis/Pair/2/ctx')), lp(utf8('SPAKE2-P256-SHA256-HKDF-HMAC')), lp(Buffer.from([0x02])),
      lp(utf8(name)), lp(port),
    ])).digest();
  };
  /** HKDF-SHA256，salt 为空（等同 32 个零字节，RFC 5869 §2.2）。 */
  const hkdfRef = (ikm: Buffer, info: Buffer, len: number): Buffer => Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), info, len));
  /** 5 字节 → 8 个 base32 字符（RFC 4648 字母表）。 */
  const base32Ref = (b: Buffer): string => {
    let v = BigInt('0x' + b.toString('hex'));
    let s = '';
    for (let i = 0; i < 8; i++) { s = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.charAt(Number(v & 31n)) + s; v >>= 5n; }
    return s;
  };

  it('pairContextHash：标签、套件、协议版本、name、u16be(listenPort) 五项都在里面，各带 8 字节小端长度前缀', () => {
    const cases: Array<[string, number]> = [['pc', 7820], ['', 0], ['书房的电脑', 65535], ['J-name', 256]];
    for (const [name, listenPort] of cases) {
      expect(hex(pairContextHash({ name, listenPort })), `${name} / ${listenPort}`).toBe(ctxRef(name, listenPort).toString('hex'));
    }
  });

  it('derivePasswordScalar：w = OS2IP(scrypt(码, "DeskMinis/Pair/2/w", N=2^14, r=8, p=1, 40 字节)) mod n', async () => {
    // P-256 的阶 n（FIPS 186-4 D.1.2.3）
    const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
    for (const code of ['0ABCDEFGH234', '0ZZZZZZZZZZZ']) {
      const dk = scryptSync(utf8(code), utf8('DeskMinis/Pair/2/w'), 40, { N: 16384, r: 8, p: 1 });
      expect(await derivePasswordScalar(code), code).toBe(BigInt('0x' + dk.toString('hex')) % n);
    }
  });

  it('derivePairingMaterial：authKey ‖ sessionSecret 与 roomId 各用自己的标签加 ctxH 从 Ke 导出', () => {
    const Ke = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
    const ctxH = ctxRef('pc', 7820);
    const okm = hkdfRef(Ke, Buffer.concat([utf8('DeskMinis/PairingKey/v2'), ctxH]), 64);
    const room = hkdfRef(Ke, Buffer.concat([utf8('DeskMinis/PairingKey/roomId/v2'), ctxH]), 5);
    const m = derivePairingMaterial(new Uint8Array(Ke), new Uint8Array(ctxH));
    expect(hex(m.authKey)).toBe(okm.subarray(0, 32).toString('hex'));
    expect(hex(m.sessionSecret)).toBe(okm.subarray(32, 64).toString('hex'));
    expect(m.roomId).toBe(base32Ref(room));
  });
});
