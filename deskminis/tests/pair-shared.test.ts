/** F11C：src/shared/pairing.ts 的纯函数——配对码格式（含标记位）、策略解析、错误码。
 *  码格式是带外的版本信号：这里错一处，加入端就可能把认证配对码的一部分当旧码明文发出去。 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PAIRING_POLICY, PAIRING_CODE_ALPHABET, PAIRING_CODE_LEN_V1, PAIRING_CODE_LEN_V2, PAIRING_CODE_V2_MARKER,
  PAIRING_SUITE, PAIR_ERROR_TEXT, PairError, classifyPairingCode, normalizePairingCode, pairErrorCodeOf, parsePairingPolicy,
  type PairErrorCode,
} from '../src/shared/pairing';

const V2 = '0ABCDEFGH234';

describe('配对码字母表与标记位', () => {
  it('字母表 31 个字符，不含 0、1、I、L、O；标记位不在字母表里', () => {
    expect(PAIRING_CODE_ALPHABET).toHaveLength(31);
    for (const ch of '01ILO') expect(PAIRING_CODE_ALPHABET).not.toContain(ch);
    expect(PAIRING_CODE_V2_MARKER).toBe('0');
    expect(PAIRING_CODE_LEN_V1).toBe(8);
    expect(PAIRING_CODE_LEN_V2).toBe(12);
    expect(PAIRING_SUITE).toBe('SPAKE2-P256-SHA256-HKDF-HMAC');
  });
});

describe('normalizePairingCode', () => {
  it('转大写、去掉连字符与空白、不截断', () => {
    expect(normalizePairingCode('abcd-2345')).toBe('ABCD2345');
    expect(normalizePairingCode(' 0abc-defg-h234 ')).toBe(V2);
    expect(normalizePairingCode('abcd2345efghjkmn')).toBe('ABCD2345EFGHJKMN');
    expect(normalizePairingCode('')).toBe('');
  });
  it('只有首位的 O 换成 0，后面的 O 不动', () => {
    expect(normalizePairingCode('oabc-defg-h234')).toBe(V2);
    expect(normalizePairingCode('AOBC')).toBe('AOBC');
  });
});

describe('classifyPairingCode', () => {
  it('完整的 v2 码：原样、小写、带连字符、首位写成字母 O，归一化结果相同', () => {
    for (const raw of [V2, V2.toLowerCase(), '0ABC-DEFG-H234', 'OABCDEFGH234', 'oabc defg h234']) {
      expect(classifyPairingCode(raw)).toEqual({ kind: 'v2', code: V2 });
    }
  });
  it('8 位、首位不是标记 → v1（不查字母表，保持原有行为）', () => {
    expect(classifyPairingCode('ABCD2345')).toEqual({ kind: 'v1' });
    expect(classifyPairingCode('abcd-2345')).toEqual({ kind: 'v1' });
    expect(classifyPairingCode('WRNG1ILL')).toEqual({ kind: 'v1' });
  });
  it('首位是标记而长度是 1–11 或 13 → invalid（没输完的 v2 码不会被当成 v1 码）', () => {
    for (let n = 1; n <= 11; n++) expect(classifyPairingCode(V2.slice(0, n)), `前 ${n} 位`).toEqual({ kind: 'invalid' });
    expect(classifyPairingCode(V2 + 'A')).toEqual({ kind: 'invalid' });
  });
  it('首位是标记、12 位、后面有字母表外的字符 → invalid', () => {
    expect(classifyPairingCode('0ABCDEFGH23O')).toEqual({ kind: 'invalid' });
    expect(classifyPairingCode('0ABCDEFGH231')).toEqual({ kind: 'invalid' });
    expect(classifyPairingCode('00BCDEFGH234')).toEqual({ kind: 'invalid' });
  });
  it('首位不是标记而长度不是 8、空串 → invalid', () => {
    expect(classifyPairingCode('WRONGCODE')).toEqual({ kind: 'invalid' });
    expect(classifyPairingCode('ABCD234')).toEqual({ kind: 'invalid' });
    expect(classifyPairingCode('ABCDEFGH2345')).toEqual({ kind: 'invalid' });
    expect(classifyPairingCode('')).toEqual({ kind: 'invalid' });
    expect(classifyPairingCode('----')).toEqual({ kind: 'invalid' });
  });
});

describe('parsePairingPolicy', () => {
  it('两个合法值原样返回；缺失或不认识的值回到缺省', () => {
    expect(parsePairingPolicy('legacy')).toBe('legacy');
    expect(parsePairingPolicy('authenticated')).toBe('authenticated');
    for (const raw of [undefined, '', 'AUTHENTICATED', '1', 'true', 'v2']) expect(parsePairingPolicy(raw)).toBe(DEFAULT_PAIRING_POLICY);
  });
});

describe('PairError / pairErrorCodeOf / PAIR_ERROR_TEXT', () => {
  const codes = Object.keys(PAIR_ERROR_TEXT) as PairErrorCode[];
  it('17 个错误码各有一条含「配对」的说明', () => {
    expect(codes).toHaveLength(17);
    for (const c of codes) expect(PAIR_ERROR_TEXT[c], c).toContain('配对');
  });
  it('PairError 的消息是「码: 说明」，pairErrorCodeOf 能取回码', () => {
    for (const c of codes) {
      const e = new PairError(c);
      expect(e).toBeInstanceOf(Error);
      expect(e.code).toBe(c);
      expect(e.message).toBe(`${c}: ${PAIR_ERROR_TEXT[c]}`);
      expect(pairErrorCodeOf(e.message)).toBe(c);
    }
  });
  it('不是 PairError 的消息、不认识的码、码不在开头 → undefined', () => {
    expect(pairErrorCodeOf('配对码无效或已过期')).toBeUndefined();
    expect(pairErrorCodeOf('PAIR_NOPE: x')).toBeUndefined();
    expect(pairErrorCodeOf('Error: PAIR_TIMEOUT: x')).toBeUndefined();
    expect(pairErrorCodeOf('constructor: x')).toBeUndefined();
  });
  it('格式错误的说明写明两种码各是几位（界面直接显示它）', () => {
    expect(PAIR_ERROR_TEXT.PAIR_BAD_CODE_FORMAT).toBe('配对码格式不对：旧方式的配对码是 8 位；认证配对码以 0 开头、共 12 位，要完整输入。');
    expect(PAIR_ERROR_TEXT.PAIR_BAD_NAME).toBe('配对用的设备名不合规：不能超过 64 字节，不能含控制字符。');
  });
});
