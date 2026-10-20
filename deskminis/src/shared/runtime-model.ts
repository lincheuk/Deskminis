/** F01 RuntimeModel：一个「配置实例」在运行时真正可用的模型规格（minisd 解析，设置页与 Agent 循环共用）。
 *
 *  适配单位是「配置实例 + 端点/协议 + 模型 ID」，不是模型 ID：同名模型经官方端点、目录收录的服务商、
 *  未知中转或本机服务接入时，各自解析，手动修正也只作用于自己那个实例。
 *
 *  每项能力分三层取交集：
 *   - 目录声明（catalog）：models.dev / 备用目录 / 内置族表怎么说这个模型；
 *   - 当前端点（endpoint）：依据是否来自这个端点本身（官方端点或目录收录的服务商记录、手动修正）；
 *   - 应用传输（transport）：DeskMinis 与当前接口协议是否实现了这条传输。
 *  unknown 不等于支持：界面显示「未确认」，运行时按各能力写明的兼容选择处理（见 minisd/providers/runtime-model.ts）。 */
import type { ModelPrice } from './model-metadata';

export type ProviderKind = 'anthropic' | 'openai-compat' | 'gemini' | 'ollama';
/** 请求构建器族：anthropic = /v1/messages；openai-chat = /chat/completions（含 Ollama）；gemini = streamGenerateContent。 */
export type RequestProtocol = 'anthropic' | 'openai-chat' | 'gemini';

/**
 * supported / unsupported：对当前端点有确定依据（手动修正、该端点自己的目录记录），
 *   或至少 3 家服务商有记录且一致否定（文本输入/输出：没有任何记录列出），才当作模型本身没有这项能力（unsupported）；
 * unknown：当前端点没有确认（中转、本机、目录缺字段）——catalog.value 只是对模型本身的提示。F01R 起还有两种来源，
 *   此时 catalog.value === false，运行时照常发送并提示：汇总有否定但不足 3 家（或没有逐家记录可佐证）；
 *   文本输入/输出上当前端点的记录说没有、别家记录说有；
 * unavailable：DeskMinis 或当前接口协议没有实现这条传输，模型再支持也用不了（手动修正也打不开）。
 */
export type CapabilityState = 'supported' | 'unsupported' | 'unknown' | 'unavailable';

/** 资料出处。endpoint = 当前端点自己的 models.dev 记录；aggregate = 跨服务商汇总（不代表当前端点）；manual = 实例手动修正（只出现在数字上）。 */
export type EvidenceSource = 'manual' | 'endpoint' | 'aggregate' | 'basellm' | 'builtin' | 'none';

export interface Capability {
  /** 三层取交集后的结论。 */
  state: CapabilityState;
  /** 目录对模型本身的说法（当前端点记录优先，其次跨服务商汇总 / 备用目录 / 内置族表）；value 缺省 = 没有资料。
   *  只记目录：手动修正单独放在 manual，界面才能把「目录声明」与「本配置的修正」分开显示。 */
  catalog: { value?: boolean; source: Exclude<EvidenceSource, 'manual'> };
  /** 本配置的手动修正（有就由它决定 supported / unsupported；应用没实现的传输打不开）。 */
  manual?: boolean;
  /** 依据是否来自当前端点：官方 / 收录服务商的记录或手动修正为 confirmed，中转与本机为 unconfirmed。
   *  F01R：端点记录的否定被别家记录反驳时（仅文本输入/输出）也记 unconfirmed，catalog 仍如实记 { value: false, source: 'endpoint' }。 */
  endpoint: 'confirmed' | 'unconfirmed';
  /** 应用与协议是否实现这条传输。 */
  transport: 'implemented' | 'app-missing' | 'protocol-missing';
  /** 不是 supported 时给人看的原因与出路（中文）。 */
  reason?: string;
}

export interface LimitValue {
  /** 运行时采用的值；缺省 = 没有资料（窗口按 128K、输出按 8192 保守回退）。
   *  limits.maxOutputTokens 在非手动来源下分三种（F01R）：
   *   - value > 0：采用的可信值（≤ outputCeiling(窗口)），requestMaxTokens 等于它；
   *   - value === 0：目录明写 0（只出图 / 只出视频的型号），照实显示，请求走兜底值；
   *   - 缺省：没有可采用的值——目录没写，或写了但不可信（后者带 declared 与 note）。
   *  所以「value 存在」不等于「可信」，要看 > 0；实际发出的值只看 RuntimeModel.requestMaxTokens。 */
  value?: number;
  source: EvidenceSource;
  /** 目录原值与 value 不同时记下（例如官方 Anthropic 端点的 1M 窗口按 200K 计）；也用来记「目录写了但没被采用的原值」。 */
  declared?: number;
  /** 没按目录原值走的原因与出路（窗口的 200K 计法、输出上限未采用目录值）。 */
  note?: string;
  /** 只出现在 limits.maxOutputTokens 上（F02）：value 是按本配置手动填写的上下文窗口的 3/4 封顶出来的，不是目录记录的值
   *  （目录原值在 declared）。这样的上限不是模型自己的：要更大，出路是手动填写最大输出或调大手动窗口，不是换用模型。
   *  单凭 value / source / declared 分不出这种情形（佐证值顶替占位的端点记录时形状相同），所以由解析器明写。 */
  cappedBy?: 'manual-window';
}

/** 推理：transport 是当前接入发送推理档位所用的参数；control 是当前端点目录声明的可调方式（中转不带）。 */
export interface ReasoningCapability extends Capability {
  control?: { toggle?: boolean; efforts?: string[]; budget?: { min?: number; max?: number } };
  param: 'effort' | 'budget' | 'none';
}

/** 输入卡的只读预告：level是实际effort（也可能为minimal）、预算档位或off。 */
export interface ThinkingPlanView {
  level: string;
  effort?: string;
  budgetTokens?: number;
  note?: string;
}
export interface ThinkingPreview { xhigh: ThinkingPlanView; max: ThinkingPlanView }

export type EndpointClass = 'official' | 'catalog' | 'relay' | 'local';

export interface CapabilityOverrides { imageInput?: boolean; toolCall?: boolean; reasoning?: boolean }

/** 实例级手动修正（providers.json 里的字段）。contextWindow 是 M4.5 起就有的旧字段，原名沿用。 */
export interface InstanceOverrides {
  /** N21：按本配置手动指定 models.dev 服务商，目录缺失时忽略但保留配置。 */
  catalogProviderId?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilityOverrides?: CapabilityOverrides;
}

export type InputMedium = 'text' | 'image' | 'audio' | 'video' | 'pdf';
export type OutputMedium = 'text' | 'image' | 'audio' | 'video';

export interface RuntimeModel {
  instanceId?: string;
  instanceName?: string;
  modelId: string;
  kind: ProviderKind;
  protocol: RequestProtocol;
  endpoint: {
    class: EndpointClass;
    host?: string;
    /** 匹配到的 models.dev 服务商（official / catalog 才有）。 */
    catalogProviderId?: string;
    /** 地址不能自动匹配时，由本配置手动指定目录服务商。官方端点不采用。 */
    manual?: true;
  };
  catalog: {
    /** 用到的是哪一层资料：当前端点自己的记录 / 跨服务商汇总 / 备用目录 / 内置族表 / 没有。 */
    record: 'endpoint' | 'aggregate' | 'basellm' | 'builtin' | 'none';
    name?: string;
    fetchedAt?: number;
    stale: boolean;
  };
  limits: { contextWindow: LimitValue; maxInputTokens: LimitValue; maxOutputTokens: LimitValue };
  /** 模型输出上限（单次请求的 max_tokens 不会超过它）。手动值原样；非手动值经合理性检查（F01R）：
   *  1 ≤ requestMaxTokens ≤ outputCeiling(W) < W，W = limits.contextWindow.value ?? FALLBACK_CONTEXT_WINDOW。
   *  F02：它是上限，不是每次请求的申请量——实际发出的 max_tokens 是 RequestBudget.output.requested，在它之下按偏好与剩余空间再收。 */
  requestMaxTokens: number;
  /** 当前端点自己的目录价格（F02）。只来自 official / catalog 端点自己的记录：中转、本机、汇总都不带——同名模型在别家的价格不能借用。 */
  price?: ModelPrice;
  input: Record<InputMedium, Capability>;
  output: Record<OutputMedium, Capability>;
  toolCall: Capability;
  structuredOutput: Capability;
  reasoning: ReasoningCapability;
  /** 生效的手动修正；invalid 列出被忽略的非法旧值（字段名 + 原值），不改写用户文件。 */
  overrides: InstanceOverrides & { invalid: string[] };
}

/** 目录与手动都没有输出上限时的 max_tokens 兜底（与 M4.5 起 chat.prompt 的 8192 一致）。 */
export const FALLBACK_MAX_OUTPUT = 8192;

/** 目录与手动都没有窗口时的保守回退。agent/context-policy.ts 的 FALLBACK_WINDOW 引用它（同值）。 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/** 非手动来源的 max_tokens 上限：窗口的 3/4，至少给输入留 1/4（F01R）。
 *  这是「目录的输出上限是否可信」的静态检查，不是请求预算——逐请求的预算在它之下再收。
 *  为什么是 3/4：目录里 0.8 × 窗口及以上的输出上限是成批算出来的占位值（output == context 最多），
 *  服务商公布的真实规格落在 3/4 及以下。 */
export function outputCeiling(contextWindow: number): number {
  return Math.max(1, Math.floor(contextWindow * 3 / 4));
}

/** 界面用的状态短词。 */
export function capabilityStateLabel(state: CapabilityState): string {
  switch (state) {
    case 'supported': return '可用';
    case 'unsupported': return '不支持';
    case 'unavailable': return '不可用';
    default: return '未确认';
  }
}
