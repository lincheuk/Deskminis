/**
 * F03 超窗恢复与压缩记录的文案层：把引擎给的 ContextRecoveryView / CompactionView 变成事件条的短句与任务面板的说明行。
 * 纯函数无 DOM，node 直测。解释的是这次恢复「发生了什么、做了哪几步、结果如何」，数字都出自引擎的事件，不在界面上另算。
 */
import { COMPACT_FUSE_REASONS, type BudgetBrief, type CompactionView, type ContextRecoveryView, type RecoveryAction } from '@shared/compaction';

const num = (n: number): string => n.toLocaleString('en-US');
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function readBrief(v: unknown): BudgetBrief | undefined {
  if (!isObj(v) || typeof v.slot !== 'string' || !isNum(v.inputTokens) || !isNum(v.inputLimit) || !isNum(v.maxTokens) || typeof v.status !== 'string') return undefined;
  return v as unknown as BudgetBrief;
}

/** 事件里的 view → ContextRecoveryView；形状不对返回 null（旧引擎、坏数据不让界面崩）。 */
export function readRecoveryView(raw: unknown): ContextRecoveryView | null {
  if (!isObj(raw) || raw.v !== 1 || !isNum(raw.incident) || !isNum(raw.seq) || !isObj(raw.slot) || typeof raw.slot.label !== 'string') return null;
  if (raw.phase !== 'resending' && raw.phase !== 'recovered' && raw.phase !== 'switched' && raw.phase !== 'failed') return null;
  if (!isNum(raw.rejections) || !isNum(raw.resends) || !Array.isArray(raw.actions) || !isObj(raw.limits) || !readBrief(raw.before)) return null;
  return raw as unknown as ContextRecoveryView;
}

/** compacted 事件的 detail / chat.contextInfo 的 compaction → CompactionView；形状不对返回 null。 */
export function readCompactionView(raw: unknown): CompactionView | null {
  if (!isObj(raw) || typeof raw.markerId !== 'string' || (raw.v !== 1 && raw.v !== 2)) return null;
  return raw as unknown as CompactionView;
}

/** 这次事故里做过的最重的一档动作（决定「…后重发」的说法）。 */
function heaviest(actions: readonly RecoveryAction[]): 'compact' | 'clip' | 'prune' | 'output' {
  if (actions.some(a => a.kind === 'compact' && a.result === 'done')) return 'compact';
  if (actions.some(a => a.kind === 'trim' && a.clipped > 0)) return 'clip';
  if (actions.some(a => a.kind === 'trim' && a.pruned > 0)) return 'prune';
  return 'output';
}
const HOW: Record<ReturnType<typeof heaviest>, string> = {
  compact: '已压缩较早的对话后重发', clip: '已裁剪较大的工具结果后重发', prune: '已修剪旧工具结果后重发', output: '已调低本次输出上限后重发',
};

/**
 * 事件条的短句。interrupted：这次重发没有完成（被取消，或以别的错误收尾）——事件条留着，说法改成「没有完成」。
 */
export function recoveryShort(v: ContextRecoveryView, o: { interrupted?: boolean } = {}): string {
  if (v.phase === 'resending') {
    const s = `上下文超出模型上限：${HOW[heaviest(v.actions)]}`;
    return o.interrupted ? `${s}，这次重发没有完成` : s;
  }
  if (v.phase === 'recovered') return `已在同一模型上恢复（重发 ${v.resends} 次）`;
  if (v.phase === 'switched') return `同一模型上放不下，改用 ${v.switchedTo ?? '备选模型'}`;
  if (v.stop === 'runLimit') return `本次运行里端点已拒绝 ${v.runRejections} 次（上限 ${v.limits.rejectionsPerRun} 次），不再在同一模型上恢复`;
  // 压缩是被本次运行的熔断挡下的（次数、摘要请求、摘要花费用完，或已停用）：写明停在哪一条——只说「恢复不了」的话，
  // 用户看到的是此前压缩过三次、这次却不压了，不知道为什么
  const fuse = fuseReason(v.actions);
  return fuse ? `同一模型上恢复不了：${SKIP_WHY[fuse]}` : '同一模型上恢复不了';
}

const SKIP_WHY: Record<string, string> = {
  disabled: '本次运行已停用压缩', limit: '本次运行的压缩次数已用完', requests: '本次运行的摘要请求次数已用完', spendCap: '本次运行的摘要花费已到上限',
  nothingToSummarize: '没有可摘要的较早对话', tooSmall: '能摘走的内容太少', wontFit: '摘要之后仍然放不下',
};
/** 这次事故里挡下压缩的那条熔断（没有则 undefined）。 */
function fuseReason(actions: readonly RecoveryAction[]): string | undefined {
  for (const a of actions) {
    if (a.kind === 'compact' && a.result === 'skipped' && COMPACT_FUSE_REASONS.has(a.reason) && SKIP_WHY[a.reason]) return a.reason;
  }
  return undefined;
}
const FAIL_WHY: Record<string, string> = {
  empty: '摘要为空', truncated: '摘要被输出上限截断', refusal: '摘要请求被模型拒绝', malformed: '摘要格式不符', invalid: '摘要结构校验未通过',
  overflow: '摘要请求自身超出模型上限', stale: '摘要期间会话发生了变化', budget: '摘要请求额度已用完', error: '摘要请求失败',
};
const RULE: Record<string, string> = { 'recent-turns': '保留最近 3 个用户回合', 'recent-messages': '保留最近 14 条消息', tight: '只保留最近 4 条消息' };
const STOP: Record<string, string> = {
  fixedCost: '系统提示与工具定义自己就占满了模型的输入上限，压缩与裁剪都减不掉',
  noProgress: '能做的减压都做了，请求仍然放不下，没有再重发',
  resendLimit: '同一次超窗已重发到上限次数',
  runLimit: '本次运行里端点拒绝的次数已超过上限',
};

function actionLine(a: RecoveryAction): string {
  if (a.kind === 'ceiling') {
    const lim = [a.input !== undefined ? `输入约 ${num(a.input)}` : '', a.total !== undefined ? `输入加输出约 ${num(a.total)}` : ''].filter(Boolean).join('、');
    if (a.basis === 'output-first') return `先调低输出：本次运行里这个模型最多申请 ${num(a.output ?? 0)} 的输出`;
    return a.basis === 'hint' ? `按端点报的数字，把上限记为${lim}` : `端点没有报数字，把上限下调到${lim}`;
  }
  if (a.kind === 'trim') {
    return a.clipped > 0
      ? `修剪 ${a.pruned} 条历史工具结果，另裁剪 ${a.clipped} 条较大的结果（保留头尾）`
      : `修剪 ${a.pruned} 条历史工具结果`;
  }
  if (a.result === 'done') return `压缩了 ${a.messages} 条较早的消息（${RULE[a.rule] ?? a.rule}）`;
  return a.result === 'skipped' ? `没有压缩：${SKIP_WHY[a.reason] ?? a.reason}` : `压缩失败：${FAIL_WHY[a.reason] ?? a.reason}`;
}
const briefLine = (b: BudgetBrief): string => `输入约 ${num(b.inputTokens)}、max_tokens ${num(b.maxTokens)}`;

/** 详情（事件条的「详情」与任务面板的恢复卡共用）：被拒的那次 → 每个动作 → 重发的那次 → 第几次重发 → 停在哪一条熔断。 */
export function recoveryLines(v: ContextRecoveryView): string[] {
  const lines: string[] = [`${v.slot.label} 拒绝了这次请求（${briefLine(v.before)}）`];
  for (const a of v.actions) lines.push(actionLine(a));
  if (v.after) lines.push(`${v.phase === 'resending' ? '重发的请求' : '被收下的请求'}：${briefLine(v.after)}`);
  if (v.resends > 0) lines.push(`第 ${v.resends} 次重发，同一次超窗最多 ${v.limits.resendsPerIncident} 次`);
  if (v.stop) lines.push(STOP[v.stop] ?? v.stop);
  if (v.phase === 'switched' && v.switchedTo) lines.push(`已改用 ${v.switchedTo}`);
  return lines;
}

const TRIGGER: Record<string, string> = { overflow: '因端点拒绝', relief: '因余量不足', watermark: '因水位' };

/** 任务面板「上下文已压缩」卡多出的两行：覆盖与触发；保留项计数。旧 marker（v1）没有这些，返回空数组。 */
export function compactionLines(v: CompactionView): string[] {
  if (v.v !== 2 || !v.coverage) return [];
  const lines = [`${TRIGGER[v.trigger ?? ''] ?? ''}${v.trigger ? '，' : ''}已摘要会话开头起的 ${v.coverage.messages} 条消息`];
  const c = v.counts;
  if (v.form === 'text') {
    lines.push(`摘要模型没有按小节输出，目标与待办未结构化${c ? `；用户指示 ${c.userInstructions} 条、文件变更 ${c.fileChanges} 个` : ''}`);
  } else if (c) {
    const kept = `用户指示 ${c.userInstructions} 条、文件变更 ${c.fileChanges} 个、涉及文件 ${c.files} 个、待办 ${c.todo} 条`;
    lines.push(c.unverified > 0 ? `${kept}；另有 ${c.unverified} 条没有工具记录佐证的陈述没有写入摘要` : kept);
  }
  return lines;
}

/** 修剪事件的详情：第 2、3 级带分级说明；没有 level 的事件用原句（文本不变）。 */
export function prunedDetail(e: { count?: unknown; level?: unknown; clipped?: unknown }): string {
  const count = Number(e.count) || 0;
  if (e.level !== 2 && e.level !== 3) return `已修剪 ${count} 条历史工具结果`;
  const clipped = Number(e.clipped) || 0;
  return clipped > 0 ? `已修剪 ${count} 条历史工具结果，另裁剪 ${clipped} 条较大的结果（保留头尾）` : `已修剪 ${count} 条历史工具结果（含较新的结果）`;
}
