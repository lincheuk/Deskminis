import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/minisd/store/memory-store';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dm-mem-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('MemoryStore', () => {
  it('readGlobal: 文件不存在返回空串', () => {
    const s = new MemoryStore(dir);
    expect(s.readGlobal()).toBe('');
  });

  it('readGlobal: 读出 GLOBAL.md 全文', () => {
    writeFileSync(join(dir, 'GLOBAL.md'), '# 我的全局\n用户偏好\n', 'utf8');
    expect(new MemoryStore(dir).readGlobal()).toBe('# 我的全局\n用户偏好\n');
  });

  it('readSoul: 文件不存在返回空串', () => {
    expect(new MemoryStore(dir).readSoul()).toBe('');
  });

  it('listDailyLogs: 无日志返回空数组', () => {
    expect(new MemoryStore(dir).listDailyLogs()).toEqual([]);
  });

  it('listDailyLogs: 列出日志文件名并按日期降序', () => {
    writeFileSync(join(dir, '2026-07-29.md'), 'x', 'utf8');
    writeFileSync(join(dir, '2026-07-30.md'), 'y', 'utf8');
    writeFileSync(join(dir, '2026-07-28.md'), 'z', 'utf8');
    expect(new MemoryStore(dir).listDailyLogs()).toEqual(['2026-07-30', '2026-07-29', '2026-07-28']);
  });

  it('listDailyLogs: 忽略非日志格式文件', () => {
    writeFileSync(join(dir, 'GLOBAL.md'), 'x', 'utf8');
    writeFileSync(join(dir, 'notes.txt'), 'y', 'utf8');
    writeFileSync(join(dir, '2026-07-30.md'), 'z', 'utf8');
    expect(new MemoryStore(dir).listDailyLogs()).toEqual(['2026-07-30']);
  });

  it('readDailyLog: 不存在返回空串', () => {
    expect(new MemoryStore(dir).readDailyLog('2026-07-30')).toBe('');
  });

  it('appendDailyLog: 新文件创建 + 条目前插', () => {
    const s = new MemoryStore(dir);
    s.appendDailyLog('2026-07-30', '第一条记忆');
    s.appendDailyLog('2026-07-30', '第二条记忆');
    const text = readFileSync(join(dir, '2026-07-30.md'), 'utf8');
    // 第二条在前（前插）
    expect(text.indexOf('第二条记忆')).toBeLessThan(text.indexOf('第一条记忆'));
    // 条目格式：<!-- timestamp -->\n{markdown}\n\n
    expect(text).toMatch(/<!-- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} -->\n第二条记忆\n\n/);
  });

  it('appendDailyLog: 非法 date 抛错', () => {
    const s = new MemoryStore(dir);
    expect(() => s.appendDailyLog('invalid', 'x')).toThrow();
    expect(() => s.appendDailyLog('2026-7-30', 'x')).toThrow();
  });

  it('parseEntries: 解析条目列表', () => {
    const text = '<!-- 2026-07-30 10:00:00 -->\n第一条\n\n<!-- 2026-07-30 11:00:00 -->\n第二条\n\n';
    const entries = new MemoryStore(dir).parseEntries(text);
    expect(entries).toHaveLength(2);
    expect(entries[0].timestamp).toBe('2026-07-30 10:00:00');
    expect(entries[0].markdown).toBe('第一条');
    expect(entries[1].markdown).toBe('第二条');
  });

  it('parseEntries: 空文本返回空数组', () => {
    expect(new MemoryStore(dir).parseEntries('')).toEqual([]);
  });

  it('parseEntries: 容错——无尾随空行的末条目仍能解析', () => {
    const text = '<!-- 2026-07-30 10:00:00 -->\n末条无空行';
    const entries = new MemoryStore(dir).parseEntries(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].markdown).toBe('末条无空行');
  });

  it('appendDailyLog: 原子写（tmp 不残留）', () => {
    const s = new MemoryStore(dir);
    s.appendDailyLog('2026-07-30', 'x');
    expect(existsSync(join(dir, '2026-07-30.md.tmp'))).toBe(false);
    expect(existsSync(join(dir, '2026-07-30.md'))).toBe(true);
  });
});
