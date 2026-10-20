import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateTextTokens } from '../src/shared/token-estimate';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { InputQueueStore } from '../src/minisd/store/input-queue';
import { runAgentLoop } from '../src/minisd/agent/loop';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { MinisPaths } from '../src/minisd/paths';
import type { AgentProvider, StreamRequest } from '../src/minisd/providers/types';

// Q10 改前的估算公式作为对照，范围与 UTF-16 长度沿用既有行为。
function previousEstimate(s: string): number {
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  return Math.ceil(cjk / 1.6 + (s.length - cjk) / 4);
}

describe('Q10 文本估算口径保持', () => {
  it.each([
    ['空串', ''], ['英文', 'Hello world!\r\n'.repeat(100)],
    ['中文', '中文预算估算'.repeat(100)], ['混排', 'a中 b文 c\n'.repeat(100)],
    ['表情与代理对', '😊𠀀𠮷\uD800\uDC00\uDBFF\uDFFF\uD800x\uDC00'.repeat(100)],
    ['范围端点与取整', '\u4dff\u4e00\u9fa5\u9fa6\u9fff\u3400abc'.repeat(100)],
  ])('%s 与改前相同', (_name, text) => {
    expect(estimateTextTokens(text)).toBe(previousEstimate(text));
  });

  it('全部 65536 个 UTF-16 单元分别覆盖 CJK 边界与取整', () => {
    const failures: number[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      const s = String.fromCharCode(code).repeat(16) + 'abc';
      if (estimateTextTokens(s) !== previousEstimate(s)) failures.push(code);
    }
    expect(failures).toEqual([]);
  });

  it('1000 组固定种子随机 UTF-16 文本与改前相同', () => {
    let seed = 0x51c0ffee;
    const next = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    for (let sample = 0; sample < 1000; sample++) {
      const units = Array.from({ length: next() % 4097 }, () => next() & 0xffff);
      const text = String.fromCharCode(...units);
      expect(estimateTextTokens(text), `sample ${sample}`).toBe(previousEstimate(text));
    }
  });
});

function traceDb(db: Database.Database) {
  const prepares: string[] = [], reads: string[] = [];
  const traced = new Proxy(db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => {
      prepares.push(sql);
      const statement = target.prepare(sql);
      return new Proxy(statement, { get(stmt, method) {
        if (method === 'get' || method === 'all') return (...args: unknown[]) => {
          reads.push(sql);
          return (stmt[method] as Function)(...args);
        };
        const value = Reflect.get(stmt, method, stmt);
        return typeof value === 'function' ? value.bind(stmt) : value;
      } });
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { traced, prepares, reads, reset: () => { prepares.length = 0; reads.length = 0; } };
}

describe('Q10 真实 SQLite 查询与消息边界', () => {
  it('单次会话查询保留全部字段、排序、坏 JSON 回落与隐藏副本过滤', () => {
    const db = openDb(':memory:');
    try {
      const trace = traceDb(db), store = new ChatStore(trace.traced);
      const put = db.prepare('INSERT INTO sessions(id,title,model_binding,memory_enabled,workspace_root,mcp_disabled_json,assistant_id,created_at,updated_at,pinned_at,remote_tombstoned_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      put.run('A', '中文', null, 1, null, null, null, 1, 10, null, null);
      put.run('B', 'B', 'binding', 0, 'C:/workspace', '["ok",3,"other"]', 'assistant', 2, 30, 0, null);
      put.run('C', 'C', '', 2, '', '{broken', '', 3, 20, 12, null);
      put.run('D', 'hidden', null, 1, null, null, null, 4, 100, null, 100);
      const expected = [
        { id: 'B', title: 'B', modelBinding: 'binding', memoryEnabled: false, workspaceRoot: 'C:/workspace', mcpDisabled: ['ok', 'other'], assistantId: 'assistant', createdAt: 2, updatedAt: 30, pinnedAt: 0 },
        { id: 'C', title: 'C', modelBinding: '', memoryEnabled: false, workspaceRoot: '', mcpDisabled: [], assistantId: '', createdAt: 3, updatedAt: 20, pinnedAt: 12 },
        { id: 'A', title: '中文', modelBinding: undefined, memoryEnabled: true, workspaceRoot: undefined, mcpDisabled: [], assistantId: undefined, createdAt: 1, updatedAt: 10, pinnedAt: undefined },
      ];
      trace.reset();
      expect(store.listSessions()).toEqual(expected);
      expect(trace.reads).toHaveLength(1); expect(trace.prepares).toHaveLength(0);
      for (const s of expected) expect(store.getSession(s.id)).toEqual(s);
      expect(store.getSession('D')).toBeUndefined(); expect(store.getSession('absent')).toBeUndefined();
      // 重用的是语句，不能缓存数据：写入后下一次列表和工作区读取必须立即看到变化。
      db.prepare('UPDATE sessions SET workspace_root=?, updated_at=? WHERE id=?').run('C:/new', 40, 'A');
      trace.reset();
      expect(store.listSessions()[0]).toMatchObject({ id: 'A', workspaceRoot: 'C:/new', updatedAt: 40 });
      expect(store.getWorkspaceRoot('A')).toBe('C:/new'); expect(store.getWorkspaceRoot('absent')).toBeUndefined();
      expect(trace.prepares).toHaveLength(0); expect(trace.reads).toHaveLength(3);
    } finally { db.close(); }
  });

  it('消息时间上界与完整历史一致，空会话和新写入不缓存', () => {
    const db = openDb(':memory:');
    try {
      const trace = traceDb(db), store = new ChatStore(trace.traced), s = store.createSession();
      expect(store.getMaxMessageCreatedAt(s.id)).toBeUndefined();
      for (const [i, time] of [11, -5, 14.125, 12].entries()) store.appendMessage({ id: 'M' + i, sessionId: s.id, role: 'user', parts: [{ type: 'text', value: 'history' }], createdAt: time, streamInterruptCount: 0 });
      const historyMax = Math.max(...store.listMessages(s.id).map(m => m.createdAt));
      trace.reset();
      expect(store.getMaxMessageCreatedAt(s.id)).toBe(historyMax);
      expect(trace.reads).toHaveLength(1); expect(trace.prepares).toHaveLength(0);
      expect(trace.reads.some(sql => sql.startsWith('SELECT * FROM messages'))).toBe(false);
      store.appendMessage({ id: 'later', sessionId: s.id, role: 'user', parts: [], createdAt: 15, streamInterruptCount: 0 });
      expect(store.getMaxMessageCreatedAt(s.id)).toBe(15);
      const other = store.createSession();
      store.appendMessage({ id: 'other', sessionId: other.id, role: 'user', parts: [], createdAt: 999, streamInterruptCount: 0 });
      expect(store.getMaxMessageCreatedAt(s.id)).toBe(15);
    } finally { db.close(); }
  });

  it('真实循环只读一遍完整历史，队列插入后发给模型，未来时间戳仍严格递增', async () => {
    const db = openDb(':memory:');
    try {
      const trace = traceDb(db), store = new ChatStore(trace.traced, 'local', { now: () => 1000000 });
      const s = store.createSession();
      store.appendMessage({ id: 'old', sessionId: s.id, role: 'user', parts: [{ type: 'text', value: 'original' }], createdAt: 1234, streamInterruptCount: 0 });
      const inbox = new InputQueueStore(db, { isSessionDeleted: id => store.isDeleted(id), now: () => 1000 });
      for (const id of ['one', 'two']) inbox.send({ sessionId: s.id, messageId: id, mode: 'steer', runId: 'R', text: 'steer:' + id });
      const requests: StreamRequest[] = [];
      const provider: AgentProvider = { name: 'q10', modelId: 'fake', async *streamAgentMessage(req) {
        requests.push(req); yield { kind: 'textDelta', text: 'answer' }; yield { kind: 'done', stopReason: 'endTurn' };
      } };
      trace.reset();
      const events = [];
      for await (const e of runAgentLoop(store, {
        sessionId: s.id, provider, tools: new ToolRegistry(), systemPrompt: 'sys',
        toolContext: { sessionId: s.id, paths: new MinisPaths(join(tmpdir(), 'dm-q10-no-files')), permissions: { async check() { return 'allow'; }, hasBridgeGrant: () => false } },
        inputQueue: {
          admit: append => inbox.admitSteers(s.id, 'R', input => append(input.text)),
          hasPending: () => inbox.pendingSteers(s.id, 'R'), delivered: ids => inbox.delivered(s.id, ids),
        },
      })) events.push(e);
      expect(trace.reads.filter(sql => sql.startsWith('SELECT * FROM messages'))).toHaveLength(1);
      expect(trace.reads.filter(sql => sql.startsWith('SELECT MAX(created_at)'))).toHaveLength(1);
      expect(requests).toHaveLength(1);
      expect(requests[0].messages.flatMap(m => m.parts.map(p => p.value))).toEqual(['original', 'steer:one', 'steer:two']);
      const history = store.listMessages(s.id);
      expect(history.flatMap(m => m.parts.map(p => p.value))).toEqual(['original', 'steer:one', 'steer:two', 'answer']);
      for (let i = 1; i < history.length; i++) expect(history[i].createdAt).toBeGreaterThan(history[i - 1].createdAt);
      expect(inbox.list(s.id).map(input => input.state)).toEqual(['delivered', 'delivered']);
      expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
    } finally { db.close(); }
  });
});
