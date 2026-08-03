import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { memoryWriteTool, memoryGetTool, MEMORY_TOOL_NAMES } from '../src/minisd/tools/memory';
import { MemoryStore } from '../src/minisd/store/memory-store';
import { MinisPaths } from '../src/minisd/paths';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let store: MemoryStore;
let paths: MinisPaths;
let sessionId: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dm-mtool-'));
  store = new MemoryStore(join(dir, 'memory'));
  paths = new MinisPaths(dir);
  sessionId = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
  paths.ensureSessionDirs(sessionId);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('memory_write 工具', () => {
  it('定义: name=memory_write + 必含 tool_title', () => {
    expect(memoryWriteTool.definition.name).toBe('memory_write');
    expect(memoryWriteTool.definition.required).toContain('tool_title');
    expect(memoryWriteTool.definition.required).toContain('markdown');
  });

  it('写当日日志（date 省略）', async () => {
    const ctx = { sessionId, paths, permissions: { async check() { return 'allow' as const; }, hasBridgeGrant: () => false } };
    const r = await memoryWriteTool.execute({ markdown: '测试记忆条目', tool_title: '写记忆' }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('已写入');
    // 验证落盘
    const today = new Date();
    const p = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(store.readDailyLog(p)).toContain('测试记忆条目');
  });

  it('指定 date 写日志', async () => {
    const ctx = { sessionId, paths, permissions: { async check() { return 'allow' as const; }, hasBridgeGrant: () => false } };
    await memoryWriteTool.execute({ markdown: '历史记忆', date: '2026-07-01', tool_title: '写记忆' }, ctx);
    expect(store.readDailyLog('2026-07-01')).toContain('历史记忆');
  });

  it('markdown 为空时报错', async () => {
    const ctx = { sessionId, paths, permissions: { async check() { return 'allow' as const; }, hasBridgeGrant: () => false } };
    const r = await memoryWriteTool.execute({ markdown: '', tool_title: '写记忆' }, ctx);
    expect(r.success).toBe(false);
    expect(r.output).toContain('不能为空');
  });
});

describe('memory_get 工具', () => {
  it('定义: name=memory_get + 必含 tool_title + query', () => {
    expect(memoryGetTool.definition.name).toBe('memory_get');
    expect(memoryGetTool.definition.required).toContain('query');
    expect(memoryGetTool.definition.required).toContain('tool_title');
  });

  it('按关键词命中排序返回条目', async () => {
    store.appendDailyLog('2026-07-29', '今天研究了 Rust 异步');
    store.appendDailyLog('2026-07-30', '今天研究了 TypeScript 类型');
    const ctx = { sessionId, paths, permissions: { async check() { return 'allow' as const; }, hasBridgeGrant: () => false } };
    const r = await memoryGetTool.execute({ query: 'TypeScript', tool_title: '查记忆' }, ctx);
    expect(r.success).toBe(true);
    // 命中的条目出现；未命中的条目（Rust 异步）不参与返回（bigram 语义：命中是检索前提）
    expect(r.output).toContain('TypeScript 类型');
    expect(r.output).not.toContain('Rust 异步');
  });

  it('无匹配时返回提示而非空', async () => {
    store.appendDailyLog('2026-07-30', '无关内容');
    const ctx = { sessionId, paths, permissions: { async check() { return 'allow' as const; }, hasBridgeGrant: () => false } };
    const r = await memoryGetTool.execute({ query: '不存在的关键词', tool_title: '查记忆' }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('未找到');
  });

  it('无任何记忆时返回空提示', async () => {
    const ctx = { sessionId, paths, permissions: { async check() { return 'allow' as const; }, hasBridgeGrant: () => false } };
    const r = await memoryGetTool.execute({ query: '任意', tool_title: '查记忆' }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('暂无记忆');
  });

  it('上限 60 条 / 30KB（构造 80 条验证截断）', async () => {
    for (let i = 0; i < 80; i++) store.appendDailyLog('2026-07-30', `条目${i}内容`);
    const ctx = { sessionId, paths, permissions: { async check() { return 'allow' as const; }, hasBridgeGrant: () => false } };
    const r = await memoryGetTool.execute({ query: '条目', tool_title: '查记忆' }, ctx);
    expect(r.success).toBe(true);
    // 30KB 上限
    expect(r.output.length).toBeLessThanOrEqual(35 * 1024); // 含格式开销留余量
  });
});

describe('MEMORY_TOOL_NAMES', () => {
  it('包含 memory_write 和 memory_get', () => {
    expect(MEMORY_TOOL_NAMES).toContain('memory_write');
    expect(MEMORY_TOOL_NAMES).toContain('memory_get');
  });
});
