import { describe, it, expect } from 'vitest';
import { applyExactEdit, decodeUtf8Exact, describeEditFailure, editUtf8Bytes, COUNT_CAP } from '../src/minisd/tools/edit-text';

// file_edit 纯函数（W1a-2）：偏移映射错一位就会写坏用户文件，这里用一个独立写法的参照实现做随机对拍。
//
// 参照实现不做偏移换算：把正文切成「单元」（\r\n 算一个单元，其余每个 UTF-16 码元各算一个），
// 归一视图里的第 i 个字符恰好就是第 i 个单元，命中区间直接按单元下标切，区间外的单元原样拼回。
// 被测实现用「前面折叠了几对 \r\n」换算原文偏移，两种写法算法不同，对拍才有意义。

type RefResult = { ok: true; text: string } | { ok: false; kind: string };

function refEdit(text: string, oldString: string, newString: string): RefResult {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const body = text.slice(bom.length);
  const units: string[] = [];
  for (let b = 0; b < body.length;) {
    if (body.startsWith('\r\n', b)) { units.push('\r\n'); b += 2; } else { units.push(body[b]); b += 1; }
  }
  const firstNl = units.findIndex((u) => u === '\n' || u === '\r\n');
  const eol = firstNl >= 0 && units[firstNl] === '\r\n' ? '\r\n' : '\n';
  const norm = units.map((u) => (u === '\r\n' ? '\n' : u)).join('');
  let oldN = oldString.split('\r\n').join('\n');
  let newN = newString.split('\r\n').join('\n');
  if (bom && oldN.startsWith('﻿')) {
    oldN = oldN.slice(1);
    if (newN.startsWith('﻿')) newN = newN.slice(1);
  }
  if (oldN === '') return { ok: false, kind: 'emptyOld' };
  const hits: number[] = [];
  for (let i = 0; i + oldN.length <= norm.length; i++) if (norm.startsWith(oldN, i)) hits.push(i);
  if (hits.length === 0) return { ok: false, kind: 'notFound' };
  if (hits.length > 1) return { ok: false, kind: 'notUnique' };
  const insert = eol === '\r\n' ? newN.split('\n').join('\r\n') : newN;
  return { ok: true, text: bom + units.slice(0, hits[0]).join('') + insert + units.slice(hits[0] + oldN.length).join('') };
}

/** 固定种子的伪随机（mulberry32），保证每次跑的用例一样，红了能复现。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('applyExactEdit：与参照实现随机对拍', () => {
  it('纯 CRLF / 纯 LF / 混合行尾 / 孤立 CR / 带 BOM 的随机文件，结果与参照逐字相同', () => {
    const next = rng(20260924);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(next() * xs.length)];
    const alphabets = [
      ['a', 'b', 'c', '\r\n'], // 纯 CRLF
      ['a', 'b', 'c', '\n'], // 纯 LF
      ['a', 'b', '\n', '\r\n'], // 混合
      ['a', 'b', '\r', '\n', '\r\n', '$'], // 孤立 CR 与 $ 混进来
    ];
    let okCount = 0;
    for (let n = 0; n < 3000; n++) {
      const alpha = pick(alphabets);
      const len = 1 + Math.floor(next() * 14);
      let body = '';
      for (let i = 0; i < len; i++) body += pick(alpha);
      const text = (next() < 0.25 ? '﻿' : '') + body;
      // old_string 从 LF 归一视图里随机截一段（大多能命中），再随机把 LF 写回 CRLF，模拟模型两种写法
      const normBody = body.split('\r\n').join('\n');
      const s = Math.floor(next() * normBody.length);
      const e = s + Math.floor(next() * (normBody.length - s + 1));
      let oldString = normBody.slice(s, e);
      if (next() < 0.3) oldString = oldString.split('\n').join('\r\n');
      if (next() < 0.1) oldString = 'zz';
      let newString = '';
      const newLen = Math.floor(next() * 5);
      for (let i = 0; i < newLen; i++) newString += pick(['x', '\n', '\r\n', '$&', "$'"]);
      const got = applyExactEdit(text, oldString, newString);
      const want = refEdit(text, oldString, newString);
      const ctx = JSON.stringify({ text, oldString, newString });
      expect(got.ok, ctx).toBe(want.ok);
      if (got.ok && want.ok) { expect(got.text, ctx).toBe(want.text); okCount++; }
      if (!got.ok && !want.ok) expect(got.failure.kind, ctx).toBe(want.kind);
    }
    // 对拍要真的覆盖到成功路径，不能全是失败例
    expect(okCount).toBeGreaterThan(500);
  });
});

describe('applyExactEdit：唯一性计数', () => {
  it('重叠出现逐个计入：在 "aaaa" 里找 "aa" 算 3 次', () => {
    const r = applyExactEdit('aaaa', 'aa', 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure).toEqual({ kind: 'notUnique', count: 3, capped: false });
  });

  it('计数有上限：病态的周期文本不做平方级扫描，文案写「以上」', () => {
    const r = applyExactEdit('a'.repeat(COUNT_CAP * 3), 'a', 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure).toEqual({ kind: 'notUnique', count: COUNT_CAP, capped: true });
      expect(describeEditFailure(r.failure, '/w/a.txt')).toContain(`出现 ${COUNT_CAP} 次以上`);
    }
  });
});

describe('decodeUtf8Exact / editUtf8Bytes：只收合法 UTF-8', () => {
  it('合法 UTF-8（含 BOM、含字面的 U+FFFD、空文件）原样解码', () => {
    expect(decodeUtf8Exact(Buffer.from('你好\n', 'utf8'))).toBe('你好\n');
    expect(decodeUtf8Exact(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe('﻿a');
    expect(decodeUtf8Exact(Buffer.from('�', 'utf8'))).toBe('�');
    expect(decodeUtf8Exact(Buffer.alloc(0))).toBe('');
  });

  it('GBK、UTF-16LE、截断的多字节序列、CESU-8 代理对都判为非 UTF-8', () => {
    expect(decodeUtf8Exact(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))).toBeUndefined();
    expect(decodeUtf8Exact(Buffer.from([0xff, 0xfe, 0x68, 0x00]))).toBeUndefined();
    expect(decodeUtf8Exact(Buffer.from([0x61, 0xe4, 0xbd]))).toBeUndefined();
    expect(decodeUtf8Exact(Buffer.from([0xed, 0xa0, 0x80]))).toBeUndefined();
  });

  it('editUtf8Bytes 对非 UTF-8 给出 notUtf8，文案指出替代做法', () => {
    const r = editUtf8Bytes(Buffer.from([0xc4, 0xe3, 0x0a]), '\n', 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('notUtf8');
      const msg = describeEditFailure(r.failure, '/w/gbk.txt');
      expect(msg).toContain('不是 UTF-8');
      expect(msg).toContain('shell_execute');
      expect(msg).toContain('file_write');
    }
  });
});
