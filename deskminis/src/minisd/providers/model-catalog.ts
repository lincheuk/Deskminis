import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import type { ThinkingLevel } from '../../shared/types';
import type { ModelCatalogEntry, ModelCatalogStatus, ModelMetadata, ModelMetadataSource, ModelPrice, ReasoningControl } from '../../shared/model-metadata';
import type { FetchLike } from './types';

export type { ModelCatalogEntry } from '../../shared/model-metadata';

/** 跨服务商的模态逐项资料（F01）：all = 每家都列了的，any = 至少一家列了的；没写模态的服务商不参与。
 *  整组完全一致的共识（aggregateMetadata）太严：一家多列个 pdf，图片这一项也跟着变成「没资料」。
 *  voters（F01R）：写了这组模态列表的服务商家数——「没有一家列出」背后是 1 家还是 5 家，结论的分量不同。 */
export interface MediaConsensus { all: string[]; any: string[]; voters: number }

/** 某项布尔能力的逐家表态（F01R）：明确写 true / false 的服务商家数，没写的不计。 */
export interface BoolVotes { yes: number; no: number }

/** 运行时解析（F01 resolveRuntimeModel）用的目录读取面：只读、无副作用，测试可用假对象替代。 */
export interface RuntimeCatalog {
  /** 某个 models.dev 服务商自己的记录（先按完整 id，再按 vendor/model 的末段）。 */
  getEndpointRecord(providerId: string, modelId: string): ModelCatalogEntry | undefined;
  /** 不限端点的资料：跨服务商汇总 → 备用目录 → 内置族表，按旧运行时的取值规则；汇总层另附模态的逐项资料。 */
  getDeclaredRecord(modelId: string): {
    entry: ModelCatalogEntry; tier: 'aggregate' | 'basellm' | 'builtin';
    media?: { input?: MediaConsensus; output?: MediaConsensus };
    /** 只有 models.dev 主源的汇总层才有；备用目录与内置族表没有逐家记录（F01R）。 */
    votes?: { toolCall: BoolVotes; thinking: BoolVotes };
  } | undefined;
  /** models.dev 服务商的 API 地址（provider id → api），用于把配置的 base URL 认成目录里的服务商。 */
  providerApiUrls(): Readonly<Record<string, string>>;
  getStatus(): ModelCatalogStatus;
}

// Include specialized models so image/audio/video output metadata is not omitted.
const API_URL = 'https://models.dev/api.json?type=all';
const BASELLM_URL = 'https://basellm.github.io/llm-metadata/api/newapi/models.json';
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function tokenLimit(value: unknown, allowZero = false): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0)
    ? value : undefined;
}

function modalities(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string' && v.length > 0 && v.length <= 64)) return undefined;
  return [...new Set(value as string[])].sort();
}

/** reasoning_options 归一：toggle / effort(values) / budget_tokens(min,max)。空数组 = 记录里没有可调参数（返回 {}），
 *  不是数组 = 没说明（undefined）。认不出的项跳过——宁可少认一种，也不把别的形状当成可发送的参数。 */
function reasoningControl(value: unknown): ReasoningControl | undefined {
  if (!Array.isArray(value)) return undefined;
  const control: ReasoningControl = {};
  for (const item of value) {
    const option = record(item);
    if (!option) continue;
    if (option.type === 'toggle') control.toggle = true;
    else if (option.type === 'effort') {
      const values = Array.isArray(option.values)
        ? option.values.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 32) : [];
      if (values.length > 0) control.efforts = [...new Set([...(control.efforts ?? []), ...values])];
    } else if (option.type === 'budget_tokens') {
      const min = tokenLimit(option.min, true);
      const max = tokenLimit(option.max);
      control.budget = { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
    }
  }
  return control;
}

function parseModelsDevEntry(value: unknown): ModelCatalogEntry | undefined {
  const model = record(value);
  if (!model) return undefined;
  const limit = record(model.limit);
  const media = record(model.modalities);
  const flag = (v: unknown) => typeof v === 'boolean' ? v : undefined;
  const entry: ModelCatalogEntry = {
    name: typeof model.name === 'string' ? model.name : undefined,
    contextWindow: tokenLimit(limit?.context),
    maxInputTokens: tokenLimit(limit?.input),
    maxOutputTokens: tokenLimit(limit?.output, true),
    thinking: flag(model.reasoning),
    toolCall: flag(model.tool_call),
    structuredOutput: flag(model.structured_output),
    inputModalities: modalities(media?.input),
    outputModalities: modalities(media?.output),
    reasoningControl: reasoningControl(model.reasoning_options),
  };
  // 先按规格字段判定条目是否为空，再解析价格（F02）：只有 cost 而别的字段全空的条目照旧丢弃——它不成其为一条模型记录
  if (!Object.values(entry).some(v => v !== undefined)) return undefined;
  const price = modelPrice(model.cost);
  if (price) entry.price = price;
  return entry;
}

/** models.dev cost 归一（F02）：每百万 token 的美元价。input 与 output 都是有限非负数才算有价格；缓存读写价与推理价同样校验后可选带上。
 *  cost.tiers 是非空数组或带 context_over_200k 对象：这个型号按上下文长度分档计价，标 tiered——按单一价格估算会出错，费用一律显示未知。
 *  价格只留在服务商自己的记录上：跨服务商汇总只带列出的字段，不含它（中转不能借用同名模型在别家的价格）。 */
function modelPrice(value: unknown): ModelPrice | undefined {
  const cost = record(value);
  if (!cost) return undefined;
  const usd = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
  const input = usd(cost.input); const output = usd(cost.output);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = usd(cost.cache_read); const cacheWrite = usd(cost.cache_write); const reasoning = usd(cost.reasoning);
  const tiered = (Array.isArray(cost.tiers) && cost.tiers.length > 0) || record(cost.context_over_200k) !== undefined;
  return {
    input, output,
    ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}), ...(tiered ? { tiered: true as const } : {}),
  };
}

/** 对外交出的条目一律深拷贝：调用方改数组 / 推理控制不能回写进目录内存与缓存。 */
function copyEntry(entry: ModelCatalogEntry): ModelCatalogEntry {
  const control = entry.reasoningControl;
  return {
    ...entry,
    inputModalities: entry.inputModalities?.slice(),
    outputModalities: entry.outputModalities?.slice(),
    ...(control ? { reasoningControl: { ...control, efforts: control.efforts?.slice(), budget: control.budget && { ...control.budget } } } : {}),
    ...(entry.price ? { price: { ...entry.price } } : {}),
  };
}

/** 服务商 API 地址只收 http(s) URL：之后拿它与配置的 base URL 做前缀比对。 */
function apiUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 512) return undefined;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? value : undefined;
  } catch { return undefined; }
}

/** When the endpoint is unknown, do not invent support by OR-ing vendor capabilities. */
function aggregateMetadata(entries: ModelCatalogEntry[]): ModelCatalogEntry {
  const result = resolveModelsDevConflict(entries);
  const consensus = <K extends keyof ModelCatalogEntry>(key: K): ModelCatalogEntry[K] => {
    const first = entries[0]?.[key];
    return first !== undefined && entries.every(e => JSON.stringify(e[key]) === JSON.stringify(first)) ? first : undefined;
  };
  result.name = consensus('name');
  result.maxInputTokens = consensus('maxInputTokens');
  result.toolCall = consensus('toolCall');
  result.structuredOutput = consensus('structuredOutput');
  result.inputModalities = consensus('inputModalities');
  result.outputModalities = consensus('outputModalities');
  if (entries.every(e => e.thinking === undefined)) delete result.thinking;
  return result;
}

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
 * M4.5 Task 1：目录在 CLI/单测中的代理环境变量出口；Electron 引擎由 outbound-fetch 走系统代理。
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
    // models.dev 域名匹配：精确或「点号前缀的域后缀」（M4.6 Task 4 收紧——裸 `dev`/`v` 不再误命中）
    if (domains.some(d => d === 'models.dev' || (d.startsWith('.') && 'models.dev'.endsWith(d)))) return undefined;
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
  [/^claude-/i, { contextWindow: 200_000, maxOutputTokens: 64_000, thinking: true }],
  [/^gpt-5/i, { contextWindow: 400_000, maxOutputTokens: 16_384, thinking: true }],
  [/^gpt-4/i, { contextWindow: 128_000, maxOutputTokens: 16_384, thinking: false }],
  [/^gemini-/i, { contextWindow: 1_000_000, maxOutputTokens: 8_192, thinking: true }],
  [/^qwen3/i, { contextWindow: 128_000, maxOutputTokens: 8_192, thinking: true }],
  [/^deepseek-r1/i, { contextWindow: 128_000, maxOutputTokens: 8_192, thinking: true }],
  [/^deepseek-v/i, { contextWindow: 128_000, maxOutputTokens: 8_192, thinking: false }],
  [/^llama/i, { contextWindow: 128_000, maxOutputTokens: 8_192, thinking: false }],
  [/^mistral/i, { contextWindow: 128_000, maxOutputTokens: 8_192, thinking: false }],
  // M4.5 Task 2：国内中转站主力模型族（models.dev 全量 6043 条按族聚合的一手数据，非二手报道）。
  // contextWindow 取当代主力型号下界且不低于 128K；thinking 按该族 reasoning 占比判定。
  // 顺序约束：^qwen 必须在 ^qwen3 之后——qwen3 仍优先匹配 thinking:true（先中先赢）。
  // maxOutputTokens 取保守下界：只作离线兜底，在线时被 models.dev 佐证值覆盖；
  // 宁低勿高——偏高会让 openai-compat 端点对超大 max_tokens 直接 400（与 chat.prompt 8192 兜底同理）。
  [/^glm/i, { contextWindow: 128_000, maxOutputTokens: 8_192, thinking: true }],
  [/^grok/i, { contextWindow: 128_000, maxOutputTokens: 8_192, thinking: true }],
  [/^kimi/i, { contextWindow: 128_000, maxOutputTokens: 8_192, thinking: true }],
  [/^minimax/i, { contextWindow: 128_000, maxOutputTokens: 8_192, thinking: true }], // reasoning 占 182/202
  [/^qwen/i, { contextWindow: 128_000, maxOutputTokens: 8_192, thinking: false }],
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
 * 规则再变时 +1。3 加入服务商记录与模态元数据，重新获取旧的数字缓存。
 */
export const MERGE_RULE_VERSION = 3;

interface CacheFile {
  fetchedAt: number;
  models: Record<string, ModelCatalogEntry>;
  providers?: Record<string, Record<string, ModelCatalogEntry>>;
  /** F01：models.dev 服务商的 API 地址。可选字段、不升合并规则版本——没有它的旧缓存照常可用，
   *  只是在下一次成功刷新之前只认内置的官方端点（升版本会让离线用户丢掉整份缓存，代价更大）。 */
  providerApis?: Record<string, string>;
  source?: 'models.dev' | 'basellm';
  mergeRule?: number;
}

/**
 * 模型能力目录（设计 §4.1「模型能力目录」段）：
 * models.dev API 拉取 + 磁盘缓存（24h TTL）+ 内置兜底表。
 * 任何一环失败都静默回退下一环——目录永远可用，只是可能不新鲜。
 */
export class ModelCatalog implements RuntimeCatalog {
  private models: Record<string, ModelCatalogEntry> = {};
  private fetchedAt = 0;
  private fetchImpl: FetchLike;
  private source: ModelMetadataSource = 'unknown';
  private providerModels: Record<string, Record<string, ModelCatalogEntry>> = {};
  private providerApis: Record<string, string> = {};
  private refreshInFlight?: Promise<boolean>;
  /** M4.5 Task 3：手动 contextWindow 覆盖表（modelId → 窗口值）。查询优先级最高。 */
  private manualOverrides: Map<string, number> = new Map();
  /** maxOutput 手动覆盖表：与 manualOverrides 独立——窗口值≠输出上限，
   *  复用了会把「手动 128K 窗口」误当「128K 输出」发给端点（超大 max_tokens 部分端点 400）。 */
  private maxOutputOverrides: Map<string, number> = new Map();

  constructor(private cacheFile: string, fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? fetch;
    if (existsSync(cacheFile)) {
      try {
        const c = JSON.parse(readFileSync(cacheFile, 'utf8')) as CacheFile;
        // 规则版本不符 = 缓存是按旧合并规则算出来的，值不可信，按无缓存处理（下次 refresh 会重拉）
        if (c.mergeRule === MERGE_RULE_VERSION) {
          this.models = c.models ?? {};
          this.providerModels = c.providers ?? {};
          this.providerApis = Object.fromEntries(Object.entries(record(c.providerApis) ?? {})
            .flatMap(([id, url]) => { const api = apiUrl(url); return api ? [[id, api]] : []; }));
          this.source = c.source ?? 'unknown';
          this.fetchedAt = typeof c.fetchedAt === 'number' && Number.isFinite(c.fetchedAt) ? c.fetchedAt : 0;
        }
      } catch { /* 缓存损坏按无缓存处理 */ }
    }
  }

  /** 拉取 models.dev；TTL 内新鲜缓存直接跳过。返回是否真的拉取并成功。 */
  async refresh(force = false): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;
    if (!force && Date.now() - this.fetchedAt < TTL_MS) return false;
    this.refreshInFlight = this.refreshSources().finally(() => { this.refreshInFlight = undefined; });
    return this.refreshInFlight;
  }

  private async refreshSources(): Promise<boolean> {
    // 主源：models.dev（结构化数字字段，无歧义）
    if (await this.tryFetchModelsDev()) return true;
    // An outage must not replace rich primary metadata with a less complete backup.
    if (this.source === 'models.dev' && Object.keys(this.models).length > 0) return false;
    // 备源：basellm（models.dev 失败时回退；直连可达，无代理也能成）
    if (await this.tryFetchBasellm()) return true;
    return false; // 双源皆失败 → 静默降级磁盘缓存/BUILTIN（不抛错不阻塞启动）
  }

  /** 主源拉取 models.dev。成功写缓存（source='models.dev'），失败返回 false。 */
  private async tryFetchModelsDev(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(API_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return false;
      const data = record(await res.json());
      if (!data) return false;
      // M4.6 Task 1：先收集同一 id 的全部 vendor 条目，再按佐证规则一次性消解。
      // 折叠式 `models[id] = merge(...)` 拿不到全局 vendor 计数，无法做 ≥2 佐证。
      const byId = new Map<string, ModelCatalogEntry[]>();
      const providerModels: Record<string, Record<string, ModelCatalogEntry>> = Object.create(null);
      const providerApis: Record<string, string> = Object.create(null);
      for (const [providerId, value] of Object.entries(data)) {
        const vendor = record(value);
        const vendorModels = record(vendor?.models);
        if (!vendorModels) continue;
        const api = apiUrl(vendor?.api);
        if (api) providerApis[providerId] = api;
        const parsed: Record<string, ModelCatalogEntry> = Object.create(null);
        for (const [id, m] of Object.entries(vendorModels)) {
          const entry = parseModelsDevEntry(m);
          if (!entry) continue;
          parsed[id] = entry;
          const arr = byId.get(id) ?? [];
          arr.push(entry);
          byId.set(id, arr);
        }
        if (Object.keys(parsed).length > 0) providerModels[providerId] = parsed;
      }
      if (byId.size === 0) return false;
      const models: Record<string, ModelCatalogEntry> = Object.create(null);
      for (const [id, entries] of byId) models[id] = aggregateMetadata(entries);
      this.commitCache(models, 'models.dev', providerModels, providerApis);
      return true;
    } catch { return false; } // 离线/格式变化：静默回退备源
  }

  /** 备源拉取 basellm。成功写缓存（source='basellm'），失败返回 false。 */
  private async tryFetchBasellm(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(BASELLM_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
      if (Object.keys(models).length === 0) return false;
      this.commitCache(models, 'basellm');
      return true;
    } catch { return false; } // 静默降级 BUILTIN
  }

  /** 写入缓存并更新内存态。 */
  private commitCache(
    models: Record<string, ModelCatalogEntry>, source: 'models.dev' | 'basellm',
    providers: Record<string, Record<string, ModelCatalogEntry>> = {}, providerApis: Record<string, string> = {},
  ): void {
    const fetchedAt = Date.now();
    const tmp = this.cacheFile + '.tmp';
    writeFileSync(tmp, JSON.stringify({ fetchedAt, models, providers, providerApis, source, mergeRule: MERGE_RULE_VERSION } satisfies CacheFile), 'utf8');
    renameSync(tmp, this.cacheFile); // 原子写（对齐 providers.json 模式）
    this.models = models;
    this.providerModels = providers;
    this.providerApis = providerApis;
    this.source = source;
    this.fetchedAt = fetchedAt;
  }

  getStatus(): ModelCatalogStatus {
    return {
      primarySource: 'models.dev', apiUrl: API_URL,
      source: this.source === 'unknown' ? 'builtin' : this.source,
      fetchedAt: this.fetchedAt || undefined,
      stale: !this.fetchedAt || Date.now() - this.fetchedAt >= TTL_MS,
      modelCount: Object.keys(this.models).length,
    };
  }

  /** Specs only; a provider ID selects its own record without borrowing another vendor's capabilities. */
  getModelMetadata(modelId: string, providerId?: string): ModelMetadata {
    const slash = modelId.indexOf('/');
    const prefix = slash >= 0 ? modelId.slice(0, slash) : undefined;
    const vendorId = providerId ?? (prefix && Object.hasOwn(this.providerModels, prefix) ? prefix : undefined);
    const tail = modelId.slice(modelId.lastIndexOf('/') + 1);
    const copy = copyEntry;
    if (vendorId) {
      const vendor = Object.hasOwn(this.providerModels, vendorId) ? this.providerModels[vendorId] : undefined;
      const entry = vendor && (Object.hasOwn(vendor, modelId) ? vendor[modelId] : Object.hasOwn(vendor, tail) ? vendor[tail] : undefined);
      return entry
        ? { ...copy(entry), source: 'models.dev', fetchedAt: this.fetchedAt, providerId: vendorId, match: 'provider' }
        : { source: 'unknown', providerId: vendorId, match: 'unknown' };
    }
    const entry = Object.hasOwn(this.models, modelId) ? this.models[modelId] : Object.hasOwn(this.models, tail) ? this.models[tail] : undefined;
    if (entry) {
      const result = copy(entry);
      if (this.source === 'models.dev') {
        const id = Object.hasOwn(this.models, modelId) ? modelId : tail;
        const entries = Object.values(this.providerModels).filter(v => Object.hasOwn(v, id)).map(v => v[id]);
        const first = entries[0]?.thinking;
        // Keep legacy runtime reasoning aggregation, but display disputes as unknown.
        result.thinking = first !== undefined && entries.every(e => e.thinking === first) ? first : undefined;
      }
      return { ...result, source: this.source, fetchedAt: this.fetchedAt, match: 'aggregate' };
    }
    const builtin = this.lookup(modelId);
    return builtin ? { ...copy(builtin), source: 'builtin', match: 'builtin' } : { source: 'unknown', match: 'unknown' };
  }

  private lookup(modelId: string): ModelCatalogEntry | undefined {
    return this.lookupTier(modelId)?.entry;
  }

  /** lookup 的分层版：同一取值顺序（缓存完整 id → 末段 → 内置族表），顺带说明命中的是哪一层、哪个键。 */
  private lookupTier(modelId: string): { entry: ModelCatalogEntry; tier: 'aggregate' | 'basellm' | 'builtin'; key?: string } | undefined {
    const tier = this.source === 'basellm' ? 'basellm' as const : 'aggregate' as const;
    if (Object.hasOwn(this.models, modelId)) return { entry: this.models[modelId], tier, key: modelId };
    const slash = modelId.lastIndexOf('/');
    const tail = slash >= 0 ? modelId.slice(slash + 1) : modelId;
    if (Object.hasOwn(this.models, tail)) return { entry: this.models[tail], tier, key: tail };
    for (const [re, entry] of BUILTIN) if (re.test(modelId) || re.test(tail)) return { entry, tier: 'builtin' };
    return undefined;
  }

  /** 某个模型在各服务商记录里的模态逐项资料（只有 models.dev 主源才有逐家记录）。 */
  private mediaConsensus(key: string, field: 'inputModalities' | 'outputModalities'): MediaConsensus | undefined {
    const lists = Object.values(this.providerModels)
      .flatMap(vendor => Object.hasOwn(vendor, key) && Array.isArray(vendor[key][field]) ? [vendor[key][field]!] : []);
    if (lists.length === 0) return undefined;
    const any = [...new Set(lists.flat())].sort();
    return { all: any.filter(m => lists.every(l => l.includes(m))), any, voters: lists.length };
  }

  /** 某个模型的一项布尔能力在各服务商记录里的表态家数（F01R）。查询时从内存里的逐家记录现算，不进缓存文件：
   *  离线重启后从缓存恢复的 providerModels 同样算得出，结论与在线时一致。 */
  private boolVotes(key: string, field: 'toolCall' | 'thinking'): BoolVotes {
    const votes: BoolVotes = { yes: 0, no: 0 };
    for (const vendor of Object.values(this.providerModels)) {
      if (!Object.hasOwn(vendor, key)) continue;
      const v = vendor[key][field];
      if (v === true) votes.yes++; else if (v === false) votes.no++;
    }
    return votes;
  }

  getEndpointRecord(providerId: string, modelId: string): ModelCatalogEntry | undefined {
    const vendor = Object.hasOwn(this.providerModels, providerId) ? this.providerModels[providerId] : undefined;
    if (!vendor) return undefined;
    const tail = modelId.slice(modelId.lastIndexOf('/') + 1);
    const entry = Object.hasOwn(vendor, modelId) ? vendor[modelId] : Object.hasOwn(vendor, tail) ? vendor[tail] : undefined;
    return entry ? copyEntry(entry) : undefined;
  }

  /** 跨服务商汇总的推理位沿用旧运行时规则（任一服务商声明即为 true）：它只作「目录提示」，
   *  中转端点据此仍是「未确认」，见 runtime-model.ts。 */
  getDeclaredRecord(modelId: string): ReturnType<RuntimeCatalog['getDeclaredRecord']> {
    const hit = this.lookupTier(modelId);
    if (!hit) return undefined;
    if (hit.tier !== 'aggregate' || !hit.key || this.source !== 'models.dev') return { entry: copyEntry(hit.entry), tier: hit.tier };
    const input = this.mediaConsensus(hit.key, 'inputModalities');
    const output = this.mediaConsensus(hit.key, 'outputModalities');
    return {
      entry: copyEntry(hit.entry), tier: hit.tier, media: { ...(input ? { input } : {}), ...(output ? { output } : {}) },
      votes: { toolCall: this.boolVotes(hit.key, 'toolCall'), thinking: this.boolVotes(hit.key, 'thinking') },
    };
  }

  providerApiUrls(): Readonly<Record<string, string>> {
    return { ...this.providerApis };
  }

  // ── 以下四个按 modelId 的旧接口只为既有测试与外部脚本保留：运行时（chat.prompt / Agent 循环 / 水位条 / 诊断）
  //    一律走 resolveRuntimeModel，按配置实例解析；手动覆盖不再按 modelId 全局生效（F01）。 ──

  /** @deprecated 运行时用 resolveRuntimeModel。M4.5 Task 3：设置手动 contextWindow 覆盖（modelId → 窗口值；undefined 清除覆盖）。 */
  setManualOverride(modelId: string, window: number | undefined): void {
    if (window === undefined) this.manualOverrides.delete(modelId);
    else this.manualOverrides.set(modelId, window);
  }

  /** @deprecated 运行时用 resolveRuntimeModel。设置手动 maxOutput 覆盖（modelId → 输出上限；undefined 清除覆盖）。 */
  setMaxOutputOverride(modelId: string, output: number | undefined): void {
    if (output === undefined) this.maxOutputOverrides.delete(modelId);
    else this.maxOutputOverrides.set(modelId, output);
  }

  /** @deprecated 运行时用 resolveRuntimeModel。M2a ContextPolicy 的窗口查询入口；未知模型返回 undefined（M2a 回退其内置映射）。
   *  M4.5 Task 3：优先级为「手动值 > models.dev 缓存/BUILTIN（lookup）> undefined」。 */
  getModelContextWindow(modelId: string): number | undefined {
    const manual = this.manualOverrides.get(modelId);
    if (manual !== undefined) return manual;
    return this.lookup(modelId)?.contextWindow;
  }

  /** @deprecated 运行时用 resolveRuntimeModel。
   *  模型输出上限查询：优先级「手动 maxOutput 覆盖 > models.dev 缓存/BUILTIN（lookup）> undefined」。
   *  走与 getModelContextWindow 相同的三级结构；手动表独立（见 maxOutputOverrides 注释）。
   *  chat.prompt 拿不到值（undefined）时兜底 8192。 */
  getModelMaxOutput(modelId: string): number | undefined {
    const manual = this.maxOutputOverrides.get(modelId);
    if (manual !== undefined) return manual;
    return this.lookup(modelId)?.maxOutputTokens;
  }

  /** @deprecated 运行时用 resolveRuntimeModel + decideThinking（按每个槽位钳制）。
   *  按模型族钳制 thinking 档位：目录/内置表判定不支持推理的模型一律钳到 off（设计 §4.1）。
   *  M4.5 Task 3 决策点 3：不查 manualOverrides——手动值只有窗口没有 thinking 标记，thinking 仍走 lookup。 */
  clampThinkingLevel(modelId: string, level: ThinkingLevel): ThinkingLevel {
    if (level === 'off') return 'off';
    const info = this.lookup(modelId);
    if (!info || info.thinking !== true) return 'off';
    return level;
  }
}
