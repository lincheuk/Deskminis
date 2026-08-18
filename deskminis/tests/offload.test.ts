import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OffloadEngine } from '../src/minisd/agent/offload';
import { MinisPaths } from '../src/minisd/paths';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let paths: MinisPaths;
const SID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dm-off-')); paths = new MinisPaths(dir); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('OffloadEngine', () => {
  it('shouldOffload: ≤20k 字符返回 false', () => {
    const e = new OffloadEngine(paths);
    expect(e.shouldOffload('a'.repeat(20_000))).toBe(false);
    expect(e.shouldOffload('a'.repeat(19_999))).toBe(false);
  });

  it('shouldOffload: >20k 字符返回 true', () => {
    const e = new OffloadEngine(paths);
    expect(e.shouldOffload('a'.repeat(20_001))).toBe(true);
  });

  it('offload: 写文件 + 返回桩（新模板：指针行前多一行首段摘录）', () => {
    const e = new OffloadEngine(paths);
    const big = 'X'.repeat(25_000);
    const r = e.offload(SID, 'TOOL123', big);
    expect(r.relativePath).toBe('offloads/TOOL123.txt');
    const abs = join(dir, 'sessions', SID, 'offloads', 'TOOL123.txt');
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, 'utf8')).toBe(big);
    // 三行结构：头行（路径+字符数）→ 开头摘录行（前 200 码点单行+省略号）→ file_read 指针行
    expect(r.stub).toBe(`[CONTEXT OFFLOADED: offloads/TOOL123.txt (25000 字符)]\n开头: ${'X'.repeat(200)}…\n使用 file_read 工具读取 /var/minis/offloads/TOOL123.txt 取回完整内容`);
  });

  it('offload: 桩包含字符数', () => {
    const e = new OffloadEngine(paths);
    const r = e.offload(SID, 'T1', 'Y'.repeat(30_000));
    expect(r.stub).toContain('30000');
  });

  it('offload: 摘录含换行 → 折叠为 ⏎ 单行（桩的三行结构不被内容打乱）', () => {
    const e = new OffloadEngine(paths);
    const output = 'line1\r\nline2\nline3\n' + 'x'.repeat(25_000);
    const r = e.offload(SID, 'T4', output);
    const lines = r.stub.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1].startsWith('开头: ')).toBe(true);
    expect(lines[1]).toContain('line1⏎line2⏎line3⏎');
    expect(lines[1]).not.toContain('\r');
  });

  it('offload: 摘录在 200 码点边界不切断 emoji（surrogate pair 完整保留）', () => {
    const e = new OffloadEngine(paths);
    // 第 200 个码点恰是一个 emoji 的开头：按码元 slice 会切出孤立高代理项（提示词里呈乱码）
    const output = 'a'.repeat(199) + '😀'.repeat(10_000);
    const r = e.offload(SID, 'T5', output);
    expect(r.stub).toContain('开头: ' + 'a'.repeat(199) + '😀…');
  });

  it('offload: 原子写（tmp 不残留）', () => {
    const e = new OffloadEngine(paths);
    e.offload(SID, 'T2', 'Z'.repeat(21_000));
    expect(existsSync(join(dir, 'sessions', SID, 'offloads', 'T2.txt.tmp'))).toBe(false);
  });

  it('offload: 同 toolUseId 覆盖', () => {
    const e = new OffloadEngine(paths);
    e.offload(SID, 'T3', 'first'.repeat(5000));
    e.offload(SID, 'T3', 'second'.repeat(5000));
    const abs = join(dir, 'sessions', SID, 'offloads', 'T3.txt');
    expect(readFileSync(abs, 'utf8')).toContain('second');
  });
});
