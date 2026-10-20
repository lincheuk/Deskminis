/** N24：在 prompt RPC 尚未完成时确定注入同会话同步通知。 */
import { describe, expect, it, vi } from 'vitest';
import { promptAndWait, type RpcClient } from './att-engines-util';
describe('N24 promptAndWait notification shapes', () => {
  it.each(['turnEnd', 'error'])('只返回这一轮的引擎事件：%s', async kind => {
    const notifications: RpcClient['notifications'] = [{ method: 'chat.event', params: { sessionId: 'S', event: { kind: 'old' } } }];
    const events = [{ kind: 'textDelta', text: '合成' }, { kind }];
    const call = vi.fn(async () => {
      notifications.push({ method: 'chat.event', params: { kind: 'synced', sessionId: 'S', count: 1 } });
      notifications.push({ method: 'chat.event', params: { sessionId: 'other', event: { kind: 'turnEnd' } } });
      notifications.push({ method: 'other', params: { sessionId: 'S', event: { kind: 'noise' } } });
      for (const event of events) notifications.push({ method: 'chat.event', params: { sessionId: 'S', event } });
      await Promise.resolve();
      return {} as any;
    });
    const result = await promptAndWait({ notifications, call, close() {} }, { sessionId: 'S', text: '合成' });
    expect(result).toEqual(events);
    expect(result.filter(ev => ev.kind === 'error')).toHaveLength(kind === 'error' ? 1 : 0);
    expect(call).toHaveBeenCalledExactlyOnceWith('chat.prompt', { sessionId: 'S', text: '合成' });
  });
});
