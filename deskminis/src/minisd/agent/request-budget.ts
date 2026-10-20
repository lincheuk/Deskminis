/**
 * F02 请求预算（agent 层）：把「请求度量 + 约束形态 + 校准 + 输出偏好」合成一次请求的 RequestBudget，
 * 并提供循环要用的几个判断（先修剪还是压缩、固定开销是否占满上限）与 usage 落库前的盖章。
 *
 * computeSlotBudget 是循环与 chat.contextInfo 共用的唯一入口：水位的两个入参、最终请求的 max_tokens、
 * 上下文条显示的数字都出自它返回的同一个对象（契约与不变量见 shared/request-budget.ts）。
 * 全部是同步的纯计算：不发网络、不调计数接口、不写存储；校准与实测上限只读落库的历史，没有内存状态——
 * 循环每轮重读历史，上一轮的真实 usage 自动生效；空闲与重启后算出同一组值。
 */
import type { AgentMessage, AgentToolDefinition, RawMessage } from '../../shared/types';
import type { RuntimeModel } from '../../shared/runtime-model';
import type { ModelPrice } from '../../shared/model-metadata';
import { estimateCost, usageKeyOf, type TokenUsage, type UsageEstimate, type UsageSource } from '../../shared/usage';
import {
  COMPACT_MIN_GAIN, DEFAULT_OUTPUT_PREFERENCE, MARGIN_FLOOR, MIN_REQUEST_OUTPUT, OUTPUT_RESERVE, buildRequestBudget, limitName,
  type LimitProfile, type RequestBudget,
} from '../../shared/request-budget';
import { RECOVERY_LIMITS, type BudgetBrief } from '../../shared/compaction';
import type { OverflowHint } from '../providers/overflow';
import type { StreamRequest, SystemPromptParts } from '../providers/types';
import { limitProfile } from '../providers/runtime-model';
import { measureRequest, type RequestMeasure } from '../providers/request-measure';
import type { ContextAction } from './context-policy';

/** 分词口径：协议 + 模型 id。同口径的实测才用来校准；换模型后回到未校准。 */
export function usageKey(rt: Pick<RuntimeModel, 'protocol' | 'modelId'>): string {
  return `${rt.protocol}:${rt.modelId}`;
}

/** 落库用的来源：有 runtime 取它的 protocol / modelId / instanceId；没有的（旧调用方）只带 provider.modelId。 */
export function usageSourceOf(slot: { provider: { modelId: string }; runtime?: RuntimeModel }): UsageSource {
  const rt = slot.runtime;
  if (!rt) return { by: 'provider', modelId: slot.provider.modelId };
  return { by: 'provider', protocol: rt.protocol, modelId: rt.modelId, ...(rt.instanceId !== undefined ? { instanceId: rt.instanceId } : {}) };
}

/** 系统提示全文：动态段为空时就是稳定段，否则两段以空行相连（与 SystemPromptParts 的约定一致）。 */
export function joinSystemPrompt(p: SystemPromptParts): string {
  return p.dynamic ? `${p.stable}\n\n${p.dynamic}` : p.stable;
}

/** 工具顺序确定化：内置工具保持注册序（启动时按固定代码顺序注册），`mcp__` 开头的按名字的码元序排在后面。
 *  MCP 服务重连后工具会重新注册到注册表末尾，不排序的话工具数组的顺序随连接先后变，请求前缀跟着变、缓存命不中。 */
export function orderToolDefinitions(defs: readonly AgentToolDefinition[]): AgentToolDefinition[] {
  const builtin = defs.filter(d => !d.name.startsWith('mcp__'));
  const mcp = defs.filter(d => d.name.startsWith('mcp__')).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [...builtin, ...mcp];
}

/**
 * 这次请求想要多少输出（上限之内）：
 *  1. 任务偏好（chat.prompt 的 maxOutputTokens）→ 偏好 + 推理预算，夹在 [1, 模型上限]；
 *  2. 本配置手动填了最大输出 → 就是它：手动值既是上限也是偏好；
 *  3. 其余 → min(模型上限, 65,536 + 推理预算)。
 * 推理预算加在偏好之上：budget_tokens 计入 max_tokens，偏好说的是可见输出。OpenAI 兼容端点的 reasoning_effort 没有显式预算，
 * 推理与正文共用这份额度。结果恒满足 1 ≤ tokens ≤ 模型上限；任务偏好低于 1,024（比如 300）时照它发，不被预算的下限抬高。
 */
export function resolveOutputPreference(
  rt: Pick<RuntimeModel, 'requestMaxTokens' | 'limits'>, o: { task?: number; thinkingBudget?: number } = {},
): { tokens: number; source: 'manual' | 'task' | 'default' } {
  const cap = rt.requestMaxTokens;
  const tb = o.thinkingBudget ?? 0;
  if (o.task !== undefined) return { tokens: Math.max(1, Math.min(cap, o.task + tb)), source: 'task' };
  if (rt.limits.maxOutputTokens.source === 'manual') return { tokens: cap, source: 'manual' };
  return { tokens: Math.min(cap, DEFAULT_OUTPUT_PREFERENCE + tb), source: 'default' };
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * 用落库的真实 usage 校准估计，并记录估计误差。
 *
 * 校准系数：从历史末尾往前找第一条满足全部条件的 assistant 消息——F02 口径（v: 2）、带发送前的估计、分词口径相同、
 * 不带图片（图片估计的偏差会混进文本系数）、文本估计 ≥ 2000（小请求上服务商自加的固定开销占比太大）、服务商报了输入、
 * 比例落在 [0.5, 2]。出了区间的样本丢弃并继续往前找，不夹到边界：少报输入的中转会把系数压到 0.5，等于把估计砍半。
 *
 * 实测上限：整段历史里同口径、同配置实例的记录中最大的实测输入（不要求有估计，带图片的、取消时落下的也算）——
 * 要的不是估算精度，而是「这个端点收下过多大的输入」。实例 id 两边都有值时必须相等：同名模型在不同接入上的窗口各不相同，
 * 别的接入收下过的输入不能算在这个接入头上。旧记录（没有 v: 2）两样都不参与。
 */
export function calibrationFrom(
  history: readonly RawMessage[], rt: Pick<RuntimeModel, 'protocol' | 'modelId' | 'instanceId'>,
): RequestBudget['input']['calibration'] {
  const key = usageKey(rt);
  let observed: number | undefined;
  let sample: { ratio: number; last: { estimated: number; actual: number; errorPct: number } } | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'assistant') continue;
    const u = m.tokenUsage;
    if (!u || u.v !== 2 || usageKeyOf(u.source) !== key) continue;
    if (!positive(u.inputTokens) || (Array.isArray(u.unreported) && u.unreported.includes('input'))) continue;
    const inst = u.source?.instanceId;
    if (inst === undefined || rt.instanceId === undefined || inst === rt.instanceId) observed = Math.max(observed ?? 0, u.inputTokens);
    if (sample) continue;
    const e = u.estimate;
    if (!e || e.media !== 0 || !positive(e.text) || e.text < 2000 || !positive(e.input)) continue;
    const ratio = u.inputTokens / e.text;
    if (ratio < 0.5 || ratio > 2) continue;
    sample = { ratio, last: { estimated: e.input, actual: u.inputTokens, errorPct: Math.round((u.inputTokens - e.input) / u.inputTokens * 100) } };
  }
  return {
    ...(sample ? { ratio: sample.ratio, calibrated: true, last: sample.last } : { ratio: 1, calibrated: false }),
    ...(observed !== undefined ? { observedMaxInput: observed } : {}),
  };
}

/** 可压部分：对话、回放推理、图片——压缩与修剪能减下去的只有这些，系统提示与工具定义减不了。 */
const compressible = (b: RequestBudget): number => b.input.components.history + b.input.components.reasoningReplay + b.input.components.media;

/** 余量不足（tight / over）。 */
export function needsRelief(b: RequestBudget): boolean {
  return b.status === 'tight' || b.status === 'over';
}

/** 余量不足，且可压部分 ≥ COMPACT_MIN_GAIN：值得发一次付费的摘要请求。 */
export function compactWorthwhile(b: RequestBudget): boolean {
  return needsRelief(b) && compressible(b) >= COMPACT_MIN_GAIN;
}

/**
 * 这一轮先做什么。入参 tier 是水位阈值表给的档位（阈值表本身不动），b 是这次请求的预算：
 *  - 水位到了压缩档、可压部分够大 → 'compact'（与 F02 之前相同）；
 *  - 水位到了压缩档、但那是固定开销撑起来的（可压部分不足）→ 'offload'：压缩减不下去，不为它发付费的摘要请求；
 *  - 水位在修剪档 → 'offload'（与以前相同）；
 *  - 水位没到档、输出余量已经不足 → 'offload'：修剪是本地操作、不花钱，排在付费的压缩前面。
 * 返回 'offload' 的含义是「先修剪，修剪后重算预算，compactWorthwhile 仍为真再压缩」（循环的三步）。
 */
export function decideContextAction(tier: ContextAction, b: RequestBudget): ContextAction {
  if (tier === 'compact') return compressible(b) >= COMPACT_MIN_GAIN ? 'compact' : 'offload';
  if (tier === 'offload') return 'offload';
  return needsRelief(b) ? 'offload' : 'none';
}

/**
 * 循环在这份预算下发请求之前会不会先修剪（chat.contextInfo 的空闲推算用，与循环的三步减压读同一张表）：
 * 第 ① 步（水位到了修剪档，或余量不足），或第 ③ 步（压缩档上压缩没有产出、余量不足）。
 * 只看修剪这一档：付费的压缩不在推算里模拟。少了这一步，空闲时的上下文条显示的是修剪前的输入，
 * 还会带出一条实际不会发生的「max_tokens 收紧 / 端点可能拒绝」。
 */
export function prunesBeforeSend(tier: ContextAction, b: RequestBudget): boolean {
  const action = decideContextAction(tier, b);
  return action === 'offload' || (action === 'compact' && needsRelief(b));
}

/**
 * 一段请求消息在这个槽位的请求里占多少 token（对话 + 回放推理 + 图片）。与预算同一把尺：同一个协议构建器、同一个校准系数。
 * 循环用它估「压缩这一次真能从请求里摘走多少」（余量不足触发的压缩，见 loop.ts 减压第 ① 步）。
 */
export function measureMessages(
  rt: Pick<RuntimeModel, 'protocol' | 'modelId' | 'kind' | 'instanceId'>, messages: AgentMessage[], history: readonly RawMessage[],
): number {
  if (messages.length === 0) return 0;
  const m = measureRequest(rt, { messages, tools: [] });
  const rho = calibrationFrom(history, rt).ratio;
  return Math.ceil(m.history * rho) + Math.ceil(m.reasoningReplay * rho) + m.media.reduce((sum, x) => sum + x.tokens, 0);
}

/** 固定开销（系统提示 + 工具）自己就占满了输入上限：清空历史也放不下，压缩与新建会话接力都解决不了。
 *  窗口没有资料、或资料上限已被实测推翻时不下这个结论。 */
export function fixedCostDominates(b: RequestBudget): boolean {
  return b.limits.windowKnown && b.input.components.system + b.input.components.tools + MARGIN_FLOOR >= b.limits.inputLimit;
}

/** 固定开销放不下时的出路（发送前拒发与端点拒绝两种说明共用）。 */
export const FIXED_COST_ADVICE = '压缩对话或新建会话解决不了这个问题；可以停用部分 MCP 服务器或技能、精简助手规则与记忆，或换用窗口更大的模型；'
  + '如确认该接入的窗口更大，可在「设置 → 模型 → 编辑 → 手动修正」填写上下文窗口';

/** 端点以超窗拒绝且 fixedCostDominates 时的错误说明：请求发过一次，原因是固定开销，不给接力草稿。 */
export function fixedCostMessage(label: string, b: RequestBudget): string {
  const c = b.input.components;
  return `${label} 拒绝了这次请求：系统提示约 ${c.system}、工具定义约 ${c.tools}（${b.input.toolCount} 个）已占满${limitName(b.limits)} ${b.limits.inputLimit}（估算），`
    + `对话本身只占约 ${compressible(b)}。${FIXED_COST_ADVICE}`;
}

/**
 * 被 max_tokens 截断的是工具调用时的提示（循环在落库之后、工具开始之前发）：这条路径不续写、直接执行工具，截断的入参已落成空对象，
 * 用户只会看到工具报缺少必填参数。只为 F02 自己造成的截断说话——按剩余空间收紧的，以及默认额度（上限更大的型号以前按上限发）；
 * 任务指定的额度、手动填写的最大输出、模型上限造成的截断返回 undefined。
 * 固定句不含数字：循环按文本去重，一次运行只说一次。
 */
export function truncatedToolCallNotice(label: string, o: Pick<RequestBudget['output'], 'limitedBy' | 'preferenceSource'>): string | undefined {
  if (o.limitedBy === 'window' || o.limitedBy === 'floor') {
    return `${label} 这次输出被 max_tokens 截断：上下文剩余空间不足，max_tokens 已收紧，工具调用的参数可能不完整。可新建会话，或等下一轮压缩后重试`;
  }
  if (o.limitedBy === 'preference' && o.preferenceSource === 'default') {
    return `${label} 这次输出被 max_tokens 截断：单次请求按默认额度申请输出，工具调用的参数可能不完整。需要更长的单次输出时，可在「设置 → 模型 → 编辑 → 手动修正」填写最大输出`;
  }
  return undefined;
}

/** outputExhaustedMessage 要看的事实：这一轮实际是怎么发的、服务商回了什么。出路按它们给，不按猜的。 */
export interface OutputExhaustedFacts {
  /** 这次请求体里带没带可调的推理参数（reasoning_effort / 推理预算）。没带时「调低推理档位」不是出路——照做后重发的请求
   *  与这一次逐字节相同。没带的三种情形：档位本来就是关；这个槽位没发（推理能力未确认、放不下最小预算）；型号的思考由服务端
   *  自适应（Anthropic 协议上的 BINDING_MODELS）——这一种 SlotPlan.thinking.level 仍是用户选的档位，只看它会判错，
   *  要另看 providers/runtime-model.ts 的 thinkingIsServerAdaptive。 */
  thinkingSent: boolean;
  /** 模型输出上限是兜底值：目录没有可用的记录、也没有手动填写（RuntimeModel.limits.maxOutputTokens.value 为空）。 */
  capIsFallback: boolean;
  /** 模型输出上限是按本配置手动填写的上下文窗口的 3/4 封顶出来的（RuntimeModel.limits.maxOutputTokens.cappedBy 为
   *  'manual-window'：目录有记录，只是被手动窗口挤掉了）。它不是模型自己的上限，换用模型不是对症的出路。缺省 = 不是。 */
  capFromManualWindow?: boolean;
  /** 这次请求的用量；服务商没报就不带。 */
  usage?: Pick<TokenUsage, 'outputTokens' | 'reasoningTokens' | 'unreported'>;
}

/**
 * 请求以 max_tokens 截断收尾、正文与工具调用都没有时的说明（循环的空响应分支用）：这是截断，不是空响应。
 * 报 outputLimit 错误时，这条说明就是用户手里唯一的出路。F02b 起，额度是模型自己的上限或手动填的最大输出、且模型组里有接得住的备用时，
 * 循环改为本轮换到备用，同一句写进 fallback 的 reason——这一跳不改绑会话，下一条消息仍先给这个模型，出路照样用得上；
 * 换过去的备用也没接住这一轮时，终态错误仍以这一句开头（后面附最后的失败原因）。
 * 所以每一条都得是照做后真能改变下一次请求的：
 *  - 按 max_tokens 为什么是这个数给出路；按剩余空间收紧的要点明是上下文剩余空间不足；
 *  - 「调低推理档位」只在这次请求体里真的带了可调的推理参数时才提（思考由服务端自适应的型号不提：档位进不了请求体）；
 *  - 模型上限是兜底值时指向手动填写最大输出（设置页对这类配置写的是「留空 = 按 … 计（目录无可用值）」）；
 *  - 模型上限是按本配置手动窗口的 3/4 封顶出来的：照实说它不是模型自己的上限，出路是手动填写最大输出或调大手动窗口
 *    （调大窗口以该接入的窗口确实更大为前提——手动窗口多半就是照着接入的实际窗口填的）；
 *  - 其余（目录记录原样采用的上限）才是模型自己的上限，指向换用模型。
 * 「额度在正文之前就用完了，多为推理占用」是按收尾原因推断的；服务商报了用量就照实写数字。报告的输出不到这次 max_tokens 的一半时，
 * 截断未必是这个额度造成的（端点自己的上限更小，或它没有把推理计入输出）——不说「用完了」，也不让人去调大额度。
 */
export function outputExhaustedMessage(
  label: string, o: Pick<RequestBudget['output'], 'requested' | 'limitedBy' | 'preferenceSource'>, facts: OutputExhaustedFacts,
): string {
  const manualFix = '「设置 → 模型 → 编辑 → 手动修正」';
  const lower = facts.thinkingSent;
  const way = o.limitedBy === 'window' || o.limitedBy === 'floor' ? `上下文剩余空间不足，这次的 max_tokens 是收紧过的；可新建会话，${lower ? '或调低推理档位后重发' : '或换用上下文窗口更大的模型'}`
    : o.limitedBy === 'preference' && o.preferenceSource === 'default' ? `${lower ? '可调低推理档位后重发' : '这次按默认额度申请输出'}；需要更长的单次输出时，在${manualFix}填写最大输出`
    : o.limitedBy === 'preference' ? `${lower ? '可调低推理档位，或' : '可'}调高这次任务指定的输出额度后重发`
    : o.limitedBy === 'manual' ? `${lower ? '可调低推理档位，或' : '可'}调高手动填写的最大输出后重发`
    : facts.capIsFallback ? `${lower ? '可调低推理档位后重发；' : ''}这个输出上限是目录没有可用记录时的兜底值，确认模型的真实上限后可在${manualFix}填写最大输出，或换用模型`
    : facts.capFromManualWindow === true ? `${lower ? '可调低推理档位后重发；' : ''}这个输出上限不是模型自己的上限，是按本配置手动填写的上下文窗口的 3/4 计的；`
      + `需要更长的单次输出时，可在${manualFix}填写最大输出，或在确认该接入的窗口更大后调大手动填写的上下文窗口`
    : `${lower ? '可调低推理档位后重发，或' : '这已是该模型的输出上限，可'}换用输出上限更大的模型`;

  const u = facts.usage;
  const out = u && Number.isFinite(u.outputTokens) && !(u.unreported ?? []).includes('output') ? u.outputTokens : undefined;
  const head = `${label} 这次输出被 max_tokens 截断，没有产出正文：`;
  const spent = `输出额度（max_tokens ${o.requested}）在正文之前就用完了`;
  if (out === undefined) return `${head}${spent}，多为推理占用。${way}`;
  const reported = `服务商报告这次输出 ${out}，${u?.reasoningTokens !== undefined ? `其中推理 ${u.reasoningTokens}` : '没有单列推理'}`;
  if (out * 2 < o.requested) {
    return `${head}${reported}，远低于这次的 max_tokens ${o.requested}：截断未必是这个额度造成的，端点自己的输出上限可能更小，或者它没有把推理计入输出。`
      + `${lower ? '可调低推理档位后重发' : '可重试一次'}；仍然如此时换用模型，或在${manualFix}核对该接入的上下文窗口与最大输出`;
  }
  return u?.reasoningTokens !== undefined ? `${head}${spent}（${reported}）。${way}` : `${head}${spent}，多为推理占用（${reported}）。${way}`;
}

// ───────────────────────── F03 拒绝上限 ─────────────────────────

/**
 * 端点拒绝过的请求给出的上限（run 级、按槽位、只降不升；数值是本机估算口径）。
 * 它进预算（computeSlotBudget 的 ceiling），所以水位、max_tokens 收紧、摘要请求的预算、上下文条自动一致，
 * 恢复不需要第二条请求构建路径。authority 是 advisory：永远不会据此在本地拒发，只用来判水位、收紧输出、判 over。
 */
export interface RejectionCeiling {
  /** 有证据的上限：输入；输入 + max_tokens。 */
  input?: number; total?: number;
  /** 「先收输出」定下的 max_tokens 上限（恒为 OUTPUT_RESERVE），不随输入变化；一旦定下留到运行结束。 */
  output?: number;
  /** 最近一次被拒的请求：输入估计；输入估计 + max_tokens。 */
  rejectedInput: number; rejectedTotal: number;
  /** 记下这些数时的校准系数。系数变了，读的一侧按比例换算（rescale）。 */
  ratio: number;
  /** 这个槽位本次运行被拒的次数。 */
  rejections: number;
  basis: 'hint' | 'output-first' | 'step';
}

const minOf = (a: number | undefined, b: number | undefined): number | undefined => a === undefined ? b : b === undefined ? a : Math.min(a, b);

/**
 * 把上限记录换到另一个校准系数下。上限是按被拒那一刻的估算口径记的；预算里文本各项按校准系数缩放，系数一变，
 * 同一段内容的估算跟着变，上限不跟着变就对不上了（新会话最常见：第一轮被拒时还没有校准，恢复后的成功响应带回 usage，
 * 下一轮系数变成实测值）。总量里被拒那次的 max_tokens 是真实 token，不随系数变，只缩放输入那一部分。
 * 图片的估计不随系数缩放，这里按整体比例换算，带很多图片的请求会有偏差（近似）。
 */
export function rescale(c: RejectionCeiling, ratio: number): RejectionCeiling {
  if (ratio === c.ratio || !(ratio > 0) || !(c.ratio > 0)) return c;
  const s = ratio / c.ratio;
  const r0 = c.rejectedTotal - c.rejectedInput;
  const rejectedInput = Math.floor(c.rejectedInput * s);
  return {
    ...c,
    ...(c.input !== undefined ? { input: Math.max(1, Math.floor(c.input * s)) } : {}),
    ...(c.total !== undefined ? { total: c.total > r0 ? Math.floor((c.total - r0) * s) + r0 : c.total } : {}),
    rejectedInput, rejectedTotal: rejectedInput + r0, ratio,
  };
}

/**
 * 端点以超窗拒绝了预算为 b 的这次请求：定出（或再降低）这个槽位的上限。依次判断：
 *  1. 报文带可用的数字：按「端点数出来的 ÷ 本机估算的」把它的上限换算成本机口径，再留 5%。比例出了 [0.5, 3] 的提示不用；
 *  2. 先收输出：共享窗口、这个槽位本次运行第一次被拒、申请的输出明显大于预留值——只记端点证明了的事（输入 + 输出放不下），
 *     收输出记成槽位级的输出上限，不动历史就能重发；
 *  3. 其余：上限按被拒输入的 stepRatio 下调（至少 1,024）。
 * 收口：比被拒那次至少小 1,024（进展保证）；与 prev 逐项取小（只降不升，prev 先换到这次的校准系数）；下限 1。
 */
export function lowerCeiling(b: RequestBudget, hint: OverflowHint | undefined, prev?: RejectionCeiling, stepRatio: number = RECOVERY_LIMITS.stepRatio): RejectionCeiling {
  const T = b.input.tokens; const R = b.output.requested; const S = T + R;
  const shared = b.limits.kind === 'shared';
  let input: number | undefined; let total: number | undefined; let output: number | undefined;
  let basis: RejectionCeiling['basis'] | undefined;
  if (hint) {
    const asInput = hint.basis === 'input' || !shared;
    const denom = asInput ? T : S;
    const k = denom > 0 ? hint.actual / denom : Number.NaN;
    if (k >= 0.5 && k <= 3) {
      const lim = Math.floor(hint.limit / k * 0.95);
      if (asInput) input = lim; else total = lim;
      basis = 'hint';
    }
  }
  if (!basis && shared && prev === undefined && R > OUTPUT_RESERVE + b.safetyMargin + 1024) {
    total = S - 1024; output = OUTPUT_RESERVE; basis = 'output-first';
  }
  if (!basis) {
    const step = Math.max(1024, Math.ceil(T * stepRatio));
    input = T - step;
    if (shared) total = S - step;
    basis = 'step';
  }
  if (input !== undefined) input = Math.min(input, T - 1024);
  if (total !== undefined) total = Math.min(total, S - 1024);
  const ratio = b.input.calibration.ratio;
  if (prev) {
    const p = rescale(prev, ratio);
    input = minOf(input, p.input); total = minOf(total, p.total); output = minOf(output, p.output);
  }
  return {
    ...(input !== undefined ? { input: Math.max(1, input) } : {}),
    ...(total !== undefined ? { total: Math.max(1, total) } : {}),
    ...(output !== undefined ? { output: Math.max(1, output) } : {}),
    rejectedInput: T, rejectedTotal: S, ratio, rejections: (prev?.rejections ?? 0) + 1, basis,
  };
}

/**
 * 把拒绝上限并进约束形态（computeSlotBudget 在有 ceiling 时用它的结果代替 limitProfile(rt)）。
 *  ⓪ 先把记录换到当前的校准系数；
 *  ① 实测下限：同一配置实例成功收下过 obs 这么大的输入（且小于被拒那次），学到的上限不低于它——步长是「不知道超了多少」时的猜测，
 *     可能猜到端点收下过的输入以下。实测值在运行中会随新的成功请求变大，所以放在读的一侧，不存进记录；
 *  ② 资料上限可不可信：窗口没有资料（inputLimit 是 128K 回退值），或已被实测推翻，都不参与取小——返回值的 windowKnown 恒为真、
 *     rejectedAt 又让 buildRequestBudget 的实测推翻不再生效，这两种本来不生效的值若参与取小，被拒一次之后就成了生效的上限。
 *     共享窗口而没有总量证据时 sharedWindow 取「输入上限 + 输出上限」：不据此收紧输出，与被拒之前一致。
 *     资料上限可信时仍取小：手动填的或端点目录给的窗口比学到的值小，说明这次拒绝另有原因，不该因此放宽。
 */
export function applyCeiling(l: LimitProfile, ceiling: RejectionCeiling, cal: RequestBudget['input']['calibration']): LimitProfile {
  const c = rescale(ceiling, cal.ratio);
  const obs = cal.observedMaxInput;
  let cin = c.input; let ctot = c.total;
  if (obs !== undefined && obs < c.rejectedInput) {
    if (cin !== undefined) cin = Math.max(cin, Math.min(obs, c.rejectedInput - 1024));
    if (ctot !== undefined) ctot = Math.max(ctot, Math.min(obs + MIN_REQUEST_OUTPUT, c.rejectedTotal - 1024));
  }
  const trusted = l.windowKnown && !(obs !== undefined && obs >= l.inputLimit);
  const shared = l.kind === 'shared';
  let ws: number | undefined; let input: number;
  if (trusted) {
    const ws0 = shared ? (l.sharedWindow ?? l.inputLimit) : undefined;
    ws = ws0 !== undefined ? Math.min(ws0, ctot ?? Infinity) : undefined;
    input = Math.min(l.inputLimit, cin ?? Infinity, ws !== undefined && ws0 !== undefined && ws < ws0 ? ws - MIN_REQUEST_OUTPUT : Infinity);
  } else {
    input = Math.min(cin ?? Infinity, ctot !== undefined ? ctot - MIN_REQUEST_OUTPUT : Infinity);
    // 没有任何学到的数（不该发生）时退回资料值，不让上限变成无穷大
    if (!Number.isFinite(input)) input = l.inputLimit;
    ws = shared ? (ctot ?? input + l.outputCap) : undefined;
  }
  const { sharedWindow: _dropped, ...rest } = l;
  void _dropped;
  return {
    ...rest,
    inputLimit: Math.max(1, Math.floor(input)),
    ...(ws !== undefined ? { sharedWindow: Math.max(1, Math.floor(ws)) } : {}),
    windowKnown: true, authority: 'advisory',
    rejectedAt: c.rejectedInput,
    ...(c.output !== undefined ? { outputCeiling: c.output } : {}),
    note: `${l.note}；本次运行里端点拒绝过约 ${c.rejectedInput} 的输入，按现在的上限计`,
  };
}

/** 一次请求预算的摘录（事件、审计、meta 共用，不带文本）。 */
export function briefOf(b: RequestBudget): BudgetBrief {
  return { slot: b.slot.label, inputTokens: b.input.tokens, inputLimit: b.limits.inputLimit, maxTokens: b.output.requested, status: b.status };
}

export interface SlotBudget {
  /** 这次要发的请求内容（消息已按槽位能力改写，图片是完整数据）。 */
  request: Pick<StreamRequest, 'messages' | 'systemPrompt' | 'systemPromptParts' | 'tools'>;
  measure: RequestMeasure;
  budget: RequestBudget;
  /** 落库用：这次请求发出前的估计。 */
  estimate: UsageEstimate;
}

/** 循环与 chat.contextInfo 共用的唯一入口。messages 是按槽位能力改写后的请求消息（shapeMessagesForSlot 的结果）。 */
export function computeSlotBudget(a: {
  rt: RuntimeModel; label: string;
  messages: AgentMessage[];
  system: { text: string; parts?: SystemPromptParts };
  tools: AgentToolDefinition[];
  /** 原始历史：校准与实测上限用。 */
  history: readonly RawMessage[];
  /** 这次请求按模型上限算出的推理预算（没带预算参数时不传）。 */
  thinkingBudget?: number;
  /** 任务偏好的输出量。 */
  taskPreference?: number;
  /** F03：这个槽位本次运行被端点拒绝后学到的上限。给了就按它重定输入上限 / 窗口与输出上限（applyCeiling）；不给时输出与以前逐字段相同。 */
  ceiling?: RejectionCeiling;
}): SlotBudget {
  const request: SlotBudget['request'] = {
    messages: a.messages, systemPrompt: a.system.text, tools: a.tools,
    ...(a.system.parts ? { systemPromptParts: a.system.parts } : {}),
  };
  const measure = measureRequest(a.rt, request);
  const calibration = calibrationFrom(a.history, a.rt);
  const profile = limitProfile(a.rt);
  const budget = buildRequestBudget({
    slot: { label: a.label, modelId: a.rt.modelId, key: usageKey(a.rt) },
    measure,
    limits: a.ceiling ? applyCeiling(profile, a.ceiling, calibration) : profile,
    calibration,
    preference: resolveOutputPreference(a.rt, { task: a.taskPreference, thinkingBudget: a.thinkingBudget }),
  });
  return { request, measure, budget, estimate: { text: budget.input.raw.text, media: budget.input.raw.media, input: budget.input.tokens } };
}

/**
 * usage 落库前盖章：加 v: 2（F02 的归一化口径）与 source（数字来自服务商，以及分词口径与配置实例）。
 * sent 有值时再加这次请求发出前的估计与费用状态——取消时的半截回复不传 sent：它不参与校准系数，也不估费用。
 * usage 为空（服务商没报）返回 undefined，调用方不落 tokenUsage：把估算写进 inputTokens / outputTokens，旧版本与同步对端会当成真实值读。
 */
export function finalizeUsage(
  usage: TokenUsage | undefined, source: UsageSource, sent?: { estimate: UsageEstimate; price?: ModelPrice },
): TokenUsage | undefined {
  if (!usage) return undefined;
  return { ...usage, v: 2, source, ...(sent ? { estimate: sent.estimate, cost: estimateCost(usage, sent.price) } : {}) };
}
