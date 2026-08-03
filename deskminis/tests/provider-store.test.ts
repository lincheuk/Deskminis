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

describe('ProviderStore ModelGroup', () => {
  it('createGroup/listGroups/getGroup: 持久化到 providers.json', () => {
    const a = store.create({ name: 'A', kind: 'anthropic', modelId: 'm1' }, 'k');
    const b = store.create({ name: 'B', kind: 'openai-compat', baseUrl: 'http://x/v1', modelId: 'm2' }, 'k');
    const g = store.createGroup('主力链', [a.id, b.id]);
    expect(g.id).toMatch(/^[0-9A-F-]{36}$/);
    expect(g.memberIds).toEqual([a.id, b.id]);

    const reopened = new ProviderStore(dir, vault);
    expect(reopened.listGroups()).toHaveLength(1);
    expect(reopened.getGroup(g.id)).toMatchObject({ name: '主力链', memberIds: [a.id, b.id] });
  });

  it('updateGroup 改名与成员', () => {
    const a = store.create({ name: 'A', kind: 'anthropic', modelId: 'm1' }, 'k');
    const g = store.createGroup('G', [a.id]);
    store.updateGroup(g.id, { name: 'G2', memberIds: [a.id, a.id] });
    expect(store.getGroup(g.id)!.name).toBe('G2');
    expect(store.getGroup(g.id)!.memberIds).toEqual([a.id, a.id]);
  });

  it('deleteGroup: 配置文件里消失', () => {
    const a = store.create({ name: 'A', kind: 'anthropic', modelId: 'm1' }, 'k');
    const g = store.createGroup('G', [a.id]);
    store.deleteGroup(g.id);
    expect(store.listGroups()).toHaveLength(0);
    expect(store.getGroup(g.id)).toBeUndefined();
  });

  it('resolveGroupMembers: 成员被删时静默跳过', () => {
    const a = store.create({ name: 'A', kind: 'anthropic', modelId: 'm1' }, 'k');
    const b = store.create({ name: 'B', kind: 'openai-compat', baseUrl: 'http://x/v1', modelId: 'm2' }, 'k');
    const g = store.createGroup('G', [a.id, b.id]);
    // 删掉 a，resolveGroupMembers 只返回 b
    store.delete(a.id);
    const members = store.resolveGroupMembers(g.id);
    expect(members).toHaveLength(1);
    expect(members[0].instance.id).toBe(b.id);
    expect(members[0].instantiate().name).toBe('openai-compat');
  });

  it('resolveGroupMembers: 全部成员被删 → 返回空数组', () => {
    const a = store.create({ name: 'A', kind: 'anthropic', modelId: 'm1' }, 'k');
    const g = store.createGroup('G', [a.id]);
    store.delete(a.id);
    expect(store.resolveGroupMembers(g.id)).toEqual([]);
  });

  it('resolveGroupMembers: 不存在的 groupId → 返回空数组', () => {
    expect(store.resolveGroupMembers('NOPE')).toEqual([]);
  });
});

describe('ProviderInstance 手动 contextWindow (M4.5 Task 3)', () => {
  it('create 支持手动 contextWindow 字段并持久化', () => {
    const p = store.create({ name: 'test', kind: 'openai-compat', baseUrl: 'http://x/v1', modelId: 'm1', contextWindow: 256_000 }, 'k');
    expect(p.contextWindow).toBe(256_000);
    expect(store.list()[0].contextWindow).toBe(256_000);
    // 持久化：重开实例仍读到
    const reopened = new ProviderStore(dir, vault);
    expect(reopened.list()[0].contextWindow).toBe(256_000);
  });

  it('update 可修改 contextWindow', () => {
    const p = store.create({ name: 'test', kind: 'openai-compat', baseUrl: 'http://x/v1', modelId: 'm1' }, 'k');
    expect(store.list()[0].contextWindow).toBeUndefined();
    store.update(p.id, { contextWindow: 200_000 });
    expect(store.list()[0].contextWindow).toBe(200_000);
    // 再次 update 清空
    store.update(p.id, { contextWindow: undefined });
    expect(store.list()[0].contextWindow).toBeUndefined();
  });

  it('create 不传 contextWindow → 字段为 undefined（向后兼容）', () => {
    const p = store.create({ name: 'test', kind: 'anthropic', modelId: 'm1' }, 'k');
    expect(p.contextWindow).toBeUndefined();
  });
});
