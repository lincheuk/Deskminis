/** renderer 源码守卫（.vue 不在 typecheck 覆盖内，照抄 renderer-settings-modal.test.ts 的纯文本守卫）：
 *  ProviderSettings「获取列表」按钮 + modelId datalist 下拉 + kind 补 gemini/ollama option，
 *  接线经 stores/chat.ts 的 fetchProviderModels → RPC provider.models.fetch。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const { _rpcCall, _rpcOn, _handlers, _rpcLost, _rpcConnect } = vi.hoisted(() => {
  const handlers = new Map<string, (params: any) => unknown>();
  return { _rpcCall: vi.fn(), _rpcOn: vi.fn((method: string, handler: (params: any) => unknown) => { handlers.set(method, handler); }), _handlers: handlers, _rpcLost: vi.fn(), _rpcConnect: vi.fn(async () => {}) };
});
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: _rpcCall, on: _rpcOn, onLost: _rpcLost, connect: _rpcConnect } }));

import fs from 'node:fs';
import path from 'node:path';
import { useChat } from '../src/renderer/src/stores/chat';
import { resetStoreRpc } from './renderer-store-fixture';

const root = path.resolve(__dirname, '..');
const vue = fs.readFileSync(path.join(root, 'src/renderer/src/ui/settings/SecModels.vue'), 'utf8');

const _probe = { call: _rpcCall, on: _rpcOn, handlers: _handlers, lost: _rpcLost, connect: _rpcConnect };
// 每例使用新的真实 Pinia；RPC 桩只记调用与订阅，由用例放行应答。
beforeEach(() => { resetStoreRpc(_probe); });
afterEach(() => { vi.restoreAllMocks(); });

describe('ProviderSettings 获取模型列表（renderer 源码守卫）', () => {
  it('ProviderSettings.vue：modelId 挂 datalist + 获取列表按钮走 provider.models.fetch + kind 四 option', () => {
    expect(vue).toMatch(/<datalist/);  // datalist 还在，id 换了名
    expect(vue).toMatch(/list="modelopts"/);
    expect(vue).toMatch(/<datalist id="modelopts"/);  // input 与 datalist 的 id 对得上才算接上
    expect(vue).toMatch(/@click="fetchModels"/);  // 按钮文案改了，锚「有一颗按钮会去拉列表」
    // RPC 名收进 store action（fetchProviderModels），组件只调 action——本文件例 3 钉那一层
    expect(vue).toMatch(/chat\.fetchProviderModels\(/);
    // 四种 kind 走 KINDS 常量表 v-for 渲染；锚「四种都在」，不锚 <option> 的写法（红线 9）
    for (const k of ['anthropic', 'openai-compat', 'gemini', 'ollama']) {
      expect(vue, `缺 ${k}`).toMatch(new RegExp(`v:\\s*'${k}'`));
    }
  });

  it('ProviderSettings.vue：失败静默回退手输——清空选项、仅 console.warn、不弹错误', () => {
    // 「取列表失败静默回落手输」的实现从 console.warn 改成吞掉错误不改状态——
    // 锚意图：失败时**不弹错、不拦住手动填写**
    expect(vue).toMatch(/catch\s*\{/);
    expect(vue).not.toMatch(/取不到模型列表[^']*throw/);
    expect(vue).toContain('modelOptions.value = []'); // 失败清空选项，手输回退是一等路径
  });

  it('stores/chat.ts：fetchProviderModels action 一行式 rpc.call', async () => {
    // 已存实例与未保存表单两种参数逐个透传；完整应答与错误都原样返回。
    const chat = useChat();
    for (const params of [{ id: 'P' }, { kind: 'openai', baseUrl: 'https://invalid.example/v1', apiKey: 'test-only' }]) {
      _rpcCall.mockClear();
      _rpcCall.mockResolvedValueOnce({ models: ['m1', 'm2'] });
      expect(await chat.fetchProviderModels(params)).toEqual({ models: ['m1', 'm2'] });
      expect(_rpcCall.mock.calls).toEqual([['provider.models.fetch', params]]);
    }
    _rpcCall.mockClear();
    _rpcCall.mockRejectedValueOnce(new Error('provider failed'));
    await expect(chat.fetchProviderModels({ id: 'P' })).rejects.toThrow('provider failed');
    expect(_rpcCall.mock.calls).toEqual([['provider.models.fetch', { id: 'P' }]]);
  });
});
