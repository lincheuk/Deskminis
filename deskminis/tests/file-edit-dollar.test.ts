import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { fileEditTool } from '../src/minisd/tools/files';
import type { ToolContext, PermissionRequest, PermissionDecision } from '../src/minisd/tools/types';
import { MinisPaths } from '../src/minisd/paths';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// file_edit 止血（W1a-2 · 止血波设计稿 §2「工具层」、§4 W1a-2；侦察 tools.md W1a-edit 先红 ①–⑩）。
//
// 一律走工作区相对路径 + 放行网关：paths.ts 在 Linux 上拒绝 POSIX 绝对路径，写相对路径才在 Linux 上可跑。
// 断言一律按字节读回——行尾、BOM、$ 序列的损坏在 utf8 字符串比较里要么看不出、要么被解码吞掉。
//
// 修之前的现状（侦察实测）：
// - 字符串模式的 replace 会解释 new_string 里的 $$ $& $` $'，模型写的美元价格、shell 变量会被改写；
// - 按原文匹配，CRLF 文件配 LF 的 old_string 报「未找到」；new_string 里的 LF 原样写进 CRLF 文件，行尾混杂；
// - split 计数不算重叠出现，在 "aaa" 里改 "aa" 静默替换第 0 位；
// - 空文件配空 old_string 算出 -1 次，把 new_string 前插到文件开头；
// - 按 utf8 读 GBK / UTF-16 文件再写回，不可解码的字节全变成 U+FFFD。

class AllowAllGateway {
  asked: PermissionRequest[] = [];
  async check(r: PermissionRequest): Promise<PermissionDecision> { this.asked.push(r); return 'allow'; }
  hasBridgeGrant(): boolean { return false; }
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

let root: string; let ws: string; let ctx: ToolContext; let reg: ToolRegistry;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dm-edit-'));
  const paths = new MinisPaths(root);
  paths.ensureSessionDirs('S1');
  ws = join(root, 'sessions', 'S1', 'workspace');
  ctx = { sessionId: 'S1', paths, permissions: new AllowAllGateway() };
  reg = new ToolRegistry();
  reg.register(fileEditTool);
});

const put = (name: string, bytes: Buffer | string): void => writeFileSync(join(ws, name), bytes);
const bytesOf = (name: string): Buffer => readFileSync(join(ws, name));
const edit = (path: string, oldString: string, newString: string) =>
  reg.execute('file_edit', JSON.stringify({ path, old_string: oldString, new_string: newString, tool_title: '改' }), ctx);

describe('file_edit：new_string 逐字落盘（$ 序列不再有特殊含义）', () => {
  it('① $$ 原样落盘，不再折成 $', async () => {
    put('p.txt', 'price: X');
    const r = await edit('p.txt', 'X', 'cost $$5');
    expect(r.success).toBe(true);
    expect(bytesOf('p.txt').toString('utf8')).toBe('price: cost $$5');
  });

  it('② $& $` $\' 原样落盘，不再插入匹配本身、匹配之前或之后的全文', async () => {
    put('q.txt', 'head X tail');
    const r = await edit('q.txt', 'X', "$&-$`-$'");
    expect(r.success).toBe(true);
    expect(bytesOf('q.txt').toString('utf8')).toBe("head $&-$`-$' tail");
  });
});

describe('file_edit：行尾——在 LF 归一视图里匹配，只改命中区间，替换文本按文件行尾还原', () => {
  it('③ CRLF 文件用 LF 写多行 old_string：命中并按 CRLF 写回', async () => {
    put('c.txt', 'a\r\nb\r\nc\r\n');
    const r = await edit('c.txt', 'a\nb', 'x\ny');
    expect(r.success).toBe(true);
    expect(bytesOf('c.txt').toString('utf8')).toBe('x\r\ny\r\nc\r\n');
  });

  it('④ CRLF 文件单行改多行：new_string 的 LF 还原为 CRLF，不留混合行尾', async () => {
    put('d.txt', 'a\r\nb\r\nc\r\n');
    const r = await edit('d.txt', 'a', 'x\ny');
    expect(r.success).toBe(true);
    expect(bytesOf('d.txt').toString('utf8')).toBe('x\r\ny\r\nb\r\nc\r\n');
  });

  it('⑤ LF 文件配 CRLF 的 old/new：先归一再匹配，写回仍是 LF', async () => {
    put('e.txt', 'a\nb\n');
    const r = await edit('e.txt', 'a\r\nb', 'q\r\nr');
    expect(r.success).toBe(true);
    expect(bytesOf('e.txt').toString('utf8')).toBe('q\nr\n');
  });

  it('末行命中、old_string 以换行结尾、文件以 CRLF 结尾：区间右端连 CR 带 LF 一起换掉', async () => {
    put('f.txt', 'a\r\nb\r\n');
    const r = await edit('f.txt', 'b\n', 'c\n');
    expect(r.success).toBe(true);
    expect(bytesOf('f.txt').toString('utf8')).toBe('a\r\nc\r\n');
  });

  it('跨行删除（new_string 为空串）：命中区间里的 CRLF 整对删掉，不留孤 CR', async () => {
    put('g.txt', 'a\r\nb\r\nc');
    const r = await edit('g.txt', 'a\nb\n', '');
    expect(r.success).toBe(true);
    expect(bytesOf('g.txt').toString('utf8')).toBe('c');
  });

  it('⑦ 混合行尾文件只改一处：命中区间之外的字节一律不动（新增守卫，现状即绿）', async () => {
    put('m.txt', 'a\r\nb\nc\r\n');
    const r = await edit('m.txt', 'b', 'B');
    expect(r.success).toBe(true);
    expect(bytesOf('m.txt').toString('utf8')).toBe('a\r\nB\nc\r\n');
  });

  it('只有一行、没有换行的文件按 LF 处理（守卫，现状即绿）', async () => {
    put('one.txt', 'abc');
    const r = await edit('one.txt', 'b', 'x\ny');
    expect(r.success).toBe(true);
    expect(bytesOf('one.txt').toString('utf8')).toBe('ax\nyc');
  });
});

describe('file_edit：BOM 显式保持', () => {
  it('⑥ BOM + CRLF：前三字节仍是 EF BB BF，正文按 CRLF 写回', async () => {
    put('b1.txt', Buffer.concat([BOM, Buffer.from('hello\r\nworld\r\n')]));
    const r = await edit('b1.txt', 'hello\nworld', 'hi\nall');
    expect(r.success).toBe(true);
    const out = bytesOf('b1.txt');
    expect(out.subarray(0, 3).equals(BOM)).toBe(true);
    expect(out.subarray(3).toString('utf8')).toBe('hi\r\nall\r\n');
  });

  it('BOM + LF：BOM 与 LF 都保持（回归守卫，现状即绿）', async () => {
    put('b2.txt', Buffer.concat([BOM, Buffer.from('hello\nworld\n')]));
    const r = await edit('b2.txt', 'hello', 'hi');
    expect(r.success).toBe(true);
    expect(bytesOf('b2.txt').equals(Buffer.concat([BOM, Buffer.from('hi\nworld\n')]))).toBe(true);
  });

  it('old_string 抄了 file_read 给出的开头 U+FEFF、new_string 没抄：BOM 仍保留，且只有一个', async () => {
    put('b3.txt', Buffer.concat([BOM, Buffer.from('hello\nworld\n')]));
    const r = await edit('b3.txt', '﻿hello', 'hi');
    expect(r.success).toBe(true);
    expect(bytesOf('b3.txt').equals(Buffer.concat([BOM, Buffer.from('hi\nworld\n')]))).toBe(true);
  });

  it('old_string 与 new_string 都抄了开头 U+FEFF：写回只有一个 BOM', async () => {
    put('b4.txt', Buffer.concat([BOM, Buffer.from('hello\nworld\n')]));
    const r = await edit('b4.txt', '﻿hello', '﻿hi');
    expect(r.success).toBe(true);
    expect(bytesOf('b4.txt').equals(Buffer.concat([BOM, Buffer.from('hi\nworld\n')]))).toBe(true);
  });
});

describe('file_edit：拒绝有歧义或会损坏文件的编辑，且文件字节不动', () => {
  it('⑧ 重叠出现算不唯一：在 "aaa" 里改 "aa" 失败，提示出现 2 次', async () => {
    put('o.txt', 'aaa');
    const r = await edit('o.txt', 'aa', 'X');
    expect(r.success).toBe(false);
    expect(r.output).toContain('出现 2 次');
    expect(r.output).toContain('必须唯一');
    expect(bytesOf('o.txt').toString('utf8')).toBe('aaa');
  });

  it('⑨ 空文件配空 old_string：拒绝，不再把 new_string 前插进文件', async () => {
    put('z.txt', '');
    const r = await edit('z.txt', '', 'X');
    expect(r.success).toBe(false);
    expect(r.output).toContain('old_string 不能为空');
    expect(r.output).toContain('file_write');
    expect(bytesOf('z.txt').length).toBe(0);
  });

  it('非空文件配空 old_string：同样按「不能为空」拒绝，而不是报「出现 N 次」', async () => {
    put('z2.txt', 'abc');
    const r = await edit('z2.txt', '', 'X');
    expect(r.success).toBe(false);
    expect(r.output).toContain('old_string 不能为空');
    expect(bytesOf('z2.txt').toString('utf8')).toBe('abc');
  });

  it('⑩ GBK 字节文件：拒绝并指出替代做法，文件字节不变（不再写回 U+FFFD）', async () => {
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a]); // 「你好」+ LF 的 GBK 编码
    put('gbk.txt', gbk);
    const r = await edit('gbk.txt', '\n', '!\n');
    expect(r.success).toBe(false);
    expect(r.output).toContain('不是 UTF-8');
    expect(r.output).toContain('shell_execute');
    expect(bytesOf('gbk.txt').equals(gbk)).toBe(true);
  });

  it('UTF-16LE（带 FF FE）文件：同样拒绝，字节不变', async () => {
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi\n', 'utf16le')]);
    put('u16.txt', u16);
    const r = await edit('u16.txt', 'h', 'H');
    expect(r.success).toBe(false);
    expect(r.output).toContain('不是 UTF-8');
    expect(bytesOf('u16.txt').equals(u16)).toBe(true);
  });

  it('未找到的文案保持原样（守卫）', async () => {
    put('n.txt', 'abc');
    const r = await edit('n.txt', 'zzz', 'y');
    expect(r.success).toBe(false);
    expect(r.output).toContain('old_string 未找到于');
    expect(bytesOf('n.txt').toString('utf8')).toBe('abc');
  });
});
