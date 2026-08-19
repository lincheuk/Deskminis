import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretVault } from './provider-store';
import type { ResolvedSearchProvider, SearchProviderKind } from '../tools/web-search';

/** vault 固定槽位：搜索密钥与模型 provider 密钥同库不同槽；清除配置时一并删除，不留悬挂密钥。 */
const VAULT_KEY = 'search-provider';

interface ConfigFile { search?: { kind: SearchProviderKind; baseUrl?: string } }

/** 对外状态（RPC get 的返回形态）：绝不含密钥本体，只有 hasKey 布尔（维持「密钥绝不回显」封装）。 */
export interface SearchProviderPublicState { kind: 'none' | SearchProviderKind; hasKey: boolean; baseUrl?: string }

/** 搜索 provider 配置存储：独立于模型 provider（单选配置而非实例列表）。
 *  密钥边界照 ProviderStore 模式：配置文件只存 kind/baseUrl，密钥只进 vault；
 *  唯一流出通道是 resolve()——仅供 minisd 内部拼请求头。 */
export class SearchProviderStore {
  private file: string;
  private cfg: ConfigFile;

  constructor(configDir: string, private vault: SecretVault) {
    this.file = join(configDir, 'search-provider.json');
    this.cfg = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as ConfigFile : {};
  }

  private save(): void {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.cfg, null, 2), 'utf8');
    renameSync(tmp, this.file); // 原子写（对齐 ProviderStore 模式）
  }

  get(): SearchProviderPublicState {
    const s = this.cfg.search;
    if (!s || (s.kind !== 'brave' && s.kind !== 'tavily' && s.kind !== 'searxng')) return { kind: 'none', hasKey: false };
    if (s.kind === 'searxng') return { kind: 'searxng', hasKey: false, baseUrl: s.baseUrl };
    return { kind: s.kind, hasKey: this.vault.get(VAULT_KEY) !== undefined };
  }

  /** kind 传空/none = 清除配置（连密钥槽位一起删）；brave/tavily 需密钥、searxng 需实例地址。
   *  同 kind 且不带新密钥 = 保留原密钥（与 provider.instances.update「留空 = 不改密钥」同一约定）；
   *  换 kind 不带新密钥一律报错——旧密钥属于另一家服务，静默复用只会换来一屏 401。 */
  set(p: { kind: string; apiKey?: string; baseUrl?: string }): void {
    const kind = String(p?.kind ?? '').trim();
    if (kind === '' || kind === 'none') {
      delete this.cfg.search;
      this.vault.delete(VAULT_KEY);
      this.save();
      return;
    }
    if (kind !== 'brave' && kind !== 'tavily' && kind !== 'searxng') throw new Error(`非法搜索 provider 类型: ${kind}`);
    const apiKey = typeof p.apiKey === 'string' ? p.apiKey.trim() : '';
    const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '';
    if (kind === 'searxng') {
      if (!baseUrl) throw new Error('SearXNG 需要实例地址');
      this.cfg.search = { kind, baseUrl };
      this.vault.delete(VAULT_KEY); // searxng 不用密钥，槽位里残留的旧密钥顺手清掉
    } else {
      if (!apiKey && this.cfg.search?.kind !== kind) throw new Error('该搜索类型需要密钥');
      if (apiKey) this.vault.set(VAULT_KEY, apiKey);
      this.cfg.search = { kind };
    }
    this.save();
  }

  /** minisd 内部消费：密钥只从这里流出、只进请求头。配置不完整（缺密钥/缺地址）返回 undefined，
   *  调用方（web_search 工具）按未配置引导，不带半截配置发请求。 */
  resolve(): ResolvedSearchProvider | undefined {
    const s = this.cfg.search;
    if (!s) return undefined;
    if (s.kind === 'searxng') return s.baseUrl ? { kind: 'searxng', baseUrl: s.baseUrl } : undefined;
    const apiKey = this.vault.get(VAULT_KEY);
    return apiKey !== undefined ? { kind: s.kind, apiKey } : undefined;
  }
}
