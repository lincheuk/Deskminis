import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AgentProvider } from '../providers/types';
import { AnthropicProvider } from '../providers/anthropic';
import { OpenAIProvider } from '../providers/openai';
import { GeminiProvider } from '../providers/gemini';

const nativeRequire = createRequire(import.meta.url);

export interface SecretVault {
  set(key: string, value: string): void;
  get(key: string): string | undefined;
  delete(key: string): void;
}

export class InMemoryVault implements SecretVault {
  private m = new Map<string, string>();
  set(k: string, v: string): void { this.m.set(k, v); }
  get(k: string): string | undefined { return this.m.get(k); }
  delete(k: string): void { this.m.delete(k); }
}

/** Windows 凭据库。原生模块动态加载，单测不触碰真实凭据库（用 InMemoryVault）。 */
export class KeyringVault implements SecretVault {
  private entry(key: string) {
    const { Entry } = nativeRequire('@napi-rs/keyring') as typeof import('@napi-rs/keyring');
    return new Entry('DeskMinis', key);
  }
  set(k: string, v: string): void { this.entry(k).setPassword(v); }
  get(k: string): string | undefined {
    try { return this.entry(k).getPassword() ?? undefined; } catch { return undefined; }
  }
  delete(k: string): void { try { this.entry(k).deletePassword(); } catch { /* 不存在则忽略 */ } }
}

export interface ProviderInstance {
  id: string; name: string; kind: 'anthropic' | 'openai-compat' | 'gemini' | 'ollama';
  baseUrl?: string; modelId: string;
}

export interface ModelGroup {
  id: string; name: string; memberIds: string[]; createdAt: number;
}

interface ConfigFile { providers: ProviderInstance[]; defaultProviderId?: string; modelGroups?: ModelGroup[] }

export class ProviderStore {
  private file: string;
  private cfg: ConfigFile;

  constructor(configDir: string, private vault: SecretVault) {
    this.file = join(configDir, 'providers.json');
    this.cfg = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as ConfigFile : { providers: [] };
  }

  private save(): void {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.cfg, null, 2), 'utf8');
    renameSync(tmp, this.file); // 原子写（对齐 OpenMinis servers.json 模式）
  }

  list(): (ProviderInstance & { hasApiKey: boolean })[] {
    return this.cfg.providers.map(p => ({ ...p, hasApiKey: this.vault.get(`provider:${p.id}`) !== undefined }));
  }

  create(inst: Omit<ProviderInstance, 'id'>, apiKey?: string): ProviderInstance {
    const full: ProviderInstance = { ...inst, id: randomUUID().toUpperCase() };
    this.cfg.providers.push(full);
    if (apiKey) this.vault.set(`provider:${full.id}`, apiKey); // Ollama 可免 key
    if (!this.cfg.defaultProviderId) this.cfg.defaultProviderId = full.id;
    this.save();
    return full;
  }

  update(id: string, patch: Partial<Omit<ProviderInstance, 'id'>> & { apiKey?: string }): void {
    const p = this.cfg.providers.find(x => x.id === id);
    if (!p) throw new Error(`provider 不存在: ${id}`);
    const { apiKey, ...rest } = patch;
    Object.assign(p, rest);
    if (apiKey !== undefined) this.vault.set(`provider:${id}`, apiKey);
    this.save();
  }

  delete(id: string): void {
    this.cfg.providers = this.cfg.providers.filter(x => x.id !== id);
    if (this.cfg.defaultProviderId === id) this.cfg.defaultProviderId = this.cfg.providers[0]?.id;
    this.vault.delete(`provider:${id}`);
    this.save();
  }

  getDefaultId(): string | undefined { return this.cfg.defaultProviderId; }
  setDefaultId(id: string): void { this.cfg.defaultProviderId = id; this.save(); }

  instantiate(id: string): AgentProvider {
    const p = this.cfg.providers.find(x => x.id === id);
    if (!p) throw new Error(`provider 不存在: ${id}`);
    const apiKey = this.vault.get(`provider:${id}`);
    switch (p.kind) {
      case 'anthropic':
        if (apiKey === undefined) throw new Error(`provider 缺少密钥: ${p.name}`);
        return new AnthropicProvider({ apiKey, modelId: p.modelId, baseUrl: p.baseUrl });
      case 'gemini':
        if (apiKey === undefined) throw new Error(`provider 缺少密钥: ${p.name}`);
        return new GeminiProvider({ apiKey, modelId: p.modelId, baseUrl: p.baseUrl });
      case 'ollama':
        // 本地端点免 key；reasoning_effort 字段 Ollama 的 OpenAI 兼容端点不认识（会 400），预设不发
        return new OpenAIProvider({ apiKey: apiKey ?? '', modelId: p.modelId, baseUrl: p.baseUrl ?? 'http://localhost:11434/v1', compat: { reasoningEffort: false } });
      default: // openai-compat
        if (apiKey === undefined) throw new Error(`provider 缺少密钥: ${p.name}`);
        return new OpenAIProvider({ apiKey, modelId: p.modelId, baseUrl: p.baseUrl ?? 'https://api.openai.com/v1' });
    }
  }

  // ── ModelGroup CRUD ──

  createGroup(name: string, memberIds: string[]): ModelGroup {
    const g: ModelGroup = { id: randomUUID().toUpperCase(), name, memberIds: [...memberIds], createdAt: Date.now() / 1000 };
    if (!this.cfg.modelGroups) this.cfg.modelGroups = [];
    this.cfg.modelGroups.push(g);
    this.save();
    return g;
  }

  listGroups(): ModelGroup[] {
    return this.cfg.modelGroups ?? [];
  }

  getGroup(id: string): ModelGroup | undefined {
    return this.cfg.modelGroups?.find(g => g.id === id);
  }

  updateGroup(id: string, patch: { name?: string; memberIds?: string[] }): void {
    const g = this.cfg.modelGroups?.find(x => x.id === id);
    if (!g) throw new Error(`模型组不存在: ${id}`);
    if (typeof patch.name === 'string' && patch.name.trim()) g.name = patch.name.trim();
    if (patch.memberIds !== undefined) g.memberIds = [...patch.memberIds];
    this.save();
  }

  deleteGroup(id: string): void {
    if (!this.cfg.modelGroups) return;
    this.cfg.modelGroups = this.cfg.modelGroups.filter(g => g.id !== id);
    this.save();
  }

  /**
   * 解析模型组成员，跳过已被 delete 的 provider 实例（静默跳过，不抛错）。
   * 全部失效时返回空数组。调用方（Agent 循环降级链）据此决定是否降级。
   */
  resolveGroupMembers(groupId: string): { instance: ProviderInstance; instantiate(): AgentProvider }[] {
    const g = this.getGroup(groupId);
    if (!g) return [];
    const out: { instance: ProviderInstance; instantiate(): AgentProvider }[] = [];
    for (const mid of g.memberIds) {
      const p = this.cfg.providers.find(x => x.id === mid);
      if (!p) continue; // 已被删除，跳过
      out.push({ instance: p, instantiate: () => this.instantiate(mid) });
    }
    return out;
  }
}
