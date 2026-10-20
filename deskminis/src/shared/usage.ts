/**
 * F02 Usage 契约：一次模型请求的用量、来源、发送前的估计与费用状态（minisd 的 adapter / 循环写，渲染端、同步与后续任务读）。
 *
 * 口径（三家 adapter 按各自官方定义归一化到这里，见 minisd/providers/usage.ts）：
 *  - inputTokens 是模型处理的全部输入，已含缓存读取与缓存写入；outputTokens 是全部输出，已含推理；
 *  - cacheReadTokens / cacheWriteTokens / reasoningTokens 是上面两个总数的「其中」项，任何地方都不得再往总数上加；
 *  - 键不存在 = 服务商没报，不是 0。应用从不把估算写进这五个数：估算在 estimate，费用在 cost。
 * 旧记录（F02 之前落库的 {"inputTokens":N,"outputTokens":M}）原样可读：没有 v 即旧口径，不回填、不换算、不估费用。
 */
import type { ModelPrice } from './model-metadata';
import type { RequestProtocol } from './runtime-model';

export type UsageDim = 'input' | 'output';

/** 用量数字的来源。by 恒为 'provider'：两个总数与三个子维度只写服务商在响应里报告的值。
 *  protocol + modelId 是分词口径（校准只在同口径之间做）；instanceId 用来区分同名模型的不同接入。不含端点地址与密钥。 */
export interface UsageSource {
  by: 'provider';
  /** 归一化用的 adapter；没有 runtime 的旧调用方不带。 */
  protocol?: RequestProtocol;
  modelId: string;
  /** 配置实例 id（RuntimeModel.instanceId），有才带。 */
  instanceId?: string;
}

/** 发出这次请求前的输入估计（循环写入）。误差 = inputTokens − input。 */
export interface UsageEstimate {
  /** 未校准的文本估计：系统提示 + 工具 + 消息 + 回放推理。 */
  text: number;
  /** 图片估计。 */
  media: number;
  /** 发送时采用的总估计（RequestBudget.input.tokens）。 */
  input: number;
}

export type CostUnknownReason = 'no-usage' | 'no-price' | 'zero-price' | 'tiered' | 'legacy' | 'unreported' | 'cache-price' | 'reasoning-price';
/** 费用只有两种状态：按目录价格估算出的美元数，或未知（带原因）。没有「0 元」这种状态——价格未知不等于免费。 */
export type CostEstimate = { status: 'estimated'; usd: number } | { status: 'unknown'; reason: CostUnknownReason };

/** 一次模型请求的用量（messages.token_usage 列存的就是它的 JSON；adapter 的 usage 事件也用它）。 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** ⊆ inputTokens */
  cacheReadTokens?: number;
  /** ⊆ inputTokens */
  cacheWriteTokens?: number;
  /** ⊆ outputTokens */
  reasoningTokens?: number;
  /** 服务商没报的总数：对应字段写 0（旧读者照旧能读），新读者据此显示「未报告」。为空时不带这个键。
   *  两个总数都没报时 adapter 不发 usage 事件，循环不落 tokenUsage。 */
  unreported?: UsageDim[];
  /** 2 = F02 的归一化口径，只由循环在落库时写。缺省 = 旧记录：Anthropic 的 inputTokens 不含缓存读写，
   *  Gemini 的 outputTokens 不含推理，OpenAI 兼容端点没报 usage 时是 0/0。 */
  v?: 2;
  /** 循环落库时无条件写，取消路径也写。adapter 的 usage 事件不带。 */
  source?: UsageSource;
  /** 发出这次请求前的输入估计（循环写入；取消路径不带）。 */
  estimate?: UsageEstimate;
  /** 落库时按当次槽位的端点价格算出的费用状态（循环写入；取消路径不带）。 */
  cost?: CostEstimate;
}

/** 分词口径 `${protocol}:${modelId}`，同口径才用来校准；source 没有 protocol 时返回 undefined。 */
export function usageKeyOf(source: UsageSource | undefined): string | undefined {
  return source && source.protocol ? `${source.protocol}:${source.modelId}` : undefined;
}

export interface UsageView {
  input: number; output: number;
  /** = input + output，子维度不再相加。 */
  total: number;
  cacheRead?: number; cacheWrite?: number; reasoning?: number;
  unreported: UsageDim[];
  /** 没有 v: 2。 */
  legacy: boolean;
  source?: UsageSource;
  estimate?: UsageEstimate;
  /** 旧记录 → unknown/legacy；没有 cost 字段的新记录 → unknown/no-price。 */
  cost: CostEstimate;
}

const count = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const UNKNOWN_REASONS: readonly CostUnknownReason[] = ['no-usage', 'no-price', 'zero-price', 'tiered', 'legacy', 'unreported', 'cache-price', 'reasoning-price'];

function readCost(raw: unknown): CostEstimate | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.status === 'estimated') { const usd = count(raw.usd); return usd !== undefined ? { status: 'estimated', usd } : undefined; }
  if (raw.status === 'unknown' && (UNKNOWN_REASONS as readonly unknown[]).includes(raw.reason)) return { status: 'unknown', reason: raw.reason as CostUnknownReason };
  return undefined;
}
function readSource(raw: unknown): UsageSource | undefined {
  if (!isRecord(raw) || raw.by !== 'provider' || typeof raw.modelId !== 'string') return undefined;
  const protocol = raw.protocol === 'anthropic' || raw.protocol === 'openai-chat' || raw.protocol === 'gemini' ? raw.protocol : undefined;
  return { by: 'provider', ...(protocol ? { protocol } : {}), modelId: raw.modelId, ...(typeof raw.instanceId === 'string' ? { instanceId: raw.instanceId } : {}) };
}
function readEstimate(raw: unknown): UsageEstimate | undefined {
  if (!isRecord(raw)) return undefined;
  const text = count(raw.text); const media = count(raw.media); const input = count(raw.input);
  return text !== undefined && media !== undefined && input !== undefined ? { text, media, input } : undefined;
}

/**
 * 容错读取（界面与校准共用）：两个总数不是有限非负数 → undefined；子维度非法或大于所属总数 → 丢掉该子维度。
 * 没有 v 且两个总数都是 0 的旧记录：unreported 为 ['input','output']、cost 为 unknown/no-usage——
 * 旧版本的 adapter 在没收到 usage 时落的就是 0/0，不能当成真实的 0 显示。
 */
export function describeUsage(raw: unknown): UsageView | undefined {
  if (!isRecord(raw)) return undefined;
  const input = count(raw.inputTokens); const output = count(raw.outputTokens);
  if (input === undefined || output === undefined) return undefined;
  const legacy = raw.v !== 2;
  const sub = (v: unknown, total: number): number | undefined => { const n = count(v); return n !== undefined && n <= total ? n : undefined; };
  const cacheRead = sub(raw.cacheReadTokens, input);
  const cacheWrite = sub(raw.cacheWriteTokens, input);
  const reasoning = sub(raw.reasoningTokens, output);
  const legacyEmpty = legacy && input === 0 && output === 0;
  const listed = Array.isArray(raw.unreported) ? raw.unreported : [];
  const unreported: UsageDim[] = legacyEmpty ? ['input', 'output'] : (['input', 'output'] as const).filter(d => listed.includes(d));
  const source = readSource(raw.source);
  const estimate = readEstimate(raw.estimate);
  const cost: CostEstimate = legacyEmpty ? { status: 'unknown', reason: 'no-usage' }
    : legacy ? { status: 'unknown', reason: 'legacy' }
    : readCost(raw.cost) ?? { status: 'unknown', reason: 'no-price' };
  return {
    input, output, total: input + output,
    ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}), ...(reasoning !== undefined ? { reasoning } : {}),
    unreported, legacy,
    ...(source ? { source } : {}), ...(estimate ? { estimate } : {}),
    cost,
  };
}

/**
 * 按当次端点的目录价格估算一次请求的费用。纯函数。只在价格与计费规则都确定时给数，其余一律未知（带原因）：
 *  - 没有价格（中转、本机、目录没有当前端点这个型号的价格、缓存较旧）；
 *  - 输入输出标价都是 0：目录里的 0 多数是订阅 / 套餐计费的占位，从目录上分不清它与真免费，一律不按 token 估算，更不显示成 0 元；
 *  - 按上下文长度分档计价；服务商没报完整用量；有缓存读写而目录没有对应的价；推理另行标价而服务商没报推理 token。
 * 缓存与推理是总数的子集：先从总数里减掉，再各自计价，不双计。批量折扣、优先级档、1 小时缓存写入价没有建模。
 */
export function estimateCost(u: TokenUsage, price: ModelPrice | undefined): CostEstimate {
  if (!price) return { status: 'unknown', reason: 'no-price' };
  if (price.input === 0 && price.output === 0) return { status: 'unknown', reason: 'zero-price' };
  if (price.tiered) return { status: 'unknown', reason: 'tiered' };
  if (u.unreported && u.unreported.length > 0) return { status: 'unknown', reason: 'unreported' };
  const cr = u.cacheReadTokens ?? 0; const cw = u.cacheWriteTokens ?? 0;
  if ((cr > 0 && price.cacheRead === undefined) || (cw > 0 && price.cacheWrite === undefined)) return { status: 'unknown', reason: 'cache-price' };
  if (price.reasoning !== undefined && price.reasoning !== price.output && u.reasoningTokens === undefined) return { status: 'unknown', reason: 'reasoning-price' };
  const rs = price.reasoning !== undefined ? (u.reasoningTokens ?? 0) : 0;
  // 价格是每百万 token 的美元数，所以这个和的单位是百万分之一美元
  const micro = (u.inputTokens - cr - cw) * price.input + cr * (price.cacheRead ?? 0) + cw * (price.cacheWrite ?? 0)
    + (u.outputTokens - rs) * price.output + rs * (price.reasoning ?? price.output);
  // 四舍五入到 6 位小数；子维度越界（大于总数）时算式可能为负，按 0 计
  return { status: 'estimated', usd: Math.max(0, Math.round(micro)) / 1_000_000 };
}
