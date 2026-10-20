/** F11C：src/minisd/remote/spake2.ts 对 RFC 9382 附录 B 的全部四组测试向量（套件 SPAKE2-P256-SHA256-HKDF-HMAC）。
 *
 *  期望值的出处：RFC 9382 附录 B 原文（https://www.rfc-editor.org/rfc/rfc9382.txt，2026-10-03 读取并转录）。
 *  它们不是本实现算出来再写回的：M / N 用反、长度前缀的字节序、w 的编码、HKDF 的 info、Ke / Ka 取反、
 *  MAC 的密钥，任一处错则下面至少一项不等。向量只覆盖 AAD 为空的情形。 */
import { describe, it, expect } from 'vitest';
import { p256 } from '@noble/curves/nist.js';
import {
  SPAKE2_M_HEX, SPAKE2_N_HEX, SPAKE2_SHARE_LEN, Spake2Error, lp8, spake2Finish, spake2Password, spake2Share,
} from '../src/minisd/remote/spake2';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const bytes = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));
const ascii = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'ascii'));
const ORDER = p256.Point.Fn.ORDER;

/** RFC 9382 附录 B，逐字转录。A / B 是身份串（可为空），其余是十六进制。 */
const VECTORS = [
  {
    A: 'server', B: 'client',
    w: '2ee57912099d31560b3a44b1184b9b4866e904c49d12ac5042c97dca461b1a5f',
    x: '43dd0fd7215bdcb482879fca3220c6a968e66d70b1356cac18bb26c84a78d729',
    pA: '04a56fa807caaa53a4d28dbb9853b9815c61a411118a6fe516a8798434751470f9010153ac33d0d5f2047ffdb1a3e42c9b4e6be662766e1eeb4116988ede5f912c',
    y: 'dcb60106f276b02606d8ef0a328c02e4b629f84f89786af5befb0bc75b6e66be',
    pB: '0406557e482bd03097ad0cbaa5df82115460d951e3451962f1eaf4367a420676d09857ccbc522686c83d1852abfa8ed6e4a1155cf8f1543ceca528afb591a1e0b7',
    K: '0412af7e89717850671913e6b469ace67bd90a4df8ce45c2af19010175e37eed69f75897996d539356e2fa6a406d528501f907e04d97515fbe83db277b715d3325',
    Ke: '0e0672dc86f8e45565d338b0540abe69', Ka: '15bdf72e2b35b5c9e5663168e960a91b',
    KcA: '00c12546835755c86d8c0db7851ae86f', KcB: 'a9fa3406c3b781b93d804485430ca27a',
    cA: '58ad4aa88e0b60d5061eb6b5dd93e80d9c4f00d127c65b3b35b1b5281fee38f0',
    cB: 'd3e2e547f1ae04f2dbdbf0fc4b79f8ecff2dff314b5d32fe9fcef2fb26dc459b',
  },
  {
    A: '', B: 'client',
    w: '0548d8729f730589e579b0475a582c1608138ddf7054b73b5381c7e883e2efae',
    x: '403abbe3b1b4b9ba17e3032849759d723939a27a27b9d921c500edde18ed654b',
    pA: '04a897b769e681c62ac1c2357319a3d363f610839c4477720d24cbe32f5fd85f44fb92ba966578c1b712be6962498834078262caa5b441ecfa9d4a9485720e918a',
    y: '903023b6598908936ea7c929bd761af6039577a9c3f9581064187c3049d87065',
    pB: '04e0f816fd1c35e22065d5556215c097e799390d16661c386e0ecc84593974a61b881a8c82327687d0501862970c64565560cb5671f696048050ca66ca5f8cc7fc',
    K: '048f83ec9f6e4f87cc6f9dc740bdc2769725f923364f01c84148c049a39a735ebda82eac03e00112fd6a5710682767cff5361f7e819e53d8d3c3a2922e0d837aa6',
    Ke: '642f05c473c2cd79909f9a841e2f30a7', Ka: '0bf89b18180af97353ba198789c2b963',
    KcA: 'c6be376fc7cd1301fd0a13adf3e7bffd', KcB: 'b7243f4ae60440a49b3f8cab3c1fba07',
    cA: '47d29e6666af1b7dd450d571233085d7a9866e4d49d2645e2df975489521232b',
    cB: '3313c5cefc361d27fb16847a91c2a73b766ffa90a4839122a9b70a2f6bd1d6df',
  },
  {
    A: 'server', B: '',
    w: '626e0cdc7b14c9db3e52a0b1b3a768c98e37852d5db30febe0497b14eae8c254',
    x: '07adb3db6bc623d3399726bfdbfd3d15a58ea776ab8a308b00392621291f9633',
    pA: '04f88fb71c99bfffaea370966b7eb99cd4be0ff1a7d335caac4211c4afd855e2e15a873b298503ad8ba1d9cbb9a392d2ba309b48bfd7879aefd0f2cea6009763b0',
    y: 'b6a4fc8dbb629d4ba51d6f91ed1532cf87adec98f25dd153a75accafafedec16',
    pB: '040c269d6be017dccb15182ac6bfcd9e2a14de019dd587eaf4bdfd353f031101e7cca177f8eb362a6e83e7d5e729c0732e1b528879c086f39ba0f31a9661bd34db',
    K: '0445ee233b8ecb51ebd6e7da3f307e88a1616bae2166121221fdc0dadb986afaf3ec8a988dc9c626fa3b99f58a7ca7c9b844bb3e8dd9554aafc5b53813504c1cbe',
    Ke: '005184ff460da2ce59062c87733c299c', Ka: '3521297d736598fc0a1127600efa1afb',
    KcA: 'f3da53604f0aeecea5a33be7bddf6edf', KcB: '9e3f86848736f159bd92b6e107ec6799',
    cA: 'bc9f9bbe99f26d0b2260e6456e05a86196a3307ec6663a18bf6ac825736533b2',
    cB: 'c2370e1bf813b086dff0d834e74425a06e6390f48f5411900276dcccc5a297ec',
  },
  {
    A: '', B: '',
    w: '7bf46c454b4c1b25799527d896508afd5fc62ef4ec59db1efb49113063d70cca',
    x: '8cef65df64bb2d0f83540c53632de911b5b24b3eab6cc74a97609fd659e95473',
    pA: '04a65b367a3f613cf9f0654b1b28a1e3a8a40387956c8ba6063e8658563890f46ca1ef6a676598889fc28de2950ab8120b79a5ef1ea4c9f44bc98f585634b46d66',
    y: 'd7a66f64074a84652d8d623a92e20c9675c61cb5b4f6a0063e4648a2fdc02d53',
    pB: '04589f13218822710d98d8b2123a079041052d9941b9cf88c6617ddb2fcc0494662eea8ba6b64692dc318250030c6af045cb738bc81ba35b043c3dcb46adf6f58d',
    K: '041a3c03d51b452537ca2a1fea6110353c6d5ed483c4f0f86f4492ca3f378d40a994b4477f93c64d928edbbcd3e85a7c709b7ea73ee97986ce3d1438e135543772',
    Ke: 'fc6374762ba5cf11f4b2caa08b2cd1b9', Ka: '907ae0e26e8d6234318d91583cd74c86',
    KcA: '5dbd2f477166b7fb6d61febbd77a5563', KcB: '7689b4654407a5faeffdc8f18359d8a3',
    cA: 'dfb4db8d48ae5a675963ea5e6c19d98d4ea028d8e898dad96ea19a80ade95dca',
    cB: 'd0f0609d1613138d354f7e95f19fb556bf52d751947241e8c7118df5ef0ae175',
  },
] as const;

const EMPTY = new Uint8Array(0);

describe('RFC 9382 §6 的常量', () => {
  it('M、N 等于 RFC 给出的压缩点', () => {
    expect(SPAKE2_M_HEX).toBe('02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f');
    expect(SPAKE2_N_HEX).toBe('03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49');
    expect(SPAKE2_SHARE_LEN).toBe(65);
  });
  it('len(x) 是 8 字节小端', () => {
    expect(hex(lp8(ascii('abc')))).toBe('0300000000000000616263');
    expect(hex(lp8(EMPTY))).toBe('0000000000000000');
  });
});

describe('RFC 9382 附录 B 的四组向量（AAD 为空）', () => {
  VECTORS.forEach((v, i) => {
    it(`第 ${i + 1} 组：A='${v.A}' B='${v.B}'`, () => {
      const pw = spake2Password(BigInt('0x' + v.w));
      const a = spake2Share('A', pw, BigInt('0x' + v.x));
      const b = spake2Share('B', pw, BigInt('0x' + v.y));
      expect(hex(a.share), 'pA').toBe(v.pA);
      expect(hex(b.share), 'pB').toBe(v.pB);

      const common = { pw, pA: a.share, pB: b.share, idA: ascii(v.A), idB: ascii(v.B), aad: EMPTY };
      const outA = spake2Finish({ role: 'A', scalar: a.scalar, ...common });
      const outB = spake2Finish({ role: 'B', scalar: b.scalar, ...common });
      for (const [side, out] of [['A', outA], ['B', outB]] as const) {
        expect(hex(out.K), `${side} 侧 K`).toBe(v.K);
        expect(hex(out.Ke), `${side} 侧 Ke`).toBe(v.Ke);
        expect(hex(out.Ka), `${side} 侧 Ka`).toBe(v.Ka);
        expect(hex(out.KcA), `${side} 侧 KcA`).toBe(v.KcA);
        expect(hex(out.KcB), `${side} 侧 KcB`).toBe(v.KcB);
        expect(hex(out.cA), `${side} 侧 cA`).toBe(v.cA);
        expect(hex(out.cB), `${side} 侧 cB`).toBe(v.cB);
      }
      expect(hex(outA.TT)).toBe(hex(outB.TT));
    });
  });
});

describe('输入校验（RFC 9382 §7：收到的点必须在群内，否则中止）', () => {
  const v = VECTORS[0];
  const pw = spake2Password(BigInt('0x' + v.w));
  const x = BigInt('0x' + v.x);
  const y = BigInt('0x' + v.y);
  const idA = ascii(v.A);
  const idB = ascii(v.B);
  const asB = (pA: Uint8Array) => (): unknown => spake2Finish({ role: 'B', pw, scalar: y, pA, pB: bytes(v.pB), idA, idB, aad: EMPTY });
  const asA = (pB: Uint8Array) => (): unknown => spake2Finish({ role: 'A', pw, scalar: x, pA: bytes(v.pA), pB, idA, idB, aad: EMPTY });

  it('33 字节的压缩点（哪怕是合法的点）被拒', () => {
    const compressed = p256.Point.fromBytes(bytes(v.pA)).toBytes(true);
    expect(compressed).toHaveLength(33);
    expect(asB(compressed)).toThrow(Spake2Error);
    expect(asA(p256.Point.fromBytes(bytes(v.pB)).toBytes(true))).toThrow(Spake2Error);
  });
  it('65 字节、首字节 0x04、但不在曲线上的点被拒', () => {
    const off = bytes(v.pA);
    off[64] ^= 0x01;
    expect(asB(off)).toThrow(Spake2Error);
    const off2 = bytes(v.pB);
    off2[40] ^= 0x80;
    expect(asA(off2)).toThrow(Spake2Error);
  });
  it('长度不对、首字节不是 0x04 被拒', () => {
    expect(asB(bytes(v.pA).slice(0, 64))).toThrow(Spake2Error);
    expect(asB(new Uint8Array([...bytes(v.pA), 0]))).toThrow(Spake2Error);
    expect(asB(EMPTY)).toThrow(Spake2Error);
    const hybrid = bytes(v.pA);
    hybrid[0] = 0x06;
    expect(asB(hybrid)).toThrow(Spake2Error);
  });
  it('对端份额等于 w·M（A 侧）或 w·N（B 侧）：相减是无穷远点，中止', () => {
    expect(asB(pw.wM.toBytes(false))).toThrow(Spake2Error);
    expect(asA(pw.wN.toBytes(false))).toThrow(Spake2Error);
  });
  it('w = 0、w = n、w 为负一律被拒；w = n − 1 可用', () => {
    expect(() => spake2Password(0n)).toThrow(Spake2Error);
    expect(() => spake2Password(ORDER)).toThrow(Spake2Error);
    expect(() => spake2Password(-1n)).toThrow(Spake2Error);
    expect(() => spake2Password(ORDER - 1n)).not.toThrow();
  });
  it('注入的临时标量不在 [1, n−1] 被拒', () => {
    expect(() => spake2Share('A', pw, 0n)).toThrow(Spake2Error);
    expect(() => spake2Share('B', pw, ORDER)).toThrow(Spake2Error);
    expect(() => spake2Finish({ role: 'A', pw, scalar: 0n, pA: bytes(v.pA), pB: bytes(v.pB), idA, idB, aad: EMPTY })).toThrow(Spake2Error);
  });
});

describe('随机标量、角色与 AAD', () => {
  const pw = spake2Password(BigInt('0x' + VECTORS[0].w));
  const idA = ascii('joiner');
  const idB = ascii('host');

  it('不注入标量时每次握手取新的 x / y：两次的份额不同，两端仍算出同一组输出', () => {
    const a1 = spake2Share('A', pw);
    const a2 = spake2Share('A', pw);
    expect(a1.scalar).not.toBe(a2.scalar);
    expect(hex(a1.share)).not.toBe(hex(a2.share));
    const b = spake2Share('B', pw);
    const common = { pw, pA: a1.share, pB: b.share, idA, idB, aad: EMPTY };
    const outA = spake2Finish({ role: 'A', scalar: a1.scalar, ...common });
    const outB = spake2Finish({ role: 'B', scalar: b.scalar, ...common });
    expect(hex(outA.cA)).toBe(hex(outB.cA));
    expect(hex(outA.cB)).toBe(hex(outB.cB));
    expect(hex(outA.Ke)).toBe(hex(outB.Ke));
    expect(hex(outA.cA)).not.toBe(hex(outA.cB));
  });
  it('两端的 w 不同：算出的 K 与确认值都对不上', () => {
    const other = spake2Password(BigInt('0x' + VECTORS[1].w));
    const a = spake2Share('A', pw);
    const b = spake2Share('B', other);
    const outA = spake2Finish({ role: 'A', pw, scalar: a.scalar, pA: a.share, pB: b.share, idA, idB, aad: EMPTY });
    const outB = spake2Finish({ role: 'B', pw: other, scalar: b.scalar, pA: a.share, pB: b.share, idA, idB, aad: EMPTY });
    expect(hex(outA.K)).not.toBe(hex(outB.K));
    expect(hex(outA.cB)).not.toBe(hex(outB.cB));
    expect(hex(outA.cA)).not.toBe(hex(outB.cA));
  });
  it('AAD 或任一身份串不同：K 相同而确认值不同（自测，RFC 向量不覆盖带 AAD 的路径）', () => {
    const a = spake2Share('A', pw);
    const b = spake2Share('B', pw);
    const base = { role: 'A' as const, pw, scalar: a.scalar, pA: a.share, pB: b.share, idA, idB, aad: EMPTY };
    const ref = spake2Finish(base);
    const withAad = spake2Finish({ ...base, aad: ascii('ctx') });
    expect(hex(withAad.K)).toBe(hex(ref.K));
    expect(hex(withAad.Ke)).toBe(hex(ref.Ke));
    expect(hex(withAad.KcA)).not.toBe(hex(ref.KcA));
    expect(hex(withAad.cA)).not.toBe(hex(ref.cA));
    expect(hex(withAad.cB)).not.toBe(hex(ref.cB));
    const otherId = spake2Finish({ ...base, idA: ascii('joiner2') });
    expect(hex(otherId.Ke)).not.toBe(hex(ref.Ke));
    expect(hex(otherId.cB)).not.toBe(hex(ref.cB));
    const swapped = spake2Finish({ ...base, idA: idB, idB: idA });
    expect(hex(swapped.cB)).not.toBe(hex(ref.cB));
  });
  it('一端把自己的份额当成对端的份额（角色反射）算不出相同的确认值', () => {
    const a = spake2Share('A', pw);
    const b = spake2Share('B', pw);
    const honest = spake2Finish({ role: 'B', pw, scalar: b.scalar, pA: a.share, pB: b.share, idA, idB, aad: EMPTY });
    // 把 A 的 pA 当作 pB 喂回 A：M ≠ N，K 对不上
    const reflected = spake2Finish({ role: 'A', pw, scalar: a.scalar, pA: a.share, pB: a.share, idA, idB, aad: EMPTY });
    expect(hex(reflected.cB)).not.toBe(hex(honest.cB));
  });
});
