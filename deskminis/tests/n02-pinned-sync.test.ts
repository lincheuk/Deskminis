import { afterEach, expect, it } from 'vitest';
import { bootEngine, rendererOn, wireClient, waitFor, type BootedEngine, type Renderer, type WireClient } from './state-sync-fixture';
import { groupSessions } from '../src/renderer/src/lib/nav/group';

let e: BootedEngine | undefined, r: Renderer | undefined, c: WireClient | undefined;
afterEach(async () => {
  await r?.close();
  c?.close();
  await e?.close();
});

it('N02 同步推来置顶与取消：真实落库并自动刷新非当前会话的左栏', async () => {
  // 真实引擎、WebSocket 和渲染端先建立一个非当前会话的列表。
  e = await bootEngine();
  c = wireClient(e.port, e.token);
  await c.ready;
  r = await rendererOn({ info: e.info });
  const created = (await c.call('chat.sessions.create', {})).result;
  const sid = created.id;
  await r.chat.refreshSessions();
  await r.quiet();
  await waitFor('初始列表', () => r!.chat.sessions.some(s => s.id === sid));

  // 分别推入置顶与取消，等待实际同步通知和渲染端刷新收尾。
  let synced = 0;
  r.rpc.on('chat.event', (p: { kind?: string }) => {
    if (p.kind === 'synced') synced++;
  });
  for (const [i, pinnedAt] of [1800000001, undefined].entries()) {
    const session = {
      id: sid,
      title: '同步会话',
      createdAt: created.createdAt,
      updatedAt: Math.max(created.updatedAt, Date.now() / 1000) + 10 + i,
      memoryEnabled: 1,
      ...(pinnedAt === undefined ? {} : { pinnedAt })
    };
    expect((await c.call('sync.push', { sessionId: sid, payload: { session, messages: [], markers: [] } })).error).toBeUndefined();
    await waitFor('同步通知', () => synced === i + 1);
    await r.quiet();

    // 同一条记录在列表、真实数据库和左栏分组中都应一致。
    expect(r.chat.sessions.find(s => s.id === sid)?.title).toBe('同步会话');
    expect(r.chat.sessions.find(s => s.id === sid)?.pinnedAt).toBe(pinnedAt);
    const stored = (await c.call('chat.sessions.list', {})).result.find((s: { id: string }) => s.id === sid);
    expect(stored.pinnedAt).toBe(pinnedAt);
    expect(groupSessions(r.chat.sessions, Date.now() / 1000).find(g => g.items.some(s => s.id === sid))?.label).toBe(pinnedAt ? '已置顶' : '今天');
  }

  // 整个同步往返没有留下未处理异常。
  expect(r.unhandled()).toBe(0);
}, 60000);
