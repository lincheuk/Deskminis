import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import type { ThinkingLevel } from '../../shared/types';
import type { FetchLike } from './types';

export interface ModelCatalogEntry {
  contextWindow?: number;
  maxOutputTokens?: number;
  thinking?: boolean;
}

const API_URL = 'https://models.dev/api.json';
const BASELLM_URL = 'https://basellm.github.io/llm-metadata/api/newapi/models.json';
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * basellm 官方 vendor 映射（决策点 6 结论 B）：命中则优先取该 vendor 的值。
 * 未命中的模型名一律走「取最小值」——规则退化路径必须有测试。
 * 只对已知族写少量条目，避免维护负担（计划约束）。
 */
const OFFICIAL_VENDORS: Record<string, string[]> = {
  glm: ['Zhipu AI', 'Z.AI'],
  kimi: ['Moonshot AI'],
  minimax: ['MiniMax'],
  qwen: ['Alibaba Cloud', 'Qwen'],
  grok: ['xAI'],
};

/** 判断 model_name 是否属于某已知族（用于查 OFFICIAL_VENDORS）。 */
function knownFamily(modelName: string): string | undefined {
  const lower = modelName.toLowerCase();
  for (const fam of Object.keys(OFFICIAL_VENDORS)) {
    if (lower.startsWith(fam)) return fam;
  }
  return undefined;
}

/** basellm tags 窗口解析：取末尾尺寸 token（支持 K/M 后缀与小数）；无尺寸返回 undefined。 */
export function parseTagsWindow(tags: string): number | undefined {
  if (!tags) return undefined;
  // 匹配末尾的尺寸 token：数字 + K/M（支持小数）
  const match = tags.match(/(\d+(?:\.\d+)?)([KM])\b/i);
  if (!match) return undefined;
  const num = parseFloat(match[1]);
  const suffix = match[2].toUpperCase();
  return suffix === 'K' ? Math.round(num * 1000) : Math.round(num * 1_000_000);
}

/** basellm tags 推理标记解析：含 Reasoning（大写）视为 thinking:true。 */
export function parseTagsThinking(tags: string): boolean {
  return tags.includes('Reasoning');
}

interface BasellmEntry {
  model_name: string;
  vendor_name: string;
  tags: string;
}

/**
 * 多 vendor 同名冲突消解（决策点 6 结论 B）：官方 vendor 优先，无官方则取最小值。
 * 无窗口的条目（parseTagsWindow 返回 undefined）被跳过；全部无窗口返回 undefined。
 */
export function resolveBasellmConflict(entries: BasellmEntry[], modelName: string): ModelCatalogEntry | undefined {
  // 解析所有条目，过滤掉无窗口的
  const parsed = entries
    .map(e => ({ vendor: e.vendor_name, window: parseTagsWindow(e.tags), thinking: parseTagsThinking(e.tags) }))
    .filter(e => e.window !== undefined) as { vendor: string; window: number; thinking: boolean }[];
  if (parsed.length === 0) return undefined;
  // 官方优先
  const fam = knownFamily(modelName);
  const officialVendors = fam ? OFFICIAL_VENDORS[fam] : [];
  const official = parsed.filter(e => officialVendors.includes(e.vendor));
  const pool = official.length > 0 ? official : parsed;
  // 取最小值（官方内部也取最小，避免多官方 vendor 值不一致时超限）
  const min = pool.reduce((a, b) => a.window <= b.window ? a : b);
  return { contextWindow: min.window, thinking: min.thinking };
}

/**
 * M4.5 Task 1：构造走系统代理的 fetchImpl，**严格限定 ModelCatalog.refresh 这一个调用点**。
 *
 * 红线：禁止 setGlobalDispatcher 或任何全局改动——全局改会把中转站 ai.nodetect.com 的
 *   直连 80ms 变成走代理 466ms（实测，香港 CDN + 电信优化线路回国，tracert 有证）。
 *
 * 代理环境变量优先级（curl / Node convention）：
 *   HTTPS_PROXY > HTTP_PROXY > ALL_PROXY（大小写各查一次，POSIX 兼容）
 * NO_PROXY 尊重：含 models.dev（精确或后缀匹配）或 * 时直连。
 * 无代理环境变量时返回 undefined（用默认全局 fetch = 直连，行为不变）。
 */
export function createProxyFetch(): FetchLike | undefined {
  const proxyUri =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
  if (!proxyUri) return undefined; // 无代理 → 用默认全局 fetch（直连）
  // NO_PROXY 尊重：models.dev 命中则直连
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (noProxy) {
    const domains = noProxy.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
    if (domains.includes('*')) return undefined; // 全部直连
    // models.dev 域名匹配（精确或后缀）
    if (domains.some(d => d === 'models.dev' || 'models.dev'.endsWith(d))) return undefined;
  }
  // 仅此一处实例化 ProxyAgent，不 setGlobalDispatcher——实例仅存于闭包内
  const agent = new ProxyAgent(proxyUri);
  // undici fetch 的类型与 DOM lib 的 typeof fetch 不完全兼容（dispatcher 字段/Blob 类型差异），
  // 用类型断言对齐 FetchLike——运行时行为正确，只绕过 lib DOM 与 undici 类型定义的细节差异
  return (async (url: string, init?: Parameters<typeof fetch>[1]) =>
    undiciFetch(url as Parameters<typeof undiciFetch>[0], { ...init, dispatcher: agent } as Parameters<typeof undiciFetch>[1])) as unknown as FetchLike;
}

/** 内置兜底表：models.dev 与磁盘缓存都不可用时仍可用。按模型族前缀正则，先中先赢。 */
const BUILTIN: [RegExp, ModelCatalogEntry][] = [
  [/^claude-/i, { contextWindow: 200_000, thinking: true }],
  [/^gpt-5/i, { contextWindow: 400_000, thinking: true }],
  [/^gpt-4/i, { contextWindow: 128_000, thinking: false }],
  [/^gemini-/i, { contextWindow: 1_000_000, thinking: true }],
  [/^qwen3/i, { contextWindow: 128_000, thinking: true }],
  [/^deepseek-r1/i, { contextWindow: 128_000, thinking: true }],
  [/^deepseek-v/i, { contextWindow: 128_000, thinking: false }],
  [/^llama/i, { contextWindow: 128_000, thinking: false }],
  [/^mistral/i, { contextWindow: 128_000, thinking: false }],
  // M4.5 Task 2：国内中转站主力模型族（models.dev 全量 6043 条按族聚合的一手数据，非二手报道）。
  // contextWindow 取当代主力型号下界且不低于 128K；thinking 按该族 reasoning 占比判定。
  // 顺序约束：^qwen 必须在 ^qwen3 之后——qwen3 仍优先匹配 thinking:true（先中先赢）。
  [/^glm/i, { contextWindow: 128_000, thinking: true }],
  [/^grok/i, { contextWindow: 128_000, thinking: true }],
  [/^kimi/i, { contextWindow: 128_000, thinking: true }],
  [/^minimax/i, { contextWindow: 128_000, thinking: true }], // reasoning 占 182/202
  [/^qwen/i, { contextWindow: 128_000, thinking: false }],
];

interface CacheFile { fetchedAt: number; models: Record<string, ModelCatalogEntry>; source?: 'models.dev' | 'basellm' }

/**
 * 模型能力目录（设计 §4.1「模型能力目录」段）：
 * models.dev API 拉取 + 磁盘缓存（24h TTL）+ 内置兜底表。
 * 任何一环失败都静默回退下一环——目录永远可用，只是可能不新鲜。
 */
export class ModelCatalog {
  private models: Record<string, ModelCatalogEntry> = {};
  private fetchedAt = 0;
  private fetchImpl: FetchLike;

  constructor(private cacheFile: string, fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? fetch;
    if (existsSync(cacheFile)) {
      try {
        const c = JSON.parse(readFileSync(cacheFile, 'utf8')) as CacheFile;
        this.models = c.models ?? {};
        this.fetchedAt = c.fetchedAt ?? 0;
      } catch { /* 缓存损坏按无缓存处理 */ }
    }
  }

  /** 拉取 models.dev；TTL 内新鲜缓存直接跳过。返回是否真的拉取并成功。 */
  async refresh(force = false): Promise<boolean> {
    if (!force && Date.now() - this.fetchedAt < TTL_MS) return false;
    // 主源：models.dev（结构化数字字段，无歧义）
    if (await this.tryFetchModelsDev()) return true;
    // 备源：basellm（models.dev 失败时回退；直连可达，无代理也能成）
    if (await this.tryFetchBasellm()) return true;
    return false; // 双源皆失败 → 静默降级磁盘缓存/BUILTIN（不抛错不阻塞启动）
  }

  /** 主源拉取 models.dev。成功写缓存（source='models.dev'），失败返回 false。 */
  private async tryFetchModelsDev(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(API_URL);
      if (!res.ok) return false;
      const data = await res.json() as Record<string, { models?: Record<string, { limit?: { context?: number; output?: number }; reasoning?: boolean }> }>;
      const models: Record<string, ModelCatalogEntry> = {};
      for (const vendor of Object.values(data)) {
        for (const [id, m] of Object.entries(vendor.models ?? {})) {
          models[id] = { contextWindow: m.limit?.context, maxOutputTokens: m.limit?.output, thinking: m.reasoning === true };
        }
      }
      this.commitCache(models, 'models.dev');
      return true;
    } catch { return false; } // 离线/格式变化：静默回退备源
  }

  /** 备源拉取 basellm。成功写缓存（source='basellm'），失败返回 false。 */
  private async tryFetchBasellm(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(BASELLM_URL);
      if (!res.ok) return false;
      const data = await res.json() as { success?: boolean; data?: BasellmEntry[] };
      if (data.success !== true || !Array.isArray(data.data)) return false;
      // 按 model_name 分组，多 vendor 同名用 resolveBasellmConflict 消解
      const byName = new Map<string, BasellmEntry[]>();
      for (const e of data.data) {
        if (!e.model_name) continue;
        const arr = byName.get(e.model_name) ?? [];
        arr.push(e);
        byName.set(e.model_name, arr);
      }
      const models: Record<string, ModelCatalogEntry> = {};
      for (const [name, entries] of byName) {
        const resolved = resolveBasellmConflict(entries, name);
        if (resolved) models[name] = resolved; // 无窗口的条目不入表
      }
      this.commitCache(models, 'basellm');
      return true;
    } catch { return false; } // 静默降级 BUILTIN
  }

  /** 写入缓存并更新内存态。 */
  private commitCache(models: Record<string, ModelCatalogEntry>, source: 'models.dev' | 'basellm'): void {
    this.models = models;
    this.fetchedAt = Date.now();
    const tmp = this.cacheFile + '.tmp';
    writeFileSync(tmp, JSON.stringify({ fetchedAt: this.fetchedAt, models, source } satisfies CacheFile), 'utf8');
    renameSync(tmp, this.cacheFile); // 原子写（对齐 providers.json 模式）
  }

  private lookup(modelId: string): ModelCatalogEntry | undefined {
    const direct = this.models[modelId];
    if (direct) return direct;
    const slash = modelId.lastIndexOf('/');
    const tail = slash >= 0 ? modelId.slice(slash + 1) : modelId;
    if (this.models[tail]) return this.models[tail];
    for (const [re, entry] of BUILTIN) if (re.test(modelId) || re.test(tail)) return entry;
    return undefined;
  }

  /** M2a ContextPolicy 的窗口查询入口；未知模型返回 undefined（M2a 回退其内置映射）。 */
  getModelContextWindow(modelId: string): number | undefined {
    return this.lookup(modelId)?.contextWindow;
  }

  /** 按模型族钳制 thinking 档位：目录/内置表判定不支持推理的模型一律钳到 off（设计 §4.1）。 */
  clampThinkingLevel(modelId: string, level: ThinkingLevel): ThinkingLevel {
    if (level === 'off') return 'off';
    const info = this.lookup(modelId);
    if (!info || info.thinking !== true) return 'off';
    return level;
  }
}
