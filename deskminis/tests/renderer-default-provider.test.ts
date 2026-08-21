/**
 * T5b · 默认 provider 必须从后端读回，不许猜。
 *
 * 背景（T5 实拍逮到）：后端没有「读默认 provider」的 RPC，渲染端一直是
 * `defaultProviderId = providers[0].id` 的猜测。设置页把这个猜测放大成了一条
 * 明晃晃的「当前默认」高亮——**用户看到 A，后端实际用的是 B**。
 * 界面撒谎比界面难看严重。
 *
 * 先红后绿：去掉 index.ts 的 provider.getDefault 或 store 里的读取即变红。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { rpcCallMock } = vi.hoisted(() => ({ rpcCallMock: vi.fn() }));
vi.mock('../src/renderer/src/rpc', () => ({
  rpc: { call: rpcCallMock, connect: async () => {}, on: vi.fn() },
}));

// eslint-disable-next-line import/first
import { createPinia, setActivePinia } from 'pinia';
// eslint-disable-next-line import/first
import { useChat } from '../src/renderer/src/stores/chat';

const THREE = [
  { id: 'P1', name: 'a', kind: 'openai-compat', modelId: 'm1', hasApiKey: true },
  { id: 'P2', name: 'b', kind: 'anthropic', modelId: 'm2', hasApiKey: true },
  { id: 'P3', name: 'c', kind: 'ollama', modelId: 'm3', hasApiKey: false },
];

function stub(defaultId: unknown): void {
  rpcCallMock.mockImplementation(async (method: string) => {
    if (method === 'provider.instances.list') return THREE;
    if (method === 'provider.getDefault') return defaultId;
    if (method === 'permission.getPreset') return { preset: 'ask' };
    if (method === 'chat.sessions.list') return [];
    if (method === 'skills.list') return [];
    if (method === 'control.status') return { syncPaused: false };
    return undefined;
  });
}

beforeEach(() => { rpcCallMock.mockReset(); setActivePinia(createPinia()); });

describe('T5b — 默认 provider 读回', () => {
  it('后端说默认是 P2，界面就该是 P2（不是列表第一个）', async () => {
    stub({ id: 'P2' });
    const chat = useChat();
    await chat.refreshProviders();
    expect(chat.defaultProviderId).toBe('P2');
  });

  it('后端没设默认（返回空）→ 回落列表第一个，而不是留空让界面一个都不高亮', async () => {
    stub({ id: '' });
    const chat = useChat();
    await chat.refreshProviders();
    expect(chat.defaultProviderId).toBe('P1');
  });

  it('后端给的 id 已被删掉 → 同样回落第一个（陈旧 id 不能让界面空着）', async () => {
    stub({ id: 'GONE' });
    const chat = useChat();
    await chat.refreshProviders();
    expect(chat.defaultProviderId).toBe('P1');
  });

  it('getDefault RPC 不可用（旧后端）也不能炸——刷新照常完成', async () => {
    rpcCallMock.mockImplementation(async (method: string) => {
      if (method === 'provider.instances.list') return THREE;
      if (method === 'provider.getDefault') throw new Error('Method not found');
      return undefined;
    });
    const chat = useChat();
    await chat.refreshProviders();
    expect(chat.providers).toHaveLength(3);
    expect(chat.defaultProviderId).toBe('P1');
  });
});
