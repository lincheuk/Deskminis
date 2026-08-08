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
 * 多 vendor 同名冲突消解（决策点 6 结论 B）：窗口官方 vendor 优先、无官方则取最小值。
 * 无窗口的条目（parseTagsWindow 返回 undefined）被跳过；全部无窗口返回 undefined。
 *
 * thinking 与主源同规则取「任一为真」，而不是取自窗口最小的那一条。
 * 原实现按后者，实测会让 88 个模型丢掉推理能力——例如 gemini-2.5-flash 在 15 家 vendor 中
 * 有 14 家报 Reasoning，但窗口最小的 302.AI 没报，thinking 就被判成 false，
 * 正是 M4.5 立项要修的那个 bug 换个入口复发。能力是模型的属性，不是某个 vendor 的属性。
 *
 * M4.6 Task 1 决策点 2：此处**不加**「≥2 家佐证」条件（对比主源 resolveModelsDevConflict）。
 * 理由：a) 官方 vendor 命中时本函数已有主导权（取官方值），加佐证大概率结果不变，收益≈零；
 * b) basellm 仅当 models.dev 失败时作备源（罕见路径），任何行为变化都引入回归面；
 * c) 官方优先路径依赖单个官方 vendor，与「≥2 佐证」概念不天然契合。
 */
export function resolveBasellmConflict(entries: BasellmEntry[], modelName: string): ModelCatalogEntry | undefined {
  // 解析所有条目，过滤掉无窗口的
  const parsed = entries
    .map(e => ({ vendor: e.vendor_name, window: parseTagsWindow(e.tags), thinking: parseTagsThinking(e.tags) }))
    .filter(e => e.window !== undefined) as { vendor: string; window: number; thinking: boolean }[];
  if (parsed.length === 0) return undefined;
  // 窗口：官方优先
  const fam = knownFamily(modelName);
  const officialVendors = fam ? OFFICIAL_VENDORS[fam] : [];
  const official = parsed.filter(e => officialVendors.includes(e.vendor));
  const pool = official.length > 0 ? official : parsed;
  // 取最小值（官方内部也取最小，避免多官方 vendor 值不一致时超限）
  const min = pool.reduce((a, b) => a.window <= b.window ? a : b);
  // 能力位：跨全部条目取或，不受「窗口最小那条是否漏标」影响
  return { contextWindow: min.window, thinking: parsed.some(e => e.thinking) };
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

/**
 * models.dev 多 vendor 同名冲突消解。实测依据：全量 6043 条中 929 个 id 跨 provider 重复，
 * 其中 434 个 contextWindow 不一致（分歧最大 15.6 倍）、189 个 reasoning 不一致。
 *
 * 规则按字段分开定，依据是「错的方向」而不是「错的次数」：
 *   - contextWindow / maxOutputTokens 取「被 ≥2 家 vendor 佐证过的值中的最小者」；
 *     全部值都只有一家报时退化为纯最小。低估只是压缩提前触发（功能正常，且用户可用
 *     providers.json 的手动 contextWindow 兜底）；高估会把水位阈值算在并不存在的空间上，
 *     模型到真实上限就直接拒绝请求——是查不出原因的硬失败。
 *     佐证条件（M4.6 Task 1 / A6）防「单离群 vendor 拖垮」：glm-5.1 有 18 家 vendor，
 *     8 家报 200000（含官方 zhipuai/zai），仅 digitalocean 一家报 163840——纯最小取到
 *     163840（比官方低 18%）。计数单位 = 不同 provider 数（同一 provider 内同一 id 只出现一次）。
 *   - thinking 取「任一为真」。这是能力位，误判为 false 会把 thinking 档位永久钳到 off
 *     （正是 M4.5 立项要修的那个 bug）；实测报 false 的都是 16:1 这类极少数离群 vendor。
 *
 * 「官方 vendor 优先」的备选方案已被数据否掉：deepseek-chat 的 1000000 恰恰来自官方 provider
 * `deepseek` 自己（真实 128K），官方源同样会报错值，且该方案需要长期维护映射表。
 *
 * 合并结果与 vendor 迭代顺序无关——计数统计天然顺序无关，models.dev 重排 vendor 时值不变。
 */
export function resolveModelsDevConflict(entries: ModelCatalogEntry[]): ModelCatalogEntry {
  const windows = new Map<number, number>();
  const outputs = new Map<number, number>();
  let thinking = false;
  for (const e of entries) {
    if (e.thinking === true) thinking = true;
    if (e.contextWindow !== undefined) windows.set(e.contextWindow, (windows.get(e.contextWindow) ?? 0) + 1);
    if (e.maxOutputTokens !== undefined) outputs.set(e.maxOutputTokens, (outputs.get(e.maxOutputTokens) ?? 0) + 1);
  }
  /** 佐证最小：≥2 家佐证的值取最小；全单例退化为纯最小。 */
  const corroboratedMin = (counts: Map<number, number>): number | undefined => {
    const corroborated = [...counts.entries()].filter(([, c]) => c >= 2).map(([v]) => v);
    if (corroborated.length > 0) return Math.min(...corroborated);
    return counts.size > 0 ? Math.min(...counts.keys()) : undefined;
  };
  return {
    contextWindow: corroboratedMin(windows),
    maxOutputTokens: corroboratedMin(outputs),
    thinking,
  };
}

/**
 * 合并规则版本。缓存里存的是「按当时规则算好的结果」而非原始响应，规则一变旧缓存就是错的。
 * 不作废的话，升级后最长要等满 24h TTL 修复才生效（期间窗口仍是高估值、被丢的推理位仍是关的）。
 * 规则再变时 +1。M4.6 Task 1：1 → 2（佐证规则引入，旧纯最小缓存作废）。
 */
export const MERGE_RULE_VERSION = 2;

interface CacheFile {
  fetchedAt: number;
  models: Record<string, ModelCatalogEntry>;
  source?: 'models.dev' | 'basellm';
  mergeRule?: number;
}

/**
 * 模型能力目录（设计 §4.1「模型能力目录」段）：
 * models.dev API 拉取 + 磁盘缓存（24h TTL）+ 内置兜底表。
 * 任何一环失败都静默回退下一环——目录永远可用，只是可能不新鲜。
 */
export class ModelCatalog {
  private models: Record<string, ModelCatalogEntry> = {};
  private fetchedAt = 0;
  private fetchImpl: FetchLike;
  /** M4.5 Task 3：手动 contextWindow 覆盖表（modelId → 窗口值）。查询优先级最高。 */
  private manualOverrides: Map<string, number> = new Map();

  constructor(private cacheFile: string, fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? fetch;
    if (existsSync(cacheFile)) {
      try {
        const c = JSON.parse(readFileSync(cacheFile, 'utf8')) as CacheFile;
        // 规则版本不符 = 缓存是按旧合并规则算出来的，值不可信，按无缓存处理（下次 refresh 会重拉）
        if (c.mergeRule === MERGE_RULE_VERSION) {
          this.models = c.models ?? {};
          this.fetchedAt = c.fetchedAt ?? 0;
        }
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
      // M4.6 Task 1：先收集同一 id 的全部 vendor 条目，再按佐证规则一次性消解。
      // 折叠式 `models[id] = merge(...)` 拿不到全局 vendor 计数，无法做 ≥2 佐证。
      const byId = new Map<string, ModelCatalogEntry[]>();
      for (const vendor of Object.values(data)) {
        for (const [id, m] of Object.entries(vendor.models ?? {})) {
          const entry: ModelCatalogEntry = {
            contextWindow: m.limit?.context,
            maxOutputTokens: m.limit?.output,
            thinking: m.reasoning === true,
          };
          const arr = byId.get(id) ?? [];
          arr.push(entry);
          byId.set(id, arr);
        }
      }
      const models: Record<string, ModelCatalogEntry> = {};
      for (const [id, entries] of byId) models[id] = resolveModelsDevConflict(entries);
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
    writeFileSync(tmp, JSON.stringify({ fetchedAt: this.fetchedAt, models, source, mergeRule: MERGE_RULE_VERSION } satisfies CacheFile), 'utf8');
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

  /** M4.5 Task 3：设置手动 contextWindow 覆盖（modelId → 窗口值；undefined 清除覆盖）。 */
  setManualOverride(modelId: string, window: number | undefined): void {
    if (window === undefined) this.manualOverrides.delete(modelId);
    else this.manualOverrides.set(modelId, window);
  }

  /** M2a ContextPolicy 的窗口查询入口；未知模型返回 undefined（M2a 回退其内置映射）。
   *  M4.5 Task 3：优先级为「手动值 > models.dev 缓存/BUILTIN（lookup）> undefined」。 */
  getModelContextWindow(modelId: string): number | undefined {
    const manual = this.manualOverrides.get(modelId);
    if (manual !== undefined) return manual;
    return this.lookup(modelId)?.contextWindow;
  }

  /** 按模型族钳制 thinking 档位：目录/内置表判定不支持推理的模型一律钳到 off（设计 §4.1）。
   *  M4.5 Task 3 决策点 3：不查 manualOverrides——手动值只有窗口没有 thinking 标记，thinking 仍走 lookup。 */
  clampThinkingLevel(modelId: string, level: ThinkingLevel): ThinkingLevel {
    if (level === 'off') return 'off';
    const info = this.lookup(modelId);
    if (!info || info.thinking !== true) return 'off';
    return level;
  }
}
