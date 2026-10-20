/** F02 请求预算与用量的文案层：任务面板（上下文条、上次请求、截断说明）与设置页规格卡共用。纯函数无 DOM，node 直测。
 *
 *  两条硬规矩：
 *   - 估算处处写「估算」，未知写「未知」并带原因——不拿缺失的数字当 0 显示；
 *   - 费用只有两种写法：「约 $x（按目录价格估算）」与「费用未知（原因）」。没有任何分支输出 0 元；
 *     未知分支不产出任何数字与货币符号（原因文字里也不写阿拉伯数字）。 */
import { DEFAULT_OUTPUT_PREFERENCE, type ContextInfo, type LimitProfile, type OutputLimitInfo, type RequestBudget } from '@shared/request-budget';
import { describeUsage, type CostEstimate, type CostUnknownReason, type UsageView } from '@shared/usage';
import type { RuntimeModel } from '@shared/runtime-model';

/** 千分位（进度条旁的「已用 / 上限」另用 fmtK 缩写，不走这里）。 */
const num = (n: number): string => n.toLocaleString('en-US');

export interface ContextBar { used: number; limit: number; pct: number; limitLabel: string }

/** 上下文条：有预算时分母是输入上限（共享窗口叫「上下文窗口」，独立上限叫「输入上限」）；旧版本引擎没给预算时退回窗口。 */
export function barOf(info: Pick<ContextInfo, 'windowTokens' | 'usedTokens' | 'budget'>): ContextBar {
  const b = info.budget;
  const limit = b ? b.limits.inputLimit : info.windowTokens;
  const used = info.usedTokens;
  return {
    used, limit,
    pct: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
    limitLabel: b && b.limits.kind === 'separate' ? '输入上限' : '上下文窗口',
  };
}

/** 约束是什么形态、这个上限有多可信。 */
export function limitNoteOf(limits: LimitProfile): string {
  if (limits.observedAbove === undefined && !limits.windowKnown) {
    return `窗口没有资料，按 ${num(limits.inputLimit)} 计，不据此限制输出`;
  }
  const shape = limits.kind === 'separate'
    ? `输入上限 ${num(limits.inputLimit)}、输出上限 ${num(limits.outputCap)}，互不占用`
    : limits.sharedWindow !== undefined && limits.sharedWindow !== limits.inputLimit
      ? `输入上限 ${num(limits.inputLimit)}；输入与输出共用 ${num(limits.sharedWindow)} 的窗口`
      : `输入与输出共用 ${num(limits.sharedWindow ?? limits.inputLimit)} 的窗口`;
  const extra = limits.observedAbove !== undefined ? `实测输入 ${num(limits.observedAbove)} 已达到这个上限，不再据此限制输出`
    // F03：这个上限是端点拒绝之后学到的（只在本次运行里生效，不写回目录与配置）
    : limits.rejectedAt !== undefined ? `端点在本次运行里拒绝过约 ${num(limits.rejectedAt)} 的输入，本次运行按这个上限提前减压与收紧输出，不据此拒发`
    : limits.authority === 'advisory' ? '上限不是当前端点自己的记录，只用于提前减压与收紧输出，不据此拒发'
    : '';
  return extra ? `${shape}；${extra}` : shape;
}

/** max_tokens 为什么是这个数。preferenceSource 只在偏好生效（limitedBy === 'preference'）时用来分清默认额度与任务指定。 */
function limitReason(limitedBy: RequestBudget['output']['limitedBy'], preferenceSource?: RequestBudget['output']['preferenceSource']): string {
  switch (limitedBy) {
    case 'preference': return preferenceSource === 'task' ? '任务指定' : preferenceSource === 'default' ? '默认额度' : '单次输出额度';
    case 'manual': return '手动填写的最大输出';
    case 'model': return '模型输出上限';
    case 'window': return '上下文剩余空间不足';
    default: return '已到下限';
  }
}

export function outputNoteOf(output: RequestBudget['output']): string {
  return `本次 max_tokens ${num(output.requested)}（${limitReason(output.limitedBy, output.preferenceSource)}）`;
}

export interface BreakdownRow { key: 'system' | 'tools' | 'history' | 'reasoningReplay' | 'media'; label: string; tokens: number; text: string }
const MEDIA_BASIS: Readonly<Record<string, string>> = { formula: '按公式估算', 'upper-bound': '按上限估算', default: '保守估算' };

/** 输入分项：系统提示、工具、对话、推理回放、图片。数值为 0 的行不出。 */
export function breakdownOf(budget: RequestBudget): BreakdownRow[] {
  const i = budget.input; const c = i.components;
  const rows: Omit<BreakdownRow, 'text'>[] = [
    { key: 'system', label: i.systemDynamic > 0 ? `系统提示（其中稳定段 ${num(i.systemStable)}）` : '系统提示', tokens: c.system },
    { key: 'tools', label: `工具（${num(i.toolCount)} 个）`, tokens: c.tools },
    { key: 'history', label: '对话', tokens: c.history },
    { key: 'reasoningReplay', label: '推理回放', tokens: c.reasoningReplay },
    { key: 'media', label: `图片（${num(i.imageCount)} 张，${MEDIA_BASIS[i.mediaBasis] ?? '保守估算'}）`, tokens: c.media },
  ];
  return rows.filter(r => r.tokens > 0).map(r => ({ ...r, text: `${r.label} ${num(r.tokens)}` }));
}

/** 这些数字是不是校准过的，上次估算差多少。 */
export function estimateNoteOf(budget: RequestBudget): string {
  const cal = budget.input.calibration;
  if (!cal.calibrated) return '估算值，尚无实测校准';
  if (!cal.last) return '已按上次实测校准';
  const pct = cal.last.errorPct;
  const diff = pct > 0 ? `上次估算比实测低 ${pct}%` : pct < 0 ? `上次估算比实测高 ${-pct}%` : '上次估算与实测一致';
  return `已按上次实测校准（${diff}）`;
}

/** turnEnd 事件带来的截断说明材料（引擎的 OutputLimitInfo）；形状不对一律当没有。 */
export function readOutputLimit(raw: unknown): OutputLimitInfo | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kinds = ['floor', 'window', 'preference', 'manual', 'model'];
  if (typeof r.requested !== 'number' || !Number.isFinite(r.requested) || typeof r.limitedBy !== 'string' || !kinds.includes(r.limitedBy)) return null;
  return { requested: r.requested, limitedBy: r.limitedBy as OutputLimitInfo['limitedBy'], continued: typeof r.continued === 'number' && Number.isFinite(r.continued) ? r.continued : 0 };
}

/** 被 max_tokens 截断的回合：那次的 max_tokens、原因、续写了几次、出路。 */
export function truncationText(limit: OutputLimitInfo | null): string {
  if (!limit) return '';
  const way = limit.limitedBy === 'window' || limit.limitedBy === 'floor' ? '上下文快满了，可新建会话或等下一轮压缩'
    : limit.limitedBy === 'preference' ? '需要更长的单次输出时，在「设置 → 模型 → 编辑 → 手动修正」填写最大输出'
    : '';
  return `这次请求的 max_tokens 是 ${num(limit.requested)}（${limitReason(limit.limitedBy)}），已自动续写 ${limit.continued} 次。${way}`;
}

export const MISSING_USAGE_TEXT = '这次请求没有用量数据（服务商未报告，或请求中途结束）';

export type LastRequest = { state: 'none' } | { state: 'missing' } | { state: 'usage'; view: UsageView };

/** 「上次请求」看的是当前会话最后一条 assistant 消息，不管它带不带用量——不回溯：
 *  把上上次请求的数字挂在「上次请求」下面是错的。 */
export function lastRequestOf(messages: readonly { role: string; tokenUsage?: unknown }[]): LastRequest {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue;
    const view = describeUsage(messages[i].tokenUsage);
    return view ? { state: 'usage', view } : { state: 'missing' };
  }
  return { state: 'none' };
}

/** 一行用量：子维度是总数的「其中」项，写在各自总数后面的括号里，不另算一项。 */
export function usageLine(view: UsageView): string {
  const missIn = view.unreported.includes('input'); const missOut = view.unreported.includes('output');
  if (missIn && missOut) return MISSING_USAGE_TEXT;
  const cache = [
    ...(view.cacheRead !== undefined ? [`缓存读取 ${num(view.cacheRead)}`] : []),
    ...(view.cacheWrite !== undefined ? [`缓存写入 ${num(view.cacheWrite)}`] : []),
  ];
  const input = missIn ? '输入 服务商未报告' : `输入 ${num(view.input)}${cache.length ? `（${cache.join('，')}）` : ''}`;
  const output = missOut ? '输出 服务商未报告' : `输出 ${num(view.output)}${view.reasoning !== undefined ? `（推理 ${num(view.reasoning)}）` : ''}`;
  return `${input} · ${output}${view.legacy ? '；旧版本记录，输入可能不含缓存、输出可能不含推理' : ''}`;
}

/** 费用未知的原因。不写阿拉伯数字（「标价为零」不写成数字）：未知分支整句不含数字与货币符号。 */
const COST_REASON: Readonly<Record<CostUnknownReason, string>> = {
  'no-usage': '没有用量',
  'no-price': '当前端点没有可确认的价格资料',
  'zero-price': '目录标价为零，可能是免费额度或订阅计费，不能按 token 估算',
  tiered: '该型号按上下文长度分档计价',
  legacy: '旧版本记录',
  unreported: '服务商没有报告完整用量',
  'cache-price': '缺少缓存读写的价格',
  'reasoning-price': '推理另行计价但服务商没有报告推理 token',
};

export function costText(cost: CostEstimate): string {
  if (cost.status === 'unknown') return `费用未知（${COST_REASON[cost.reason] ?? '原因不明'}）`;
  // 金额太小（含四舍五入后为零）时不写成零：写「不足」
  if (!(cost.usd >= 0.0001)) return '不足 $0.0001（按目录价格估算）';
  return `约 $${cost.usd.toFixed(4)}（按目录价格估算）`;
}

/** 设置页规格卡：单次请求实际申请多少输出（规格卡「最大输出」那一行说的是上限，两者不是一回事）。 */
export function outputRequestNote(rt: Pick<RuntimeModel, 'requestMaxTokens' | 'limits'>): string {
  const cap = rt.requestMaxTokens;
  if (rt.limits.maxOutputTokens.source === 'manual') return `单次请求按手动填写的最大输出 ${num(cap)} 申请；上下文剩余空间不足时收紧`;
  if (cap > DEFAULT_OUTPUT_PREFERENCE) {
    return `单次请求默认申请 ${num(DEFAULT_OUTPUT_PREFERENCE)}（上限 ${num(cap)}），带推理预算时另加预算；上下文剩余空间不足时收紧。需要更长的单次输出可手动填写最大输出`;
  }
  return `单次请求按上限 ${num(cap)} 申请；上下文剩余空间不足时收紧`;
}
