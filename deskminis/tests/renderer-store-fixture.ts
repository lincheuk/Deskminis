/** Q20b：真实 Pinia store 的进程内 RPC 桩；不连接引擎，不接触用户数据。 */
import { createPinia, setActivePinia } from 'pinia';
import { expect, type Mock } from 'vitest';
import { useChat } from '../src/renderer/src/stores/chat';

export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? ((<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false) : false;
export type Chat = ReturnType<typeof useChat>;
export type SessionRow = { id: string; title: string; updatedAt?: number; pinnedAt?: number; memoryEnabled?: boolean; modelBinding?: string; assistantId?: string; mcpDisabled?: string[] };
export type AssistantRow = { id: string; name: string; avatar: string; rules: string; modelBinding?: string; skillIds: string[]; prompts: string[]; sortOrder: number };
export type ToolCard = { toolUseId: string; name: string; title: string; output?: string; success?: boolean; startedAt?: number; endedAt?: number; input?: string };
export type EventKind = 'fallback' | 'compacted' | 'offloaded' | 'retry' | 'error' | 'synced' | 'pruned' | 'compactFailed' | 'capability' | 'contextRecovery';
export type PendingCard = { requestId: string; sessionId: string; detail: string; kind: string; toolTitle: string; timeoutMs?: number; riskClass?: string; bridgeTriggers?: string[]; deadlineMs?: number; preview?: { oldText: string; newText: string }; note?: string };
export interface StoreRpcProbe { call: Mock; on: Mock; handlers: Map<string, (params: any) => unknown>; lost: Mock; connect: Mock }

/** 应答闸没有计时器；测试在已知入口自行放行。 */
export function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}

/** 默认应答只提供 init/open 的最小合法形状；每例可逐次覆写 call。 */
export async function minimalReply(method: string): Promise<any> {
  if (['chat.sessions.list', 'chat.messages.list', 'chat.sessions.listRetained', 'skills.list', 'assistants.list', 'cron.list', 'modelgroup.list', 'provider.instances.list'].includes(method)) return [];
  if (method === 'remote.status') return { devices: [] };
  if (method === 'chat.annotations.list') return { annotations: [] };
  if (method === 'attachments.status') return { items: [] };
  if (method === 'mcp.servers.list') return { servers: [], statuses: [], configError: false };
  if (method === 'permission.getPreset') return { preset: 'ask' };
  if (method === 'control.status') return { syncPaused: false };
  if (method === 'search.provider.get') return { kind: 'none', hasKey: false };
  if (method === 'chat.contextInfo') return { windowTokens: 64000, usedTokens: 100, remaining: 63900 };
  if (method === 'workspace.get') return { root: '', isDefault: true };
  return { ok: true };
}

export function resetStoreRpc(probe: StoreRpcProbe): void {
  setActivePinia(createPinia());
  probe.call.mockReset();
  probe.call.mockImplementation(minimalReply);
  probe.handlers.clear();
  probe.on.mockClear();
  probe.lost.mockClear();
  probe.connect.mockClear();
}

/** 所有本桩应答都落定后让出一轮事件循环，用于 void 刷新与否定断言的确定收尾点。 */
export async function settleStore(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }

export async function initStore(probe: StoreRpcProbe): Promise<Chat> {
  const chat = useChat();
  await chat.init();
  await settleStore();
  probe.call.mockClear();
  return chat;
}

export async function dispatchStore(probe: StoreRpcProbe, method: string, params: unknown): Promise<void> {
  const handler = probe.handlers.get(method);
  expect(handler, method + ' 订阅').toBeTypeOf('function');
  await handler!(params);
  await settleStore();
}

export function openCalls(id: string): unknown[][] {
  return [['chat.messages.list', { sessionId: id }], ['skills.list', { sessionId: id }], ['chat.annotations.list', { sessionId: id }], ['attachments.status', { sessionId: id }], ['workspace.get', { sessionId: id }]];
}
