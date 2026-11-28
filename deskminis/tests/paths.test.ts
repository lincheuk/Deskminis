import { describe, it, expect, beforeEach } from 'vitest';
import { MinisPaths } from '../src/minisd/paths';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

const WIN = process.platform === 'win32';

let root: string; let p: MinisPaths;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dm-')); p = new MinisPaths(root); });

describe('MinisPaths', () => {
  it('会话桶路径 + 目录创建', () => {
    p.ensureSessionDirs('S1');
    expect(p.sessionBucket('S1', 'workspace')).toBe(join(root, 'sessions', 'S1', 'workspace'));
  });
  it('/var/minis/workspace 解析到会话桶', () => {
    expect(p.resolveGuestPath('S1', '/var/minis/workspace/a/b.txt'))
      .toBe(join(root, 'sessions', 'S1', 'workspace', 'a', 'b.txt'));
  });
  it('/var/minis/skills 解析到全局目录', () => {
    expect(p.resolveGuestPath('S1', '/var/minis/skills/foo/SKILL.md'))
      .toBe(join(root, 'skills', 'foo', 'SKILL.md'));
  });
  it('相对路径落在会话 workspace', () => {
    expect(p.resolveGuestPath('S1', 'notes.md')).toBe(join(root, 'sessions', 'S1', 'workspace', 'notes.md'));
  });
  it.runIf(WIN)('Windows 宿主：盘符绝对路径放行；没有盘符的 / 开头路径拒绝', () => {
    expect(p.resolveGuestPath('S1', 'C:\\temp\\x.txt')).toBe('C:\\temp\\x.txt');
    expect(() => p.resolveGuestPath('S1', '/etc/hosts')).toThrow(/不支持的绝对 guest 路径/);
  });
  it.runIf(!WIN)('POSIX 宿主：/ 开头的绝对路径放行并归一化；盘符字样只是相对文件名，落在工作区里', () => {
    expect(p.resolveGuestPath('S1', '/tmp/a/../x.txt')).toBe('/tmp/x.txt');
    expect(p.resolveGuestPath('S1', '/var//minis/workspace')).toBe('/var/minis/workspace');
    expect(p.resolveGuestPath('S1', 'C:\\temp\\x.txt')).toBe(join(root, 'sessions', 'S1', 'workspace', 'C:\\temp\\x.txt'));
  });
  it('/var/minis 是 guest 命名空间，不当宿主路径：缺命名空间、未知命名空间都抛错', () => {
    expect(() => p.resolveGuestPath('S1', '/var/minis')).toThrow(/不支持的绝对 guest 路径/);
    expect(() => p.resolveGuestPath('S1', '/var/minis/')).toThrow(/不支持的绝对 guest 路径/);
    expect(() => p.resolveGuestPath('S1', '/var/minis/nope/x.txt')).toThrow(/未知 minis 命名空间/);
  });
  it('路径穿越抛错', () => {
    expect(() => p.resolveGuestPath('S1', '/var/minis/workspace/../../../etc')).toThrow(/穿越/);
    expect(() => p.resolveGuestPath('S1', '../..' + sep + 'x')).toThrow(/穿越/);
  });
});
