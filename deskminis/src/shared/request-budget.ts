/**
 * F02 RequestBudget 契约：一次「实际将发送的请求」的输入、输出与约束（minisd 的循环与 chat.contextInfo 算，渲染端与后续任务读）。
 *
 * 三层：
 *  - LimitProfile：这个配置实例的输入、输出与窗口是什么约束形态（共享窗口 / 各有各的上限），由 adapter 规则与目录资料决定，
 *    不给所有 API 套同一条公式（minisd/providers/runtime-model.ts 的 limitProfile）；
 *  - 请求度量：系统提示、工具定义、对话、回放推理、图片各占多少（minisd/providers/request-measure.ts，用各协议自己的构建器）；
 *  - RequestBudget：两者合起来得出这次请求的 max_tokens 与状态。水位、压缩触发、最终请求、上下文条读的是同一个对象。
 *
 * 后续任务可依赖的不变量：
 *  I-B1 input.tokens 等于五个 components 之和；
 *  I-B2 1 ≤ output.requested ≤ output.preference ≤ output.cap（发出的 max_tokens 不会大于偏好，over 时也一样）；
 *  I-B3 limits.kind === 'shared'、limits.windowKnown 且 status 为 ok / tight 时，input.tokens + output.requested + safetyMargin ≤ sharedWindow；
 *  I-B4 kind === 'separate' 或 !windowKnown 时，output.requested 不随输入变化；
 *  I-B5 status === 'blocked' 当且仅当：limits.windowKnown、authority 是 manual / endpoint、「系统提示 + 工具」的估算下界 ≥ inputLimit。
 *       这个下界不随校准变严。blocked 的槽位循环不发请求；
 *  I-B6 calibration.observedMaxInput 不小于资料给出的 inputLimit、且本次运行这个槽位没有被端点拒绝过（limits.rejectedAt 为空）时，
 *       limits.windowKnown === false、limits.observedAbove 等于它、status === 'ok'：端点已经收下过这么大的输入，
 *       资料上限不再用来收紧输出或拒发。被拒绝过的槽位不适用：拒绝是比先前的实测更新的证据（F03）。
 */
import type { CompactionView, ContextRecoveryView } from './compaction';

/** 非手动配置、没有任务偏好时，单次请求申请的输出额度。 */
export const DEFAULT_OUTPUT_PREFERENCE = 65_536;
/** 输出余量低于它就该先减压。 */
export const OUTPUT_RESERVE = 16_384;
/** max_tokens 的下限（偏好或模型上限更小时取更小的那个）。 */
export const MIN_REQUEST_OUTPUT = 1_024;
export const MARGIN_FLOOR = 1_024;
/** 可压部分（对话 + 回放推理 + 图片）不足它，不为减压发付费的摘要请求。 */
export const COMPACT_MIN_GAIN = 4_096;

/** 输入、输出、窗口三者的约束形态。 */
export interface LimitProfile {
  /** shared：输入与输出共占一个窗口；separate：各有各的上限，互不占用。 */
  kind: 'shared' | 'separate';
  /** 输入上限，也是水位的分母。 */
  inputLimit: number;
  /** 只有 shared 才有：输入 + 输出 + 余量 ≤ 它。 */
  sharedWindow?: number;
  /** = RuntimeModel.requestMaxTokens */
  outputCap: number;
  /** false：不据这个上限收紧输出，也不拒发，只用来判水位。两种情形：窗口没有资料（inputLimit 是 128K 回退值）；
   *  或资料上限已被实测推翻（见 observedAbove）。 */
  windowKnown: boolean;
  /** inputLimit 这个数有多硬。manual：本配置手动填的；endpoint：当前端点自己的目录记录原值；
   *  advisory：跨服务商汇总、备用目录、内置族表，或被 200K 计法改小的值（这些来源有意取低）；none：没有资料。
   *  只有 manual / endpoint 才允许据此拒发（blocked）；advisory 仍用来判水位与收紧输出。 */
  authority: 'manual' | 'endpoint' | 'advisory' | 'none';
  /** 同一配置实例上成功请求的实测输入已达到 inputLimit 时，记下最大的实测值。只出现在 RequestBudget.limits 上
   *  （buildRequestBudget 写入），此时 windowKnown 为 false。 */
  observedAbove?: number;
  /** F03：本次运行里端点以超窗拒绝过这个槽位时，最近一次被拒的请求的输入估计。只出现在 RequestBudget.limits 上。
   *  有它时 inputLimit / sharedWindow 已按拒绝重定（资料上限可信时与它取小；窗口没有资料或资料上限已被实测推翻时只用学到的值），
   *  windowKnown 为 true、authority 为 'advisory'：只用来判水位、收紧输出、判 over，永不据此拒发。 */
  rejectedAt?: number;
  /** F03：「先收输出」定下的输出上限（这个槽位本次运行最多申请这么多输出），不随输入变化。只出现在 RequestBudget.limits 上。 */
  outputCeiling?: number;
  basis: 'window' | 'catalog-input' | 'catalog-input+window' | 'adapter-separate';
  /** 给人看的一句依据。 */
  note: string;
}

export interface MediaEstimate {
  /** G03 在这里加 'pdf' | 'audio' | 'video'。 */
  kind: 'image';
  tokens: number;
  /** formula：按服务商公布的公式与实际尺寸；upper-bound：读不出尺寸，取公布的单张上限；default：没有核对过的规则，保守近似。 */
  basis: 'formula' | 'upper-bound' | 'default';
}

export type BudgetStatus = 'ok' | 'tight' | 'over' | 'blocked';

export interface RequestBudget {
  v: 1;
  slot: { label: string; modelId: string; key: string };
  limits: LimitProfile;
  input: {
    /** 采用值 = 下面五项之和。 */
    tokens: number;
    components: { system: number; tools: number; history: number; reasoningReplay: number; media: number };
    /** 两者相加 = components.system。 */
    systemStable: number; systemDynamic: number;
    toolCount: number; imageCount: number;
    /** 各张图里最不确定的一档。 */
    mediaBasis: 'none' | MediaEstimate['basis'];
    /** 未校准的估计。 */
    raw: { text: number; media: number };
    calibration: {
      ratio: number; calibrated: boolean;
      last?: { estimated: number; actual: number; errorPct: number };
      /** 同一配置实例上成功请求里最大的实测输入。没有样本时不带。 */
      observedMaxInput?: number;
    };
  };
  safetyMargin: number;
  output: {
    /** 实际写进 max_tokens 的值。 */
    requested: number;
    cap: number;
    preference: number;
    preferenceSource: 'manual' | 'task' | 'default';
    reserve: number;
    /** shared 且窗口已知：min(cap, 窗口 − 输入 − 余量)，放不下时为负；其余：cap。 */
    available: number;
    limitedBy: 'floor' | 'window' | 'preference' | 'manual' | 'model';
  };
  status: BudgetStatus;
  /** status 不是 ok 时的中文原因。 */
  reason?: string;
}

/** 被 max_tokens 截断时的说明材料（turnEnd 事件带）：requested = 这次请求实际发出的 max_tokens；
 *  limitedBy = 它为什么是这个数；continued = 截断后已自动续写的次数。 */
export interface OutputLimitInfo { requested: number; limitedBy: RequestBudget['output']['limitedBy']; continued: number }

/** chat.contextInfo 的返回值。前三个字段是 F02 之前就有的：windowTokens 是上下文窗口（不是输入上限），usedTokens 在有预算时
 *  等于 budget.input.tokens，remaining = max(0, windowTokens − usedTokens)。 */
export interface ContextInfo {
  windowTokens: number; usedTokens: number; remaining: number;
  budget?: RequestBudget;
  /** true：运行中最近一次发出的请求的预算；false：按落库状态推算的下一次请求里除新消息以外的部分——循环发请求前会先修剪的，
   *  推算也按修剪后的历史算；历史图片只保留「将要发的那条 + 上一轮」，更早的按占位文字算（新消息按不带图的文字算）；
   *  付费的压缩不模拟（真压缩了的话实际请求只会更小）。 */
  live?: boolean;
  /** F03：最新压缩记录的摘录（来自库，重启后仍在）。没有 marker 时不带键。 */
  compaction?: CompactionView;
  /** F03：这个会话最近一次超窗恢复的状态（仅内存；下一次 chat.prompt 时清）。没有时不带键。 */
  recovery?: ContextRecoveryView;
}

export interface BudgetMeasure {
  system: number; systemStable: number;
  tools: number; toolCount: number;
  history: number; reasoningReplay: number;
  media: MediaEstimate[];
}

const BASIS_RANK: Readonly<Record<MediaEstimate['basis'], number>> = { formula: 1, 'upper-bound': 2, default: 3 };

/** 约束在文案里叫什么：共享窗口说「上下文窗口」，独立上限说「输入上限」。 */
export function limitName(limits: Pick<LimitProfile, 'kind'>): string {
  return limits.kind === 'shared' ? '上下文窗口' : '输入上限';
}

/**
 * 预算算法（纯函数）。
 *
 * 文本四项按校准系数缩放，图片不缩放（图片估计的偏差与文本分词无关）。
 * blocked 只看固定开销（系统提示 + 工具）的估算下界：估计偏差在未校准时可达三成，拿估计值直接拒发会误伤放得下的请求；
 * 固定开销连下界都放不下时，压缩与接力都无能为力，这时拒发才有把握。再加三道保险：
 *  1. 下界不随校准变严——系数取 min(0.70, 0.90 × ratio)：校准说估计偏高时下界跟着降，说偏低时仍按 0.70。
 *     否则一次成功的请求（恰恰证明端点收得下）会让同一个会话从此每条都被本地拒发；
 *  2. 只认硬来源——authority 是 advisory / none 时最多判 over；
 *  3. 实测推翻——同一配置实例上有成功请求的实测输入 ≥ inputLimit，资料上限就是偏低的：不拒发、不收紧输出，状态恒为 ok。
 * over（估计值超过上限、下界没超过）照发：端点拒绝后由循环分清是固定开销还是对话过长。
 */
export function buildRequestBudget(a: {
  slot: RequestBudget['slot'];
  measure: BudgetMeasure;
  limits: LimitProfile;
  calibration: RequestBudget['input']['calibration'];
  preference: { tokens: number; source: 'manual' | 'task' | 'default' };
}): RequestBudget {
  const { measure: m, limits, calibration } = a;
  const rho = calibration.ratio;
  const scale = (n: number): number => Math.ceil(n * rho);
  const system = scale(m.system); const tools = scale(m.tools); const history = scale(m.history); const reasoningReplay = scale(m.reasoningReplay);
  const media = m.media.reduce((sum, x) => sum + x.tokens, 0);
  const tokens = system + tools + history + reasoningReplay + media;
  const systemStable = Math.min(system, scale(m.systemStable));
  const mediaBasis: RequestBudget['input']['mediaBasis'] = m.media.reduce<RequestBudget['input']['mediaBasis']>(
    (worst, x) => worst === 'none' || BASIS_RANK[x.basis] > BASIS_RANK[worst] ? x.basis : worst, 'none');

  const L = limits.inputLimit; const C = limits.outputCap; const p = a.preference.tokens;
  const obs = calibration.observedMaxInput;
  // F03：本次运行里端点拒绝过这个槽位（rejectedAt 有值）时实测不再推翻上限——学到的上限最低可以正好等于实测值，
  // 不加这个条件预算会整个忽略它
  const proven = limits.rejectedAt === undefined && obs !== undefined && obs >= L;
  const known = limits.windowKnown && !proven;
  const hard = known && (limits.authority === 'manual' || limits.authority === 'endpoint');
  const fixedLow = Math.floor((m.system + m.tools) * Math.min(0.70, calibration.calibrated ? 0.90 * rho : 0.70));
  const margin = Math.min(Math.floor(L / 10), Math.max(MARGIN_FLOOR, Math.ceil(tokens * (calibration.calibrated ? 0.05 : 0.15))));
  // F03：outputCeiling（「先收输出」定下的输出上限）再取一次小；没有它时与以前逐字段相同。它不改 cap 与 preference（I-B2 不变），
  // limitedBy 因此落在 'window'：按这个上限截断的回复算「收紧出来的」，不在模型组里换槽
  const available = Math.min(limits.outputCeiling ?? C, known && limits.sharedWindow !== undefined ? Math.min(C, limits.sharedWindow - tokens - margin) : C);
  const floorOut = Math.min(p, MIN_REQUEST_OUTPUT);
  const requested = Math.max(floorOut, Math.min(p, available));
  const reserve = Math.min(OUTPUT_RESERVE, p, Math.max(MIN_REQUEST_OUTPUT, Math.floor((limits.sharedWindow ?? L) / 4)));

  const status: BudgetStatus = !known ? 'ok'
    : hard && fixedLow >= L ? 'blocked'
    : tokens + margin > L || available < floorOut ? 'over'
    : available < reserve ? 'tight'
    : 'ok';
  const limitedBy: RequestBudget['output']['limitedBy'] = Math.min(p, available) < floorOut ? 'floor'
    : available < p ? 'window'
    : a.preference.source === 'manual' ? 'manual'
    : p < C ? 'preference'
    : 'model';
  const name = limitName(limits);
  const reason = status === 'tight' ? `输出空间只剩约 ${available}，低于预留值 ${reserve}：本次 max_tokens 收紧到 ${requested}`
    : status === 'over' ? `预计输入约 ${tokens}（估算），${name} ${L} 放不下它加上余量 ${margin} 与最小输出 ${floorOut}：仍会发送，端点可能拒绝`
    : status === 'blocked' ? `系统提示约 ${system}、工具定义约 ${tools}（${m.toolCount} 个），按估算下界 ${fixedLow} 已不小于${name} ${L}`
    : undefined;

  return {
    v: 1,
    slot: a.slot,
    limits: proven ? { ...limits, windowKnown: false, observedAbove: obs } : limits,
    input: {
      tokens,
      components: { system, tools, history, reasoningReplay, media },
      systemStable, systemDynamic: system - systemStable,
      toolCount: m.toolCount, imageCount: m.media.length, mediaBasis,
      raw: { text: m.system + m.tools + m.history + m.reasoningReplay, media },
      calibration,
    },
    safetyMargin: margin,
    output: { requested, cap: C, preference: p, preferenceSource: a.preference.source, reserve, available, limitedBy },
    status,
    ...(reason !== undefined ? { reason } : {}),
  };
}
