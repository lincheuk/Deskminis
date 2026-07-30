import { describe, it, expect, beforeEach } from 'vitest';
import { MinisPaths } from '../src/minisd/paths';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

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
  it('绝对 Windows 路径放行', () => {
    expect(p.resolveGuestPath('S1', 'C:\\temp\\x.txt')).toBe('C:\\temp\\x.txt');
  });
  it('路径穿越抛错', () => {
    expect(() => p.resolveGuestPath('S1', '/var/minis/workspace/../../../etc')).toThrow(/穿越/);
    expect(() => p.resolveGuestPath('S1', '../..' + sep + 'x')).toThrow(/穿越/);
  });
});
