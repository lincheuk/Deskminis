import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AgentProvider } from '../providers/types';
import { AnthropicProvider } from '../providers/anthropic';
import { OpenAIProvider } from '../providers/openai';

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
  id: string; name: string; kind: 'anthropic' | 'openai-compat';
  baseUrl?: string; modelId: string;
}

interface ConfigFile { providers: ProviderInstance[]; defaultProviderId?: string }

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

  create(inst: Omit<ProviderInstance, 'id'>, apiKey: string): ProviderInstance {
    const full: ProviderInstance = { ...inst, id: randomUUID().toUpperCase() };
    this.cfg.providers.push(full);
    this.vault.set(`provider:${full.id}`, apiKey);
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
    if (apiKey === undefined) throw new Error(`provider 缺少密钥: ${p.name}`);
    if (p.kind === 'anthropic') return new AnthropicProvider({ apiKey, modelId: p.modelId, baseUrl: p.baseUrl });
    return new OpenAIProvider({ apiKey, modelId: p.modelId, baseUrl: p.baseUrl ?? 'https://api.openai.com/v1' });
  }
}
