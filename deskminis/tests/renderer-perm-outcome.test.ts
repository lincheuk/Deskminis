/**
 * F13 · 渲染端：权限卡被作废（invalidated）时留一条说明；点了按钮但引擎回「没有生效」时留一条说明。
 * 接旧引擎（没有 outcome、没有 applied、没有 invalidated）时两处新逻辑都不触发，行为与以前相同。
 * 桩法同 perm-session-scope.test.ts：rpc.call 走可控实现，rpc.on 把处理器收进 handlers，测试里直接派发广播。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { rpcCallMock, handlers } = vi.hoisted(() => ({
  rpcCallMock: vi.fn(),
  handlers: new Map<string, (p: any) => void>(),
}));

vi.mock('../src/renderer/src/rpc', () => ({
  rpc: {
    call: rpcCallMock,
    connect: async () => {},
    on: (method: string, h: (p: any) => void) => { handlers.set(method, h); },
    onLost: vi.fn(),
  },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部，此处 import 拿到的是桩
import { createPinia, setActivePinia } from 'pinia';
// eslint-disable-next-line import/first
import { useChat } from '../src/renderer/src/stores/chat';
// eslint-disable-next-line import/first
import { PERM_INVALIDATED_NOTE, permLateNote } from '../src/renderer/src/lib/perm/copy';

/** permission.respond 的应答由每个用例自己定。 */
let respondResult: unknown;
function stubRpc(): void {
  rpcCallMock.mockImplementation(async (method: string) => {
    if (method === 'permission.respond') return respondResult;
    if (method === 'permission.getPreset') return { preset: 'ask' };
    if (method === 'chat.sessions.list') return [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }];
    if (method === 'provider.instances.list') return [];
    if (method === 'provider.getDefault') return {};
    if (method === 'modelgroup.list') return [];
    if (method === 'assistants.list') return [];
    if (method === 'skills.list') return [];
    if (method === 'control.status') return { syncPaused: false };
    if (method === 'chat.messages.list') return [];
    if (method === 'chat.annotations.list') return { annotations: [] };
    if (method === 'workspace.get') return { root: '/w', isDefault: true };
    return undefined;
  });
}

async function boot(active = 'A') {
  stubRpc();
  const chat = useChat();
  await chat.init();
  await chat.open(active);
  return chat;
}

function dispatch(method: string, payload: unknown): void {
  const h = handlers.get(method);
  if (!h) throw new Error(`init() 没有订阅 ${method}`);
  h(payload);
}
const request = (requestId: string, sessionId: string) => dispatch('permission.request', {
  requestId, req: { sessionId, kind: 'mcp', detail: 'fx', toolTitle: '调 MCP' }, meta: { timeoutMs: 90000, toolUseId: 'TU-1' },
});
const resolved = (requestId: string, reason?: string, outcome?: unknown) =>
  dispatch('permission.resolved', { requestId, ...(reason === undefined ? {} : { reason }), ...(outcome === undefined ? {} : { outcome }) });
const TIMEOUT_NOTE = '权限请求已超时，自动拒绝';
const details = (chat: ReturnType<typeof useChat>): string[] => chat.eventNotes.map((n: any) => n.detail);

beforeEach(() => {
  rpcCallMock.mockReset();
  handlers.clear();
  respondResult = { ok: true, applied: true };
  setActivePinia(createPinia());
});

describe('R1 permission.resolved 按 reason 分流', () => {
  it('invalidated：当前会话的卡摘卡并留一条；别的会话的卡只摘卡', async () => {
    const chat = await boot('A');
    request('R1', 'A'); request('R2', 'B');
    resolved('R2', 'invalidated', { decision: 'deny', reason: 'invalidated', cause: 'mcp-disabled', requestId: 'R2' });
    expect(chat.pendingPerms.map(p => p.requestId)).toEqual(['R1']);
    expect(details(chat), '别的会话的卡失效，不写进当前会话').toEqual([]);

    resolved('R1', 'invalidated', { decision: 'deny', reason: 'invalidated', cause: 'mcp-disabled', requestId: 'R1' });
    expect(chat.pendingPerms).toEqual([]);
    expect(chat.eventNotes).toHaveLength(1);
    expect(chat.eventNotes[0]).toMatchObject({ kind: 'error', detail: PERM_INVALIDATED_NOTE, retryable: false });
  });

  it('timeout 的留条照旧（带不带 outcome 都一样）', async () => {
    const chat = await boot('A');
    request('R1', 'A'); request('R2', 'A');
    resolved('R1', 'timeout');
    resolved('R2', 'timeout', { decision: 'deny', reason: 'timeout', cause: 'unanswered', requestId: 'R2', waitedMs: 90000 });
    expect(chat.pendingPerms).toEqual([]);
    expect(details(chat)).toEqual([TIMEOUT_NOTE, TIMEOUT_NOTE]);
  });

  it.each(['cancelled', 'session-deleted', 'shutdown', 'answered', '将来才有的取值', undefined])('reason=%s：只摘卡，不留条', async reason => {
    const chat = await boot('A');
    request('R1', 'A');
    resolved('R1', reason);
    expect(chat.pendingPerms).toEqual([]);
    expect(details(chat)).toEqual([]);
  });

  it('手里没有这张卡（渲染端重载后才收到 invalidated）：不猜、不写', async () => {
    const chat = await boot('A');
    resolved('没见过', 'invalidated');
    expect(details(chat)).toEqual([]);
  });
});

describe('R2 respondPerm：引擎回 applied:false 时留一条说明', () => {
  it.each([
    [{ reason: 'timeout', decision: 'deny' }, '这张权限卡已超时，你的选择没有生效'],
    [{ reason: 'answered', decision: 'allow' }, '这张权限卡已在别处处理，你的选择没有生效'],
    [{ reason: 'cancelled', decision: 'deny' }, '这张权限卡已取消，你的选择没有生效'],
    [{ reason: 'session-deleted', decision: 'deny' }, '这张权限卡已取消，你的选择没有生效'],
    [{ reason: 'shutdown', decision: 'deny' }, '这张权限卡已取消，你的选择没有生效'],
    [{ reason: 'invalidated', decision: 'deny' }, '这张权限卡已失效，你的选择没有生效'],
    [undefined, '这张权限卡已失效，你的选择没有生效'],
  ])('settled=%j：当前会话留条', async (settled, note) => {
    const chat = await boot('A');
    request('R1', 'A');
    respondResult = { ok: true, applied: false, ...(settled ? { settled } : {}) };
    await chat.respondPerm('R1', 'allow-once');
    expect(rpcCallMock).toHaveBeenCalledWith('permission.respond', { requestId: 'R1', decision: 'allow-once' });
    expect(chat.pendingPerms).toEqual([]);
    expect(chat.eventNotes).toHaveLength(1);
    expect(chat.eventNotes[0]).toMatchObject({ kind: 'error', detail: note, retryable: false });
  });

  it('undelivered（卡仍待批、答复来自发卡之后才建立的连接）：按不带 settled 留「已失效」', async () => {
    const chat = await boot('A');
    request('R1', 'A');
    respondResult = { ok: true, applied: false, undelivered: true };
    await chat.respondPerm('R1', 'deny');
    expect(details(chat)).toEqual(['这张权限卡已失效，你的选择没有生效']);
  });

  it('卡属于别的会话：不留条', async () => {
    const chat = await boot('A');
    request('R1', 'B');
    respondResult = { ok: true, applied: false, settled: { reason: 'timeout', decision: 'deny' } };
    await chat.respondPerm('R1', 'allow-once');
    expect(chat.pendingPerms).toEqual([]);
    expect(details(chat)).toEqual([]);
  });

  it('applied:true：不留条', async () => {
    const chat = await boot('A');
    request('R1', 'A');
    await chat.respondPerm('R1', 'allow-session');
    expect(chat.pendingPerms).toEqual([]);
    expect(details(chat)).toEqual([]);
  });
});

describe('R3 接旧引擎：没有 outcome、没有 applied', () => {
  it.each([[{ ok: true }], [undefined], [null], ['ok']])('permission.respond 返回 %j：不抛、不留条，卡照常摘掉', async result => {
    const chat = await boot('A');
    request('R1', 'A');
    respondResult = result;
    await expect(chat.respondPerm('R1', 'allow-once')).resolves.toBeUndefined();
    expect(chat.pendingPerms).toEqual([]);
    expect(details(chat)).toEqual([]);
  });

  it('旧引擎的 permission.resolved（只有 requestId / reason）：answered 只摘卡，timeout 留条', async () => {
    const chat = await boot('A');
    request('R1', 'A'); request('R2', 'A');
    resolved('R1', 'answered');
    resolved('R2', 'timeout');
    expect(chat.pendingPerms).toEqual([]);
    expect(details(chat)).toEqual([TIMEOUT_NOTE]);
  });
});

describe('R4 permLateNote 全表', () => {
  it('逐条', () => {
    expect(permLateNote({ reason: 'timeout' })).toBe('这张权限卡已超时，你的选择没有生效');
    expect(permLateNote({ reason: 'answered' })).toBe('这张权限卡已在别处处理，你的选择没有生效');
    for (const reason of ['cancelled', 'session-deleted', 'shutdown']) expect(permLateNote({ reason })).toBe('这张权限卡已取消，你的选择没有生效');
    expect(permLateNote({ reason: 'invalidated' })).toBe('这张权限卡已失效，你的选择没有生效');
    for (const s of [undefined, {}, { reason: '将来才有的取值' }]) expect(permLateNote(s)).toBe('这张权限卡已失效，你的选择没有生效');
    expect(PERM_INVALIDATED_NOTE).toBe('权限请求已失效（相关服务被停用或配置已修改），没有执行');
  });
});
