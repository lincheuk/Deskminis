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

  it('offload: 写文件 + 返回桩', () => {
    const e = new OffloadEngine(paths);
    const big = 'X'.repeat(25_000);
    const r = e.offload(SID, 'TOOL123', big);
    expect(r.relativePath).toBe('offloads/TOOL123.txt');
    const abs = join(dir, 'sessions', SID, 'offloads', 'TOOL123.txt');
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, 'utf8')).toBe(big);
    expect(r.stub).toContain('[CONTEXT OFFLOADED');
    expect(r.stub).toContain('offloads/TOOL123.txt');
    expect(r.stub).toContain('/var/minis/offloads/TOOL123.txt');
  });

  it('offload: 桩包含字符数', () => {
    const e = new OffloadEngine(paths);
    const r = e.offload(SID, 'T1', 'Y'.repeat(30_000));
    expect(r.stub).toContain('30000');
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
