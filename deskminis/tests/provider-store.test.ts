import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderStore, InMemoryVault } from '../src/minisd/store/provider-store';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string; let vault: InMemoryVault; let store: ProviderStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dm-prov-')); vault = new InMemoryVault(); store = new ProviderStore(dir, vault); });

describe('ProviderStore', () => {
  it('create/list: 密钥进 vault, 配置文件无明文', () => {
    const inst = store.create({ name: '我的中继', kind: 'openai-compat', baseUrl: 'https://relay.example/v1', modelId: 'claude-sonnet-5' }, 'sk-secret');
    expect(store.list()[0]).toMatchObject({ name: '我的中继', hasApiKey: true });
    expect((store.list()[0] as unknown as Record<string, unknown>).apiKey).toBeUndefined();
    expect(readFileSync(join(dir, 'providers.json'), 'utf8')).not.toContain('sk-secret');
    expect(vault.get(`provider:${inst.id}`)).toBe('sk-secret');
  });
  it('默认 provider 设置与持久化', () => {
    const a = store.create({ name: 'A', kind: 'anthropic', modelId: 'claude-sonnet-5' }, 'k1');
    store.setDefaultId(a.id);
    const reopened = new ProviderStore(dir, vault);
    expect(reopened.getDefaultId()).toBe(a.id);
  });
  it('instantiate 返回对应 Provider', () => {
    const a = store.create({ name: 'A', kind: 'anthropic', modelId: 'm1' }, 'k');
    const o = store.create({ name: 'O', kind: 'openai-compat', baseUrl: 'http://x/v1', modelId: 'm2' }, 'k');
    expect(store.instantiate(a.id).name).toBe('anthropic');
    expect(store.instantiate(o.id).name).toBe('openai-compat');
  });
  it('delete 同时清 vault', () => {
    const a = store.create({ name: 'A', kind: 'anthropic', modelId: 'm' }, 'k');
    store.delete(a.id);
    expect(store.list()).toHaveLength(0);
    expect(vault.get(`provider:${a.id}`)).toBeUndefined();
  });
});

describe('ProviderStore gemini/ollama kind', () => {
  it('ollama 免 key：create 不传 apiKey，hasApiKey=false，instantiate 成功', () => {
    const o = store.create({ name: '本地 Ollama', kind: 'ollama', modelId: 'qwen3' });
    expect(store.list()[0]).toMatchObject({ name: '本地 Ollama', hasApiKey: false });
    expect(readFileSync(join(dir, 'providers.json'), 'utf8')).not.toContain('apiKey');
    expect(store.instantiate(o.id).name).toBe('openai-compat');
  });
  it('gemini 带 key：instantiate 返回 GeminiProvider', () => {
    const g = store.create({ name: 'G', kind: 'gemini', modelId: 'gemini-2.5-flash' }, 'gk');
    expect(store.instantiate(g.id).name).toBe('gemini');
    expect(vault.get(`provider:${g.id}`)).toBe('gk');
  });
  it('gemini 无 key → instantiate 抛缺少密钥', () => {
    const g = store.create({ name: 'G', kind: 'gemini', modelId: 'm' });
    expect(() => store.instantiate(g.id)).toThrow('缺少密钥');
  });
  it('ollama 也可带 key（前置代理场景）→ 照常写 vault', () => {
    const o = store.create({ name: 'O', kind: 'ollama', modelId: 'qwen3', baseUrl: 'http://nas:11434/v1' }, 'lk');
    expect(store.list()[0].hasApiKey).toBe(true);
    expect(store.instantiate(o.id).name).toBe('openai-compat');
  });
});
