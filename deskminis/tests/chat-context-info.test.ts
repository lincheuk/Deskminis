import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startMinisd } from '../src/minisd/index';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; });

function rpcClient(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  let idc = 0;
  const pending = new Map<number, (v: any) => void>();
  const notifications: { method: string; params: any }[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
    else if (msg.method) notifications.push({ method: msg.method, params: msg.params });
  });
  const ready = new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  function call(method: string, params?: unknown): Promise<any> {
    const id = ++idc;
    return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
  return { ready, call, notifications, close: () => ws.close() };
}

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-cxi-'));
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
  stop = srv.close;
  return { ...srv, dataDir };
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise(r => setTimeout(r, 20));
  }
}

/** 往会话里塞一条 role=user 的文本消息（直接用 appendMessage 的话没有 RPC 暴露，走 chat.prompt + 假 provider 把它跑通更稳定）。 */
async function promptTurn(c: ReturnType<typeof rpcClient>, sessionId: string, text: string): Promise<void> {
  await c.call('chat.prompt', { sessionId, text, providerId: '__fake__' });
  // 等到 turnEnd，确保有实际消息落库（含 assistant 回复）
  await waitFor(`turnEnd for prompt "${text.slice(0, 20)}"`, () =>
    c.notifications.some(n => n.method === 'chat.event' && n.params.sessionId === sessionId && n.params.event.kind === 'turnEnd'));
  // 清 notifications，避免后续断言被历史事件污染
  c.notifications.length = 0;
}

describe('chat.contextInfo RPC（#7 水位条所需；M2a 红线：buildEffectiveHistory 唯一输入）', () => {
  it('例 1（基础链路）：3 轮对话后返回 windowTokens/usedTokens/remaining 字段，语义正确', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    await promptTurn(c, s.id, '回合一：你好');
    await promptTurn(c, s.id, '回合二：说点啥都行');
    await promptTurn(c, s.id, '回合三：继续');
    const r = await c.call('chat.contextInfo', { sessionId: s.id });
    expect(r.error).toBeFalsy();
    const info = r.result;
    expect(typeof info.windowTokens).toBe('number');
    expect(typeof info.usedTokens).toBe('number');
    expect(typeof info.remaining).toBe('number');
    expect(info.windowTokens).toBeGreaterThanOrEqual(32000);  // fake provider 的 catalog 查不到会兜底 32K
    expect(info.usedTokens).toBeGreaterThanOrEqual(0);
    expect(info.remaining).toBe(Math.max(0, info.windowTokens - info.usedTokens));
    c.close();
  }, 60000);

  it('例 2（M2a 红线锚点）：写入 compact marker 后 usedTokens 必须下降（不能跟压缩前相等——若相等说明用了原始 history 而非 buildEffectiveHistory）', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    // 跑 4 轮对话，产生足够多的 raw messages
    await promptTurn(c, s.id, '压缩前 1：这里是一段足够长的文本，用来确保压缩前 token 基数足够大，后面被压缩后下降效果更明显。再多补几句让 effectiveHistory 在没有 marker 时的 parts JSON 字符数足够长。');
    await promptTurn(c, s.id, '压缩前 2：继续追加内容，让上下文历史在 4 轮后有足够的 token 估算基数，使得 anchor 定在中间时，前后差值能被稳稳地检出。');
    await promptTurn(c, s.id, '压缩前 3：继续往会话里塞内容，确保 raw history 数组至少 8 条（每轮 user + assistant 各一条），锚在倒数第 2 条时前面至少有几条会被压缩。');
    await promptTurn(c, s.id, '压缩前 4：最后一轮先落库，usedBefore 按完整 effectiveHistory（无 marker）估算。');
    const before = (await c.call('chat.contextInfo', { sessionId: s.id })).result;
    // 直接写 compact marker（不走 agent 循环：fake 32K 档 ContextPolicy 只 offload 不 compact，
    //   循环永远触发不了 compacted，红线断言对象是 chat.contextInfo 的 buildEffectiveHistory 链路，
    //   循环触发时机 M2a 已测，不归本用例。计划内修正：按真名 appendCompactMarker）
    const db2 = openDb(join(dataDir, 'minis.db'));
    try {
      const store2 = new ChatStore(db2);
      const msgs = store2.listMessages(s.id);
      // 锚点取中后段，禁止最后一条——M2a 毒 marker 教训（锚=末条会把 effectiveHistory 压成摘要占位 + 空）
      const anchor = msgs[Math.max(0, msgs.length - 2)];
      store2.appendCompactMarker(s.id, '压缩摘要（几个字）', anchor.id);
    } finally {
      db2.close();
    }
    const after = (await c.call('chat.contextInfo', { sessionId: s.id })).result;
    // 核心红线断言：usedAfter 必须 < usedBefore
    //   ——若实现违反 M2a 红线（直接把 chat.listMessages 的 RawMessage 喂 estimateTokens），
    //     marker 不改变 RawMessage 数量，usedTokens 会永远相等
    expect(typeof before.usedTokens).toBe('number');
    expect(typeof after.usedTokens).toBe('number');
    expect(before.usedTokens).toBeGreaterThan(0);
    expect(after.usedTokens).toBeLessThan(before.usedTokens);
    c.close();
  }, 90000);
});
