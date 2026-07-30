import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryInjector } from '../src/minisd/store/memory-injector';
import { MemoryStore } from '../src/minisd/store/memory-store';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let store: MemoryStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dm-inj-')); store = new MemoryStore(dir); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('MemoryInjector', () => {
  it('memoryEnabled=false: 只返回 basePrompt', () => {
    const inj = new MemoryInjector(store);
    expect(inj.build('你是助手', { memoryEnabled: false })).toBe('你是助手');
  });

  it('memoryEnabled=true 但无任何记忆文件: 只返回 basePrompt', () => {
    const inj = new MemoryInjector(store);
    const out = inj.build('你是助手', { memoryEnabled: true });
    expect(out).toBe('你是助手');
  });

  it('注入 GLOBAL.md', () => {
    writeFileSync(join(dir, 'GLOBAL.md'), '用户喜欢简洁回复', 'utf8');
    const out = new MemoryInjector(store).build('你是助手', { memoryEnabled: true });
    expect(out).toContain('用户喜欢简洁回复');
    expect(out).toContain('你是助手');
  });

  it('注入 SOUL.md 作为人设（在 basePrompt 之前）', () => {
    writeFileSync(join(dir, 'SOUL.md'), '你是一个严谨的工程师', 'utf8');
    const out = new MemoryInjector(store).build('你是助手', { memoryEnabled: true });
    expect(out).toContain('你是一个严谨的工程师');
    expect(out).toContain('你是助手');
    expect(out.indexOf('你是一个严谨的工程师')).toBeLessThan(out.indexOf('你是助手'));
  });

  it('注入最近 3 个非空日志', () => {
    store.appendDailyLog('2026-07-28', '28号的记忆');
    store.appendDailyLog('2026-07-29', '29号的记忆');
    store.appendDailyLog('2026-07-30', '30号的记忆');
    store.appendDailyLog('2026-07-27', '27号的记忆'); // 第 4 个，不应被注入
    const out = new MemoryInjector(store).build('你是助手', { memoryEnabled: true });
    expect(out).toContain('30号的记忆');
    expect(out).toContain('29号的记忆');
    expect(out).toContain('28号的记忆');
    expect(out).not.toContain('27号的记忆');
  });

  it('空日志文件不算"非空"（跳过）', () => {
    writeFileSync(join(dir, '2026-07-29.md'), '', 'utf8');
    store.appendDailyLog('2026-07-30', '30号记忆');
    const out = new MemoryInjector(store).build('你是助手', { memoryEnabled: true });
    expect(out).toContain('30号记忆');
    // 2026-07-29.md 是空文件，不算非空日志，不应注入任何内容
    expect(out.match(/2026-07-29/g)).toBeNull();
  });

  it('措辞框定包含"背景上下文"提示', () => {
    writeFileSync(join(dir, 'GLOBAL.md'), 'x', 'utf8');
    const out = new MemoryInjector(store).build('你是助手', { memoryEnabled: true });
    expect(out).toContain('背景上下文');
  });

  it('GLOBAL.md 超 4096 字符被截断', () => {
    writeFileSync(join(dir, 'GLOBAL.md'), 'A'.repeat(5000), 'utf8');
    const out = new MemoryInjector(store).build('你是助手', { memoryEnabled: true });
    // 截断后应包含截断标记
    expect(out).toContain('A'.repeat(4096));
    expect(out).not.toContain('A'.repeat(4097));
  });
});
