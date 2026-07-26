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
